import {
  queryOptions,
  skipToken,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { z } from "zod";
import { describeActivity } from "../features/execution/activity.js";
import type { RunEvent, WorkflowRun } from "../../src/contracts/index.js";
import { client, type projectSchema } from "../shared/api.js";
import { workflowQueryKeys } from "../shared/query-client.js";
import { mergeEvents, mergeRuns, newerRun, type RunList } from "../features/execution/run-state.js";

const refreshKinds: Record<string, true> = {
  draft: true,
  approved: true,
  node_start: true,
  node_end: true,
  group_state: true,
  run_end: true,
  rejected: true,
  paused: true,
  resumed: true,
  interrupted: true,
  recovery: true,
  usage: true,
  run_deleted: true,
};
export type WorkflowNotice = {
  id: string;
  runId: string;
  title: string;
  message: string;
  time: string;
  read: boolean;
};
export type TaskStream = { activity: string; text: string; kind: string; time: string };

type WorkflowLocalState = {
  selectedId: string | undefined;
  usageRevision: number;
  setupRevision: number;
  liveText: string;
  liveTextByNode: Record<string, string>;
  coordinatorText: string;
  coordinatorActivity: string;
  connected: boolean;
  error: string;
  taskStreams: Record<string, TaskStream>;
  notices: WorkflowNotice[];
};
type WorkflowSnapshot = WorkflowLocalState & {
  project: z.infer<typeof projectSchema> | undefined;
  runs: RunList;
  run: WorkflowRun | undefined;
  events: RunEvent[];
};

const emptyRuns: RunList = [];
const emptyEvents: RunEvent[] = [];
const projectOptions = queryOptions({
  queryKey: workflowQueryKeys.project,
  queryFn: ({ signal }) => client.project(signal),
});
const runsOptions = queryOptions({
  queryKey: workflowQueryKeys.runs,
  queryFn: ({ signal }) => client.runs(signal),
  structuralSharing: (previous, incoming) =>
    mergeRuns((previous as RunList | undefined) ?? emptyRuns, incoming as RunList),
});
function runOptions(id: string | undefined) {
  return queryOptions({
    queryKey: workflowQueryKeys.run(id),
    queryFn: id ? ({ signal }) => client.run(id, signal) : skipToken,
    structuralSharing: (previous, incoming) =>
      newerRun(previous as WorkflowRun | undefined, incoming as WorkflowRun, id),
  });
}
function eventsOptions(id: string | undefined) {
  return queryOptions({
    queryKey: workflowQueryKeys.events(id),
    queryFn: id ? ({ signal }) => client.events(id, signal) : skipToken,
    structuralSharing: (previous, incoming) =>
      mergeEvents((previous as RunEvent[] | undefined) ?? emptyEvents, incoming as RunEvent[]),
  });
}
function mergeRunSummary(queryClient: QueryClient, loaded: WorkflowRun) {
  const { id, status, mode, createdAt, updatedAt, revision, cursor, deletedAt } = loaded;
  queryClient.setQueryData(runsOptions.queryKey, (previous) =>
    mergeRuns(previous ?? emptyRuns, [
      {
        id,
        status,
        mode,
        createdAt,
        updatedAt,
        revision,
        cursor,
        deletedAt,
        title: loaded.plan.title,
        task: loaded.plan.task,
      },
    ]),
  );
}

/** Only transient stream/UI state lives outside the Query cache. */
function createWorkflowStore(queryClient: QueryClient, initialId?: string) {
  let snapshot: WorkflowLocalState = {
    selectedId: initialId,
    usageRevision: 0,
    setupRevision: 0,
    liveText: "",
    liveTextByNode: {},
    coordinatorText: "",
    coordinatorActivity: "",
    connected: false,
    error: "",
    taskStreams: {},
    notices: [],
  };
  const listeners = new Set<() => void>();
  const stepSummaries = new Map<string, string>();
  function update(patch: Partial<WorkflowLocalState>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  function applyRun(loaded: WorkflowRun) {
    queryClient.setQueryData(runOptions(loaded.id).queryKey, (current) =>
      newerRun(current, loaded, loaded.id),
    );
    mergeRunSummary(queryClient, loaded);
  }
  async function refreshRuns() {
    await queryClient.invalidateQueries({ queryKey: workflowQueryKeys.runs });
  }
  async function refreshProject() {
    await queryClient.invalidateQueries({ queryKey: workflowQueryKeys.project });
  }
  function refreshHistory(includeEvents: boolean) {
    void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.runs });
    const id = snapshot.selectedId;
    if (id) {
      void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.run(id) });
      if (includeEvents)
        void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.events(id) });
    }
  }
  function start() {
    const lifetime = new AbortController();
    const source = client.subscribe(
      (event) => {
        if (lifetime.signal.aborted) return;
        if (event.kind === "setup_state") {
          update({
            setupRevision: snapshot.setupRevision + 1,
            usageRevision: snapshot.usageRevision + 1,
          });
          void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.setup });
          void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.usage });
          return;
        }
        if (["usage", "model_session_end", "task_state", "run_end"].includes(event.kind)) {
          update({ usageRevision: snapshot.usageRevision + 1 });
          void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.usage });
        }
        if (event.kind === "run_deleted") {
          update({ notices: snapshot.notices.filter((item) => item.runId !== event.runId) });
          stepSummaries.delete(event.runId);
        }
        if (event.kind === "node_end") {
          stepSummaries.set(event.runId, event.message.split("\n").slice(1).join("\n"));
        }
        if (
          ["run_end", "interrupted", "paused"].includes(event.kind) &&
          !snapshot.notices.some((item) => item.id === event.id)
        ) {
          const runs = queryClient.getQueryData(runsOptions.queryKey) ?? emptyRuns;
          const title = runs.find((item) => item.id === event.runId)?.title ?? "Workflow";
          const summary = stepSummaries.get(event.runId);
          update({
            notices: [
              {
                id: event.id,
                runId: event.runId,
                title,
                time: event.time,
                read: false,
                message: `${event.message}${summary ? ` · ${summary}` : ""}`,
              },
              ...snapshot.notices,
            ].slice(0, 30),
          });
        }
        if (event.runId.startsWith("task:")) {
          const id = event.runId.slice(5);
          const previous = snapshot.taskStreams[id];
          update({
            taskStreams: {
              ...snapshot.taskStreams,
              [id]: {
                activity:
                  event.kind === "text_delta"
                    ? (previous?.activity ?? "Understanding your request…")
                    : describeActivity(event).preview,
                text:
                  event.kind === "text_delta"
                    ? ((previous?.text ?? "") + event.message).slice(-8000)
                    : event.kind === "agent_message"
                      ? event.message
                      : (previous?.text ?? ""),
                kind: event.kind === "text_delta" ? (previous?.kind ?? "planning") : event.kind,
                time: event.time,
              },
            },
          });
          if (event.kind === "task_state") {
            void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.tasks });
            void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.task(id) });
            refreshHistory(false);
          }
          return;
        }
        if (event.runId === "coordinator") {
          if (event.kind === "text_delta") {
            update({ coordinatorText: (snapshot.coordinatorText + event.message).slice(-8000) });
          } else {
            update({
              coordinatorActivity: describeActivity(event).preview.slice(0, 2000),
              ...(event.kind === "agent_message"
                ? { coordinatorText: event.message.slice(-8000) }
                : {}),
            });
          }
          return;
        }
        if (event.runId === snapshot.selectedId) {
          if (event.kind === "text_delta") {
            if (event.nodeId)
              update({
                liveTextByNode: {
                  ...snapshot.liveTextByNode,
                  [event.nodeId]: (
                    (snapshot.liveTextByNode[event.nodeId] ?? "") + event.message
                  ).slice(-16_000),
                },
              });
            else update({ liveText: (snapshot.liveText + event.message).slice(-16_000) });
            return;
          }
          if (
            ["agent_message", "node_start", "node_end", "run_end", "interrupted"].includes(
              event.kind,
            )
          ) {
            if (event.kind === "run_end") update({ liveText: "", liveTextByNode: {} });
            else if (event.nodeId) {
              const next = { ...snapshot.liveTextByNode };
              delete next[event.nodeId];
              update({ liveTextByNode: next });
            } else update({ liveText: "" });
          }
          queryClient.setQueryData(eventsOptions(event.runId).queryKey, (previous) =>
            mergeEvents(previous ?? emptyEvents, [event]),
          );
        }
        if (refreshKinds[event.kind]) refreshHistory(false);
      },
      {
        signal: lifetime.signal,
        onOpen: () => {
          if (lifetime.signal.aborted) return;
          update({ connected: true });
          void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.project });
          void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.tasks });
          void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.taskDetails });
          void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.setup });
          void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.usage });
          refreshHistory(true);
        },
        onError: () => {
          if (!lifetime.signal.aborted) update({ connected: false });
        },
      },
    );
    return () => {
      lifetime.abort();
      source.close();
    };
  }
  return {
    getLocalSnapshot: () => snapshot,
    getSnapshot: (): WorkflowSnapshot => ({
      ...snapshot,
      project: queryClient.getQueryData(projectOptions.queryKey),
      runs: queryClient.getQueryData(runsOptions.queryKey) ?? emptyRuns,
      run: queryClient.getQueryData(runOptions(snapshot.selectedId).queryKey),
      events: queryClient.getQueryData(eventsOptions(snapshot.selectedId).queryKey) ?? emptyEvents,
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    selectRun: (id?: string) => {
      if (id === snapshot.selectedId) return;
      update({ selectedId: id, liveText: "", liveTextByNode: {} });
    },
    applyRun,
    refreshRuns,
    refreshProject,
    setError: (error: string) => update({ error }),
    setCoordinatorText: (coordinatorText: string) => update({ coordinatorText }),
    setCoordinatorActivity: (coordinatorActivity: string) => update({ coordinatorActivity }),
    markNoticesRead: () =>
      update({ notices: snapshot.notices.map((item) => ({ ...item, read: true })) }),
  };
}

/** Query owns revisioned server state; one reconnecting stream owns transient text/notices. */
export function useWorkflowData(initialId?: string) {
  const queryClient = useQueryClient();
  const [store] = useState(() => createWorkflowStore(queryClient, initialId));
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getLocalSnapshot,
    store.getLocalSnapshot,
  );
  const refetchInterval = snapshot.connected ? false : 5000;
  const project = useQuery(projectOptions);
  const runs = useQuery({ ...runsOptions, refetchInterval });
  const run = useQuery({ ...runOptions(snapshot.selectedId), refetchInterval });
  const events = useQuery({ ...eventsOptions(snapshot.selectedId), refetchInterval });
  useEffect(() => store.start(), [store]);
  useEffect(() => {
    if (run.data) mergeRunSummary(queryClient, run.data);
  }, [queryClient, run.data]);
  const loadError = project.error ?? runs.error ?? run.error ?? events.error;
  return {
    ...snapshot,
    project: project.data,
    runs: runs.data ?? emptyRuns,
    run: run.data,
    events: events.data ?? emptyEvents,
    error: snapshot.error || loadError?.message || "",
    ...store,
  };
}
