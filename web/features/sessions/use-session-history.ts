import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import type {
  SessionHistoryPage,
  SessionSummary,
  TaskRequest,
  WorkflowRun,
} from "../../../src/contracts/index.js";
import { client } from "../../shared/api.js";
import { workflowQueryKeys } from "../../shared/query-client.js";
import {
  mergeSessionPages,
  reconcileSessionEntry,
  updateSessionPages,
  type SessionPages,
} from "./session-state.js";

export function cachedSessionTitle(queryClient: QueryClient, runId: string) {
  for (const [, history] of queryClient.getQueriesData<InfiniteData<SessionHistoryPage>>({
    queryKey: workflowQueryKeys.sessions,
  })) {
    for (const page of history?.pages ?? []) {
      const session = page.items.find((item) => item.runId === runId);
      if (session) return session.title;
    }
  }
  return "Workflow";
}

export function updateRunSessionHistory(queryClient: QueryClient, run: WorkflowRun) {
  queryClient.setQueriesData<SessionPages>({ queryKey: workflowQueryKeys.sessions }, (history) =>
    updateSessionPages(history, (entry) => {
      if (entry.runId !== run.id || entry.runRevision > run.revision) return entry;
      return {
        ...entry,
        title: run.plan.title,
        status: run.status,
        deletedAt: run.deletedAt ?? entry.deletedAt,
        revision: entry.revision - entry.runRevision + run.revision,
        runRevision: run.revision,
      };
    }),
  );
}

export function updateTaskSessionHistory(queryClient: QueryClient, task: TaskRequest) {
  queryClient.setQueriesData<SessionPages>({ queryKey: workflowQueryKeys.sessions }, (history) =>
    updateSessionPages(history, (entry) => {
      if (entry.id !== task.id || entry.revision - entry.runRevision > task.revision) return entry;
      return {
        ...entry,
        runId: task.runId,
        title: entry.runRevision ? entry.title : task.prompt,
        status: entry.runRevision ? entry.status : task.status,
        deletedAt: task.deletedAt ?? entry.deletedAt,
        revision: task.revision + entry.runRevision,
      };
    }),
  );
}

export function useSessionHistory(search: string, connected: boolean) {
  const queryClient = useQueryClient();
  const history = useInfiniteQuery({
    queryKey: [...workflowQueryKeys.sessions, search],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      client.sessions({ search, before: pageParam, limit: 50 }, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: connected ? false : 5000,
    structuralSharing: (_previous, incoming) => {
      const pages = queryClient
        .getQueriesData<SessionPages>({ queryKey: workflowQueryKeys.sessions })
        .flatMap(([, history]) => history?.pages ?? []);
      const received = incoming as SessionPages;
      const normalized = {
        ...received,
        pages: received.pages.map((page) => ({
          ...page,
          items: page.items.map((entry) => {
            const task = entry.id.startsWith("run:")
              ? undefined
              : queryClient.getQueryData<TaskRequest>(workflowQueryKeys.task(entry.id));
            const runId =
              task && task.revision >= entry.revision - entry.runRevision
                ? task.runId
                : entry.runId;
            const run = runId
              ? queryClient.getQueryData<WorkflowRun>(workflowQueryKeys.run(runId))
              : undefined;
            return reconcileSessionEntry(entry, task, run);
          }),
        })),
      };
      return mergeSessionPages({ pages, pageParams: [] }, normalized);
    },
  });
  const entries = useMemo(() => {
    const entries = new Map<string, SessionSummary>();
    for (const page of history.data?.pages ?? []) {
      for (const entry of page.items) {
        const current = entries.get(entry.id);
        if (!current || current.revision <= entry.revision) entries.set(entry.id, entry);
      }
    }
    return [...entries.values()].filter((entry) => !entry.deletedAt);
  }, [history.data]);
  return { ...history, entries };
}
