import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "./atomic-file.js";
import { availableModels } from "./available-models.js";
import { loadLibrary } from "./library.js";
import { LibraryProposals, libraryHash, validateModelChoice } from "./library-proposals.js";
import { loadOrchestration, saveOrchestration } from "./orchestration-settings.js";
import { designSettings, validateDesign, type DesignOptions } from "./settings-designer.js";
import { validateCodeBlocks } from "./program-compiler.js";
import { validateLibraryChanges } from "./library-proposals.js";
import type { ActivitySink } from "./agent-session.js";
import { clearProjectCoordinator, projectModelSettings } from "./project-model.js";
import { randomUUID } from "node:crypto";
import { createAccountingContext } from "./usage-store.js";

const setupRecordSchema = z.object({
  version: z.literal(1), completedAt: z.string(),
  model: z.object({ provider: z.string(), model: z.string(), thinking: z.string() }),
  libraryProposalId: z.string().uuid(),
  usageScopeId: z.string().uuid().optional(),
});

export type InitializeSetupOptions = {
  instructions?: string;
  regenerate?: boolean;
  signal?: AbortSignal;
  emit?: ActivitySink;
  maxSetupCostUsd?: number;
};

/** Explicit project bootstrap. Ordinary init/startup never makes model requests. */
export async function initializeSetup(
  project: string,
  options: InitializeSetupOptions = {},
  services: { catalog?: typeof availableModels; design?: typeof designSettings } = {},
) {
  const signal = options.signal ?? AbortSignal.timeout(600_000);
  const emit = options.emit ?? (() => {});
  const [library, state, config] = await Promise.all([loadLibrary(project), loadOrchestration(project), projectModelSettings(project)]);
  const counts = () => ({ profiles: state.settings.profiles.length, cases: state.settings.cases.length, blocks: Object.keys(library.blocks).length });
  const recordPath = path.join(project, ".workflow", "setup.json");
  if (!options.regenerate) {
    try {
      setupRecordSchema.parse(JSON.parse(await readFile(recordPath, "utf8")));
      return { status: "existing" as const, ...counts() };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  signal.throwIfAborted();
  emit("setup", "Refreshing the connected model catalog…");
  const { models, warnings } = await (services.catalog ?? availableModels)(signal, true);
  for (const warning of warnings) emit("setup", warning);
  if (!models.length) return { status: "unconnected" as const, ...counts() };
  const agent = library.config.agent;
  if (!agent.provider || !agent.model) {
    throw new Error("Choose a default model first with workflow model, workflow setup --model provider/model-id, or Settings → Providers & models.");
  }
  validateModelChoice(agent, models);
  const { provider, model, thinking } = agent;
  const setupId = randomUUID();
  const accounting = await createAccountingContext(project, "setup", { owner: { kind: "setup", id: setupId }, setupId, maxCostUsd: options.maxSetupCostUsd ?? library.config.budget?.maxSetupCostUsd });
  const design = services.design ?? designSettings;
  // Setup is explicitly driven by the chosen default, even when regenerating a
  // project with an older dedicated coordinator. Preserve execution limits.
  const context: Omit<DesignOptions, "scope" | "messages"> = {
    project,
    library: { ...library, config: { ...library.config, coordinator: undefined } },
    settings: { ...state.settings, coordinatorProfile: "" },
    models, signal, emit,
  };
  const request = async (scope: "profiles" | "cases" | "blocks", instructions: string) => {
    signal.throwIfAborted();
    emit("setup", `Designing project ${scope} with ${provider}/${model}…`);
    const input: DesignOptions = { ...context, scope, accounting: { ...accounting, operationId: `${setupId}/${scope}`, setupStage: scope }, messages: [{
      role: "user", time: new Date().toISOString(),
      content: `${instructions}\n\nInspect the actual project using read-only tools. Generate a complete proposal now, using reasonable defaults instead of questions. Keep the result concise and reusable. User preferences: ${options.instructions || "Balance reliability and cost; keep simple work simple."}`,
    }] };
    const result = await design(input);
    signal.throwIfAborted();
    const proposal = validateDesign(result.proposal, input);
    if (proposal.scope !== scope) throw new Error(`Project setup expected ${scope}, but the model proposed ${proposal.scope}. Retry workflow setup.`);
    return proposal;
  };

  const profiles = await request("profiles", [
    "Create a small set of model profiles for routine work, coding, independent review and difficult analysis.",
    "Choose exact IDs and supported thinking levels from the refreshed catalog, preferring the latest suitable available models. Use cheap models for simple work; strong reasoning only where justified. Do not pick the most expensive model for every role.",
    `The user selected ${provider}/${model} (${thinking}) as the default planner. Leave coordinatorProfile empty so planning continues to follow that default.`,
  ].join(" "));
  if (profiles.scope !== "profiles" || !profiles.profiles.some(profile => profile.enabled)) {
    throw new Error("Setup must produce at least one enabled model profile.");
  }
  context.settings = { ...context.settings, profiles: profiles.profiles, coordinatorProfile: "" };

  const cases = await request("cases", [
    "Tailor reusable task instructions for review, bug fixes, features, documentation, and any other useful project-specific work.",
    "These are workflow presets describing intent, verification and handoff rules, not fixed graphs or specific tickets. The default model will compose the actual execution graph from each user's requirements.",
    "Preserve useful existing custom task instructions. Control costs through concise typed handoffs, isolated step context, optional no-context steps, and ordinary code for deterministic work. Keep unrelated settings unchanged.",
  ].join(" "));
  if (cases.scope !== "cases") throw new Error("Setup must produce task instructions.");
  context.settings = { ...context.settings, cases: cases.cases, instructions: cases.instructions, suggestBlocks: cases.suggestBlocks };

  const blocks = await request("blocks", [
    "Tailor the reusable TypeScript block library to this repository with a small, focused patch, not a full-library rewrite. Inspect the existing blocks first. Usually change or add only 1–4 of the most useful blocks; unmentioned blocks remain available unchanged and do not need to appear in the proposal. The existing generic library already supports requirements, implementation, tests and review; task presets do not each require a new block.",
    "Preserve already suitable deterministic checks and publication blocks unchanged. Do not reauthor checks or push just to restate their contracts or add schemas. Honor explicit behavior changes, including a user's prohibition on publication, with the smallest necessary patch or guard. Preserve useful existing source and make the smallest edits needed for the project's actual languages, commands and conventions.",
    "Use ctx.ai only for reasoning. Tests, builds, formatting and Git operations should use ordinary TypeScript and ctx.exec without model calls where possible. Publication must remain optional and only used when the user requests it.",
    "Use the generated model profiles through ctx.models where appropriate, with a safe default fallback. Assign cheap capable models to small tasks, suitable coding models to implementation and independent models to consequential review.",
    "Use explicit typed input/output contracts; send only selected outputs or summaries between steps, never entire prior conversations. Use ctx.ai({context: \"none\", prompt: ...}) when only explicit selected inputs should reach a model; this excludes inherited task/graph/inputs/project instructions. Preserve existing block IDs, required output artifacts and verification responsibilities. All proposed blocks must be executable TypeScript.",
    "Keep TypeScript return types compatible with declared output schemas. When returning a constructed object with enum/literal fields, return OutputSchema.parse({...}) or preserve literal types explicitly; do not let outcome widen to string. A block overload error mentioning input often means its run return type does not match output, not that input is unsupported. Returning a typed ctx.ai result directly also preserves the schema type.",
  ].join(" "));
  if (blocks.scope !== "blocks") throw new Error("Setup must produce reusable blocks.");
  if (blocks.changes.blocks.some(change => change.bundle.definition.executor?.kind !== "code")) {
    throw new Error("Setup must generate TypeScript blocks; no legacy agent or script definitions.");
  }
  const validated = validateLibraryChanges(blocks.changes, library, "regenerate", models);
  await validateCodeBlocks(project, validated.blocks);
  signal.throwIfAborted();

  // Do all model work and validation before publishing anything. Concurrent UI
  // edits invalidate the complete proposal instead of being overwritten.
  const [currentLibrary, currentState] = await Promise.all([loadLibrary(project), loadOrchestration(project)]);
  if (libraryHash(currentLibrary) !== libraryHash(library) || currentState.revision !== state.revision) {
    throw new Error("Project settings changed during setup. Retry workflow setup to preserve those edits.");
  }
  await clearProjectCoordinator(project, config.configRevision);
  const configuredLibrary = await loadLibrary(project);
  if (libraryHash(configuredLibrary) !== libraryHash({ ...library, config: { ...library.config, coordinator: undefined } })) {
    throw new Error("Project settings changed while selecting the default planner. Retry workflow setup to preserve those edits.");
  }
  const proposals = new LibraryProposals(project);
  const proposal = await proposals.create(configuredLibrary, "regenerate", blocks.changes, models);
  signal.throwIfAborted();
  await proposals.apply(proposal.id, models);
  try {
    await saveOrchestration(project, { ...state, settings: context.settings }, models);
  } catch (error) {
    throw new Error(`Generated blocks were saved, but model profiles/task instructions could not be saved. Retry workflow setup to finish: ${error instanceof Error ? error.message : String(error)}`);
  }
  await atomicWrite(recordPath, JSON.stringify(setupRecordSchema.parse({
    version: 1, completedAt: new Date().toISOString(), model: { provider, model, thinking }, libraryProposalId: proposal.id, usageScopeId: accounting.scopeId,
  }), null, 2) + "\n");
  emit("setup", "Project setup saved. Review models, task instructions and blocks in Settings.");
  return { status: "generated" as const, profiles: context.settings.profiles.length, cases: context.settings.cases.length, blocks: Object.keys(validated.blocks).length };
}
