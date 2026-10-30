import { computed, shallowRef, watch, toValue, type MaybeRefOrGetter } from "vue";
import { taskListSchema, taskSchema, type TaskRequest } from "../../../src/contracts/index.js";
import type { z } from "zod";
import { request } from "../../shared/api.js";

export function useTasks(source: MaybeRefOrGetter<string | undefined>) {
  const tasks = shallowRef<z.infer<typeof taskListSchema>>([]);
  const task = shallowRef<TaskRequest>();
  const error = shallowRef("");
  const selected = computed(() => toValue(source));
  const apply = (loaded: TaskRequest) => {
    if (
      selected.value === loaded.id &&
      !(task.value?.id === loaded.id && task.value.revision > loaded.revision)
    ) {
      task.value = loaded;
    }
    if (!tasks.value.some((item) => item.id === loaded.id && item.revision > loaded.revision)) {
      tasks.value = [...tasks.value.filter((item) => item.id !== loaded.id), loaded].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
    }
  };
  watch(
    selected,
    (id, _previous, onCleanup) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      task.value = undefined;
      const refresh = async () => {
        const [list, detail] = await Promise.allSettled([
          request("/api/tasks", taskListSchema, { signal: controller.signal }),
          id
            ? request(`/api/tasks/${id}`, taskSchema, {
                signal: controller.signal,
              })
            : Promise.resolve(undefined),
        ]);
        if (controller.signal.aborted) {
          return;
        }
        if (list.status === "fulfilled") {
          const merged = new Map(tasks.value.map((item) => [item.id, item]));
          for (const item of list.value) {
            if ((merged.get(item.id)?.revision ?? -1) <= item.revision) {
              merged.set(item.id, item);
            }
          }
          tasks.value = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          error.value = "";
        } else {
          error.value = list.reason instanceof Error ? list.reason.message : "Could not load tasks";
        }
        if (detail.status === "fulfilled" && detail.value) {
          apply(detail.value);
        }
        if (detail.status === "rejected") {
          error.value =
            detail.reason instanceof Error ? detail.reason.message : "Could not load this task";
        }
        timer = setTimeout(() => {
          void refresh();
        }, 1000);
      };
      void refresh();
      onCleanup(() => {
        controller.abort();
        clearTimeout(timer);
      });
    },
    { immediate: true, flush: "sync" },
  );
  return { tasks, task, apply, error };
}
