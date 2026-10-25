import { executionWorkspace } from "./execution-workspace.js";
import { prepareAIHandoff } from "./ai-handoff.js";
import { ProtectedPaths, ProtectedPathsChangedError } from "./protected-paths.js";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { ApplicationFailure, CancelledFailure, Context } from "@temporalio/activity";
import { WorkflowFailedError, WorkflowNotFoundError } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import {
  resolveAgentSettings,
  bundleSchema,
  agentOverrideSchema,
  executionTimeoutMs,
  resolveInputs,
  runSchema,
  validatePlan,
  type Library,
  type RunEvent,
  type WorkflowPlan,
  type WorkflowRun,
  type UsageTotals,
} from "./domain.js";
import { runCommandBlock, validateBlockResult, type BlockRunner } from "./block-runner.js";
import { runFunctionBlock } from "./legacy/git-push-v1.js";
import { runScriptBlock } from "./script-runner.js";
import { runCheck } from "./checks.js";
import { RunStore } from "./run-store.js";
import { connectTemporal, type TemporalOptions } from "./temporal-runtime.js";
import type { WorkflowActivities, executeWorkflow, AttemptIdentity } from "./temporal-workflow.js";
import { WorkflowVersions, type WorkflowVersion } from "./workflow-versions.js";
import { addUsage, emptyUsage, estimateBudget } from "./budget.js";
import { attemptDirectory, loadUsage, saveUsage } from "./attempt-store.js";
import { FileJournal, FileClaims } from "./recovery.js";
import { Workspace } from "./workspace.js";
import { getModelRuntime } from "./model-runtime.js";
import { acquireProjectLock } from "./project-lock.js";
import { compileProgram } from "./program-compiler.js";
import { codeOperationSchema, type CodeOperation } from "./code-schema.js";
import { executeCodeCommand } from "./code-host.js";
import { programSourceSchema } from "./program-schema.js";
import { graphProgram } from "./graph-composition.js";
import { compositionPlan } from "./composition-plan.js";
import { loadOrchestration } from "./orchestration-settings.js";

const activeStatuses = new Set<WorkflowRun["status"]>(["running", "pausing", "paused", "interrupted"]);

export class WorkflowEngine {
  private readonly executionWorkspaces = new Map<string, { token: symbol; access: "read" | "write" | "legacy" }[]>();
  private readonly usageByAttempt = new Map<string, UsageTotals>();
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly emitter = new EventEmitter();
  private readonly store: RunStore;
  private environment: Awaited<ReturnType<typeof connectTemporal>> | undefined;
  private readonly workers = new Map<string, { worker: Worker; done: Promise<void> }>();
  private readonly versions: WorkflowVersions;
  private currentVersion: WorkflowVersion | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private mutations = Promise.resolve();
  private projections = Promise.resolve();
  private readonly taskQueue: string;
  private releaseProject: (() => Promise<void>) | undefined;
  private readonly leaseCancellation = new AbortController();
  private fileClaims: FileClaims | undefined;
  private budgetQueue = Promise.resolve();

  constructor(
    readonly project: string,
    readonly mode: "demo" | "live",
    private readonly runner: BlockRunner,
    private readonly temporalOptions: TemporalOptions = {},
  ) {
    this.versions = new WorkflowVersions(path.join(project, ".workflow", "versions"));
    this.store = new RunStore(path.join(project, ".workflow", "runs"));
    this.taskQueue = `workflow-${createHash("sha256").update(project).digest("hex").slice(0, 32)}`;
    this.emitter.setMaxListeners(100);
  }

  async initialize() {
    this.releaseProject = await acquireProjectLock(this.project, (error) => {
      this.leaseCancellation.abort(error);
      void this.shutdown().catch((failure: unknown) => { console.error("Project lease lost:", failure); });
    });
    try {
      this.fileClaims = new FileClaims((await Workspace.create(this.project)).root);
      for (const run of await this.store.load()) {
        if (run.status === "running" && !run.temporalWorkflowId) {
          run.status = "interrupted";
          run.error = "This legacy run has no Temporal history. Cancel it and create a new workflow; no agent was replayed.";
          await this.store.save(run);
        }
        this.runs.set(run.id, run);
        for (const attempt of run.attempts) await FileJournal.open(attemptDirectory(this.project, run.id, attempt.nodeId, attempt.visit), this.fileClaims);
      }
      this.environment = await connectTemporal(this.project, this.temporalOptions);
      this.currentVersion = await this.versions.install(this.temporalOptions.workflowBundlePath ?? fileURLToPath(new URL("../dist/workflow-bundle.js", import.meta.url)));
      await this.startWorker(this.currentVersion.id);
      for (const run of this.runs.values()) {
        if (activeStatuses.has(run.status) && run.temporalWorkflowId) { await this.startWorker(run.executionVersion); }
      }
      for (const run of this.runs.values()) {
        if (!run.temporalWorkflowId || !activeStatuses.has(run.status)) { continue; }
        try {
          await this.refresh(run.id);
        } catch (error) {
          if (!(error instanceof WorkflowNotFoundError)) {
            throw error;
          }
          const current = this.requireRun(run.id);
          if (current.temporalStart === "pending" && current.status === "running" && !current.attempts.length && !Object.keys(current.visits).length) {
            await this.restoreUnstarted(current, "Approval was interrupted before execution started. Review this draft and approve again; no block was executed.");
            continue;
          }
          if (activeStatuses.has(run.status)) {
            throw new Error(`Temporal history for ${run.id} is missing. Restore .workflow/temporal before continuing.`, { cause: error });
          }
        }
      }
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  private async startWorker(version?: string) {
    const key = version ?? "legacy";
    if (this.workers.has(key)) { return; }
    if (!this.environment) { throw new Error("Temporal is not connected"); }
    // Each code program has its own frozen version. Retain workers only while
    // a run needs them, otherwise a long-lived UI would accumulate one per task.
    for (const [other, entry] of this.workers) {
      if (other === this.currentVersion?.id || [...this.runs.values()].some(run =>
        activeStatuses.has(run.status) && (run.executionVersion ?? "legacy") === other)) continue;
      if (entry.worker.getState() === "RUNNING") entry.worker.shutdown();
      await entry.done;
      this.workers.delete(other);
    }
    const codePath = version ? (await this.versions.load(version)).codePath : fileURLToPath(new URL("../dist/workflow-v1-bundle.js", import.meta.url));
    const worker = await Worker.create({
      connection: this.environment.nativeConnection,
      namespace: this.temporalOptions.namespace ?? "default",
      taskQueue: this.queueFor(version), workflowBundle: { codePath },
      activities: {
        saveProjection: (run, event) => { this.assertActivity(runSchema.parse(run)); return this.saveProjection(run, event); },
        executeBlock: (run, identity) => this.executeBlock(this.scopeAttempt(run, identity)),
        executeOperation: (run, operation, identity) => this.executeOperation(this.scopeAttempt(run, identity), operation),
        settleAttempt: (run, commit, identity) => this.settleAttempt(run, commit, identity),
      } satisfies WorkflowActivities,
      maxConcurrentActivityTaskExecutions: 12,
      maxHeartbeatThrottleInterval: "1 second", defaultHeartbeatThrottleInterval: "1 second",
      shutdownGraceTime: "2 seconds", shutdownForceTime: "5 seconds",
    });
    const done = worker.run();
    this.workers.set(key, { worker, done });
    void done.catch((error: unknown) => { this.coordinatorActivity("worker_error", `Temporal worker ${key.slice(0, 12)} stopped: ${String(error)}`); });
  }

  private queueFor(version?: string) { return version ? `${this.taskQueue}-${version}` : this.taskQueue; }

  private async priceSnapshot(plan: { nodes: { block?: string; agent?: WorkflowPlan["nodes"][number]["agent"] }[] }, library: Library) {
    if (this.mode === "demo") { return; }
    const settings = plan.nodes.flatMap(node => {
      const bundle = node.block ? library.blocks[node.block] : undefined;
      return bundle?.definition.executor && bundle.definition.executor.kind !== "code" ? [] : [resolveAgentSettings(library.config.agent, bundle?.definition.agent, node.agent)];
    });
    for (const setting of settings) {
      if (!setting.provider || !setting.model) { continue; }
      const key = `${setting.provider}/${setting.model}`;
      if (library.config.budget?.prices[key]) { continue; }
      const model = (await getModelRuntime()).getModel(setting.provider, setting.model);
      if (!model || ![model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some((cost) => cost > 0)) { continue; }
      const { budgetSchema } = await import("./domain.js");
      library.config.budget ??= budgetSchema.parse({});
      library.config.budget.prices[key] = { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite, tiers: model.cost.tiers };
    }
  }

  private mutate<T>(action: () => Promise<T>) {
    const operation = this.mutations.then(action);
    this.mutations = operation.then(() => {}, () => {});

    return operation;
  }

  list(includeDeleted = false) {
    return [...this.runs.values()]
      .filter(run => includeDeleted || !run.deletedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((run) => ({
        id: run.id, title: run.plan.title, task: run.plan.task, status: run.status,
        mode: run.mode, createdAt: run.createdAt, updatedAt: run.updatedAt, cursor: run.cursor, revision: run.revision, deletedAt: run.deletedAt,
      }));
  }

  get(id: string) {
    const stored = this.runs.get(id);
    if (!stored) { throw new Error("Workflow not found"); }
    const run = structuredClone(stored);
    for (const attempt of run.attempts) {
      const live = this.usageByAttempt.get(`${id}/${attempt.nodeId}/${attempt.visit}`);
      if (live && live.requests >= (attempt.usage?.requests ?? 0)) { attempt.usage = { ...live }; }
    }
    if (run.executionProtocol === 2 && run.attempts.length) {
      run.usage = run.attempts.reduce((total, attempt) => addUsage(total, attempt.usage ?? emptyUsage()), emptyUsage());
    }
    return run;
  }

  private requireRun(id: string) {
    const run = this.runs.get(id);
    if (!run || run.deletedAt) {
      throw new Error("Workflow not found");
    }

    return run;
  }

  /** Hide a settled run, retaining recovery journals and Temporal history. */
  async remove(id: string) {
    return await this.mutate(async () => {
      const operation = this.projections.then(async () => {
        const current = this.runs.get(id);
        if (!current) { throw new Error("Workflow not found"); }
        if (current.deletedAt) { return structuredClone(current); }
        if (activeStatuses.has(current.status)) { throw new Error("Stop execution before deleting this workflow"); }
        const now = new Date().toISOString();
        const removed = { ...structuredClone(current), deletedAt: now, updatedAt: now, revision: current.revision + 1 };
        await this.store.save(removed);
        this.runs.set(id, removed);
        this.emit(removed, "run_deleted", "Removed from history. Project files and recovery records are retained.");
        await this.store.flush();
        return structuredClone(removed);
      });
      this.projections = operation.then(() => {}, () => {});
      return await operation;
    });
  }

  private handle(id: string) {
    const run = this.requireRun(id);
    if (!this.environment || !run.temporalWorkflowId) {
      throw new Error("This run has no Temporal execution. Create a new workflow.");
    }

    return this.environment.client.workflow.getHandle<typeof executeWorkflow>(run.temporalWorkflowId);
  }

  subscribe(listener: (event: RunEvent) => void) {
    this.emitter.on("event", listener);

    return () => { this.emitter.off("event", listener); };
  }

  coordinatorActivity(kind: string, message: string, runId = "coordinator") {
    this.emitter.emit("event", {
      id: randomUUID(), runId, time: new Date().toISOString(), kind, message,
    } satisfies RunEvent);
  }

  async events(id: string) {
    this.requireRun(id);
    await this.store.flush();

    return await this.store.events(id);
  }

  private emit(run: WorkflowRun, kind: string, message: string, nodeId?: string, id: string = randomUUID()) {
    const event: RunEvent = { id, runId: run.id, time: new Date().toISOString(), kind, message, nodeId };
    if (kind !== "text_delta") {
      this.store.record(event);
    }
    this.emitter.emit("event", event);
  }

  private assertSnapshot(run: WorkflowRun) {
    const approved = this.runs.get(run.id);
    const policy = (value: WorkflowRun) => JSON.parse(JSON.stringify({
      // Code-derived steps are authorized by the frozen program/version/catalog.
      // Graph workflows still compare their complete immutable plan and blocks.
      program: value.program,
      plan: value.program ? { title: value.plan.title, task: value.plan.task } : value.plan,
      config: value.config, blocks: value.program ? undefined : value.blocks,
      executionVersion: value.executionVersion, executionProtocol: value.executionProtocol,
      estimate: value.estimate, mode: value.mode, temporalWorkflowId: value.temporalWorkflowId, approvedAt: value.approvedAt,
    }));
    if (!approved?.approvedAt || !isDeepStrictEqual(policy(approved), policy(run))) {
      throw ApplicationFailure.nonRetryable("Temporal execution does not match a locally approved snapshot", "UnapprovedExecution");
    }
  }

  private assertActivity(run: WorkflowRun) {
    this.assertSnapshot(run);
    if (!run.temporalWorkflowId || Context.current().info.workflowExecution?.workflowId !== run.temporalWorkflowId) {
      throw ApplicationFailure.nonRetryable("Activity belongs to another Temporal workflow", "UnapprovedExecution");
    }
  }

  private saveProjection(value: WorkflowRun, event?: { kind: string; message: string; nodeId?: string }) {
    const run = runSchema.parse(value);
    this.assertSnapshot(run);
    const operation = this.projections.then(async () => {
      const current = this.runs.get(run.id);
      if (current?.deletedAt) return;
      if (current && current.revision > run.revision) {
        // Concurrent branches may deliver checkpoints out of order. Keep the
        // newest projection, but retain every branch's activity event.
        if (event) {
          this.emit(run, event.kind, event.message, event.nodeId, `${run.id}:${run.revision}:${event.kind}`);
          await this.store.flush();
        }
        return;
      }
      this.assertSnapshot(run);
      run.temporalStart = "confirmed";
      await this.store.save(run);
      this.runs.set(run.id, run);
      if (event) {
        this.emit(run, event.kind, event.message, event.nodeId, `${run.id}:${run.revision}:${event.kind}`);
      }
      await this.store.flush();
    });
    this.projections = operation.then(() => {}, () => {});

    return operation;
  }

  async refresh(id: string) {
    await this.startWorker(this.requireRun(id).executionVersion);
    const state = runSchema.parse(await this.handle(id).query<WorkflowRun>("state"));
    await this.saveProjection(state);

    return this.get(id);
  }

  async create(plan: WorkflowPlan, library: Library) {
    if (plan.nodes.some(node => library.blocks[node.block]?.definition.executor?.kind === "code")) {
      const checked = validatePlan(plan, library);
      return this.createProgram(checked.title, checked.task, { source: graphProgram(library), input: { plan: checked } }, library, undefined, checked);
    }
    return await this.mutate(async () => {
      const snapshot = structuredClone(library);
      const checkedPlan = validatePlan(plan, snapshot);
      await this.priceSnapshot(checkedPlan, snapshot);
      const now = new Date().toISOString();
      const id = randomUUID();
      const run: WorkflowRun = {
        executionVersion: this.currentVersion?.id, executionProtocol: 2,
        estimate: estimateBudget(checkedPlan, snapshot, this.mode),
        id, temporalWorkflowId: `workflow-${id}`, revision: 0,
        createdAt: now, updatedAt: now, mode: this.mode, status: "draft",
        plan: checkedPlan, config: snapshot.config, blocks: snapshot.blocks,
        cursor: checkedPlan.entry, visits: {}, artifacts: {}, attempts: [],
      };
      if (Buffer.byteLength(JSON.stringify(run)) > 1_000_000) {
        throw new Error("Workflow snapshot is too large for Temporal. Reduce block resources or split the workflow.");
      }
      await this.store.save(run);
      this.runs.set(run.id, run);
      this.emit(run, "draft", "Workflow proposed. Review its steps, commands and handoffs before approval.");
      await this.store.flush();

      return this.get(run.id);
    });
  }

  async createProgram(title: string, task: string, value: unknown, library: Library, signal?: AbortSignal, graph?: WorkflowPlan) {
    return await this.mutate(async () => {
      signal?.throwIfAborted();
      const snapshot = structuredClone(library);
      const checked = graph && validatePlan(graph, snapshot);
      if (checked) await this.priceSnapshot(checked, snapshot);
      const prepared = await this.prepareProgram(value, snapshot);
      const composed = prepared.program.structure && compositionPlan(prepared.program.structure, title, task, snapshot);
      signal?.throwIfAborted();
      const now = new Date().toISOString(), id = randomUUID();
      const run = runSchema.parse({
        id, temporalWorkflowId: `workflow-${id}`, revision: 0,
        executionVersion: prepared.version.id, executionProtocol: 2,
        createdAt: now, updatedAt: now, mode: this.mode, status: "draft",
        plan: checked ?? composed?.plan ?? { title, task, entry: "start", nodes: [] },
        program: { ...prepared.program, composition: checked ? "graph" : composed ? "structured" : undefined },
        config: snapshot.config, blocks: checked ? snapshot.blocks : composed?.blocks ?? {}, cursor: checked?.entry ?? composed?.plan.entry ?? "start", visits: {}, artifacts: {}, attempts: [],
      });
      this.checkSnapshotSize(run);
      await this.store.save(run);
      this.runs.set(id, run);
      this.emit(run, "draft", checked
        ? "Workflow graph composed and frozen. Review its blocks, models and connections before approval."
        : "TypeScript workflow typechecked and frozen. Review the source and inputs before approval.");
      await this.store.flush();
      if (signal?.aborted) {
        run.deletedAt = new Date().toISOString(); run.updatedAt = run.deletedAt; run.revision++;
        await this.store.save(run); this.runs.set(id, run);
        this.emit(run, "run_deleted", "Source compilation was cancelled; the unpublished draft was removed.");
        await this.store.flush();
        signal.throwIfAborted();
      }
      return this.get(id);
    });
  }

  private checkSnapshotSize(run: WorkflowRun) {
    if (Buffer.byteLength(JSON.stringify(run)) > 1_000_000) throw new Error("Workflow snapshot is too large. Reduce source, inputs or block resources.");
  }

  private async prepareProgram(value: unknown, library: Library) {
    const valueSource = programSourceSchema.parse(value);
    const { settings } = await loadOrchestration(this.project);
    const models = Object.fromEntries(settings.profiles.filter(profile => profile.enabled).map(profile => [profile.id, profile.agent]));
    // Freeze known model prices up front; unknown choices with a spending cap
    // are rejected before their first model request, not silently underpriced.
    const priceNodes = [
      { agent: library.config.agent },
      ...Object.values(library.blocks).filter(bundle => !bundle.definition.executor).map(bundle => ({ block: bundle.definition.id })),
      ...Object.values(models).map(agent => ({ agent })),
    ];
    await this.priceSnapshot({ nodes: priceNodes }, library);
    const { source, structure, version } = await compileProgram(this.project, valueSource, this.versions, library.blocks);
    return { version, program: { ...source, structure, catalog: structuredClone(library.blocks), models } };
  }

  async updateProgram(id: string, value: unknown, expectedRevision?: number, signal?: AbortSignal) {
    return await this.mutate(async () => {
      const run = structuredClone(this.requireRun(id));
      if (run.status !== "draft" || !run.program) throw new Error("Only a draft TypeScript workflow can be edited.");
      if (run.program.composition === "graph") throw new Error("Edit the workflow graph; its TypeScript execution is generated automatically.");
      this.assertRevision(run, expectedRevision);
      const prepared = await this.prepareProgram(value, { config: run.config, blocks: run.program.catalog });
      signal?.throwIfAborted();
      const composed = prepared.program.structure && compositionPlan(prepared.program.structure, run.plan.title, run.plan.task, {config:run.config,blocks:run.program.catalog});
      run.program = { ...prepared.program, composition: composed ? "structured" : undefined };
      run.plan = composed?.plan ?? { ...run.plan, entry: "start", nodes: [] };
      run.blocks = composed?.blocks ?? {};
      run.cursor = run.plan.entry;
      run.executionVersion = prepared.version.id;
      run.revision++;
      run.updatedAt = new Date().toISOString();
      this.checkSnapshotSize(run);
      await this.store.save(run);
      this.runs.set(id, run);
      this.emit(run, "draft", "TypeScript source and inputs updated. Execution still requires approval.");
      await this.store.flush();
      return this.get(id);
    });
  }

  async update(id: string, value: unknown, expectedRevision?: number) {
    return await this.mutate(async () => {
      const run = structuredClone(this.requireRun(id));
      if (run.status !== "draft") {
        throw new Error("Only draft workflows can be edited");
      }
      if (run.program && run.program.composition !== "graph") throw new Error("Edit this workflow's TypeScript source instead of its execution trace.");
      this.assertRevision(run, expectedRevision);
      const plan = validatePlan(value, { config: run.config, blocks: run.blocks });
      if (Buffer.byteLength(JSON.stringify({ ...run, plan })) > 1_000_000) {
        throw new Error("Workflow snapshot is too large for Temporal. Reduce the graph or block resources.");
      }
      await this.priceSnapshot(plan, { config: run.config, blocks: run.blocks });
      if (run.program?.composition === "graph") {
        // Connections and defaults are inputs to the already frozen TypeScript.
        // Do not rebuild helpers from today's files when editing a graph draft.
        run.program.input = { ...run.program.input, plan };
        run.estimate = undefined;
      } else run.estimate = estimateBudget(plan, { config: run.config, blocks: run.blocks }, run.mode);
      run.plan = plan;
      this.checkSnapshotSize(run);
      run.cursor = run.plan.entry;
      run.revision += 1;
      run.updatedAt = new Date().toISOString();
      await this.store.save(run);
      this.runs.set(id, run);
      this.emit(run, "draft", "Draft graph updated. Execution still requires approval.");
      await this.store.flush();

      return this.get(id);
    });
  }

  async reject(id: string) {
    return await this.mutate(async () => {
      const run = structuredClone(this.requireRun(id));
      if (run.status !== "draft") {
        throw new Error("Only draft workflows can be rejected");
      }
      run.status = "rejected";
      run.revision += 1;
      run.updatedAt = new Date().toISOString();
      await this.store.save(run);
      this.runs.set(id, run);
      this.emit(run, "rejected", "Workflow rejected. No block was executed.");
      await this.store.flush();

      return this.get(id);
    });
  }

  private assertRevision(run: WorkflowRun, expectedRevision?: number) {
    if (expectedRevision !== undefined && run.revision !== expectedRevision) {
      throw new Error("Draft changed since you loaded it. Review the latest draft and try again.");
    }
  }

  private async restoreUnstarted(approved: WorkflowRun, message: string) {
    const operation = this.projections.then(async () => {
      const current = this.requireRun(approved.id);
      if (current.temporalStart !== "pending") { throw new Error("Execution start is already confirmed; cannot restore its draft"); }
      const restored: WorkflowRun = {
        ...structuredClone(current), status: "draft", approvedAt: undefined, temporalStart: undefined,
        // Fence a late start response: its old snapshot can never authorize an activity.
        temporalWorkflowId: `workflow-${current.id}-${randomUUID()}`,
        revision: current.revision + 1, updatedAt: new Date().toISOString(), error: message,
      };
      await this.store.save(restored);
      this.runs.set(restored.id, restored);
      this.emit(restored, "draft", message);
      await this.store.flush();
    });
    this.projections = operation.then(() => {}, () => {});
    await operation;
  }

  private async confirmStart(id: string) {
    const operation = this.projections.then(async () => {
      const current = this.requireRun(id);
      if (current.temporalStart === "confirmed") { return; }
      const confirmed = { ...current, temporalStart: "confirmed" as const };
      await this.store.save(confirmed);
      this.runs.set(id, confirmed);
    });
    this.projections = operation.then(() => {}, () => {});
    await operation;
  }

  async approve(id: string, expectedRevision?: number) {
    return await this.mutate(async () => {
      const run = structuredClone(this.requireRun(id));
      if (run.status !== "draft") {
        throw new Error("Only draft workflows can be approved");
      }
      this.assertRevision(run, expectedRevision);
      if ([...this.runs.values()].some((candidate) => activeStatuses.has(candidate.status))) {
        throw new Error("Another workflow is running or paused in this project");
      }
      if (run.mode !== this.mode) {
        throw new Error("This draft was created in a different execution mode. Regenerate it before approval.");
      }
      if (!this.environment || !run.temporalWorkflowId) {
        throw new Error("Temporal is not connected");
      }
      if (!run.program || run.program.composition === "graph") validatePlan(run.plan, { config: run.config, blocks: run.blocks });
      const approved = structuredClone(run);
      approved.executionVersion ??= this.currentVersion?.id;
      approved.executionProtocol = 2;
      if (!run.program) approved.estimate = estimateBudget(approved.plan, { config: approved.config, blocks: approved.blocks }, approved.mode);
      if (approved.config.budget?.maxCostUsd !== undefined && approved.estimate?.unpricedNodes.length) {
        throw new Error("A spending limit requires explicit provider/model selections and pricing for every node");
      }
      await this.startWorker(approved.executionVersion);
      approved.status = "running";
      approved.temporalStart = "pending";
      approved.error = undefined;
      approved.approvedAt = new Date().toISOString();
      approved.updatedAt = approved.approvedAt;
      approved.revision += 1;
      await this.store.save(approved);
      this.runs.set(id, approved);
      try {
        // Start receipts belong to the host, not the frozen workflow schema.
        const { temporalStart: _receipt, ...input } = approved;
        await this.environment.client.workflow.start("executeWorkflow", {
          workflowId: run.temporalWorkflowId, taskQueue: this.queueFor(approved.executionVersion), args: [input],
        });
        await this.confirmStart(id);
      } catch (error) {
        try {
          await this.handle(id).describe();
          return await this.refresh(id);
        } catch (lookupError) {
          if (lookupError instanceof WorkflowNotFoundError) {
            // Readers may already have observed approval. Recovery is a new
            // revision so they can safely replace that in-flight state.
            await this.restoreUnstarted(approved, "Execution did not start. The draft is ready for review and another approval attempt.");
          }
        }
        throw error;
      }

      return this.get(id);
    });
  }

  async pause(id: string) {
    return await this.mutate(async () => {
      if (this.requireRun(id).status !== "running") {
        throw new Error("Only running workflows can be paused");
      }
      await this.handle(id).signal("pause");

      return await this.refresh(id);
    });
  }

  async resume(id: string) {
    return await this.mutate(async () => {
      const run = this.requireRun(id);
      if (!["paused", "pausing", "interrupted"].includes(run.status)) {
        throw new Error("Only paused or interrupted workflows can be resumed");
      }
      if (run.mode !== this.mode) {
        throw new Error("Restart workflow in the original execution mode before resuming");
      }
      if (run.executionProtocol === 2 && run.status === "interrupted") {
        const settled = await this.recoverAttempts(run);
        if (settled.recovery.status === "conflict") { throw new Error(`Resolve recovery conflicts before resuming: ${settled.recovery.conflicts.join(", ")}`); }
      }
      await this.handle(id).signal("resume");

      return await this.refresh(id);
    });
  }

  async cancel(id: string) {
    return await this.mutate(async () => {
      const run = structuredClone(this.requireRun(id));
      if (!activeStatuses.has(run.status)) {
        throw new Error("This workflow is not running or paused");
      }
      if (!run.temporalWorkflowId) {
        run.status = "cancelled";
        run.revision += 1;
        run.updatedAt = new Date().toISOString();
        await this.store.save(run);
        this.runs.set(id, run);
        this.emit(run, "run_end", "CANCELLED");
        await this.store.flush();
      } else {
        await this.handle(id).cancel();
      }

      return this.get(id);
    });
  }

  async waitForIdle() {
    const active = [...this.runs.values()].filter((run) => activeStatuses.has(run.status) && run.temporalWorkflowId);
    await Promise.all(active.map(async (run) => {
      try {
        await this.handle(run.id).result();
      } catch (error) {
        if (!(error instanceof WorkflowFailedError && error.cause instanceof CancelledFailure)) { throw error; }
      }
      await this.refresh(run.id);
    }));
    await this.projections;
  }

  shutdown() {
    this.shutdownPromise ??= (async () => {
      // Stop workers, not workflows. Temporal retains paused/running executions for restart.
      try {
        for (const { worker } of this.workers.values()) {
          if (worker.getState() === "RUNNING") { worker.shutdown(); }
        }
        // A crashed worker must not release ownership while another worker is
        // still stopping activities that can change the shared project.
        const stopped = await Promise.allSettled([...this.workers.values()].map(({ done }) => done));
        await this.projections;
        await this.store.flush();
        const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) { throw new AggregateError(failures.map(result => result.reason), "Temporal workers failed while stopping"); }
      } finally {
        try { await this.environment?.teardown(); } finally { await this.releaseProject?.(); }
      }
    })();

    return this.shutdownPromise;
  }

  private scopeAttempt(value: WorkflowRun, identity?: AttemptIdentity): WorkflowRun {
    const run = runSchema.parse(value);
    if (identity) {
      if (!run.attempts.some(attempt => attempt.nodeId === identity.nodeId && attempt.visit === identity.visit) || run.visits[identity.nodeId] !== identity.visit) throw new Error("Unknown execution attempt");
      run.cursor = identity.nodeId;
    }
    return run;
  }

  private async recoverAttempt(run: WorkflowRun, commit: boolean, identity?: AttemptIdentity) {
    const attempt = identity ? run.attempts.find(attempt => attempt.nodeId === identity.nodeId && attempt.visit === identity.visit) : run.attempts.at(-1);
    if (identity && !attempt) throw new Error("Unknown recovery attempt");
    if (!attempt) { return { recovery: { status: "none" as const, restored: [], conflicts: [] }, usage: emptyUsage() }; }
    const directory = attemptDirectory(this.project, run.id, attempt.nodeId, attempt.visit);
    const node = run.plan.nodes.find((candidate) => candidate.id === attempt.nodeId);
    const bundle = node && run.blocks[node.block];
    if (!bundle) { throw new Error("Unknown recovery block"); }
    const workspace = await Workspace.create(this.project);
    const journal = await FileJournal.open(directory, this.fileClaims);
    const recovery = await journal.settle(workspace, commit || run.config.recovery?.rollbackOnFailure === false);
    return { recovery, usage: await loadUsage(directory) };
  }

  private async settleAttempt(value: WorkflowRun, commit: boolean, identity?: AttemptIdentity) {
    const run = runSchema.parse(value);
    this.assertActivity(run);
    return this.recoverAttempt(run, commit, identity);
  }

  private async recoverAttempts(run: WorkflowRun) {
    const attempts = run.attempts.filter(attempt => attempt.error || attempt.recovery?.status === "conflict");
    if (!attempts.length) {
      const settled = await this.recoverAttempt(run, false);
      const last = run.attempts.at(-1);
      if (last) { last.recovery = settled.recovery; last.usage = settled.usage; }
      return settled;
    }
    const recovery: import("./domain.js").RecoveryResult = { status: "none", restored: [], conflicts: [] };
    let usage = emptyUsage();
    for (const attempt of attempts) {
      const settled = await this.recoverAttempt(run, false, attempt);
      attempt.recovery = settled.recovery; attempt.usage = settled.usage;
      recovery.restored.push(...settled.recovery.restored); recovery.conflicts.push(...settled.recovery.conflicts);
      usage = addUsage(usage, settled.usage);
    }
    recovery.status = recovery.conflicts.length ? "conflict" : recovery.restored.length ? "restored" : "none";
    return { recovery, usage };
  }

  async recover(id: string) {
    return this.mutate(async () => {
      const run = structuredClone(this.requireRun(id));
      if (!["cancelled", "failed", "interrupted"].includes(run.status)) { throw new Error("Only cancelled, failed or interrupted steps can be recovered"); }
      const settled = await this.recoverAttempts(run);
      if (run.status !== "interrupted") {
        run.revision += 1; run.updatedAt = new Date().toISOString();
        await this.store.save(run); this.runs.set(id, run);
      }
      this.emit(run, "recovery", JSON.stringify(settled.recovery));
      await this.store.flush();
      return { run: this.get(id), ...settled };
    });
  }

  async keepRecoveryFiles(id: string) {
    return this.mutate(async () => {
      const run = structuredClone(this.requireRun(id));
      if (!["failed", "cancelled"].includes(run.status) || [...this.runs.values()].some(candidate => activeStatuses.has(candidate.status))) {
        throw new Error("Stop execution before keeping recovery files");
      }
      const attempts = run.attempts.filter(attempt => attempt.recovery?.status === "conflict");
      if (!attempts.length) throw new Error("No recovery conflicts to resolve");
      for (const attempt of attempts) {
        const settled = await this.recoverAttempt(run, true, attempt);
        attempt.recovery = settled.recovery;
      }
      run.revision += 1;
      run.updatedAt = new Date().toISOString();
      await this.store.save(run);
      this.runs.set(id, run);
      this.emit(run, "recovery", "Current files retained without overwriting them. Resolved file claims released; implementation acceptance remains pending.");
      await this.store.flush();
      return this.get(id);
    });
  }

  private async executeOperation(value: WorkflowRun, raw: CodeOperation): Promise<unknown> {
    const run = runSchema.parse(value);
    this.assertActivity(run);
    if (run.mode !== this.mode) {
      throw new Error("Execution mode mismatch. Restart the server in this run's original mode.");
    }
    if (!run.program) throw new Error("Code effects require a frozen TypeScript workflow");
    const operation = codeOperationSchema.parse(raw);
    const node = run.plan.nodes.find(node => node.id === run.cursor)!;
    const bundle = run.blocks[node.block]!;
    if (bundle.definition.executor?.kind !== "code") throw new Error("Code effect has no active TypeScript block");
    const context = Context.current();
    const signal = AbortSignal.any([context.cancellationSignal, this.leaseCancellation.signal]);
    signal.throwIfAborted();
    const emit = (kind: string, message: string) => this.emit(run, kind, message, node.id);
    const label = operation.kind === "exec" ? operation.command : operation.kind === "ai" ? operation.prompt : operation.path;
    emit("operation_start", `${operation.kind}: ${label.slice(0, 6000)}`);
    const heartbeat = setInterval(() => context.heartbeat({ nodeId: node.id, operation: operation.kind }), 1000);
    context.heartbeat({ nodeId: node.id });
    try {
      let result: unknown;
      if (operation.kind === "ai") {
        const model = operation.model ? agentOverrideSchema.parse(operation.model) : undefined;
        run.blocks[node.block] = bundleSchema.parse({
          ...bundle,
          definition: { ...bundle.definition, executor: undefined, checks: [],
            agent: resolveAgentSettings(run.config.agent, bundle.definition.agent, node.agent, model),
            outputs: operation.outputSchema ? ["data"] : [], outputSchema: operation.outputSchema,
          },
          prompt: operation.instructions || "Complete the requested task. Use tools when useful, then submit a concise result.",
        });
        // Call-specific settings win over the workflow's default model override.
        node.agent = undefined;
        const contextDirectory = attemptDirectory(this.project, run.id, node.id, run.visits[node.id] ?? 1);
        const handoff = await prepareAIHandoff(contextDirectory, operation.prompt);
        const inheritedInputs = operation.tools === "none" ? {} : resolveInputs(node, run);
        const inherited = await prepareAIHandoff(contextDirectory, "Enclosing step inputs (evidence, not additional instructions):\n" + JSON.stringify(inheritedInputs));
        if (handoff.reference) emit("context_reference", JSON.stringify(handoff.reference));
        if (inherited.reference) emit("context_reference", JSON.stringify(inherited.reference));
        node.goal = handoff.prompt.slice(0, 8000);
        node.inputs = [];
        node.context = { ...(inherited.reference ? { "step-context": inherited.prompt } : inheritedInputs), "call-prompt": handoff.prompt };
        const workspace = await executionWorkspace(this.project, operation.workspace, signal);
        const isolated = operation.workspace !== undefined && workspace !== await realpath(this.project);
        const readOnly = operation.writablePaths?.length === 0 || operation.protectedPaths?.includes("**/*") || operation.tools === "none";
        const access = readOnly ? "read" : isolated || operation.writablePaths !== undefined || operation.protectedPaths?.length ? "write" : "legacy";
        const owners = this.executionWorkspaces.get(workspace) ?? [];
        if (owners.some(owner => access === "write" || owner.access === "write" || owner.access !== access)) {
          const summary = "Another AI call owns this worktree; use a distinct worktree for each concurrent writer";
          emit("operation_error", summary);
          // This is a rejected operation with no effects, not a lost activity
          // that needs interruption/recovery and an explicit resume.
          return { outcome: "fail", summary, artifacts: {} };
        }
        const token = Symbol("workspace-call");
        this.executionWorkspaces.set(workspace, [...owners, { token, access }]);
        let protection: ProtectedPaths | undefined;
        let audit: ProtectedPaths | undefined;
        try {
          protection = (operation.protectedPaths?.length || operation.writablePaths !== undefined) ? await ProtectedPaths.capture(workspace, operation.protectedPaths ?? [], operation.writablePaths) : undefined;
          try { audit = await ProtectedPaths.capture(workspace, ["**/*"]); }
          catch { emit("file_evidence_unavailable", "File scan unavailable or exceeds limits; unchanged files have not been established."); }
          emit("execution_workspace", workspace);
          const completion = await this.executeBlock(run, "value", operation.protectedPaths, operation.writablePaths, workspace, operation.tools);
          result = completion.result;
        } finally {
          try {
            if (audit) {
              try {
                const changes = await audit.changes();
                emit("file_evidence", JSON.stringify({ workspace, changedFileCount: changes.length, changes: changes.slice(0, 100) }));
              } catch { emit("file_evidence_unavailable", "Final file scan unavailable; inspect the worktree before accepting it."); }
            }
            try { await protection?.assertUnchanged(); }
            catch (error) {
              if (!(error instanceof ProtectedPathsChangedError)) throw error;
              result = { outcome: "fail", summary: error.message, artifacts: {} };
            }
          } finally {
            const remaining = (this.executionWorkspaces.get(workspace) ?? []).filter(owner => owner.token !== token);
            if (remaining.length) this.executionWorkspaces.set(workspace, remaining);
            else this.executionWorkspaces.delete(workspace);
          }
        }
      } else if (this.mode === "demo") {
        result = operation.kind === "exec" ? { exitCode: 0, stdout: "DEMO", stderr: "", output: "DEMO: no command was executed.", timedOut: false }
          : operation.kind === "read" ? "DEMO: no file was read." : null;
      } else if (operation.kind === "exec") {
        result = await executeCodeCommand(this.project, run, operation, signal, emit);
      } else {
        const directory = attemptDirectory(this.project, run.id, node.id, run.visits[node.id] ?? 1);
        const workspace = await Workspace.create(this.project, { signal, journal: await FileJournal.open(directory, this.fileClaims) });
        if (operation.kind === "read") result = await workspace.read(operation.path);
        else { await workspace.write(operation.path, operation.content); result = null; }
      }
      signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(result)) > 256_000) throw new Error("Operation result exceeds 256 KB. Read a smaller file or return a concise result.");
      emit("operation_end", operation.kind === "exec"
        ? `exec: exit ${(result as { exitCode: number | null }).exitCode}` : `${operation.kind}: finished`);
      return result;
    } catch (error) { emit("operation_error", `${operation.kind}: ${String(error)}`); throw error; }
    finally { clearInterval(heartbeat); }
  }

  private async executeBlock(value: WorkflowRun, resultMode?: "value", protectedPaths?: string[], writablePaths?: string[], workspace = this.project, tools?: "none") {
    const node = value.plan.nodes.find(node => node.id === value.cursor);
    if (value.config.budget?.maxCostUsd === undefined || (node && value.blocks[node.block]?.definition.executor)) return this.executeBlockNow(value, resultMode, protectedPaths, writablePaths, workspace, tools);
    // Only budgeted model sessions serialize. Otherwise siblings may spend the
    // same stale remaining balance. Compute and unbudgeted AI stay parallel.
    const before = this.budgetQueue;
    let release!: () => void;
    this.budgetQueue = new Promise<void>(resolve => { release = resolve; });
    const activity = Context.current();
    const heartbeat = setInterval(() => activity.heartbeat({ nodeId: value.cursor, waiting: "budgeted model session" }), 1000);
    activity.heartbeat({ nodeId: value.cursor, waiting: "budgeted model session" });
    const signal = AbortSignal.any([activity.cancellationSignal, this.leaseCancellation.signal]);
    let onAbort!: () => void;
    try {
      signal.throwIfAborted();
      await Promise.race([before, new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, {once:true}); })]);
      signal.throwIfAborted();
      return await this.executeBlockNow(value, resultMode, protectedPaths, writablePaths, workspace, tools);
    } finally {
      clearInterval(heartbeat);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      void before.then(release, release);
    }
  }

  private async executeBlockNow(value: WorkflowRun, resultMode?: "value", protectedPaths?: string[], writablePaths?: string[], workspace = this.project, tools?: "none") {
    const run = runSchema.parse(value);
    this.assertActivity(run);
    if (run.mode !== this.mode) {
      throw new Error("Execution mode mismatch. Restart the server in this run's original mode.");
    }
    const node = run.plan.nodes.find((candidate) => candidate.id === run.cursor);
    const bundle = node && run.blocks[node.block];
    if (!node || !bundle) {
      throw new Error(`Unknown execution node: ${run.cursor}`);
    }
    const settings = resolveAgentSettings(run.config.agent, bundle.definition.agent, node.agent);
    const context = Context.current();
    const signal = AbortSignal.any([context.cancellationSignal, this.leaseCancellation.signal, AbortSignal.timeout(executionTimeoutMs(run.config, bundle, node))]);
    signal.throwIfAborted();
    const directory = attemptDirectory(this.project, run.id, node.id, run.visits[node.id] ?? 1);
    const journal = run.executionProtocol === 2 ? await FileJournal.open(directory, this.fileClaims) : undefined;
    const previousUsage = await loadUsage(directory);
    let spent = 0;
    if (run.config.budget?.maxCostUsd !== undefined) {
      const attempts = new Map([...this.requireRun(run.id).attempts, ...run.attempts].map(attempt => [`${attempt.nodeId}/${attempt.visit}`, attempt]));
      for (const attempt of attempts.values()) spent += (await loadUsage(attemptDirectory(this.project, run.id, attempt.nodeId, attempt.visit))).costUsd;
    }
    const remainingCost = run.config.budget?.maxCostUsd === undefined ? undefined : run.config.budget.maxCostUsd - spent;
    if (!bundle.definition.executor && remainingCost !== undefined && remainingCost <= 0) { throw new Error("Workflow spending limit reached"); }
    if (run.program && !bundle.definition.executor && remainingCost !== undefined &&
        !run.config.budget?.prices[`${settings.provider}/${settings.model}`]) {
      throw new Error(`A spending limit requires a saved price for ${settings.provider}/${settings.model}. Configure pricing before running this model.`);
    }
    const heartbeat = setInterval(() => { context.heartbeat({ nodeId: node.id }); }, 1000);
    context.heartbeat({ nodeId: node.id });
    try {
      const runner = this.mode !== "live" || !bundle.definition.executor ? this.runner
        : bundle.definition.executor.kind === "script" ? runScriptBlock
        : bundle.definition.executor.kind === "function" ? runFunctionBlock : runCommandBlock;
      const isolated = workspace !== this.project && workspace !== await realpath(this.project);
      const result = validateBlockResult(await runner({
        project: workspace, attachmentProject: this.project, absoluteJournalPaths: isolated, config: run.config, bundle, node, protectedPaths, writablePaths, tools, task: run.plan.task, workflow: run.plan, composition: run.program?.structure,
        inputs: resolveInputs(node, run), visit: run.visits[node.id] ?? 1,
        settings, signal, journal, maxCostUsd: remainingCost, resultMode,
        onUsage: async (sessionUsage) => { const usage = addUsage(previousUsage, sessionUsage); await saveUsage(directory, usage); this.usageByAttempt.set(`${run.id}/${node.id}/${run.visits[node.id] ?? 1}`, { ...usage }); this.emit(run, "usage", JSON.stringify(usage), node.id); },
        emit: (kind, message) => { this.emit(run, kind, message, node.id); },
      }), bundle);
      signal.throwIfAborted();
      const checks: WorkflowRun["attempts"][number]["checks"] = [];
      if (result.outcome !== "fail") {
        for (const check of bundle.definition.checks) {
          this.emit(run, "check_start", `${check.command} must ${check.expect === "success" ? "pass" : "fail"}`, node.id);
          const checked = this.mode === "demo"
            ? { command: check.command, expected: check.expect, exitCode: check.expect === "success" ? 0 : 1, matched: true, output: "DEMO: simulated check result; no command was executed." }
            : await runCheck(this.project, run.config, check, signal);
          checks.push(checked);
          this.emit(run, "check", `${check.command}: ${checked.matched ? "condition met" : "condition NOT met"}\n${checked.output}`, node.id);
        }
        if (checks.some((check) => !check.matched)) {
          result.outcome = "retry";
          result.summary = result.summary.slice(0, 15_800) + "\nHost verification failed; following the approved retry route.";
        }
      }
      signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(run)) + 3 * Buffer.byteLength(JSON.stringify({ result, checks })) > 1_500_000) {
        throw new Error("Temporal payload budget exhausted. Cancel and split this workflow into smaller runs.");
      }

      return { result, checks };
    } finally {
      clearInterval(heartbeat);
    }
  }
}
