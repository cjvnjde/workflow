import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { atomicWrite } from "../../infrastructure/atomic-file.js";
import {
  agentOverrideSchema,
  bundleSchema,
  configSchema,
  resolveAgentSettings,
} from "../../contracts/domain.js";
import {
  libraryChangesSchema,
  type AvailableModel,
} from "../../contracts/library-editor-schema.js";
import {
  orchestrationSchema,
  orchestrationStateSchema,
  projectCapabilitiesSchema,
} from "../../contracts/orchestration-schema.js";
import { executionSettingsSchema, setupSchema } from "../../contracts/setup-schema.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const snapshotSchema = z.object({
  library: z.object({ config: configSchema, blocks: z.record(z.string(), bundleSchema) }),
  orchestration: orchestrationStateSchema.extend({
    projectCapabilities: projectCapabilitiesSchema,
  }),
  model: setupSchema.omit({ providers: true }),
  execution: executionSettingsSchema,
  rawConfig: z.string(),
  configRevision: z.string(),
  libraryHash: z.string(),
});
export type SetupSnapshot = z.infer<typeof snapshotSchema>;
const inputSchema = z.object({
  jobId: z.string().uuid(),
  base: z.object({
    libraryHash: z.string(),
    configRevision: z.string(),
    orchestrationRevision: z.string(),
  }),
  libraryChanges: libraryChangesSchema,
  settings: orchestrationSchema,
  modelOverride: agentOverrideSchema
    .pick({ provider: true, model: true, thinking: true })
    .required()
    .optional(),
});
export type SetupPublicationInput = z.input<typeof inputSchema>;
const receiptSchema = z.object({
  generationId: z.string().uuid(),
  libraryProposalId: z.string().uuid(),
  completedAt: z.string(),
  counts: z.object({
    profiles: z.number().int(),
    cases: z.number().int(),
    blocks: z.number().int(),
  }),
});
export type SetupPublicationReceipt = z.infer<typeof receiptSchema>;
const journalSchema = z.object({
  version: z.literal(1),
  jobId: z.string().uuid(),
  state: z.enum(["applying", "committed"]),
  input: inputSchema,
  before: snapshotSchema,
  configAfter: z.string(),
  orchestrationAfter: z.string(),
  libraryAfter: z.string(),
  receipt: receiptSchema,
});
type Journal = z.infer<typeof journalSchema>;
const headSchema = z.object({
  version: z.literal(1),
  jobId: z.string().uuid(),
  generationId: z.string().uuid(),
  state: z.enum(["applying", "committed"]),
});
type Context = {
  project: string;
  raw?: boolean;
  lease?: boolean;
  active?: boolean;
  snapshot?: SetupSnapshot;
  checkpoint?: (point: string) => void | Promise<void>;
};
const context = new AsyncLocalStorage<Context>();
const directory = (project: string) => path.join(project, ".workflow", "settings-publications");
const journalFile = (project: string, jobId: string) =>
  path.join(directory(project), `${z.string().uuid().parse(jobId)}.json`);
const headFile = (project: string) => path.join(project, ".workflow", "settings-publication.json");
async function head(project: string) {
  try {
    return headSchema.parse(JSON.parse(await readFile(headFile(project), "utf8")));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
async function journal(project: string, jobId: string) {
  const saved = journalSchema.parse(
    JSON.parse(await readFile(journalFile(project, jobId), "utf8")),
  );
  if (saved.jobId !== jobId || saved.input.jobId !== jobId)
    throw new Error("Settings publication identity mismatch.");
  return saved;
}
async function saveJournal(project: string, value: Journal) {
  await atomicWrite(
    journalFile(project, value.jobId),
    JSON.stringify(journalSchema.parse(value)) + "\n",
  );
}
async function lease<T>(project: string, action: () => Promise<T>) {
  const owner = context.getStore();
  if (owner?.project === project && owner.lease && owner.active) return await action();
  const release = await lockfile.lock(path.join(project, ".workflow", "settings-owner"), {
    realpath: false,
    lockfilePath: path.join(project, ".workflow", "settings-write-lease"),
    stale: 10_000,
    update: 2000,
    retries: { retries: 100, minTimeout: 100, maxTimeout: 100, randomize: false },
  });
  const value: Context = { project, raw: true, lease: true, active: true };
  try {
    return await context.run(value, action);
  } finally {
    value.active = false;
    await release();
  }
}

/** One lock order for every configuration writer, including nested publication calls. */
export async function withProjectSettingsWrite<T>(project: string, action: () => Promise<T>) {
  project = await realpath(project);
  const owner = context.getStore();
  if (owner?.project === project && owner.lease && owner.active) return await action();
  return await lease(project, async () => {
    const current = await head(project);
    if (current?.state === "applying")
      throw new Error(
        `Setup ${current.jobId} has an unfinished settings publication. Resume that setup before changing settings.`,
      );
    return await action();
  });
}

async function capture(project: string): Promise<SetupSnapshot> {
  const [
    { loadLibrary },
    { loadOrchestration },
    { projectModelSettings, executionSettings },
    { libraryHash },
  ] = await Promise.all([
    import("../library/library.js"),
    import("./orchestration-settings.js"),
    import("./project-model.js"),
    import("../library/library-proposals.js"),
  ]);
  const [library, orchestration, model, execution, rawConfig] = await Promise.all([
    loadLibrary(project),
    loadOrchestration(project),
    projectModelSettings(project),
    executionSettings(project),
    readFile(path.join(project, ".workflow", "config.json"), "utf8"),
  ]);
  // Use the same representation before and after a durable JSON round-trip.
  return snapshotSchema.parse(
    JSON.parse(
      JSON.stringify({
        library,
        orchestration,
        model,
        execution,
        rawConfig,
        configRevision: hash(rawConfig),
        libraryHash: libraryHash(library),
      }),
    ),
  );
}

/** Capture once, then release the lock before any model or workflow work. */
export async function readSetupSnapshot(project: string): Promise<SetupSnapshot> {
  project = await realpath(project);
  const current = context.getStore();
  if (current?.project === project && current.snapshot) return structuredClone(current.snapshot);
  if (current?.project === project && current.raw && current.active) return await capture(project);
  const pending = await head(project);
  if (pending?.state === "applying")
    return structuredClone((await journal(project, pending.jobId)).before);
  return await lease(project, async () => {
    const pending = await head(project);
    return pending?.state === "applying"
      ? structuredClone((await journal(project, pending.jobId)).before)
      : await capture(project);
  });
}

export async function withProjectSettingsSnapshot<T>(project: string, action: () => Promise<T>) {
  project = await realpath(project);
  const current = context.getStore();
  if (current?.project === project && (current.snapshot || (current.raw && current.active)))
    return await action();
  const snapshot = await readSetupSnapshot(project);
  return await context.run({ project, snapshot }, action);
}

/** Reader adapters use their existing disk implementation only inside a captured view. */
export async function readSettingsPart<
  K extends "library" | "orchestration" | "model" | "execution",
>(project: string, part: K, raw: () => Promise<SetupSnapshot[K]>): Promise<SetupSnapshot[K]> {
  project = await realpath(project);
  const current = context.getStore();
  if (current?.project === project && current.raw && current.active) return await raw();
  const snapshot =
    current?.project === project && current.snapshot
      ? current.snapshot
      : await readSetupSnapshot(project);
  return structuredClone(snapshot[part]);
}

export async function publicationCheckpoint(project: string, point: string) {
  const owner = context.getStore();
  if (owner?.project === (await realpath(project)) && owner.active) await owner.checkpoint?.(point);
}

export async function readSetupPublication(
  project: string,
  jobId: string,
): Promise<SetupPublicationReceipt | null> {
  try {
    const saved = await journal(await realpath(project), jobId);
    // The shared head is the commit point; a crash may precede updating the journal.
    const current = await head(project);
    return saved.state === "committed" ||
      (current?.jobId === jobId && current.state === "committed")
      ? saved.receipt
      : null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** Finalization uses no model calls and is resumable from the durable publication. */
export async function publishSetup(
  project: string,
  value: SetupPublicationInput,
  models: AvailableModel[],
  signal?: AbortSignal,
  services: { checkpoint?: (point: string) => void | Promise<void> } = {},
): Promise<SetupPublicationReceipt> {
  project = await realpath(project);
  const input = inputSchema.parse(value);
  return await lease(project, async () => {
    const owner = context.getStore()!;
    owner.checkpoint = services.checkpoint;
    // Preserve the prior receipt before a successor can replace the head. A
    // process may have stopped immediately after the head's atomic commit.
    const previousHead = await head(project);
    if (previousHead?.state === "committed") {
      const previous = await journal(project, previousHead.jobId);
      if (previous.state !== "committed") {
        previous.state = "committed";
        await saveJournal(project, previous);
      }
    }
    const committed = await readSetupPublication(project, input.jobId);
    if (committed) return committed;
    const pending = await head(project);
    if (pending?.state === "applying" && pending.jobId !== input.jobId)
      throw new Error(`Setup ${pending.jobId} has an unfinished publication. Resume it first.`);
    if (pending?.state !== "applying") signal?.throwIfAborted();
    const [
      { LibraryProposals, libraryHash, validateLibraryChanges, validateModelChoice },
      { loadLibrary },
      { loadOrchestration, saveOrchestration },
    ] = await Promise.all([
      import("../library/library-proposals.js"),
      import("../library/library.js"),
      import("./orchestration-settings.js"),
    ]);
    const proposals = new LibraryProposals(project);
    let saved: Journal | undefined;
    try {
      saved = await journal(project, input.jobId);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (saved && JSON.stringify(saved.input) !== JSON.stringify(input))
      throw new Error(
        "Saved setup publication differs from this request. Resume the original job without changing its accepted proposals.",
      );
    if (saved && pending?.state !== "applying") {
      const current = await capture(project);
      if (
        current.libraryHash !== saved.before.libraryHash ||
        current.configRevision !== saved.before.configRevision ||
        current.orchestration.revision !== saved.before.orchestration.revision
      ) {
        throw new Error(
          "Project settings changed before setup publication began. Existing edits are preserved; start a new setup against the current settings.",
        );
      }
    }
    if (!saved) {
      const before = await capture(project);
      if (
        before.libraryHash !== input.base.libraryHash ||
        before.configRevision !== input.base.configRevision ||
        before.orchestration.revision !== input.base.orchestrationRevision
      ) {
        throw new Error(
          "Project settings changed during setup. The accepted proposals are preserved; start a new setup against the current settings.",
        );
      }
      const raw = JSON.parse(before.rawConfig) as Record<string, unknown>;
      delete raw.coordinator;
      if (input.modelOverride)
        raw.agent = { ...(raw.agent as object | undefined), ...input.modelOverride };
      const configAfter = JSON.stringify(raw, null, 2) + "\n";
      const configured = structuredClone(before.library);
      delete configured.config.coordinator;
      if (input.modelOverride)
        configured.config.agent = resolveAgentSettings(
          configured.config.agent,
          input.modelOverride,
        );
      validateModelChoice(configured.config.agent, models);
      const proposal = await proposals.create(
        configured,
        "regenerate",
        input.libraryChanges,
        models,
      );
      const { blocks } = validateLibraryChanges(proposal.changes, configured, "regenerate", models);
      saved = journalSchema.parse({
        version: 1,
        jobId: input.jobId,
        state: "applying",
        input,
        before,
        configAfter,
        orchestrationAfter: JSON.stringify(input.settings, null, 2) + "\n",
        libraryAfter: libraryHash({ config: configured.config, blocks }),
        receipt: {
          generationId: randomUUID(),
          libraryProposalId: proposal.id,
          completedAt: new Date().toISOString(),
          counts: {
            profiles: input.settings.profiles.length,
            cases: input.settings.cases.length,
            blocks: Object.keys(blocks).length,
          },
        },
      });
      await mkdir(directory(project), { recursive: true, mode: 0o700 });
      await atomicWrite(path.join(directory(project), ".gitignore"), "*\n");
      signal?.throwIfAborted();
      await saveJournal(project, saved);
    }
    // Once visible as applying, cancellation cannot abandon a half-finalized write.
    if (pending?.state !== "applying") signal?.throwIfAborted();
    await atomicWrite(
      headFile(project),
      JSON.stringify({
        version: 1,
        jobId: saved.jobId,
        generationId: saved.receipt.generationId,
        state: "applying",
      }),
    );
    await publicationCheckpoint(project, "prepared");
    const configFile = path.join(project, ".workflow", "config.json");
    const config = await readFile(configFile, "utf8");
    if (config !== saved.configAfter) {
      if (hash(config) !== saved.before.configRevision)
        throw new Error(
          "Project config was manually edited during interrupted setup; the edit is preserved.",
        );
      await atomicWrite(configFile, saved.configAfter, 0o600, async () => {
        if (hash(await readFile(configFile, "utf8")) !== saved!.before.configRevision)
          throw new Error("Project config changed while publishing setup; the edit is preserved.");
      });
    }
    await publicationCheckpoint(project, "config");
    await proposals.apply(saved.receipt.libraryProposalId, models);
    await publicationCheckpoint(project, "library");
    const state = await loadOrchestration(project);
    if (state.revision !== hash(saved.orchestrationAfter)) {
      if (state.revision !== saved.before.orchestration.revision)
        throw new Error(
          "Orchestration settings were edited during interrupted setup; the edit is preserved.",
        );
      await saveOrchestration(project, { ...state, settings: saved.input.settings }, models);
    }
    await publicationCheckpoint(project, "orchestration");
    if (
      (await readFile(configFile, "utf8")) !== saved.configAfter ||
      (await loadOrchestration(project)).revision !== hash(saved.orchestrationAfter) ||
      libraryHash(await loadLibrary(project)) !== saved.libraryAfter
    )
      throw new Error(
        "Settings or block sources changed during setup publication; manual edits were preserved. Reconcile the changed files before resuming.",
      );
    await atomicWrite(
      headFile(project),
      JSON.stringify({
        version: 1,
        jobId: saved.jobId,
        generationId: saved.receipt.generationId,
        state: "committed",
      }),
    );
    await publicationCheckpoint(project, "committed");
    saved.state = "committed";
    await saveJournal(project, saved);
    return saved.receipt;
  });
}
