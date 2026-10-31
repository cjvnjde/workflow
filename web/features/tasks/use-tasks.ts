import { useEffect, useState, useSyncExternalStore } from "react";
import { taskListSchema, taskSchema, type TaskRequest } from "../../../src/contracts/index.js";
import type { z } from "zod";
import { request } from "../../shared/api.js";

type TasksSnapshot = {
  tasks: z.infer<typeof taskListSchema>;
  task: TaskRequest | undefined;
  selectedId: string | undefined;
  error: string;
};

function createTasksStore() {
  let snapshot: TasksSnapshot = { tasks: [], task: undefined, selectedId: undefined, error: "" };
  const listeners = new Set<() => void>();
  function update(patch: Partial<TasksSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  function apply(loaded: TaskRequest) {
    const patch: Partial<TasksSnapshot> = {};
    if (
      snapshot.selectedId === loaded.id &&
      !(snapshot.task?.id === loaded.id && snapshot.task.revision > loaded.revision)
    ) {
      patch.task = loaded;
    }
    if (!snapshot.tasks.some((item) => item.id === loaded.id && item.revision > loaded.revision)) {
      patch.tasks = [...snapshot.tasks.filter((item) => item.id !== loaded.id), loaded].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt),
      );
    }
    update(patch);
  }
  function start(id: string | undefined) {
    const controller = new AbortController();
    let timer: number | undefined;
    update({ selectedId: id, task: undefined });
    async function refresh() {
      const [list, detail] = await Promise.allSettled([
        request("/api/tasks", taskListSchema, { signal: controller.signal }),
        id
          ? request(`/api/tasks/${id}`, taskSchema, { signal: controller.signal })
          : Promise.resolve(undefined),
      ]);
      if (controller.signal.aborted) return;
      if (list.status === "fulfilled") {
        const merged = new Map(snapshot.tasks.map((item) => [item.id, item]));
        for (const item of list.value) {
          if ((merged.get(item.id)?.revision ?? -1) <= item.revision) merged.set(item.id, item);
        }
        update({
          tasks: [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          error: "",
        });
      } else {
        update({
          error: list.reason instanceof Error ? list.reason.message : "Could not load tasks",
        });
      }
      if (detail.status === "fulfilled" && detail.value) apply(detail.value);
      if (detail.status === "rejected") {
        update({
          error:
            detail.reason instanceof Error ? detail.reason.message : "Could not load this task",
        });
      }
      timer = window.setTimeout(() => void refresh(), 1000);
    }
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    apply,
    setError: (error: string) => update({ error }),
  };
}

/** Poll task history and the selected task without applying superseded requests. */
export function useTasks(selectedId: string | undefined) {
  const [store] = useState(createTasksStore);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => store.start(selectedId), [store, selectedId]);
  return {
    tasks: snapshot.tasks,
    task: snapshot.task?.id === selectedId ? snapshot.task : undefined,
    error: snapshot.error,
    apply: store.apply,
    setError: store.setError,
  };
}
