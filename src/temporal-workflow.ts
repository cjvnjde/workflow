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
import { resolveAgentSettings, resolveInputs, runSchema, type BlockResult, type CheckResult, type WorkflowRun, type RecoveryResult, type UsageTotals } from "./domain.js";
import { addUsage, emptyUsage } from "./budget.js";
import { failureMessage } from "./failure-message.js";

export type WorkflowActivities = {
  saveProjection(run: WorkflowRun, event?: { kind: string; message: string; nodeId?: string }): Promise<void>;
  settleAttempt(run: WorkflowRun, commit: boolean): Promise<{ recovery: RecoveryResult; usage: UsageTotals }>;
  executeBlock(run: WorkflowRun): Promise<{ result: BlockResult; checks: CheckResult[] }>;
};

export const pauseSignal = defineSignal("pause");
export const resumeSignal = defineSignal("resume");
export const stateQuery = defineQuery<WorkflowRun>("state");
const { saveProjection, settleAttempt } = proxyActivities<WorkflowActivities>({
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
      if (!bundle.definition.executor && run.config.budget?.maxCostUsd !== undefined && (run.usage?.costUsd ?? 0) >= run.config.budget.maxCostUsd) { throw new Error("Workflow spending limit reached"); }
      resolveInputs(node, run);
      run.visits[node.id] = visit;
      const attempt: WorkflowRun["attempts"][number] = {
        nodeId: node.id,
        visit,
        startedAt: new Date().toISOString(),
        checks: [],
      };
      run.attempts.push(attempt);
      const settle = async (commit: boolean) => {
        const settled = await CancellationScope.nonCancellable(() => settleAttempt(run, commit));
        attempt.recovery = settled.recovery;
        attempt.usage = settled.usage;
        run.usage = run.attempts.reduce((total, item) => addUsage(total, item.usage ?? emptyUsage()), emptyUsage());
        return settled.recovery;
      };
      const waitToResume = async (message: string) => {
        while (true) {
          await condition(() => resumeRequested);
          const recovery = await settle(false);
          if (recovery.status !== "conflict") { break; }
          resumeRequested = false;
          run.error = `Recovery conflicts: ${recovery.conflicts.join(", ")}. Resolve them before resuming.`;
          await checkpoint("interrupted", run.error, node.id);
        }
        paused = false; run.status = "running"; delete run.error;
        await checkpoint("resumed", message, node.id);
      };
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
        attempt.finishedAt = new Date().toISOString();
        attempt.error = failureMessage(error);
        const recovery = await settle(false);
        if (isCancellation(error) && CancellationScope.current().consideredCancelled) { throw error; }
        resumeRequested = false;
        run.status = "interrupted";
        run.error = `${attempt.error}. ${recovery.status === "conflict" ? `Recovery conflicts: ${recovery.conflicts.join(", ")}. Resolve them before resuming.` : `File-tool recovery: ${recovery.status}. Inspect shell, Git and check-command effects before resuming.`} Resume retries this step and consumes another visit.`;
        await checkpoint("interrupted", run.error, node.id);
        await waitToResume("Explicitly retrying the interrupted step. Completed steps are not replayed.");
        continue;
      }
      const recovery = await settle(completion.result.outcome === "pass");
      if (recovery.status === "conflict") {
        attempt.finishedAt = new Date().toISOString();
        attempt.error = `Recovery conflicts: ${recovery.conflicts.join(", ")}`;
        resumeRequested = false;
        run.status = "interrupted"; run.error = attempt.error;
        await checkpoint("interrupted", run.error, node.id);
        await waitToResume("Retrying after recovery conflicts were resolved.");
        continue;
      }
      if (recovery.status === "restored") {
        completion.result.summary = completion.result.summary.slice(0, 13_500) + `\nHost file recovery restored this nonpassing attempt: ${recovery.restored.join(", ").slice(0, 2000)}.`;
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
