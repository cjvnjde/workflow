import type { z } from "zod";
import type { RunEvent, WorkflowRun } from "../../../src/contracts/index.js";
import type { runListSchema } from "../../shared/api.js";

export type RunList = z.infer<typeof runListSchema>;

/** Retain revisioned deletion markers so late responses cannot restore history. */
export function mergeRuns(previous: RunList, incoming: RunList): RunList {
  const runs = new Map(previous.map((run) => [run.id, run]));
  for (const run of incoming) {
    const current = runs.get(run.id);
    if (!current || run.revision >= current.revision) {
      runs.set(run.id, run);
    }
  }
  return [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function newerRun(
  current: WorkflowRun | undefined,
  loaded: WorkflowRun,
  selectedId?: string,
) {
  if (
    loaded.id !== selectedId ||
    (current?.id === loaded.id &&
      (current.revision > loaded.revision ||
        (current.revision === loaded.revision &&
          (current.usage?.requests ?? 0) > (loaded.usage?.requests ?? 0))))
  ) {
    return current;
  }
  return loaded;
}

export function mergeEvents(previous: RunEvent[], incoming: RunEvent[]) {
  return [...new Map([...previous, ...incoming].map((event) => [event.id, event])).values()]
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(-500);
}
