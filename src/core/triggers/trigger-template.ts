import { runSchema, type WorkflowRun } from "../../contracts/domain.js";
import { automationTemplate } from "../execution/automation-template.js";
import { githubEventSchema, type GithubEvent } from "../../contracts/trigger-schema.js";

/** Keep the frozen executable/configuration, never a previous run's mutable execution state. */
export async function triggerTemplate(value: WorkflowRun): Promise<WorkflowRun> {
  const run = runSchema.parse(value);
  if (!run.program || !run.executionVersion || run.executionProtocol !== 2)
    throw new Error("Select a saved TypeScript workflow with an execution archive");
  const previous = githubEventSchema.safeParse(run.program.input.event);
  if (previous.success) {
    const suffix = ` · ${previous.data.repository}#${previous.data.number}`;
    if (run.plan.title.endsWith(suffix)) run.plan.title = run.plan.title.slice(0, -suffix.length);
  }
  return automationTemplate(run);
}

export async function instantiateTrigger(template: WorkflowRun, id: string, event: GithubEvent) {
  const run = await triggerTemplate(template);
  const now = new Date().toISOString();
  run.id = id;
  run.temporalWorkflowId = `workflow-${id}`;
  run.createdAt = now;
  run.updatedAt = now;
  const suffix = ` · ${event.repository}#${event.number}`;
  run.plan.title = `${run.plan.title.slice(0, Math.max(1, 200 - suffix.length))}${suffix}`.slice(
    0,
    200,
  );
  run.program!.input = { ...run.program!.input, event };
  return run;
}
