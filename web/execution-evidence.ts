import type { WorkflowRun } from "../src/contracts.js";

/** Intervals are actual step attempts, not planned graph branches. */
export function executionEvidence(
  run: Pick<WorkflowRun, "status" | "updatedAt"> & {
    plan: { nodes: { id: string; label: string }[] };
    attempts: {
      nodeId: string;
      visit: number;
      startedAt: string;
      finishedAt?: string;
      error?: string;
      result?: { outcome: string; disposition?: string };
    }[];
  },
  now: number,
) {
  const terminal = !["running", "pausing"].includes(run.status);
  const labelFor = (id: string) => {
    const label = run.plan.nodes.find((node) => node.id === id)?.label;
    if (!label) return id;
    return run.plan.nodes.filter((node) => node.label === label).length > 1
      ? `${label} · ${id}`
      : label;
  };
  const intervals = run.attempts.map((attempt) => {
    const start = Date.parse(attempt.startedAt);
    const end = Date.parse(
      attempt.finishedAt ??
        (terminal ? run.updatedAt : new Date(now).toISOString()),
    );
    return {
      nodeId: attempt.nodeId,
      visit: attempt.visit,
      start,
      end: Math.max(start, end),
      outcome: attempt.error
        ? "Execution error"
        : attempt.result?.disposition === "blocked"
          ? "Blocked"
          : attempt.result?.disposition === "accepted"
            ? "Accepted"
            : attempt.result?.disposition === "work-completed"
              ? "Work completed · acceptance separate"
              : attempt.result?.outcome === "retry"
                ? "Changes requested"
                : attempt.result?.outcome === "fail"
                  ? "Not accepted"
                  : attempt.result?.outcome === "pass"
                    ? "Step passed"
                    : terminal
                      ? "Interrupted"
                      : "Running",
      label: labelFor(attempt.nodeId),
    };
  });
  const overlaps: { first: string; second: string; seconds: number }[] = [];
  for (let i = 0; i < intervals.length; i++)
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i]!,
        b = intervals[j]!;
      if (a.nodeId === b.nodeId) continue;
      const ms = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (ms > 0)
        overlaps.push({
          first: `${a.label} (visit ${a.visit})`,
          second: `${b.label} (visit ${b.visit})`,
          seconds: ms / 1000,
        });
    }
  return { intervals, overlaps };
}
