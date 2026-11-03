import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { WorkflowEngine } from "../engine.js";
import type { WorkflowRun, UsageTotals } from "../../contracts/domain.js";
import {
  automationActionSchema,
  automationCaseSchema,
  automationJobActionSchema,
  automationJobSchema,
  ingestSignalsSchema,
  saveAutomationSchema,
  schedulerSettingsSchema,
  discoveryResultSchema,
  type Automation,
  type AutomationAction,
  type AutomationCase,
  type AutomationJson as Json,
  type AutomationExecution,
  type AutomationJob,
  type AutomationJobAction,
  type AutomationObservation,
  type AutomationRoute,
  type AutomationState,
  type WorkSignal,
} from "../../contracts/automation-schema.js";
import { AutomationStore, type AutomationVersion } from "../storage/automation-store.js";
import { emptyUsage, addUsage } from "../execution/budget.js";
import { dueFires, initialFire } from "./schedules.js";
import { readAutomationAccounting } from "./accounting.js";

type AutomationEngine = Pick<
  WorkflowEngine,
  | "project"
  | "mode"
  | "get"
  | "snapshotForAutomation"
  | "createAutomatedRun"
  | "approve"
  | "pause"
  | "resume"
  | "cancel"
  | "reject"
  | "cleanupAutomationWorkspace"
> &
  Partial<Pick<WorkflowEngine, "setAutomationAdmissionGuard" | "setSignalHandler">> & {
    usage?: Pick<WorkflowEngine["usage"], "report" | "sessions">;
    list(includeDeleted?: boolean): Pick<WorkflowRun, "id" | "status">[];
  };
const terminal = ["completed", "failed", "cancelled"];
const runActive = ["running", "pausing", "paused", "interrupted"];
const computing = ["admitted", "running"];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const message = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 4000) : "Automation operation failed";
const jsonValue = (value: unknown): Json => z.json().parse(JSON.parse(JSON.stringify(value)));
const timestamp = (now: number) => new Date(now).toISOString();

export function signalIdentity(signal: WorkSignal) {
  return hash(
    signal.id
      ? [signal.sourceId, "delivery", signal.id]
      : [
          signal.sourceId,
          signal.resourceKey,
          signal.signalKind,
          signal.revision,
          signal.fingerprint,
        ],
  );
}
export function signalCaseId(signal: WorkSignal) {
  return hash([signal.sourceId, signal.correlationKey ?? signal.resourceKey]);
}
export function matchesRoute(route: AutomationRoute, signal: WorkSignal) {
  return (
    route.signalKind === signal.signalKind &&
    (!route.sourceId || route.sourceId === signal.sourceId) &&
    Object.entries(route.match).every(([key, value]) =>
      isDeepStrictEqual(signal.payload[key], value),
    )
  );
}
function executionFor(version: AutomationVersion, job: AutomationJob): AutomationExecution {
  if (job.phase === "reaction")
    return (
      version.config.routes.find((route) => `route:${route.id}` === job.targetKey)?.execution ??
      version.config.execution
    );
  if (job.phase === "output" || job.phase === "reconcile")
    return version.config.output?.execution ?? version.config.execution;
  return version.config.execution;
}
function machineResult(run: WorkflowRun): Json | undefined {
  if (run.outputValueError)
    throw new Error(
      run.outputValueError === "too_large"
        ? "Workflow machine result exceeds 256 KB; return focused data or references."
        : "Workflow machine result is not JSON; return focused data or references.",
    );
  if (run.outputValue !== undefined) return run.outputValue;
  // Legacy archives have only a Markdown workflow summary. Never parse it as machine JSON.
  const data = run.attempts.findLast((attempt) => attempt.result?.artifacts.data !== undefined)
    ?.result?.artifacts.data;
  return data === undefined ? undefined : z.json().parse(JSON.parse(data));
}

/** Durable queue/admission around the existing executor, never an alternative workflow runtime. */
export class Automations {
  private queue = Promise.resolve();
  private admissions = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private closed = false;
  private error?: string;
  private constructor(
    private readonly engine: AutomationEngine,
    private readonly store: AutomationStore,
    private readonly now: () => number,
  ) {}
  static async open(engine: AutomationEngine, options: { now?: () => number } = {}) {
    const service = new Automations(
      engine,
      await AutomationStore.open(engine.project),
      options.now ?? Date.now,
    );
    engine.setAutomationAdmissionGuard?.((runId) => service.assertRunAdmission(runId));
    engine.setSignalHandler?.(async (automationId, signal) => {
      await service.ingest(automationId, { signals: [signal] });
    });
    return service;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Automations are closing"));
    const pending = this.queue.then(action);
    this.queue = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
  start() {
    if (this.timer || this.closed) return;
    const work = () => {
      void this.tick().catch((error) => {
        if (!this.closed) this.error = message(error);
      });
    };
    this.timer = setInterval(work, 1000);
    this.timer.unref();
    work();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all([this.queue, this.admissions]);
    this.store.close();
  }
  state(): AutomationState {
    const usage: Record<string, UsageTotals> = {};
    for (const job of this.store.jobs("all"))
      usage[job.automationId] = addUsage(
        usage[job.automationId] ?? emptyUsage(),
        job.usage ?? emptyUsage(),
      );
    const jobs = new Map(this.store.jobs().map((job) => [job.id, job]));
    for (const job of this.store.jobs("pending")) jobs.set(job.id, job);
    return {
      automations: this.store.definitions(),
      jobs: [...jobs.values()],
      cases: this.store.cases(),
      observations: this.store.observations(),
      audit: this.store.history(),
      settings: this.store.settings(),
      usage,
      error: this.error,
    };
  }
  version(id: string) {
    z.string().uuid().parse(id);
    const value = this.store.version(id);
    return {
      id,
      config: value.config,
      targets: Object.fromEntries(
        Object.entries(value.templates).map(([key, run]) => [
          key,
          {
            title: run.plan.title,
            executionVersion: run.executionVersion,
            source: run.program?.source,
            input: run.program?.input,
            settings: run.config,
            blocks: run.program?.catalog ?? run.blocks,
            models: run.program?.models ?? {},
          },
        ]),
      ),
    };
  }
  settings(value: unknown) {
    const input = schedulerSettingsSchema.parse(value);
    return this.serial(async () => {
      if (input.revision !== this.store.settings().revision)
        throw new Error("Scheduler settings changed. Reload before saving.");
      const result = { ...input, revision: input.revision + 1 };
      this.store.saveSettings(result);
      return result;
    });
  }
  save(value: unknown) {
    const input = saveAutomationSchema.parse(value);
    return this.serial(async () => {
      const current = input.id ? this.store.definition(input.id) : undefined;
      if (current && current.revision !== input.revision)
        throw new Error("Automation changed. Reload before saving.");
      if (!current && this.store.definitions().length >= 100)
        throw new Error("A project supports at most 100 automations");
      const config = input.config;
      // Validate cron/timezone even when preserving the previous scheduling checkpoint.
      const next = initialFire(config.schedule, this.now());
      const templates: Record<string, WorkflowRun> = {};
      templates.main = await this.engine.snapshotForAutomation(config.target, config.execution);
      for (const route of config.routes)
        if (route.target)
          templates[`route:${route.id}`] = await this.engine.snapshotForAutomation(
            route.target,
            route.execution ?? config.execution,
          );
      if (config.output) {
        templates.output = await this.engine.snapshotForAutomation(
          config.output.target,
          config.output.execution ?? config.execution,
        );
        if (config.output.reconcile)
          templates.reconcile = await this.engine.snapshotForAutomation(
            config.output.reconcile,
            config.output.execution ?? config.execution,
          );
      }
      const time = timestamp(this.now());
      const automation: Automation = {
        id: current?.id ?? randomUUID(),
        revision: (current?.revision ?? -1) + 1,
        versionId: randomUUID(),
        config,
        state: config.enabled ? "enabled" : "disabled",
        createdAt: current?.createdAt ?? time,
        updatedAt: time,
        nextFireAt:
          current && isDeepStrictEqual(config.schedule, current.config.schedule)
            ? current.nextFireAt
            : next,
        lastFireAt: current?.lastFireAt,
        lastAdmittedAt: current?.lastAdmittedAt,
        checkpoint: current?.checkpoint,
      };
      this.store.transaction(() => {
        this.store.save(automation, { config, templates });
        this.audit(
          automation.id,
          "definition",
          `Saved version ${automation.revision}; ${automation.state}. Future jobs use this snapshot.`,
        );
      });
      return automation;
    });
  }
  action(
    id: string,
    value: AutomationAction,
    expectedRevision?: number,
  ): Promise<Automation | AutomationJob> {
    z.string().uuid().parse(id);
    const action = automationActionSchema.parse(value);
    return this.serial(async () => {
      const automation = this.store.definition(id);
      if (expectedRevision !== undefined && expectedRevision !== automation.revision)
        throw new Error("Automation changed. Reload before acting.");
      if (action === "run-now" || action === "test") {
        if (action === "run-now" && automation.state !== "enabled")
          throw new Error("Enable the automation before running it, or create a test draft");
        const job = this.makeJob(automation, {
          key: `manual:${randomUUID()}`,
          test: action === "test",
        });
        this.store.transaction(() => {
          this.checkQueue(automation);
          this.store.insert(job);
          this.audit(
            id,
            "queued",
            action === "test"
              ? "Test requires approval and never publishes or routes results."
              : "Explicit run-now request.",
            job.id,
          );
        });
        await this.admit(job);
        return this.store.job(job.id);
      }
      automation.state =
        action === "pause" ? "paused" : action === "disable" ? "disabled" : "enabled";
      automation.config.enabled = automation.state === "enabled";
      automation.revision++;
      automation.updatedAt = timestamp(this.now());
      this.store.transaction(() => {
        this.store.save(automation);
        this.audit(id, action, `Automation ${automation.state}; active jobs retain their policy.`);
      });
      return automation;
    });
  }
  private audit(
    automationId: string,
    kind: string,
    text: string,
    jobId?: string,
    signalKey?: string,
  ) {
    this.store.audit({
      automationId,
      kind,
      message: text,
      jobId,
      signalKey,
      time: timestamp(this.now()),
    });
  }
  private change(job: AutomationJob, status: AutomationJob["status"], reason?: string) {
    reason = reason?.slice(0, 4000);
    const changed = job.status !== status || job.reason !== reason;
    job.status = status;
    job.reason = reason;
    job.updatedAt = timestamp(this.now());
    this.store.update(job);
    if (changed) this.audit(job.automationId, status, reason ?? `Job ${status}.`, job.id);
  }
  private checkQueue(automation: Automation, internal = false) {
    const queued = this.store
      .jobs("pending")
      .filter((job) => ["queued", "waiting"].includes(job.status));
    const settings = this.store.settings();
    const globalLimit = settings.maxQueued + (internal ? settings.concurrency : 0);
    const localLimit =
      automation.config.policy.maxQueued + (internal ? automation.config.policy.concurrency : 0);
    if (
      queued.length >= globalLimit ||
      queued.filter((job) => job.automationId === automation.id).length >= localLimit
    )
      throw new Error("Automation queue is full; intake and checkpoint were not advanced");
  }
  private makeJob(
    automation: Automation,
    options: {
      key: string;
      phase?: AutomationJob["phase"];
      targetKey?: string;
      signal?: WorkSignal;
      workCase?: AutomationCase;
      route?: AutomationRoute;
      test?: boolean;
      parent?: AutomationJob;
      versionId?: string;
      input?: Record<string, Json>;
    },
  ): AutomationJob {
    const versionId = options.versionId ?? automation.versionId;
    const config = this.store.version(versionId).config;
    const phase = options.phase ?? (config.mode === "discovery" ? "discovery" : "direct");
    const id = randomUUID();
    const publicationKey =
      options.parent?.publicationKey ??
      (phase === "output" ? `workflow-automation:${options.parent!.id}` : undefined);
    return automationJobSchema.parse({
      id,
      automationId: automation.id,
      automationName: config.name,
      versionId,
      key: options.key,
      phase,
      targetKey: options.targetKey ?? "main",
      caseId: options.workCase?.id ?? options.parent?.caseId,
      parentJobId: options.parent?.id,
      signal: options.signal,
      revisionPolicy: options.route?.revisionPolicy ?? options.parent?.revisionPolicy ?? "current",
      input: jsonValue({
        ...config.inputs,
        ...options.route?.inputs,
        ...options.input,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.workCase ? { case: options.workCase } : {}),
        automation: {
          id: automation.id,
          jobId: id,
          phase,
          ...(automation.checkpoint === undefined ? {} : { checkpoint: automation.checkpoint }),
          ...(publicationKey ? { publicationKey } : {}),
        },
      }),
      runId: randomUUID(),
      status: "queued",
      priority: options.route?.priority ?? 0,
      createdAt: timestamp(this.now()),
      updatedAt: timestamp(this.now()),
      availableAt: this.now(),
      attempt: 1,
      test: options.test ?? false,
      approval: options.test
        ? "required"
        : phase === "output"
          ? config.output!.approval
          : phase === "reconcile"
            ? "automatic"
            : (options.route?.approval ?? config.policy.approval),
      publicationKey,
    });
  }
  ingest(id: string, value: unknown) {
    z.string().uuid().parse(id);
    const input = ingestSignalsSchema.parse(value);
    if (Buffer.byteLength(JSON.stringify(input)) > 512_000)
      throw new Error("Signal batch exceeds 512 KB");
    return this.serial(async () => {
      this.store.transaction(() =>
        this.intake(this.store.definition(id), input.signals, input.checkpoint),
      );
      return this.state();
    });
  }
  private intake(
    automation: Automation,
    signals: WorkSignal[],
    checkpoint?: Json,
    versionId = automation.versionId,
  ) {
    const version = this.store.version(versionId);
    for (const signal of signals) {
      const identity = signalIdentity(signal);
      if (this.store.observed(automation.id, identity)) {
        this.audit(
          automation.id,
          "duplicate",
          "Unchanged observation already recorded.",
          undefined,
          identity,
        );
        continue;
      }
      this.routeObservation(
        automation,
        version,
        {
          key: identity,
          automationId: automation.id,
          signal,
          disposition: "received",
          caseId: signalCaseId(signal),
          receivedAt: timestamp(this.now()),
          versionId,
        },
        versionId,
      );
    }
    if (checkpoint !== undefined) {
      automation.checkpoint = checkpoint;
      this.store.save(automation);
    }
  }
  private routeObservation(
    automation: Automation,
    version: AutomationVersion,
    observation: AutomationObservation,
    versionId: string,
    deferred = false,
  ) {
    const { signal } = observation;
    const route = version.config.routes.find((candidate) => matchesRoute(candidate, signal));
    let workCase = this.store.case(observation.caseId!);
    let disposition = "unmatched";
    if (route) {
      const sameRevision = workCase?.currentRevision === signal.revision;
      const stale =
        this.store.retired(observation.caseId!, signal.revision) ||
        (route.revisionPolicy === "advance" &&
          !sameRevision &&
          workCase !== undefined &&
          Date.parse(signal.observedAt) <
            Date.parse(workCase.revisionObservedAt ?? workCase.observedAt));
      if (route.revisionPolicy !== "any" && stale) disposition = "stale";
      else if (route.revisionPolicy === "current" && !sameRevision)
        disposition = "awaiting-revision";
      else {
        if (workCase && !sameRevision && route.revisionPolicy === "advance") {
          this.store.retire(workCase.id, workCase.currentRevision);
          if (version.config.policy.supersede)
            for (const pending of this.store.jobs("pending"))
              if (
                pending.caseId === workCase.id &&
                pending.revisionPolicy !== "any" &&
                pending.signal?.revision !== signal.revision &&
                ["queued", "waiting"].includes(pending.status) &&
                (!pending.runStatus || pending.runStatus === "draft")
              )
                this.change(
                  pending,
                  "cancelled",
                  "Superseded by a newer case revision before execution.",
                );
        }
        if (!workCase || route.revisionPolicy === "advance" || sameRevision) {
          workCase = {
            id: observation.caseId!,
            sourceId: signal.sourceId,
            correlationKey: signal.correlationKey ?? signal.resourceKey,
            currentRevision: signal.revision,
            observedAt:
              workCase && Date.parse(workCase.observedAt) > Date.parse(signal.observedAt)
                ? workCase.observedAt
                : signal.observedAt,
            revisionObservedAt:
              route.revisionPolicy === "advance" ? signal.observedAt : workCase?.revisionObservedAt,
            updatedAt: timestamp(this.now()),
            references: { ...workCase?.references, ...signal.references },
            payload: signal.payload,
            lastSignalKind: signal.signalKind,
            lastJobId: workCase?.lastJobId,
            lastRunId: workCase?.lastRunId,
          };
          this.store.saveCase(workCase);
        }
        if (route.target) {
          this.checkQueue(automation);
          const job = this.makeJob(automation, {
            key: `signal:${observation.key}`,
            phase: "reaction",
            targetKey: `route:${route.id}`,
            signal,
            workCase,
            route,
            versionId,
          });
          this.store.insert(job);
          this.audit(
            automation.id,
            "queued",
            `Matched route ${route.id}; ${route.revisionPolicy} revision policy.`,
            job.id,
            observation.key,
          );
          disposition = "queued";
        } else disposition = "observed";
      }
    }
    observation.disposition = disposition;
    if (deferred) this.store.updateObservation(observation);
    else this.store.observe(observation);
    this.audit(
      automation.id,
      disposition,
      route ? `Route ${route.id}: ${disposition}.` : "No deterministic route matched.",
      undefined,
      observation.key,
    );
    if (!deferred && disposition !== "awaiting-revision" && disposition !== "stale" && workCase)
      for (const pending of this.store.deferred(workCase.id)) {
        const owner = this.store.definition(pending.automationId);
        this.routeObservation(
          owner,
          this.store.version(pending.versionId),
          pending,
          pending.versionId,
          true,
        );
      }
  }
  tick() {
    if (this.ticking) return this.ticking;
    this.ticking = this.serial(async () => {
      this.error = undefined;
      for (const job of this.store.jobs("pending")) await this.reconcileRun(job);
      for (const automation of this.store.definitions()) {
        if (automation.state !== "enabled") continue;
        const due = dueFires(
          automation.config.schedule,
          automation.nextFireAt,
          this.now(),
          automation.config.policy,
        );
        if (due.next === automation.nextFireAt && !due.fires.length) continue;
        try {
          this.store.transaction(() => {
            for (const fire of due.fires) {
              const overlaps = this.store
                .jobs("pending")
                .some(
                  (job) =>
                    job.automationId === automation.id &&
                    ["direct", "discovery"].includes(job.phase),
                );
              if (automation.config.policy.overlap === "skip" && overlaps) {
                this.audit(
                  automation.id,
                  "overlap",
                  `Skipped overlapping tick ${timestamp(fire)}.`,
                );
                continue;
              }
              this.checkQueue(automation);
              const job = this.makeJob(automation, { key: `tick:${fire}` });
              this.store.insert(job);
              this.audit(automation.id, "scheduled", `Scheduled tick ${timestamp(fire)}.`, job.id);
            }
            automation.nextFireAt = due.next;
            automation.lastFireAt = due.fires.at(-1) ?? automation.lastFireAt;
            automation.error = undefined;
            this.store.save(automation);
            if (due.skipped)
              this.audit(
                automation.id,
                "missed-runs",
                `Applied bounded ${automation.config.policy.missedRuns} downtime policy.`,
              );
          });
        } catch (error) {
          const current = this.store.definition(automation.id);
          current.error = message(error);
          this.store.save(current);
        }
      }
      for (const job of this.store.jobs("all")) {
        if (job.status !== "cancelled" || job.runStatus !== "draft") continue;
        const run = this.run(job);
        if (run?.status === "draft") await this.engine.reject(run.id);
        job.runStatus = this.run(job)?.status;
        this.store.update(job);
      }
      const score = (job: AutomationJob) =>
        job.priority + Math.floor((this.now() - Date.parse(job.createdAt)) / 60_000);
      const pending = this.store
        .jobs("pending")
        .filter((job) => ["queued", "admitted"].includes(job.status))
        .sort((a, b) => score(b) - score(a) || a.createdAt.localeCompare(b.createdAt));
      for (const job of pending) await this.admit(job);
    }).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private run(job: AutomationJob) {
    const present = this.engine.list(true).some((run) => run.id === job.runId);
    return present ? this.engine.get(job.runId) : undefined;
  }
  assertRunAdmission(runId: string) {
    if (this.closed) return Promise.reject(new Error("Automations are closing"));
    const admission = this.admissions.then(() => this.reserveRunAdmission(runId));
    this.admissions = admission.then(
      () => {},
      () => {},
    );
    return admission;
  }
  private async reserveRunAdmission(runId: string) {
    const job = this.store.jobs("pending").find((candidate) => candidate.runId === runId);
    if (!job) throw new Error("Automation admission reservation is missing or terminal");
    const run = this.engine.get(runId);
    if (run.status === "draft") {
      if (!job.test && this.store.definition(job.automationId).state !== "enabled")
        throw new Error("Enable the automation before approving its job");
      if (job.availableAt > this.now()) throw new Error("The job's retry backoff has not elapsed");
      if (
        job.status === "needs_attention" ||
        (job.status === "waiting" && job.approval !== "required")
      )
        throw new Error("Resume or retry admission through the automation job controls first");
    }
    if (
      job.revisionPolicy !== "any" &&
      job.signal &&
      job.caseId &&
      this.store.retired(job.caseId, job.signal.revision)
    )
      throw new Error("This job's revision was superseded; do not execute stale work");
    const reason = await this.capacity(job, this.store.version(job.versionId));
    if (reason) throw new Error(reason);
    if (run.status === "draft" || ["paused", "pausing", "interrupted"].includes(run.status)) {
      if (job.approval === "required") job.approval = "approved";
      this.change(
        job,
        "admitted",
        "Explicit admission from the linked workflow; scheduler policy retained.",
      );
    }
  }
  private async capacity(
    job: AutomationJob,
    version: AutomationVersion,
  ): Promise<string | undefined> {
    const pending = this.store
      .jobs("pending")
      .filter(
        (candidate) =>
          candidate.id !== job.id &&
          !(job.phase === "reconcile" && candidate.id === job.parentJobId),
      );
    const activeRuns = this.engine.list().filter((run) => runActive.includes(run.status));
    if (activeRuns.some((run) => run.id !== job.runId && !this.engine.get(run.id).automation))
      return "An unmanaged workflow owns the project checkout.";
    const active = new Set(
      activeRuns
        .filter((run) => ["running", "pausing"].includes(run.status) && run.id !== job.runId)
        .map((run) => run.id),
    );
    for (const candidate of pending)
      if (computing.includes(candidate.status)) active.add(candidate.runId);
    const settings = this.store.settings();
    if (active.size >= settings.concurrency) return "Global concurrency limit reached.";
    if (
      pending.filter(
        (candidate) =>
          candidate.automationId === job.automationId &&
          (computing.includes(candidate.status) || active.has(candidate.runId)),
      ).length >= version.config.policy.concurrency
    )
      return "Automation concurrency limit reached.";
    if (
      job.caseId &&
      pending.some(
        (candidate) =>
          candidate.caseId === job.caseId &&
          (computing.includes(candidate.status) ||
            active.has(candidate.runId) ||
            ["waiting", "needs_attention"].includes(candidate.status) ||
            (candidate.phase === "output" && candidate.status === "queued")) &&
          !(candidate.status === "waiting" && candidate.reason === "Job paused before admission."),
      )
    )
      return "Another job owns this case; resolve or resume it first.";
    const execution = executionFor(version, job);
    if (execution.workspace === "project" && activeRuns.some((run) => run.id !== job.runId))
      return "Project checkout requires exclusive ownership.";
    for (const candidate of pending) {
      if (
        !computing.includes(candidate.status) &&
        !active.has(candidate.runId) &&
        !(candidate.effects === "possible" && !terminal.includes(candidate.status))
      )
        continue;
      const other = executionFor(this.store.version(candidate.versionId), candidate);
      if (execution.resources.some((resource) => other.resources.includes(resource)))
        return "A configured environment/resource is reserved by another job.";
    }
    const automation = this.store.definition(job.automationId);
    if (
      automation.lastAdmittedAt !== undefined &&
      this.now() < automation.lastAdmittedAt + version.config.policy.cooldownSeconds * 1000
    )
      return "Automation admission cooldown is active.";
    const all = this.store.jobs("all");
    let snapshot: Awaited<ReturnType<typeof readAutomationAccounting>> | undefined;
    for (const [cap, jobs, label] of [
      [settings.maxCostUsd, all, "Global"],
      [
        version.config.policy.maxCostUsd,
        all.filter((candidate) => candidate.automationId === job.automationId),
        "Automation",
      ],
    ] as const) {
      if (cap === undefined) continue;
      const accounting = (snapshot ??= await this.accounting(all));
      if (execution.maxCostUsd === undefined)
        return `${label} spending limit requires a per-job cost reservation.`;
      if (jobs.some((candidate) => accounting.get(candidate.id)!.usageIncomplete))
        return `${label} spending is incomplete because some requests have uncertain or unpriced usage.`;
      const spent = jobs.reduce(
        (sum, candidate) => sum + accounting.get(candidate.id)!.usage.costUsd,
        0,
      );
      const reserved = jobs
        .filter(
          (candidate) =>
            candidate.id !== job.id &&
            !(job.phase === "reconcile" && candidate.id === job.parentJobId) &&
            (computing.includes(candidate.status) ||
              active.has(candidate.runId) ||
              (candidate.effects === "possible" && !terminal.includes(candidate.status))),
        )
        .reduce(
          (sum, candidate) =>
            sum +
            Math.max(
              0,
              (executionFor(this.store.version(candidate.versionId), candidate).maxCostUsd ?? 0) -
                accounting.get(candidate.id)!.currentUsage.costUsd,
            ),
          0,
        );
      const remaining =
        execution.maxModelCalls === 0
          ? 0
          : Math.max(0, execution.maxCostUsd - accounting.get(job.id)!.currentUsage.costUsd);
      if (spent + reserved + remaining > cap + 1e-9)
        return `${label} spending limit exhausted or reserved by active jobs.`;
    }
    return undefined;
  }
  private async accounting(jobs: AutomationJob[]) {
    // Terminal reports were captured before releasing ownership. Do not rescan
    // every historical ledger file on each admission; retain their uncertainty.
    const live = jobs.filter((job) => !terminal.includes(job.status) || !job.usage);
    const reservedRunIds = new Set(
      live
        .filter(
          (job) => executionFor(this.store.version(job.versionId), job).maxCostUsd !== undefined,
        )
        .map((job) => job.runId),
    );
    const accounting = await readAutomationAccounting(this.engine, live, { reservedRunIds });
    for (const job of jobs)
      if (!accounting.has(job.id))
        accounting.set(job.id, {
          usage: job.usage!,
          currentUsage: this.run(job)?.usage ?? emptyUsage(),
          usageIncomplete: job.usageIncomplete || !!job.usage?.unpricedRequests,
          reports: [],
        });
    return accounting;
  }
  private async admit(job: AutomationJob) {
    if (!["queued", "admitted"].includes(job.status) || job.availableAt > this.now()) return;
    const automation = this.store.definition(job.automationId);
    if (!job.test && automation.state !== "enabled" && job.status === "queued") {
      this.change(job, "queued", `Automation is ${automation.state}.`);
      return;
    }
    const version = this.store.version(job.versionId);
    const existing = this.run(job);
    if (existing && existing.status !== "draft") {
      await this.reconcileRun(job);
      return;
    }
    if (
      job.signal &&
      job.caseId &&
      job.revisionPolicy !== "any" &&
      version.config.policy.supersede &&
      this.store.retired(job.caseId, job.signal.revision)
    ) {
      this.change(job, "cancelled", "Superseded before admission by a newer revision.");
      return;
    }
    if (!job.test) {
      const reason = await this.capacity(job, version);
      if (reason) {
        this.change(job, "queued", reason);
        return;
      }
    }
    try {
      const execution = executionFor(version, job);
      if (!job.prepared) {
        if (job.caseId) {
          const workCase = this.store.case(job.caseId);
          if (workCase) job.input.case = jsonValue(workCase);
          job.input.prior = this.store
            .jobs("all")
            .filter(
              (prior) =>
                prior.caseId === job.caseId &&
                prior.id !== job.id &&
                terminal.includes(prior.status),
            )
            .slice(-5)
            .map((prior) => ({
              jobId: prior.id,
              runId: prior.runId,
              status: prior.status,
              ...(prior.result === undefined ? {} : { result: prior.result }),
            }));
          if (JSON.stringify(job.input.prior).length > 128_000)
            job.input.prior = this.store
              .jobs("all")
              .filter((prior) => prior.caseId === job.caseId && terminal.includes(prior.status))
              .slice(-5)
              .map((prior) => ({ jobId: prior.id, runId: prior.runId, status: prior.status }));
        }
        const previousRunId =
          job.phase === "reconcile"
            ? undefined
            : job.parentJobId
              ? this.store.job(job.parentJobId).runId
              : job.phase === "reaction" && job.caseId
                ? this.store.case(job.caseId)?.lastRunId
                : undefined;
        if (previousRunId && previousRunId !== job.runId) {
          const previous = this.engine.get(previousRunId);
          if (previous.automation?.automationId === job.automationId) {
            job.previousRunId = previousRunId;
            job.input.continuation = jsonValue({
              runId: previousRunId,
              workspace: { root: previous.automation.root, branch: previous.automation.branch },
            });
          }
        }
        job.prepared = true;
        this.change(
          job,
          "admitted",
          "Reserved stable run identity and resource policy before dispatch.",
        );
      }
      const template = version.templates[job.targetKey];
      if (!template) throw new Error("Frozen target is missing");
      const run = await this.engine.createAutomatedRun(template, job.runId, job.input, {
        automationId: job.automationId,
        jobId: job.id,
        workspace: execution.workspace,
        baseRef: execution.baseRef,
        previousRunId: job.previousRunId,
        execution,
      });
      job.workspace = run.automation?.root;
      job.runStatus = run.status;
      if (run.deletedAt) {
        this.change(job, "cancelled", "Reserved run was removed.");
        return;
      }
      if (run.status === "draft" && job.approval === "required") {
        this.change(job, "waiting", "Approval required for this frozen target.");
        return;
      }
      if (run.status === "draft") await this.engine.approve(run.id, run.revision);
      job.effects = "possible";
      this.store.transaction(() => {
        this.change(job, "running");
        automation.lastAdmittedAt = this.now();
        this.store.save(automation);
      });
    } catch (error) {
      const observed = this.run(job);
      if (observed && observed.status !== "draft") {
        await this.reconcileRun(job);
        return;
      }
      this.change(
        job,
        "needs_attention",
        `Admission did not finish: ${message(error)}. Stable reservation retained; retry admission only after inspection.`,
      );
    }
  }
  private async reconcileRun(job: AutomationJob) {
    const run = this.run(job);
    if (!run) return;
    const beforeStatus = job.runStatus;
    job.runStatus = run.status;
    const accounting = (await this.accounting([job])).get(job.id)!;
    job.usage = accounting.usage;
    job.usageIncomplete = accounting.usageIncomplete;
    if (run.status === "draft") {
      if (job.status === "running")
        this.change(
          job,
          "admitted",
          "Recovered a reservation whose Temporal start was not acknowledged.",
        );
      else if (beforeStatus !== run.status) this.store.update(job);
      return;
    }
    if (runActive.includes(run.status)) {
      job.effects = "possible";
      this.change(
        job,
        run.status === "interrupted"
          ? "needs_attention"
          : run.status === "paused"
            ? "waiting"
            : "running",
        run.status === "interrupted"
          ? "Execution interrupted; inspect recovery evidence before explicit resume."
          : run.status === "paused"
            ? "Run paused; case/workspace retained, compute slot released."
            : undefined,
      );
      return;
    }
    if (terminal.includes(job.status)) return;
    const version = this.store.version(job.versionId);
    if (run.status !== "completed") {
      if (
        (job.phase === "discovery" || job.phase === "direct") &&
        run.status === "failed" &&
        version.config.policy.retry.safe === "read-only" &&
        job.attempt < version.config.policy.retry.maxAttempts
      ) {
        const backoff = version.config.policy.retry.backoffSeconds * 1000 * 2 ** (job.attempt - 1);
        const jitter =
          0.8 + (Number.parseInt(hash([job.id, job.attempt]).slice(0, 4), 16) / 65535) * 0.4;
        job.priorRunIds.push(job.runId);
        job.runId = randomUUID();
        job.runStatus = undefined;
        job.attempt++;
        job.availableAt = this.now() + Math.min(3_600_000, backoff * jitter);
        job.effects = "none";
        this.change(
          job,
          "queued",
          "Explicitly read-only target failed; bounded backoff before a new attempt.",
        );
      } else {
        const uncertain =
          run.status !== "rejected" &&
          (job.phase === "output" ||
            (run.status === "failed" &&
              !(
                ["direct", "discovery"].includes(job.phase) &&
                version.config.policy.retry.safe === "read-only"
              )));
        this.change(
          job,
          uncertain
            ? "needs_attention"
            : run.status === "cancelled" || run.status === "rejected"
              ? "cancelled"
              : "failed",
          uncertain
            ? "Execution stopped with potentially mutating effects. Inspect evidence or reconcile the stable publication key; never retry blindly."
            : (run.error ?? `Run ${run.status}.`),
        );
      }
      return;
    }
    try {
      const result = machineResult(run);
      this.store.transaction(() => {
        const automation = this.store.definition(job.automationId);
        job.result = result;
        job.effects = "reconciled";
        if (!job.test) {
          if (job.phase === "discovery") {
            const scan = discoveryResultSchema.parse(result);
            this.intake(automation, scan.signals, scan.checkpoint, job.versionId);
          } else if (
            result &&
            typeof result === "object" &&
            !Array.isArray(result) &&
            "signals" in result
          ) {
            const scan = discoveryResultSchema.parse({ signals: result.signals });
            this.intake(automation, scan.signals, undefined, job.versionId);
          }
          if (job.phase === "reconcile" && job.parentJobId) {
            const outcome = z
              .object({ published: z.boolean(), reference: z.string().optional() })
              .parse(result);
            const publication = this.store.job(job.parentJobId);
            if (outcome.published) {
              publication.effects = "reconciled";
              publication.result = result;
              this.change(
                publication,
                "completed",
                "Remote outcome found by reconciliation; no publication replayed.",
              );
            } else
              this.change(
                publication,
                "needs_attention",
                "Reconciliation did not find a publication. Human confirmation is still required before any new write.",
              );
          }
          if (version.config.output && ["direct", "reaction"].includes(job.phase)) {
            this.checkQueue(automation, true);
            const output = this.makeJob(automation, {
              key: `output:${job.id}`,
              phase: "output",
              targetKey: "output",
              parent: job,
              signal: job.signal,
              versionId: job.versionId,
              workCase: job.input.case ? automationCaseSchema.parse(job.input.case) : undefined,
              input: {
                result: result ?? null,
                run: { id: run.id, status: run.status, artifacts: run.artifacts },
              },
            });
            this.store.insert(output);
            this.audit(
              job.automationId,
              "output",
              "Reserved configured output target with stable publication key.",
              output.id,
            );
          }
        }
        if (job.caseId) {
          const workCase = this.store.case(job.caseId);
          if (workCase) {
            workCase.lastJobId = job.id;
            workCase.lastRunId = run.id;
            workCase.updatedAt = timestamp(this.now());
            this.store.saveCase(workCase);
          }
        }
        this.change(job, "completed");
      });
    } catch (error) {
      this.change(
        job,
        "needs_attention",
        `Completed run result requires attention: ${message(error)}. Checkpoint and result delivery not advanced.`,
      );
    }
  }
  jobAction(id: string, value: AutomationJobAction) {
    z.string().uuid().parse(id);
    const action = automationJobActionSchema.parse(value);
    return this.serial(async () => {
      const job = this.store.job(id);
      const run = this.run(job);
      if (action === "cleanup") {
        if (!terminal.includes(job.status))
          throw new Error("Only terminal jobs can release their workspace");
        const ids = new Set([...job.priorRunIds, job.runId]);
        if (
          this.store.retainedByCase(ids) ||
          this.store
            .jobs("pending")
            .some(
              (candidate) =>
                candidate.parentJobId === job.id ||
                (candidate.previousRunId && ids.has(candidate.previousRunId)),
            )
        )
          throw new Error("Workspace is retained for a case continuation or dependent job");
        for (const runId of ids)
          if (this.engine.list(true).some((value) => value.id === runId))
            await this.engine.cleanupAutomationWorkspace(runId);
        this.audit(
          job.automationId,
          "cleanup",
          "Clean owned workspaces for all attempts released; execution evidence retained.",
          job.id,
        );
      } else if (action === "cancel") {
        if (terminal.includes(job.status)) throw new Error("Job is already terminal");
        const accounting = (await this.accounting([job])).get(job.id)!;
        job.usage = accounting.usage;
        job.usageIncomplete = accounting.usageIncomplete;
        if (run && runActive.includes(run.status)) {
          await this.engine.cancel(run.id);
          this.change(
            job,
            "running",
            "Cancellation requested; ownership retained until execution stops.",
          );
        } else {
          if (run?.status === "draft") await this.engine.reject(run.id);
          this.change(job, "cancelled", "Cancelled by user.");
        }
      } else if (action === "pause") {
        if (run?.status === "running") {
          await this.engine.pause(run.id);
          this.change(
            job,
            "running",
            "Pause requested; compute slot retained until execution stops.",
          );
        } else if (job.status === "queued")
          this.change(job, "waiting", "Job paused before admission.");
        else throw new Error("Only queued or running jobs can be paused");
      } else if (action === "approve") {
        if (job.approval !== "required" || job.status !== "waiting")
          throw new Error("This job is not awaiting approval");
        job.approval = "approved";
        this.change(job, "queued", "Explicitly approved by user.");
        await this.admit(job);
      } else if (action === "resume") {
        if (run && ["paused", "interrupted"].includes(run.status)) {
          const reason = await this.capacity(job, this.store.version(job.versionId));
          if (reason) throw new Error(reason);
          await this.engine.resume(run.id);
          this.change(job, "running", "Explicit resume after inspection.");
        } else if (job.status === "waiting" && job.approval !== "required") {
          this.change(job, "queued");
          await this.admit(job);
        } else throw new Error("This job cannot be resumed");
      } else if (action === "retry") {
        if (run && run.status !== "draft")
          throw new Error(
            "Never blindly retry executed jobs. Resume interrupted execution or reconcile its result.",
          );
        if (job.status !== "needs_attention")
          throw new Error("Only failed admission can be retried");
        this.change(job, "queued", "Retrying the same stable admission reservation.");
        await this.admit(job);
      } else if (action === "reconcile") {
        if (job.status !== "needs_attention")
          throw new Error("Only jobs needing attention can be reconciled");
        if (job.phase !== "output") {
          await this.reconcileRun(job);
        } else {
          const version = this.store.version(job.versionId);
          if (!version.templates.reconcile)
            throw new Error(
              "No reconciliation target configured; inspect the remote outcome and explicitly resolve instead",
            );
          if (
            this.store
              .jobs("pending")
              .some(
                (candidate) => candidate.phase === "reconcile" && candidate.parentJobId === job.id,
              )
          )
            throw new Error("Reconciliation is already pending");
          const automation = this.store.definition(job.automationId);
          this.checkQueue(automation, true);
          if (run && ["interrupted", "paused"].includes(run.status))
            await this.engine.cancel(run.id);
          const reconciliation = this.makeJob(automation, {
            key: `reconcile:${job.id}:${randomUUID()}`,
            phase: "reconcile",
            targetKey: "reconcile",
            parent: job,
            versionId: job.versionId,
            input: {
              ...job.input,
              publication: { jobId: job.id, runId: job.runId, key: job.publicationKey! },
            },
          });
          // Reconciliation is read-only and must run despite its uncertain parent retaining the case.
          reconciliation.caseId = undefined;
          this.store.insert(reconciliation);
          this.audit(
            job.automationId,
            "reconcile",
            "Reserved read-only reconciliation target; no publication replay.",
            reconciliation.id,
          );
        }
      } else {
        if (job.status !== "needs_attention" || (run && runActive.includes(run.status)))
          throw new Error("Only stopped jobs needing attention can be explicitly resolved");
        job.effects = "reconciled";
        this.change(
          job,
          "completed",
          "User explicitly confirmed external outcome; no execution replayed.",
        );
      }
      return this.store.job(id);
    });
  }
}
