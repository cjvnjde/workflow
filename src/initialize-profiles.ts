import { loadLibrary } from "./library.js";
import { loadOrchestration, saveOrchestration } from "./orchestration-settings.js";
import { availableModels } from "./available-models.js";
import { designSettings, validateDesign } from "./settings-designer.js";
import { createAccountingContext } from "./usage-store.js";

/** Explicit initialization/regeneration; no background model calls on ordinary server startup. */
export async function initializeProfiles(project: string, options: { instructions?: string; regenerate?: boolean; signal?: AbortSignal; emit?: (kind: string, message: string) => void } = {}, services: { catalog?: typeof availableModels; design?: typeof designSettings } = {}) {
  const signal = options.signal ?? AbortSignal.timeout(120_000);
  const [library, state] = await Promise.all([loadLibrary(project), loadOrchestration(project)]);
  if (state.settings.profiles.length && !options.regenerate) { return { status: "existing" as const, count: state.settings.profiles.length }; }
  const { models } = await (services.catalog ?? availableModels)(signal, true);
  if (!models.length) { return { status: "unconnected" as const, count: 0 }; }
  const request = `${options.regenerate ? "Regenerate" : "Initialize"} model profiles for this project using the connected catalog. Inspect the project and create a concise set of useful roles: routine low-cost work, implementation, independent review, and demanding analysis when needed. Prefer the newest suitable available models, not a fixed list of historical IDs. Use inexpensive models and low thinking for simple tasks; reserve expensive reasoning for work that benefits from it. Respect the user's configured default model for planning; leave coordinatorProfile empty to inherit that default. Produce a complete proposal without asking questions; use reasonable defaults. ${options.instructions ?? ""}`;
  const context = { project, scope: "profiles" as const, library, settings: state.settings, models, accounting: await createAccountingContext(project, "setup", { maxCostUsd: library.config.budget?.maxSetupCostUsd, setupStage: "profiles" }), messages: [{ role: "user" as const, content: request, time: new Date().toISOString() }], signal, emit: options.emit ?? (() => {}) };
  const result = await (services.design ?? designSettings)(context);
  signal.throwIfAborted();
  const proposal = validateDesign(result.proposal, context);
  if (proposal.scope !== "profiles" || !proposal.profiles.some((profile) => profile.enabled)) { throw new Error("Initialization must produce at least one enabled model profile"); }
  const coordinatorProfile = proposal.coordinatorProfile;
  await saveOrchestration(project, { ...state, settings: { ...state.settings, profiles: proposal.profiles, coordinatorProfile } }, models);
  return { status: "generated" as const, count: proposal.profiles.length };
}
