import { queryOptions, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import type { taskListSchema, TaskRequest } from "../../../src/contracts/index.js";
import type { z } from "zod";
import { client } from "../../shared/api.js";
import { workflowQueryKeys } from "../../shared/query-client.js";

type TaskList = z.infer<typeof taskListSchema>;
const emptyTasks: TaskList = [];

/** Keep deletion markers and newer revisions when a response races a mutation or SSE refresh. */
function mergeTasks(previous: TaskList, incoming: TaskList): TaskList {
  const tasks = new Map(previous.map((task) => [task.id, task]));
  for (const task of incoming) {
    if ((tasks.get(task.id)?.revision ?? -1) <= task.revision) tasks.set(task.id, task);
  }
  return [...tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function newerTask(previous: TaskRequest | undefined, incoming: TaskRequest) {
  return previous && previous.revision > incoming.revision ? previous : incoming;
}
const tasksOptions = queryOptions({
  queryKey: workflowQueryKeys.tasks,
  queryFn: ({ signal }) => client.tasks(signal),
  structuralSharing: (previous, incoming) =>
    mergeTasks((previous as TaskList | undefined) ?? emptyTasks, incoming as TaskList),
  refetchInterval: 1000,
});
function taskOptions(id: string | undefined) {
  return queryOptions({
    queryKey: workflowQueryKeys.task(id),
    queryFn: id ? ({ signal }) => client.task(id, signal) : skipToken,
    structuralSharing: (previous, incoming) =>
      newerTask(previous as TaskRequest | undefined, incoming as TaskRequest),
    refetchInterval: 1000,
  });
}

/** Query cancels superseded selections and owns both polling and revisioned task history. */
export function useTasks(selectedId: string | undefined) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState("");
  const tasks = useQuery(tasksOptions);
  const task = useQuery(taskOptions(selectedId));
  const apply = useCallback(
    (loaded: TaskRequest) => {
      queryClient.setQueryData(taskOptions(loaded.id).queryKey, (current) =>
        newerTask(current, loaded),
      );
      queryClient.setQueryData(tasksOptions.queryKey, (current) =>
        mergeTasks(current ?? emptyTasks, [loaded]),
      );
      void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.tasks });
    },
    [queryClient],
  );
  useEffect(() => {
    if (!task.data) return;
    const loaded = task.data;
    queryClient.setQueryData(tasksOptions.queryKey, (current) =>
      mergeTasks(current ?? emptyTasks, [loaded]),
    );
  }, [queryClient, task.data]);
  return {
    tasks: tasks.data ?? emptyTasks,
    task: task.data,
    error: actionError || task.error?.message || tasks.error?.message || "",
    apply,
    setError: setActionError,
  };
}
