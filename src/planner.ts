import { planningAgent } from "./planning-model.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  validatePlan,
  type Library,
  type WorkflowPlan,
} from "./domain.js";
import { runAgentSession, type ActivitySink } from "./agent-session.js";
import { textResult } from "./block-runner.js";
import { graphInstructions } from "./graph-composition.js";
import { availableModels } from "./available-models.js";
import { validatePlanModels } from "./library-proposals.js";
import type { AvailableModel } from "./library-editor-schema.js";
import { createAccountingContext } from "./usage-store.js";
import type { AccountingContext } from "./usage-schema.js";
import { planningMemory } from "./planning-memory.js";
import { blockCatalogTools } from "./block-catalog.js";

export async function createAiPlan(options: {
  accounting?: AccountingContext;
  project: string;
  library: Library;
  task: string;
  instructions: string;
  emit: ActivitySink;
  signal: AbortSignal;
  models?: AvailableModel[];
  previousPlan?: WorkflowPlan;
}, session: typeof runAgentSession = runAgentSession): Promise<WorkflowPlan> {
  const { library, task } = options;
  const models = options.models ?? (await availableModels(options.signal)).models;
  if (!models.length) { throw new Error("No models are available. Connect a provider before AI planning."); }
  let plan: WorkflowPlan | undefined;
  const submit = defineTool({
    name: "submit_plan",
    label: "Propose workflow",
    description:
      "Submit the proposed workflow as a JSON string. The host validates the graph and a user must approve it before execution.",
    parameters: Type.Object({ json: Type.String() }),
    async execute(_id, params) {
      const candidate = validatePlan({ ...JSON.parse(params.json), task }, library);
      validatePlanModels(candidate, library, models);
      plan = candidate;
      return {
        ...textResult("Workflow proposal accepted for approval."),
        terminate: true,
      };
    },
  });
  const settings = planningAgent(library.config.agent, library.config.coordinator, models);
  const memory = await planningMemory(options.project, options.signal);
  const catalog = blockCatalogTools({ blocks: () => library.blocks, signal: options.signal });
  await session({
    price: library.config.budget?.prices[`${settings.provider}/${settings.model}`],
    accounting: options.accounting ?? await createAccountingContext(options.project, options.previousPlan ? "refinement" : "planning", { maxCostUsd: library.config.budget?.maxTaskCostUsd }),
    project: options.project,
    settings,
    tools: [...memory.tools, ...catalog.tools, submit],
    completion: { isComplete: () => !!plan, prompt: () => "Submit a valid graph with submit_plan. Correct any validation errors; investigation belongs in execution blocks." },
    signal: AbortSignal.any([
      options.signal,
      AbortSignal.timeout(settings.timeoutMs),
    ]),
    emit: options.emit,
    systemPrompt: [
      "Compose or refine the workflow using ONLY the supplied context, blocks, task instructions and available models. Do not inspect project files, Git, shell or MCP. Put any investigation into execution blocks. Preserve the user's intent and unrelated parts of an existing graph. Submit exactly one accepted plan using submit_plan.",
      graphInstructions,
      "Use exact provider/id pairs from the available model catalog. Respect each block's chosen model unless the requested step needs a different tradeoff. Stronger reasoning models suit complex review/implementation; cheaper capable models suit routine work. Price is not a quality ranking. If overriding a model, set provider, model and a supported thinking level explicitly. All effective node model settings are validated against the available catalog.",
      `Available models:\n${JSON.stringify(models)}`,
      `Project instructions:\n${library.config.instructions}`,
      ...(memory.prompt ? [memory.prompt] : []),
      `Configured host check commands (AI blocks may also use bash):\n${JSON.stringify(library.config.commands, null, 2)}`,
      catalog.prompt(),
    ].join("\n\n"),
    prompt: JSON.stringify({
      task,
      coordinatorInstructions: options.instructions,
      previousPlan: options.previousPlan,
    }),
  });
  if (!plan) {
    throw new Error("Coordinator did not submit a valid plan");
  }

  return plan;
}
