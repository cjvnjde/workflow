import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "../../infrastructure/atomic-file.js";
import { availableModels } from "../models/available-models.js";
import { bundleSchema, configSchema, resolveAgentSettings } from "../../contracts/domain.js";
import { designProposalSchema } from "../../contracts/design-schema.js";
import { availableModelSchema } from "../../contracts/library-editor-schema.js";
import { validateLibraryChanges, validateModelChoice } from "../library/library-proposals.js";
import { orchestrationSchema } from "../../contracts/orchestration-schema.js";
import { validateCodeBlocks } from "../planning/program-compiler.js";
import { designSettings, validateDesign, type DesignOptions } from "../design/settings-designer.js";
import {
  publishSetup,
  readSetupPublication,
  readSetupSnapshot,
  type SetupPublicationReceipt,
} from "../settings/settings-publication.js";
import {
  completedSetupSchema,
  resumeSetupSchema,
  setupJobActionSchema,
  setupJobSchema,
  setupModelSchema,
  setupStageIdSchema,
  startSetupSchema,
  type CompletedSetup,
  type SetupJob,
} from "../../contracts/setup-job-schema.js";
import { setupInstructions } from "./setup-generation.js";
import { createAccountingContext, UsageStore } from "../storage/usage-store.js";

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const active = new Set<SetupJob["status"]>(["queued", "running", "cancelling"]);
const stageIds = setupStageIdSchema.options;
const recordSchema = setupJobSchema.omit({ actions: true }).extend({
  base: z.object({
    libraryHash: z.string(),
    configRevision: z.string(),
    orchestrationRevision: z.string(),
  }),
  library: z.object({ config: configSchema, blocks: z.record(z.string(), bundleSchema) }),
  settings: orchestrationSchema,
  models: z.array(availableModelSchema),
  modelOverride: setupModelSchema.optional(),
  accepted: z.object({
    profiles: designProposalSchema.optional(),
    cases: designProposalSchema.optional(),
    blocks: designProposalSchema.optional(),
  }),
});
type SetupRecord = z.infer<typeof recordSchema>;
export interface SetupJobServices {
  catalog?: typeof availableModels;
  design?: typeof designSettings;
  snapshot?: typeof readSetupSnapshot;
  publish?: typeof publishSetup;
  publication?: typeof readSetupPublication;
}
const markerSchema = z.object({
  version: z.literal(1),
  completedAt: z.string(),
  model: setupModelSchema,
  libraryProposalId: z.string().uuid(),
  usageScopeId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  generationId: z.string().optional(),
  counts: completedSetupSchema.shape.counts,
});

/** One core-owned setup job; clients attach without owning its cancellation. */
export class SetupJobs {
  private readonly records = new Map<string, SetupRecord>();
  private readonly jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly writes = new Map<string, Promise<void>>();
  private mutations = Promise.resolve();
  private readonly stopping = new AbortController();
  private closed = false;
  constructor(
    private readonly project: string,
    private readonly services: SetupJobServices = {},
    private readonly emit: (kind: string, message: string) => void = () => {},
  ) {}
  private filename(id: string) {
    return path.join(this.project, ".workflow/setup-jobs", `${z.string().uuid().parse(id)}.json`);
  }
  private exclusive<T>(action: () => Promise<T>) {
    const next = this.mutations.then(action);
    this.mutations = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private async save(record: SetupRecord) {
    const snapshot = structuredClone(record);
    return this.write(record.id, () => snapshot);
  }
  private async write(id: string, update: (current: SetupRecord | undefined) => SetupRecord) {
    const next = (this.writes.get(id) ?? Promise.resolve()).then(async () => {
      const record = update(this.records.get(id) && structuredClone(this.records.get(id)!));
      record.revision = (this.records.get(id)?.revision ?? record.revision) + 1;
      record.updatedAt = new Date().toISOString();
      const saved = recordSchema.parse(record);
      await atomicWrite(this.filename(id), JSON.stringify(saved));
      this.records.set(id, structuredClone(saved));
      this.emit(
        "setup_state",
        JSON.stringify({ id, revision: saved.revision, status: saved.status, stage: saved.stage }),
      );
    });
    this.writes.set(
      id,
      next.catch(() => {}),
    );
    await next;
  }
  private async marker() {
    try {
      return markerSchema.parse(
        JSON.parse(await readFile(path.join(this.project, ".workflow/setup.json"), "utf8")),
      );
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  async completed(): Promise<CompletedSetup | null> {
    const marker = await this.marker();
    return marker
      ? completedSetupSchema.parse({
          completedAt: marker.completedAt,
          model: marker.model,
          libraryProposalId: marker.libraryProposalId,
          jobId: marker.jobId,
          generationId: marker.generationId,
          counts: marker.counts,
        })
      : null;
  }
  async initialize() {
    const directory = path.dirname(this.filename(randomUUID()));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(directory, ".gitignore"), "*\n");
    for (const filename of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(filename)) continue;
      const record = recordSchema.parse(
        JSON.parse(await readFile(path.join(directory, filename), "utf8")),
      );
      if (`${record.id}.json` !== filename)
        throw new Error("Setup identity does not match its storage path");
      this.records.set(record.id, record);
      const receipt =
        record.stage === "applying" && record.status !== "completed"
          ? await (this.services.publication ?? readSetupPublication)(this.project, record.id)
          : null;
      if (receipt) {
        await this.finish(record, receipt);
        continue;
      }
      if (active.has(record.status)) {
        record.status = "interrupted";
        record.error =
          "The host stopped during setup. Resume explicitly to continue from the saved stage.";
        const stage = record.stages.find((stage) => stage.id === record.stage)!;
        if (stage.status === "running") stage.status = "interrupted";
        await this.save(record);
      }
    }
  }
  get(id: string): SetupJob {
    const value = this.records.get(z.string().uuid().parse(id));
    if (!value) throw new Error("Setup job not found");
    const {
      base: _base,
      library: _library,
      settings: _settings,
      models: _models,
      accepted: _accepted,
      modelOverride: _override,
      ...job
    } = structuredClone(value);
    return setupJobSchema.parse({
      ...job,
      actions: {
        canResume:
          !this.closed &&
          !this.jobs.has(id) &&
          ["failed", "cancelled", "interrupted"].includes(job.status),
        canCancel:
          !this.closed &&
          this.jobs.has(id) &&
          job.stage !== "applying" &&
          ["queued", "running"].includes(job.status),
      },
    });
  }
  latest() {
    const latest = [...this.records.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )[0];
    return { job: latest ? this.get(latest.id) : null };
  }
  usage(id: string) {
    return new UsageStore(this.project).report({ scopeId: this.get(id).usageScopeId });
  }
  async start(value: unknown = {}): Promise<SetupJob> {
    const input = startSetupSchema.parse(value);
    return this.exclusive(async () => {
      if (this.closed) throw new Error("Host is shutting down");
      const current = [...this.records.values()].find(
        (job) =>
          active.has(job.status) ||
          (job.stage === "applying" &&
            job.status !== "completed" &&
            !job.conflict?.requiresRegeneration),
      );
      if (current) {
        if (
          (input.model &&
            (input.model.provider !== current.model.provider ||
              input.model.model !== current.model.model ||
              (input.model.thinking && input.model.thinking !== current.model.thinking))) ||
          (input.instructions && input.instructions !== current.instructions) ||
          (input.maxSetupCostUsd !== undefined && input.maxSetupCostUsd !== current.maxSetupCostUsd)
        ) {
          throw new Error(
            `Setup ${current.id} already owns this project. Its model and instructions are frozen; attach or cancel it before starting another setup.`,
          );
        }
        return this.get(current.id);
      }
      const latest = this.latest().job;
      if (latest && !input.regenerate) return latest;
      const snapshot = await (this.services.snapshot ?? readSetupSnapshot)(this.project);
      const completed = await this.marker();
      if (completed && !input.regenerate) {
        // Import the previous synchronous setup marker without repeating paid work.
        const id = completed.jobId ?? randomUUID(),
          now = new Date().toISOString();
        const usageScopeId = completed.usageScopeId ?? id;
        await new UsageStore(this.project).ensureScope({
          id: usageScopeId,
          owner: { kind: "setup", id },
        });
        const record = recordSchema.parse({
          id,
          usageScopeId,
          revision: 0,
          createdAt: completed.completedAt,
          updatedAt: now,
          status: "completed",
          stage: "applying",
          model: completed.model,
          instructions: "",
          stages: stageIds.map((id) => ({
            id,
            status: "completed",
            attempt: 0,
            completedAt: completed.completedAt,
          })),
          result: {
            ...(completed.counts ?? {
              profiles: snapshot.orchestration.settings.profiles.length,
              cases: snapshot.orchestration.settings.cases.length,
              blocks: Object.keys(snapshot.library.blocks).length,
            }),
            completedAt: completed.completedAt,
            generationId: completed.generationId ?? completed.libraryProposalId,
          },
          base: {
            libraryHash: snapshot.libraryHash,
            configRevision: snapshot.configRevision,
            orchestrationRevision: snapshot.orchestration.revision,
          },
          library: snapshot.library,
          settings: snapshot.orchestration.settings,
          models: [],
          accepted: {},
        });
        await this.save(record);
        return this.get(id);
      }
      const catalog = await (this.services.catalog ?? availableModels)(
        AbortSignal.any([this.stopping.signal, AbortSignal.timeout(30_000)]),
        true,
      );
      if (!catalog.models.length)
        throw new Error(
          "No connected provider. Run workflow login, choose workflow model, then resume setup.",
        );
      const selected = input.model ?? snapshot.library.config.agent;
      if (!selected.provider || !selected.model)
        throw new Error(
          "Choose a default model first with workflow model, workflow setup --model provider/model-id, or Settings → Providers & models.",
        );
      const choice = catalog.models.find(
        (item) => item.provider === selected.provider && item.id === selected.model,
      );
      const model = setupModelSchema.parse({
        provider: selected.provider,
        model: selected.model,
        thinking:
          selected.thinking ??
          (choice?.thinkingLevels.includes("medium")
            ? "medium"
            : (choice?.thinkingLevels[0] ?? "off")),
      });
      validateModelChoice(
        resolveAgentSettings(snapshot.library.config.agent, model),
        catalog.models,
      );
      if (this.closed) throw new Error("Host is shutting down");
      const id = randomUUID(),
        now = new Date().toISOString();
      const maxSetupCostUsd =
        input.maxSetupCostUsd ?? snapshot.library.config.budget?.maxSetupCostUsd;
      await new UsageStore(this.project).ensureScope({
        owner: { kind: "setup", id },
        maxCostUsd: maxSetupCostUsd,
      });
      const record = recordSchema.parse({
        id,
        usageScopeId: id,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        status: "queued",
        stage: "profiles",
        model,
        modelOverride: input.model ? model : undefined,
        instructions: input.instructions,
        maxSetupCostUsd,
        stages: stageIds.map((id) => ({ id, status: "pending", attempt: 0 })),
        base: {
          libraryHash: snapshot.libraryHash,
          configRevision: snapshot.configRevision,
          orchestrationRevision: snapshot.orchestration.revision,
        },
        library: snapshot.library,
        settings: snapshot.orchestration.settings,
        models: catalog.models,
        accepted: {},
      });
      await this.save(record);
      this.enqueue(record);
      return this.get(id);
    });
  }
  async resume(id: string, value: unknown) {
    const { revision, maxSetupCostUsd } = resumeSetupSchema.parse(value);
    return this.exclusive(async () => {
      const job = this.get(id);
      if (job.revision !== revision || !job.actions.canResume)
        throw new Error("Setup changed or cannot resume. Refresh its current state.");
      if (
        [...this.records.values()].some((record) => record.id !== id && active.has(record.status))
      )
        throw new Error("Another setup job is active");
      const record = structuredClone(this.records.get(id)!);
      const usage = new UsageStore(this.project);
      const scope =
        maxSetupCostUsd === undefined
          ? await usage.getScope(record.usageScopeId)
          : await usage.raiseScopeLimit(record.usageScopeId, maxSetupCostUsd);
      record.maxSetupCostUsd = scope.maxCostUsd;
      record.status = "queued";
      record.error = undefined;
      record.conflict = undefined;
      await this.save(record);
      this.enqueue(record);
      return this.get(id);
    });
  }
  async cancel(id: string, value: unknown) {
    const { revision } = setupJobActionSchema.parse(value);
    const current = this.get(id),
      job = this.jobs.get(id);
    if (current.revision !== revision || !current.actions.canCancel || !job)
      throw new Error("Setup changed or is no longer running. Refresh its current state.");
    job.controller.abort(new Error("Setup cancelled by user"));
    await this.write(id, (current) => ({ ...current!, status: "cancelling" }));
    await job.done;
    return this.get(id);
  }
  async wait(id: string) {
    await this.jobs.get(id)?.done;
    return this.get(id);
  }
  private enqueue(record: SetupRecord) {
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.run(record, controller.signal))
      .catch((error) => {
        console.error(
          "Could not persist setup state:",
          error instanceof Error ? error.message : "unknown error",
        );
        const current = this.records.get(record.id)!;
        current.status = "failed";
        current.error = "Could not persist setup progress. Check local storage, then resume.";
      })
      .finally(() => {
        this.jobs.delete(record.id);
      });
    this.jobs.set(record.id, { controller, done });
  }
  private async checkBase(record: SetupRecord) {
    const snapshot = await (this.services.snapshot ?? readSetupSnapshot)(this.project);
    if (
      snapshot.libraryHash !== record.base.libraryHash ||
      snapshot.configRevision !== record.base.configRevision ||
      snapshot.orchestration.revision !== record.base.orchestrationRevision
    ) {
      throw new Error(
        "Project settings changed during setup. Accepted stages are preserved; regenerate against the current settings.",
      );
    }
  }
  private context(
    record: SetupRecord,
  ): Omit<DesignOptions, "scope" | "messages" | "signal" | "emit"> {
    const settings = structuredClone(record.settings);
    const profiles = record.accepted.profiles,
      cases = record.accepted.cases;
    if (profiles?.scope === "profiles") settings.profiles = profiles.profiles;
    settings.coordinatorProfile = "";
    if (cases?.scope === "cases")
      Object.assign(settings, {
        cases: cases.cases,
        instructions: cases.instructions,
        suggestBlocks: cases.suggestBlocks,
      });
    return {
      project: this.project,
      library: {
        ...record.library,
        config: {
          ...record.library.config,
          coordinator: undefined,
          agent: resolveAgentSettings(record.library.config.agent, record.model),
        },
      },
      settings,
      models: record.models,
    };
  }
  private async run(record: SetupRecord, signal: AbortSignal) {
    try {
      const receipt = await (this.services.publication ?? readSetupPublication)(
        this.project,
        record.id,
      );
      if (receipt) {
        await this.finish(record, receipt);
        return;
      }
      signal.throwIfAborted();
      await this.checkBase(record);
      if (
        ["profiles", "cases", "blocks"].some(
          (stage) => !record.accepted[stage as keyof SetupRecord["accepted"]],
        )
      ) {
        const catalog = await (this.services.catalog ?? availableModels)(signal, true);
        validateModelChoice(
          resolveAgentSettings(record.library.config.agent, record.model),
          catalog.models,
        );
        record.models = catalog.models;
      }
      for (const stageId of stageIds) {
        const stage = record.stages.find((stage) => stage.id === stageId)!;
        if (stage.status === "completed") continue;
        signal.throwIfAborted();
        record.status = "running";
        record.stage = stageId;
        record.error = undefined;
        stage.status = "running";
        stage.startedAt = new Date().toISOString();
        stage.attempt++;
        stage.error = undefined;
        record.activity =
          stageId === "applying" ? "Publishing validated project setup…" : `Preparing ${stageId}…`;
        await this.save(record);
        if (stageId === "profiles" || stageId === "cases" || stageId === "blocks") {
          const context = this.context(record);
          const options: DesignOptions = {
            ...context,
            scope: stageId,
            signal,
            accounting: await createAccountingContext(this.project, "setup", {
              scopeId: record.usageScopeId,
              setupId: record.id,
              setupStage: stageId,
              operationId: `${record.id}/${stageId}`,
            }),
            messages: [
              {
                role: "user",
                time: new Date().toISOString(),
                content: `${setupInstructions(stageId, record.model)}\n\nInspect the actual project using read-only tools. Generate a complete proposal now, using reasonable defaults instead of questions. Keep the result concise and reusable. User preferences: ${record.instructions || "Balance reliability and cost; keep simple work simple."}`,
              },
            ],
            emit: (kind, message) => {
              if (signal.aborted) return;
              if (["agent_start", "tool_start", "tool_end"].includes(kind)) {
                record.activity = message.slice(0, 1000);
                const visible = this.records.get(record.id);
                if (visible) visible.activity = record.activity;
              }
              this.emit(kind, message);
            },
          };
          const result = await (this.services.design ?? designSettings)(options);
          signal.throwIfAborted();
          const proposal = validateDesign(result.proposal, options);
          if (proposal.scope !== stageId)
            throw new Error(
              `Project setup expected ${stageId}, but received ${proposal.scope}. Resume to retry this stage.`,
            );
          if (
            proposal.scope === "profiles" &&
            !proposal.profiles.some((profile) => profile.enabled)
          )
            throw new Error("Setup must produce at least one enabled model profile.");
          if (
            proposal.scope === "blocks" &&
            proposal.changes.blocks.some(
              (change) => change.bundle.definition.executor?.kind !== "code",
            )
          )
            throw new Error("Setup must generate executable TypeScript blocks.");
          record.accepted[stageId] = proposal;
          stage.summary = proposal.summary;
        } else if (stageId === "validation") {
          const blocks = record.accepted.blocks;
          if (blocks?.scope !== "blocks") throw new Error("Setup has no accepted block proposal");
          const validated = validateLibraryChanges(
            blocks.changes,
            this.context(record).library,
            "regenerate",
            record.models,
          );
          await validateCodeBlocks(this.project, validated.blocks);
          signal.throwIfAborted();
          stage.summary = `Validated ${Object.keys(validated.blocks).length} reusable blocks`;
        } else {
          const blocks = record.accepted.blocks;
          if (blocks?.scope !== "blocks") throw new Error("Setup has no accepted block proposal");
          const receipt = await (this.services.publish ?? publishSetup)(
            this.project,
            {
              jobId: record.id,
              base: record.base,
              libraryChanges: blocks.changes,
              settings: this.context(record).settings,
              modelOverride: record.modelOverride,
            },
            record.models,
            signal,
          );
          // Commit is authoritative even if cancellation arrives immediately after it.
          await this.finish(record, receipt);
          return;
        }
        stage.status = "completed";
        stage.completedAt = new Date().toISOString();
        record.activity = stage.summary ?? `${stageId} completed`;
        await this.save(record);
        signal.throwIfAborted();
        await this.checkBase(record);
      }
    } catch (error) {
      const committed = await (this.services.publication ?? readSetupPublication)(
        this.project,
        record.id,
      );
      if (committed) {
        await this.finish(record, committed);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const conflict =
        /settings changed during setup|accepted proposals.*current settings|publication.*conflict/i.test(
          message,
        );
      record.status = this.closed
        ? "interrupted"
        : signal.aborted
          ? "cancelled"
          : conflict
            ? "conflicted"
            : "failed";
      record.error = this.closed
        ? "The host stopped during setup. Resume explicitly from the saved stage."
        : message.slice(0, 2000);
      record.activity = "";
      if (conflict) record.conflict = { message: record.error, requiresRegeneration: true };
      const stage = record.stages.find((stage) => stage.id === record.stage)!;
      if (stage.status !== "completed") {
        stage.status = signal.aborted ? "interrupted" : "failed";
        stage.error = record.error;
      }
      await this.save(record);
    }
  }
  private async finish(record: SetupRecord, receipt: SetupPublicationReceipt) {
    const marker = markerSchema.parse({
      version: 1,
      completedAt: receipt.completedAt,
      model: record.model,
      libraryProposalId: receipt.libraryProposalId,
      usageScopeId: record.usageScopeId,
      jobId: record.id,
      generationId: receipt.generationId,
      counts: receipt.counts,
    });
    await atomicWrite(
      path.join(this.project, ".workflow/setup.json"),
      JSON.stringify(marker, null, 2) + "\n",
    );
    record.status = "completed";
    record.stage = "applying";
    record.error = undefined;
    record.conflict = undefined;
    record.activity =
      "Project setup saved. Review models, task instructions and blocks in Settings.";
    record.result = {
      ...receipt.counts,
      completedAt: receipt.completedAt,
      generationId: receipt.generationId,
    };
    const stage = record.stages.find((stage) => stage.id === "applying")!;
    stage.status = "completed";
    stage.completedAt = receipt.completedAt;
    stage.summary = "Published one coherent project setup";
    await this.save(record);
  }
  async close() {
    this.closed = true;
    this.stopping.abort(new Error("Host stopped"));
    await this.mutations;
    for (const job of this.jobs.values()) job.controller.abort(new Error("Host stopped"));
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
  }
}
