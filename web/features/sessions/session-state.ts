import type { InfiniteData } from "@tanstack/react-query";
import type {
  SessionHistoryPage,
  SessionSummary,
  TaskRequest,
  WorkflowRun,
} from "../../../src/contracts/index.js";

export type SessionPages = InfiniteData<SessionHistoryPage>;

/** Detail reads and mutation responses remain authoritative before a task/run link reaches history. */
export function reconcileSessionEntry(
  entry: SessionSummary,
  task: TaskRequest | undefined,
  run:
    | (Pick<WorkflowRun, "id" | "revision" | "status" | "deletedAt"> & {
        plan: Pick<WorkflowRun["plan"], "title">;
      })
    | undefined,
): SessionSummary {
  let next = entry;
  if (task && task.id === entry.id && task.revision >= entry.revision - entry.runRevision) {
    const linked = task.runId === entry.runId && !!entry.runId;
    next = {
      ...entry,
      runId: task.runId,
      title: linked ? entry.title : task.prompt,
      status: linked ? entry.status : task.status,
      deletedAt: task.deletedAt ?? entry.deletedAt,
      runRevision: linked ? entry.runRevision : 0,
      revision: task.revision + (linked ? entry.runRevision : 0),
    };
  }
  if (run && run.id === next.runId && run.revision >= next.runRevision) {
    next = {
      ...next,
      title: run.plan.title,
      status: run.status,
      deletedAt: run.deletedAt ?? next.deletedAt,
      revision: next.revision - next.runRevision + run.revision,
      runRevision: run.revision,
    };
  }
  return next;
}

/** Late pages cannot undo a confirmed mutation or resurrect a deleted session. */
export function mergeSessionPages(
  previous: SessionPages | undefined,
  incoming: SessionPages,
): SessionPages {
  if (!previous) return incoming;
  const known = new Map<string, SessionSummary>();
  for (const page of previous.pages) {
    for (const entry of page.items) {
      const current = known.get(entry.id);
      if (!current || current.revision < entry.revision) known.set(entry.id, entry);
    }
  }
  return {
    ...incoming,
    pages: incoming.pages.map((page) => ({
      ...page,
      items: page.items.map((entry) => {
        const current = known.get(entry.id);
        return current && current.revision > entry.revision ? current : entry;
      }),
    })),
  };
}

export function updateSessionPages(
  history: SessionPages | undefined,
  update: (entry: SessionSummary) => SessionSummary,
): SessionPages | undefined {
  if (!history) return history;
  let changed = false;
  const pages = history.pages.map((page) => {
    let changedPage = false;
    const items = page.items.map((entry) => {
      const next = update(entry);
      changedPage ||= next !== entry;
      return next;
    });
    changed ||= changedPage;
    return changedPage ? { ...page, items } : page;
  });
  return changed ? { ...history, pages } : history;
}
