import { runSchema, type WorkflowRun } from "../../contracts/domain.js";
import { compositionPlan } from "../planning/composition-plan.js";
import { githubEventSchema, type GithubEvent } from "../../contracts/trigger-schema.js";

/** Keep the frozen executable/configuration, never a previous run's mutable execution state. */
export function triggerTemplate(value: WorkflowRun): WorkflowRun {
  const run = runSchema.parse(value);
  if (!run.program || !run.executionVersion || run.executionProtocol !== 2)
    throw new Error("Select a saved TypeScript workflow with an execution archive");
  const previous = githubEventSchema.safeParse(run.program.input.event);
  if (previous.success) {
    const suffix = ` · ${previous.data.repository}#${previous.data.number}`;
    if (run.plan.title.endsWith(suffix)) run.plan.title = run.plan.title.slice(0, -suffix.length);
  }
  const composed =
    run.program.composition === "structured" && run.program.structure
      ? compositionPlan(run.program.structure, run.plan.title, run.plan.task, {
          config: run.config,
          blocks: run.program.catalog,
        })
      : undefined;
  const plan =
    composed?.plan ??
    (run.program.composition === "graph"
      ? run.plan
      : { title: run.plan.title, task: run.plan.task, entry: "start", nodes: [] });
  return runSchema.parse({
    id: run.id,
    revision: 0,
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
    executionVersion: run.executionVersion,
    executionProtocol: 2,
    mode: run.mode,
    status: "draft",
    plan,
    program: run.program,
    config: run.config,
    blocks: composed?.blocks ?? (run.program.composition === "graph" ? run.blocks : {}),
    cursor: plan.entry,
    visits: {},
    artifacts: {},
    attempts: [],
  });
}

export function instantiateTrigger(template: WorkflowRun, id: string, event: GithubEvent) {
  const run = triggerTemplate(template);
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
