import type { ExecutionOperation, WorkflowRun } from "../src/contracts.js";
export interface TimelineRow {
  key: string;
  label: string;
  nodeId?: string;
  visit?: number;
  operationKey?: string;
  start: number;
  end: number;
  settled: boolean;
  state: string;
}
export function executionTimeline(
  run: WorkflowRun,
  operations: ExecutionOperation[],
  mode: "time" | "sequence",
) {
  const rows: TimelineRow[] = [];
  const grouped = new Map<string, TimelineRow[]>();
  const visitKey = (nodeId: string | undefined, visit: number | undefined) =>
    JSON.stringify([nodeId, visit]);
  operations.forEach((item, index) => {
    if (!item.startedAt || !Number.isFinite(Date.parse(item.startedAt))) return;
    const key = visitKey(item.nodeId, item.visit);
    const children = grouped.get(key) ?? [];
    children.push(operationRow(item, index, mode));
    grouped.set(key, children);
  });
  for (const attempt of run.attempts) {
    const start = Date.parse(attempt.startedAt),
      end = attempt.finishedAt ? Date.parse(attempt.finishedAt) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const key = visitKey(attempt.nodeId, attempt.visit);
    const children = grouped.get(key) ?? [];
    grouped.delete(key);
    rows.push({
      key: `visit/${attempt.nodeId}/${attempt.visit}`,
      label: `${run.plan.nodes.find((item) => item.id === attempt.nodeId)?.label ?? attempt.nodeId} · visit ${attempt.visit}`,
      nodeId: attempt.nodeId,
      visit: attempt.visit,
      start:
        mode === "time" ? start : (children[0]?.start ?? operations.length),
      end:
        mode === "time"
          ? Math.max(start, end)
          : (children.at(-1)?.end ?? operations.length),
      settled: !!attempt.finishedAt,
      state: attempt.error
        ? "failed"
        : attempt.finishedAt
          ? "completed"
          : "started",
    });
    for (const child of children) rows.push(child);
  }
  for (const children of grouped.values())
    for (const child of children) rows.push(child);
  let start = Infinity,
    end = -Infinity;
  for (const row of rows) {
    start = Math.min(start, row.start);
    end = Math.max(end, row.end);
  }
  return {
    rows,
    start: rows.length ? start : 0,
    end: rows.length ? Math.max(start + 1, end) : 1,
  };
}
function operationRow(
  item: ExecutionOperation,
  index: number,
  mode: "time" | "sequence",
): TimelineRow {
  const start = Date.parse(item.startedAt!),
    duration = item.durationMs;
  const end =
    duration !== undefined
      ? start + duration
      : item.finishedAt
        ? Date.parse(item.finishedAt)
        : start;
  return {
    key: item.key,
    operationKey: item.key,
    nodeId: item.nodeId,
    visit: item.visit,
    label: item.name,
    start: mode === "time" ? start : index,
    end: mode === "time" ? Math.max(start, end) : index + 1,
    settled: item.finishedAt !== undefined || duration !== undefined,
    state: item.state,
  };
}
