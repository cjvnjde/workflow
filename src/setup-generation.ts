import type { SetupJob } from "./setup-job-schema.js";

export function setupInstructions(stage: "profiles" | "cases" | "blocks", model: SetupJob["model"]) {
  if (stage === "profiles") return [
    "Create a small set of model profiles for routine work, coding, independent review and difficult analysis.",
    "Choose exact IDs and supported thinking levels from the refreshed catalog, preferring the latest suitable available models. Use cheap models for simple work; strong reasoning only where justified. Do not pick the most expensive model for every role.",
    `The user selected ${model.provider}/${model.model} (${model.thinking}) as the default planner. Leave coordinatorProfile empty so planning continues to follow that default.`,
  ].join(" ");
  if (stage === "cases") return [
    "Tailor reusable task instructions for review, bug fixes, features, documentation, and any other useful project-specific work.",
    "These are workflow presets describing intent, verification and handoff rules, not fixed graphs or specific tickets. The default model will compose the actual execution graph from each user's requirements.",
    "Preserve useful existing custom task instructions. Control costs through concise typed handoffs, isolated step context, optional no-context steps, and ordinary code for deterministic work. Keep unrelated settings unchanged.",
  ].join(" ");
  return [
    "Tailor the reusable TypeScript block library to this repository with a small, focused patch, not a full-library rewrite. Inspect the existing blocks first. Usually change or add only 1–4 of the most useful blocks; unmentioned blocks remain available unchanged and do not need to appear in the proposal. The existing generic library already supports requirements, implementation, tests and review; task presets do not each require a new block.",
    "Preserve already suitable deterministic checks and publication blocks unchanged. Do not reauthor checks or push just to restate their contracts or add schemas. Honor explicit behavior changes, including a user's prohibition on publication, with the smallest necessary patch or guard. Preserve useful existing source and make the smallest edits needed for the project's actual languages, commands and conventions.",
    "Use ctx.ai only for reasoning. Tests, builds, formatting and Git operations should use ordinary TypeScript and ctx.exec without model calls where possible. Publication must remain optional and only used when the user requests it.",
    "Use the generated model profiles through ctx.models where appropriate, with a safe default fallback. Assign cheap capable models to small tasks, suitable coding models to implementation and independent models to consequential review.",
    'Use explicit typed input/output contracts; send only selected outputs or summaries between steps, never entire prior conversations. Use ctx.ai({context: "none", prompt: ...}) when only explicit selected inputs should reach a model; this excludes inherited task/graph/inputs/project instructions. Preserve existing block IDs, required output artifacts and verification responsibilities. All proposed blocks must be executable TypeScript.',
    "Keep TypeScript return types compatible with declared output schemas. When returning a constructed object with enum/literal fields, return OutputSchema.parse({...}) or preserve literal types explicitly; do not let outcome widen to string. A block overload error mentioning input often means its run return type does not match output, not that input is unsupported. Returning a typed ctx.ai result directly also preserves the schema type.",
  ].join(" ");
}
