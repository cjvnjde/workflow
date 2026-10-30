import { codeBundle } from "./code-migration.js";
import { formatCode } from "./source-format.js";
import { z } from "zod";
import { budgetSchema } from "./domain.js";
import { WorkflowEngine } from "./engine.js";
import { loadLibrary } from "./library.js";
import { createTemplate } from "./templates.js";
import { createAiPlan } from "./planner.js";
import { availableModels } from "./available-models.js";
import { generateLibraryChanges } from "./library-generator.js";
import { DesignChats } from "./design-chats.js";
import { designSettings } from "./settings-designer.js";
import { designScopeSchema } from "./design-schema.js";
import { libraryHash, LibraryProposals } from "./library-proposals.js";
import { libraryChangesSchema, modelKey } from "./library-editor-schema.js";
import { providerStatus } from "./provider-status.js";
import { executionSettings, updateExecutionSettings, projectModelSettings, updateProjectModel } from "./project-model.js";
import { BrowserAuth } from "./browser-auth.js";
import { loadOrchestration, saveOrchestration } from "./orchestration-settings.js";
import { Attachments } from "./attachments.js";
import { Tasks } from "./tasks.js";
import { planTask } from "./task-planner.js";
import { mcpServerSchema } from "./capability-schema.js";
import { inspectMcp } from "./mcp-tools.js";
import { createProgramSchema } from "./contracts.js";
import { refineProgram } from "./program-refiner.js";
import { createAccountingContext } from "./usage-store.js";
import { Triggers } from "./triggers.js";
import type { GithubTriggerSource } from "./github-trigger-source.js";

import { realpath } from "node:fs/promises";
import { runDemoBlock, runPiBlock, type BlockRunner } from "./block-runner.js";
import type { TemporalOptions } from "./temporal-runtime.js";
import type { ExecutionEnvironmentFactory } from "./execution-environment.js";
export type { ExecutionEnvironmentFactory, EnvironmentOptions } from "./execution-environment.js";
export { localExecutionEnvironment } from "./execution-environment.js";
const proposalSchema = z
  .object({
    task: z.string().trim().min(1).max(32_000),
    strategy: z.enum(["bug", "feature", "ai"]).default("feature"),
    instructions: z.string().max(8000).default(""),
    autoApprove: z.boolean().default(false),
    maxCostUsd: z.number().positive().optional(),
    maxTaskCostUsd: z.number().positive().optional(),
  })
  .strict();

export interface ApplicationServices {
  triggerSource?: GithubTriggerSource;
  startTriggers?: boolean;
  catalog?: typeof availableModels;
  generateLibrary?: typeof generateLibraryChanges;
  plan?: typeof createAiPlan;
  providers?: typeof providerStatus;
  auth?: BrowserAuth;
  taskPlanner?: typeof planTask;
  design?: typeof designSettings;
}

/** Attach services to an initialized engine; close() owns their shutdown. */
export async function attachApplication(engine: WorkflowEngine, services: ApplicationServices = {}) {
  const planning = new AbortController();
  const jobs = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  let planningActive = false;
  const proposals = new LibraryProposals(engine.project);
  const catalog = services.catalog ?? availableModels;
  const planWithAi = services.plan ?? createAiPlan;
  const generateLibrary = services.generateLibrary ?? generateLibraryChanges;
  const providers = services.providers ?? providerStatus;
  const auth = services.auth ?? new BrowserAuth();
  const attachments = new Attachments(engine.project);
  const tasks = new Tasks(engine, catalog, services.taskPlanner);
  const triggers = await Triggers.open(engine, services.triggerSource).catch(error => { auth.close(); throw error; });
  const designChats = new DesignChats(engine.project, catalog, services.design, proposals, async (resource, id) => {
    if (resource === "tasks") return tasks.list();
    if (resource === "runs") return engine.list();
    if (!id) throw new Error("An ID is required");
    if (resource === "task") return tasks.get(id);
    if (resource === "events") return await engine.events(id);
    return engine.get(id);
  });
  try {
    await tasks.initialize();
    await designChats.initialize();
  } catch (error) {
    auth.close();
    planning.abort(error);
    await Promise.allSettled([tasks.close(), designChats.close(), triggers.close()]);
    throw error;
  }
  const emit = (kind: string, message: string) => { engine.coordinatorActivity(kind, message); };
  const operation = <T>(action: () => Promise<T>): Promise<T> => {
    planning.signal.throwIfAborted();
    const job = Promise.resolve().then(() => { planning.signal.throwIfAborted(); return action(); });
    jobs.add(job);
    void job.then(() => jobs.delete(job), () => jobs.delete(job));
    return job;
  };
  const planningJob = <T>(action: () => Promise<T>): Promise<T> => operation(async () => {
    if (planningActive) throw new Error("A coordinator proposal is already in progress");
    planningActive = true;
    try { return await action(); } finally { planningActive = false; }
  });
  const signalFor = (signal?: AbortSignal) => signal
    ? AbortSignal.any([planning.signal, signal]) : planning.signal;
  if (services.startTriggers !== false) triggers.start();
  return {
    engine,
    tasks,
    triggers,
    designChats,
    attachments,
    auth,
    get project() { return engine.project; },
    get mode() { return engine.mode; },
    subscribe: engine.subscribe.bind(engine),
    listRuns: (includeDeleted = true) => engine.list(includeDeleted),
    getRun: (id: string) => engine.get(id),
    events: (id: string) => engine.events(id),
    approve: (id: string, revision?: number) => operation(() => engine.approve(id, revision)),
    reject: (id: string) => operation(() => engine.reject(id)),
    pause: (id: string) => operation(() => engine.pause(id)),
    resume: (id: string) => operation(() => engine.resume(id)),
    cancel: (id: string) => operation(() => engine.cancel(id)),
    recover: (id: string) => operation(async () => (await engine.recover(id)).run),
    keepRecoveryFiles: (id: string) => operation(() => engine.keepRecoveryFiles(id)),
    removeRun: (id: string) => operation(() => tasks.removeRun(id)),
    updatePlan: (id: string, value: unknown, revision?: number) => operation(() => engine.update(id, value, revision)),
    updateProgram: (id: string, value: unknown, revision?: number) => operation(() => engine.updateProgram(id, value, revision, planning.signal)),
    getProject: async () => ({ project: engine.project, mode: engine.mode, ...(await loadLibrary(engine.project)) }),
    models: () => catalog(planning.signal),
    refreshModels: () => planningJob(() => catalog(planning.signal, true)),
    orchestration: () => loadOrchestration(engine.project),
    updateOrchestration: (value: unknown) => planningJob(async () => saveOrchestration(engine.project, value, (await catalog(planning.signal)).models)),
    executionSettings: () => executionSettings(engine.project),
    updateExecutionSettings: (value: unknown) => planningJob(() => updateExecutionSettings(engine.project, value)),
    setup: async () => ({ ...(await projectModelSettings(engine.project)), providers: await providers(planning.signal) }),
    usage: () => engine.usage.report(),
    taskUsage: (id: string) => { tasks.get(id); return engine.usage.report({ taskId: id }); },
    runUsage: (id: string) => { engine.get(id); return engine.usage.report({ runId: id }); },
    updateProjectModel: (value: unknown) => planningJob(async () => ({
      ...(await updateProjectModel(engine.project, value, (await catalog(planning.signal)).models)),
      providers: await providers(planning.signal),
    })),
    inspectMcp: async (value: unknown, signal?: AbortSignal) => ({ tools: await inspectMcp(
      mcpServerSchema.parse(value), engine.project, AbortSignal.any([signalFor(signal), AbortSignal.timeout(20_000)]),
    ) }),
    latestDesign: (scope: unknown) => designChats.latest(designScopeSchema.parse(scope)),
    applyDesign: (id: string, value: unknown) => planningJob(() => designChats.apply(id, value)),
    format: (body: unknown) => {
      const value = z.object({ source: z.string().max(256_000), language: z.enum(["typescript", "javascript", "json"]),
        cursorOffset: z.number().int().nonnegative().optional(),
      }).strict().parse(body);
      return formatCode(value.source, value.language, value.cursorOffset);
    },
    library: async () => {
      const library = await loadLibrary(engine.project);
      return { revision: libraryHash(library), blocks: library.blocks,
        codeBlocks: Object.fromEntries(Object.entries(library.blocks).map(([id, bundle]) => [id, codeBundle(bundle, library.config.commands)])) };
    },
    removeBlock: (id: string, value: unknown) => planningJob(() => {
      const input = z.object({ revision: z.string() }).strict().parse(value);
      return proposals.removeBlock(id, input.revision);
    }),
    getProposal: (id: string) => proposals.get(id),
    applyProposal: (id: string) => planningJob(async () => proposals.apply(id, (await catalog(planning.signal)).models)),
    rejectProposal: (id: string) => planningJob(() => proposals.reject(id)),
    createProposal: async (value: unknown) => {
      const input = z.object({
        kind: z.enum(["regenerate", "models", "manual"]), instructions: z.string().max(8000).default(""),
        allowedModels: z.array(z.string()).max(1000).default([]), changes: libraryChangesSchema.optional(),
        baseHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      }).strict().parse(value);
      return await planningJob(async () => {
        const library = await loadLibrary(engine.project);
        if (input.baseHash && input.baseHash !== libraryHash(library)) { throw new Error("The block library changed in another session. Reload blocks before saving your edits."); }
        const current = await catalog(planning.signal);
        const models = input.allowedModels.length ? current.models.filter((model) => input.allowedModels.includes(modelKey(model))) : current.models;
        if (input.allowedModels.some((key) => !current.models.some((model) => modelKey(model) === key))) { throw new Error("The allowed model list contains an unavailable model. Refresh models and try again."); }
        if (input.kind !== "manual" && engine.mode !== "live") { throw new Error("AI block generation needs live mode"); }
        const changes = input.kind === "manual" ? input.changes : await generateLibrary({
          project: engine.project, library, kind: input.kind, models, instructions: input.instructions, signal: planning.signal, emit,
        });
        return await proposals.create(library, input.kind, changes, models);
      });
    },
    createProgram: (value: unknown, cancellation?: AbortSignal) => operation(async () => {
      const { title, task, ...program } = createProgramSchema.parse(value);
      return engine.createProgram(title, task, program, await loadLibrary(engine.project), signalFor(cancellation));
    }),
    createRun: (value: unknown, cancellation?: AbortSignal) => {
      const proposal = proposalSchema.parse(value);
      const signal = signalFor(cancellation);
      return planningJob(async () => {
        signal.throwIfAborted();
        const library = await loadLibrary(engine.project);
        if (proposal.maxCostUsd !== undefined) {
          library.config.budget = budgetSchema.parse({ ...library.config.budget, maxCostUsd: proposal.maxCostUsd });
        }
        if (proposal.maxTaskCostUsd !== undefined) library.config.budget = budgetSchema.parse({ ...library.config.budget, maxTaskCostUsd: proposal.maxTaskCostUsd });
        const accounting = proposal.strategy === "ai" ? await createAccountingContext(engine.project, "planning", { maxCostUsd: library.config.budget?.maxTaskCostUsd }) : undefined;
        if (proposal.strategy === "ai" && engine.mode === "demo") {
          throw new Error(
            "AI coordination needs live mode. Demo supports bug and feature templates.",
          );
        }
        const plan =
          proposal.strategy === "ai"
            ? await planWithAi({
                project: engine.project,
                library,
                accounting,
                task: proposal.task,
                instructions: proposal.instructions,
                emit: (kind, message) => {
                  engine.coordinatorActivity(kind, message);
                },
                signal,
                models: (await catalog(signal)).models,
              })
            : createTemplate(proposal.task, proposal.strategy, library);
        signal.throwIfAborted();
        const run = await engine.create(plan, library, accounting ? { scopeId: accounting.scopeId } : undefined);
        if (signal.aborted) {
          await engine.remove(run.id);
          signal.throwIfAborted();
        }

        return proposal.autoApprove ? await engine.approve(run.id) : run;
      });
    },
    refine: (id: string, value: unknown, revision?: number, cancellation?: AbortSignal) => {
      const input = z.object({ instructions: z.string().min(1).max(8000) }).strict().parse(value);
      if (engine.mode !== "live") throw new Error("AI workflow refinement needs live mode");
      const signal = signalFor(cancellation);
      return planningJob(async () => {
        const run = engine.get(id);
        if (run.status !== "draft") { throw new Error("Only draft workflows can be refined"); }
        if (revision !== undefined && run.revision !== revision) { throw new Error("Draft changed since you loaded it. Review the latest draft and try again."); }
        const accounting = await createAccountingContext(engine.project, "refinement", { scopeId: (await engine.usage.ensureRun(run)).id, runId: run.id });
        if (run.program && run.program.composition !== "graph") {
          const program = await refineProgram({ project: engine.project, run, accounting, instructions: input.instructions,
            models: (await catalog(signal)).models, signal, emit });
          signal.throwIfAborted();
          return await engine.updateProgram(run.id, program, run.revision, signal);
        }
        const plan = await planWithAi({
          project: engine.project, library: { config: run.config, blocks: run.blocks }, task: run.plan.task,
          previousPlan: run.plan, instructions: input.instructions, signal, emit,
          accounting,
          models: (await catalog(signal)).models,
        });
        signal.throwIfAborted();
        if (plan.task !== run.plan.task) { throw new Error("AI refinement must preserve the task"); }
        return await engine.update(run.id, plan, run.revision);
      });
    },
    close: () => closing ??= (async () => {
      auth.close();
      planning.abort(new Error("Application closing"));
      try {
        await Promise.allSettled([...jobs, tasks.close(), designChats.close(), triggers.close()]);
      } finally { await engine.shutdown(); }
    })(),
  };
}

export type WorkflowApplication = Awaited<ReturnType<typeof attachApplication>>;

export interface ApplicationOptions extends ApplicationServices {
  project: string;
  mode?: "demo" | "live";
  runner?: BlockRunner;
  temporal?: TemporalOptions;
  environment?: ExecutionEnvironmentFactory;
}

/** Own one engine and its project lease. No HTTP listener, DOM, or GUI is created. */
export async function createApplication(options: ApplicationOptions): Promise<WorkflowApplication> {
  const project = await realpath(options.project);
  await loadLibrary(project);
  const mode = options.mode ?? "live";
  const engine = new WorkflowEngine(project, mode, options.runner ?? (mode === "demo" ? runDemoBlock : runPiBlock), options.temporal, options.environment);
  try {
    await engine.initialize();
    return await attachApplication(engine, options);
  } catch (error) {
    await engine.shutdown();
    throw error;
  }
}
