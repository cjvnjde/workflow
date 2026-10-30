import { planningAgent } from "./planning-model.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runAgentSession, type ActivitySink } from "./agent-session.js";
import { type WorkflowRun } from "./domain.js";
import { programInstructions, type ProgramSource } from "./program-schema.js";
import { validateProgram } from "./program-compiler.js";
import { textResult } from "./block-runner.js";
import type { AvailableModel } from "./library-editor-schema.js";
import { createAccountingContext, UsageStore } from "./usage-store.js";
import type { AccountingContext } from "./usage-schema.js";
import { planningMemory } from "./planning-memory.js";

export async function refineProgram(options: {
  accounting?: AccountingContext;
  project: string; run: WorkflowRun; instructions: string; models: AvailableModel[];
  signal: AbortSignal; emit: ActivitySink;
}, session = runAgentSession): Promise<ProgramSource> {
  const { project, run, signal, emit } = options;
  if (!run.program) throw new Error("This workflow has no TypeScript source");
  let result: ProgramSource | undefined, rejected = "";
  const submit = defineTool({
    name: "submit_workflow", label: "Refine TypeScript workflow",
    description: "Submit the complete revised source and JSON object inputs. The host typechecks it before saving.",
    parameters: Type.Object({ source: Type.String(), input: Type.String() }),
    async execute(_id, args) {
      signal.throwIfAborted();
      try {
        result = await validateProgram(project, { source: args.source, input: JSON.parse(args.input), filename: run.program!.filename }, run.program!.catalog);
        return { ...textResult("Refined TypeScript accepted."), terminate: true };
      } catch (error) {
        rejected = error instanceof Error ? error.message : String(error);
        emit("plan_validation", rejected);
        throw error;
      }
    },
  });
  const settings = planningAgent(run.config.agent, run.config.coordinator, options.models);
  const memory = await planningMemory(project, signal);
  await session({
    price: run.config.budget?.prices[`${settings.provider}/${settings.model}`],
    accounting: options.accounting ?? await createAccountingContext(project, "refinement", { scopeId: (await new UsageStore(project).ensureRun(run)).id, runId: run.id }),
    project, settings, signal: AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]), emit,
    tools: [...memory.tools, submit],
    completion: { isComplete: () => !!result, prompt: () => `Submit the revised TypeScript with submit_workflow. Correct this error if present: ${rejected}` },
    systemPrompt: [
      "Refine the user's saved TypeScript workflow. Use only the supplied source, block catalog, models, instructions and task context, then submit complete source and input. Do not inspect files, Git, shell or MCP. Do not execute the workflow, implement its task, or mutate project files during refinement. Preserve the original request and unrelated behavior.",
      programInstructions, `Available models: ${JSON.stringify(options.models)}`,
      `Frozen model profiles: ${JSON.stringify(run.program.models)}`,
      `Frozen Settings blocks: ${JSON.stringify(run.program.catalog)}`,
      `Project instructions: ${run.config.instructions}`,
      ...(memory.prompt ? [memory.prompt] : []),
    ].join("\n\n"),
    prompt: JSON.stringify({ request: run.plan.task, source: run.program.source, input: run.program.input, changes: options.instructions }),
  });
  signal.throwIfAborted();
  if (!result) throw new Error(`AI did not submit a valid TypeScript refinement. ${rejected}`);
  return result;
}
