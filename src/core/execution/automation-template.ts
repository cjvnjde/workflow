import {
  runSchema,
  resolveAgentSettings,
  budgetSchema,
  type WorkflowRun,
} from "../../contracts/domain.js";
import type { AutomationExecution } from "../../contracts/automation-schema.js";
import { compositionPlan } from "../planning/composition-plan.js";

/** Immutable host policy; structured execution may add runtime nodes and attempts. */
export function automationRunPolicy(run: WorkflowRun) {
  return {
    program: run.program,
    config: run.config,
    plan:
      run.program?.composition === "graph"
        ? run.plan
        : { title: run.plan.title, task: run.plan.task },
    blocks: run.program?.composition === "graph" ? run.blocks : undefined,
    executionVersion: run.executionVersion,
    mode: run.mode,
  };
}
/** Retain the archive and frozen catalog, never execution state or ownership. */
export async function automationTemplate(value: WorkflowRun): Promise<WorkflowRun> {
  const run = runSchema.parse(value);
  if (!run.program || !run.executionVersion || run.executionProtocol !== 2)
    throw new Error("Select a saved TypeScript workflow with an execution archive");
  const composed =
    run.program.composition === "structured" && run.program.structure
      ? await compositionPlan(run.program.structure, run.plan.title, run.plan.task, {
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

export function applyAutomationExecution(run: WorkflowRun, execution: AutomationExecution) {
  const profile = execution.modelProfile
    ? run.program?.models?.[execution.modelProfile]
    : undefined;
  if (execution.modelProfile && !profile)
    throw new Error(`Unknown frozen model profile: ${execution.modelProfile}`);
  run.config.agent = resolveAgentSettings(run.config.agent, profile, execution.agent);
  run.config.agent.maxToolCalls = Math.min(run.config.agent.maxToolCalls, execution.maxToolCalls);
  run.config.maxSteps = Math.min(run.config.maxSteps, execution.maxSteps);
  const maxCostUsd = Math.min(
    execution.maxCostUsd ?? Infinity,
    run.config.budget?.maxCostUsd ?? Infinity,
    run.config.budget?.maxTaskCostUsd ?? Infinity,
  );
  if (Number.isFinite(maxCostUsd))
    run.config.budget = budgetSchema.parse({
      ...run.config.budget,
      maxCostUsd,
      // The ledger scope gate shares this allowance across concurrent model sessions.
      maxTaskCostUsd: maxCostUsd,
    });
  const capabilities = run.config.capabilities;
  for (const id of execution.skills ?? [])
    if (!capabilities?.skills.some((skill) => skill.id === id && skill.enabled))
      throw new Error(`Unknown enabled skill: ${id}`);
  for (const id of execution.mcpServers ?? [])
    if (!capabilities?.mcpServers.some((server) => server.id === id && server.enabled))
      throw new Error(`Unknown enabled MCP server: ${id}`);
  if (capabilities) {
    capabilities.skills = capabilities.skills.filter(
      (skill) => execution.skills === undefined || execution.skills.includes(skill.id),
    );
    capabilities.mcpServers = capabilities.mcpServers.filter(
      (server) => execution.mcpServers === undefined || execution.mcpServers.includes(server.id),
    );
    for (const server of capabilities.mcpServers)
      if (server.enabled && server.tokenEnv && !execution.environment.includes(server.tokenEnv))
        throw new Error(
          `MCP credential must be an allowed environment reference: ${server.tokenEnv}`,
        );
  }
  if (execution.skills !== undefined)
    for (const bundle of [
      ...Object.values(run.blocks),
      ...Object.values(run.program?.catalog ?? {}),
    ]) {
      bundle.definition.skills = bundle.definition.skills.filter((skill) =>
        execution.skills!.includes(skill),
      );
      bundle.skills = bundle.skills.filter((skill) =>
        execution.skills!.some((id) => skill.path === id || skill.path.startsWith(`${id}/`)),
      );
    }
}
