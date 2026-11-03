import {
  sessionHistoryQuerySchema,
  type SessionHistoryPage,
  type SessionSummary,
} from "../../contracts/session-schema.js";
import type { taskListSchema } from "../../contracts/task-schema.js";
import type { runListSchema } from "../../contracts/index.js";
import type { z } from "zod";

/** Merge linked tasks and runs before paging so one durable session appears once. */
export function sessionHistory(
  tasks: z.infer<typeof taskListSchema>,
  runs: z.infer<typeof runListSchema>,
  value: unknown,
): SessionHistoryPage {
  const query = sessionHistoryQuerySchema.parse(value);
  const executions = new Map(runs.map((run) => [run.id, run]));
  const linked = new Set(tasks.map((task) => task.runId));
  const entries: SessionSummary[] = [];
  for (const task of tasks) {
    const run = executions.get(task.runId ?? "");
    entries.push({
      id: task.id,
      runId: task.runId,
      title: run?.title ?? task.prompt,
      status: run?.status ?? task.status,
      createdAt: task.createdAt,
      revision: task.revision + (run?.revision ?? 0),
      runRevision: run?.revision ?? 0,
      deletedAt: task.deletedAt ?? run?.deletedAt,
    });
  }
  for (const run of runs) {
    if (linked.has(run.id)) continue;
    entries.push({
      id: `run:${run.id}`,
      runId: run.id,
      title: run.title,
      status: run.status,
      createdAt: run.createdAt,
      revision: run.revision,
      runRevision: run.revision,
      deletedAt: run.deletedAt,
    });
  }
  const search = query.search.toLowerCase();
  const ordered = entries
    .filter((entry) => entry.title.toLowerCase().includes(search))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const cursor = (entry: SessionSummary) => `${entry.createdAt}|${entry.id}`;
  const matching = query.before
    ? ordered.filter((entry) => cursor(entry).localeCompare(query.before!) < 0)
    : ordered;
  const items = matching.slice(0, query.limit);
  return {
    items,
    nextCursor: matching.length > query.limit ? cursor(items.at(-1)!) : null,
  };
}
