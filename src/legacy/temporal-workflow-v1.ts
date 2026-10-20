import {
  ApplicationFailure,
  CancellationScope,
  CancelledFailure,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import { resolveAgentSettings, resolveInputs, runSchema, type BlockResult, type CheckResult, type WorkflowRun } from "./domain-v1.js";
import { failureMessage } from "./failure-message-v1.js";

export type WorkflowActivities = {
  saveProjection(run: WorkflowRun, event?: { kind: string; message: string; nodeId?: string }): Promise<void>;
  executeBlock(run: WorkflowRun): Promise<{ result: BlockResult; checks: CheckResult[] }>;
};

export const pauseSignal = defineSignal("pause");
export const resumeSignal = defineSignal("resume");
export const stateQuery = defineQuery<WorkflowRun>("state");
const { saveProjection } = proxyActivities<WorkflowActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 5 },
});

export async function executeWorkflow(input: WorkflowRun) {
  const parsed = runSchema.safeParse(input);
  if (!parsed.success) {
    throw ApplicationFailure.nonRetryable("Invalid workflow execution snapshot", "InvalidSnapshot");
  }
  const run = parsed.data;
  let paused = false;
  let resumeRequested = false;
  let cancelled = false;
  const changed = () => {
    run.revision += 1;
    run.updatedAt = new Date().toISOString();
  };
  setHandler(stateQuery, () => run);
  setHandler(pauseSignal, () => {
    if (run.status === "running" || run.status === "pausing") {
      paused = true;
      run.status = "pausing";
      changed();
    }
  });
  setHandler(resumeSignal, () => {
    if (run.status === "paused" || run.status === "pausing" || run.status === "interrupted") {
      paused = false;
      resumeRequested = run.status === "interrupted";
      if (run.status === "pausing") { run.status = "running"; }
      changed();
    }
  });
  const checkpoint = async (kind: string, message: string, nodeId?: string) => {
    changed();
    await saveProjection(run, { kind, message, nodeId });
  };

  try {
    await checkpoint("approved", run.mode === "demo" ? "Approved for DEMO simulation only." : "Approved. Temporal is executing the frozen workflow.");
    while (run.cursor !== "$complete" && run.cursor !== "$failed") {
      if (paused) {
        run.status = "paused";
        await checkpoint("paused", "Paused at a safe step boundary. Resume continues without replaying completed steps.");
        await condition(() => !paused);
        run.status = "running";
        await checkpoint("resumed", "Workflow resumed.");
      }
      resumeRequested = false;
      const node = run.plan.nodes.find((candidate) => candidate.id === run.cursor);
      const bundle = node && run.blocks[node.block];
      if (!node || !bundle) {
        throw new Error(`Unknown execution node or block: ${run.cursor}`);
      }
      const visit = (run.visits[node.id] ?? 0) + 1;
      if (visit > node.maxVisits || run.attempts.length >= run.config.maxSteps) {
        throw new Error(`Workflow iteration budget exhausted at ${node.id}`);
      }
      resolveInputs(node, run);
      run.visits[node.id] = visit;
      const attempt: WorkflowRun["attempts"][number] = {
        nodeId: node.id,
        visit,
        startedAt: new Date().toISOString(),
        checks: [],
      };
      run.attempts.push(attempt);
      await checkpoint("node_start", `${node.label} · visit ${visit}/${node.maxVisits}`, node.id);
      const settings = resolveAgentSettings(run.config.agent, bundle.definition.agent, node.agent);
      const activities = proxyActivities<WorkflowActivities>({
        startToCloseTimeout: settings.timeoutMs + 5000,
        heartbeatTimeout: "10 seconds",
        cancellationType: "WAIT_CANCELLATION_COMPLETED",
        // Agent/check activities can mutate files. Never blindly retry them after a crash.
        retry: { maximumAttempts: 1 },
      });
      let completion: Awaited<ReturnType<WorkflowActivities["executeBlock"]>>;
      try {
        completion = await activities.executeBlock(run);
      } catch (error) {
        if (isCancellation(error) && CancellationScope.current().consideredCancelled) {
          throw error;
        }
        resumeRequested = false;
        attempt.finishedAt = new Date().toISOString();
        attempt.error = failureMessage(error);
        run.status = "interrupted";
        run.error = `${attempt.error}. Inspect partial file changes before resuming; resume retries this step and consumes another visit.`;
        await checkpoint("interrupted", run.error, node.id);
        await condition(() => resumeRequested);
        paused = false;
        run.status = "running";
        delete run.error;
        await checkpoint("resumed", "Explicitly retrying the interrupted step. Completed steps are not replayed.", node.id);
        continue;
      }
      attempt.finishedAt = new Date().toISOString();
      attempt.result = completion.result;
      attempt.checks = completion.checks;
      const evidence = completion.checks.map((check) => `${check.command}: exit ${check.exitCode}, expected ${check.expected}\n${check.output}`).join("\n\n");
      run.artifacts[node.id] = {
        ...completion.result.artifacts,
        summary: completion.result.summary + (evidence ? `\n\nHost checks:\n${evidence}` : ""),
      };
      run.cursor = node.on[completion.result.outcome];
      await checkpoint("node_end", `${completion.result.outcome.toUpperCase()} → ${run.cursor}\n${completion.result.summary}`, node.id);
    }
    run.status = run.cursor === "$complete" ? "completed" : "failed";
  } catch (error) {
    cancelled = isCancellation(error) || CancellationScope.current().consideredCancelled;
    run.status = cancelled ? "cancelled" : "failed";
    run.error = failureMessage(error);
  }
  await CancellationScope.nonCancellable(async () => {
    await checkpoint("run_end", `${run.status.toUpperCase()}${run.error ? `: ${run.error}` : ""}`);
  });

  if (cancelled) {
    throw new CancelledFailure("Cancelled by user");
  }

  return run;
}
