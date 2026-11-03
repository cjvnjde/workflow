import { queryOptions, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { TaskRequest } from "../../../src/contracts/index.js";
import { client } from "../../shared/api.js";
import { workflowQueryKeys } from "../../shared/query-client.js";
import { updateTaskSessionHistory } from "../sessions/use-session-history.js";

function newerTask(previous: TaskRequest | undefined, incoming: TaskRequest) {
  return previous && previous.revision > incoming.revision ? previous : incoming;
}
function taskOptions(id: string | undefined) {
  return queryOptions({
    queryKey: workflowQueryKeys.task(id),
    queryFn: id ? ({ signal }) => client.task(id, signal) : skipToken,
    structuralSharing: (previous, incoming) =>
      newerTask(previous as TaskRequest | undefined, incoming as TaskRequest),
  });
}

/** Task details refresh through the shared event stream, polling only while disconnected. */
export function useTasks(selectedId: string | undefined, connected: boolean) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState("");
  const task = useQuery({
    ...taskOptions(selectedId),
    refetchInterval: connected ? false : 5000,
  });
  const apply = useCallback(
    (loaded: TaskRequest) => {
      queryClient.setQueryData(taskOptions(loaded.id).queryKey, (current) =>
        newerTask(current, loaded),
      );
      updateTaskSessionHistory(queryClient, loaded);
      void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.sessions });
    },
    [queryClient],
  );
  return {
    task: task.data,
    error: actionError || task.error?.message || "",
    apply,
    setError: setActionError,
  };
}
