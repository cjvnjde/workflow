import type { RunEvent, WorkflowRun } from "../../../src/contracts/index.js";

export function recoveryAdvice(run: Pick<WorkflowRun, "status" | "error" | "attempts">) {
  if (!["failed", "interrupted", "cancelled", "paused"].includes(run.status)) return undefined;
  const diagnostic = [run.error, ...run.attempts.slice(-8).map((a) => a.error)]
    .filter(Boolean)
    .join("\n");
  const rules: [RegExp, string, string][] = [
    [
      /ownership|protected.*(changed|file)|protectedPaths|writablePaths|must be read-only/i,
      "File ownership",
      "Inspect the reported paths. Return test defects to their author; production repair must preserve the reproduction tests. Re-run verification and review after correction.",
    ],
    [
      /MCP|credential|authentication|unauthorized|api.key/i,
      "Capability or credentials",
      "Repair the unavailable connection or select the capabilities this block actually needs, then retry the affected work.",
    ],
    [
      /budget|spending|token.*limit|tool.*limit|timeout|timed out/i,
      "Execution limit",
      "Inspect the last tool result before increasing the relevant limit or splitting the block. Check whether external actions already completed.",
    ],
    [
      /condition after|iteration|visit.*limit/i,
      "Repair limit",
      "Review the repeated feedback and exit condition. Correct the underlying defect or test contract before starting another bounded repair cycle.",
    ],
    [
      /schema|validation|input|output|submit_result/i,
      "Block contract",
      "Compare the producer output with the consumer input schema. Correct the responsible block and re-run its dependent checks.",
    ],
    [
      /conflict|baseline|worktree/i,
      "Workspace or integration",
      "Inspect retained worktrees and baseline changes. Resolve integration explicitly, then verify the combined result.",
    ],
  ];
  const latestAttempt = run.attempts.at(-1);
  const blocked = !latestAttempt?.error && latestAttempt?.result?.disposition === "blocked";
  const match = blocked ? undefined : rules.find(([pattern]) => pattern.test(diagnostic));
  return {
    category: blocked ? "Missing prerequisite" : (match?.[1] ?? "Stopped execution"),
    action: blocked
      ? "The final step reported a missing prerequisite. Read its report and supply the missing implementation, access or input before retrying."
      : (match?.[2] ??
        "Inspect the failing step and its diagnostics. A recovery plan can reuse prior evidence after checking the current files."),
    reuse:
      "Completed attempts remain in history. Resume uses durable checkpoints; a new recovery plan must verify which outputs remain valid. Shell and remote side effects are not automatically undone.",
  };
}

/** Evidence is deliberately scoped: passing a command or authoring step is not task acceptance. */
export function runReport(run: WorkflowRun, events: RunEvent[]) {
  const latest = new Map<string, WorkflowRun["attempts"][number]>();
  for (const attempt of run.attempts) latest.set(attempt.nodeId, attempt);
  const accepted = [...latest.values()].filter(
    (a) => a.result?.disposition === "accepted" && !a.error,
  );
  const unresolved = [...latest.values()].filter(
    (a) => a.error || a.result?.outcome === "retry" || a.result?.outcome === "fail",
  );
  const checks = run.attempts.flatMap((a) =>
    a.checks.map((check) => ({ ...check, nodeId: a.nodeId, visit: a.visit })),
  );
  const decisions = events
    .filter((e) => e.kind === "flow_decision")
    .flatMap((e) => {
      try {
        const value = JSON.parse(e.message);
        return [{ ...value, id: e.id, time: e.time }];
      } catch {
        return [];
      }
    });
  const calls: {
    id: string;
    nodeId?: string;
    description: string;
    tools: string[];
    startedAt: string;
    endedAt?: string;
    workspace?: string;
    durationMs?: number;
    usage?: WorkflowRun["usage"];
  }[] = [];
  const active = new Map<string, number>();
  const workspaces = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "execution_workspace") workspaces.set(event.nodeId ?? "", event.message);
    if (event.kind === "model_session") {
      try {
        const data = JSON.parse(event.message);
        active.set(event.nodeId ?? "", calls.length);
        calls.push({
          id: event.id,
          nodeId: event.nodeId,
          description: `${data.provider}/${data.model} · thinking ${data.thinking}`,
          tools: data.tools ?? [],
          startedAt: event.time,
          workspace: workspaces.get(event.nodeId ?? ""),
        });
      } catch {
        /* Older events remain readable in activity. */
      }
    } else if (event.kind === "model_session_end") {
      const index = active.get(event.nodeId ?? "");
      if (index !== undefined) {
        try {
          Object.assign(calls[index]!, JSON.parse(event.message), {
            endedAt: event.time,
          });
        } catch {
          /* Partial evidence. */
        }
        active.delete(event.nodeId ?? "");
      }
    }
  }
  const modelOverlaps: {
    id: string;
    first: string;
    second: string;
    seconds: number;
    isolated: boolean;
  }[] = [];
  for (let i = 0; i < calls.length; i++)
    for (let j = i + 1; j < calls.length; j++) {
      const a = calls[i]!,
        b = calls[j]!;
      if (a.nodeId === b.nodeId || !a.endedAt || !b.endedAt) continue;
      const ms =
        Math.min(Date.parse(a.endedAt), Date.parse(b.endedAt)) -
        Math.max(Date.parse(a.startedAt), Date.parse(b.startedAt));
      if (ms > 0)
        modelOverlaps.push({
          id: `${a.id}/${b.id}`,
          first: a.nodeId ?? "session",
          second: b.nodeId ?? "session",
          seconds: ms / 1000,
          isolated: !!a.workspace && !!b.workspace && a.workspace !== b.workspace,
        });
    }
  return {
    modelOverlaps,
    accepted,
    unresolved,
    checks,
    decisions,
    calls,
    recovery: recoveryAdvice(run),
  };
}
