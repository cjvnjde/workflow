import type { RunEvent, WorkflowRun } from "../../../src/contracts/index.js";
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
