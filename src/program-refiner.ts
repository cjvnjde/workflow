import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runAgentSession, type ActivitySink } from "./agent-session.js";
import { resolveAgentSettings, type WorkflowRun } from "./domain.js";
import { programInstructions, type ProgramSource } from "./program-schema.js";
import { checkProgram } from "./program-compiler.js";
import { Workspace } from "./workspace.js";
import { workspaceTools, textResult } from "./block-runner.js";
import type { AvailableModel } from "./library-editor-schema.js";

export async function refineProgram(options: {
  project: string; run: WorkflowRun; instructions: string; models: AvailableModel[];
  signal: AbortSignal; emit: ActivitySink;
}, session = runAgentSession): Promise<ProgramSource> {
  const { project, run, signal, emit } = options;
  if (!run.program) throw new Error("This workflow has no TypeScript source");
  let result: ProgramSource | undefined, rejected = "";
  const workspace = await Workspace.create(project, { signal });
  const submit = defineTool({
    name: "submit_workflow", label: "Refine TypeScript workflow",
    description: "Submit the complete revised source and JSON object inputs. The host typechecks it before saving.",
    parameters: Type.Object({ source: Type.String(), input: Type.String() }),
    async execute(_id, args) {
      signal.throwIfAborted();
      try {
        result = checkProgram(project, { source: args.source, input: JSON.parse(args.input), filename: run.program!.filename });
        return { ...textResult("Refined TypeScript accepted."), terminate: true };
      } catch (error) {
        rejected = error instanceof Error ? error.message : String(error);
        emit("plan_validation", rejected);
        throw error;
      }
    },
  });
  const settings = resolveAgentSettings(run.config.agent, run.config.coordinator);
  await session({
    project, settings, signal: AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]), emit,
    tools: [...workspaceTools(workspace), submit],
    completion: { isComplete: () => !!result, prompt: () => `Submit the revised TypeScript with submit_workflow. Correct this error if present: ${rejected}` },
    systemPrompt: [
      "Refine the user's saved TypeScript workflow. Inspect if needed, then submit complete source and input. Do not execute the workflow, implement its task, or mutate project files during refinement. Preserve the original request and unrelated behavior.",
      programInstructions, `Available models: ${JSON.stringify(options.models)}`,
      `Frozen model profiles: ${JSON.stringify(run.program.models)}`,
      `Frozen Settings blocks: ${JSON.stringify(run.program.catalog)}`,
      `Project instructions: ${run.config.instructions}`,
    ].join("\n\n"),
    prompt: JSON.stringify({ request: run.plan.task, source: run.program.source, input: run.program.input, changes: options.instructions }),
  });
  signal.throwIfAborted();
  if (!result) throw new Error(`AI did not submit a valid TypeScript refinement. ${rejected}`);
  return result;
}
