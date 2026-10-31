import { useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { describeActivity } from "../features/execution/activity.js";
import {
  eventSchema,
  runSchema,
  type RunEvent,
  type WorkflowRun,
} from "../../src/contracts/index.js";
import { client, projectSchema, request, runListSchema } from "../shared/api.js";
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

type WorkflowSnapshot = {
  project: z.infer<typeof projectSchema> | undefined;
  runs: RunList;
  selectedId: string | undefined;
  run: WorkflowRun | undefined;
  events: RunEvent[];
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

function createWorkflowStore(initialId?: string) {
  let snapshot: WorkflowSnapshot = {
    project: undefined,
    runs: [],
    selectedId: initialId,
    run: undefined,
    events: [],
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
  let controller: AbortController | undefined;
  let scheduleRefresh: ((includeEvents: boolean) => void) | undefined;
  let loadError = "";
  function update(patch: Partial<WorkflowSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  function applyRun(loaded: WorkflowRun) {
    const { id, status, mode, createdAt, updatedAt, revision, cursor, deletedAt } = loaded;
    update({
      run: newerRun(snapshot.run, loaded, snapshot.selectedId),
      runs: mergeRuns(snapshot.runs, [
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
    });
  }
  async function refreshRuns() {
    const signal = controller?.signal;
    const loaded = await request("/api/runs", runListSchema, { signal });
    if (!signal?.aborted) update({ runs: mergeRuns(snapshot.runs, loaded) });
  }
  async function refreshProject() {
    const signal = controller?.signal;
    const loaded = await request("/api/project", projectSchema, { signal });
    if (!signal?.aborted) {
      update({ project: loaded, ...(snapshot.error === loadError ? { error: "" } : {}) });
    }
  }
  function start() {
    const lifetime = new AbortController();
    controller = lifetime;
    const options = { signal: lifetime.signal };
    let running = false;
    let pending = false;
    let pendingEvents = false;
    let timer: number | undefined;
    function report(failure: unknown) {
      if (lifetime.signal.aborted) return;
      loadError = failure instanceof Error ? failure.message : String(failure);
      update({ error: loadError });
    }
    async function refresh() {
      timer = undefined;
      if (lifetime.signal.aborted || running) return;
      running = true;
      const id = snapshot.selectedId;
      const includeEvents = pendingEvents;
      pending = false;
      pendingEvents = false;
      const [list, detail, history] = await Promise.allSettled([
        request("/api/runs", runListSchema, options),
        id ? request(`/api/runs/${id}`, runSchema, options) : Promise.resolve(undefined),
        id && includeEvents
          ? request(`/api/runs/${id}/events`, z.array(eventSchema), options)
          : Promise.resolve(undefined),
      ]);
      if (!lifetime.signal.aborted) {
        if (
          [list, detail, history].every((result) => result.status === "fulfilled") &&
          snapshot.error === loadError
        )
          update({ error: "" });
        if (list.status === "fulfilled") update({ runs: mergeRuns(snapshot.runs, list.value) });
        else report(list.reason);
        if (detail.status === "fulfilled") {
          if (detail.value) applyRun(detail.value);
        } else if (id === snapshot.selectedId) report(detail.reason);
        if (history.status === "fulfilled") {
          if (history.value && id === snapshot.selectedId) {
            update({ events: mergeEvents(snapshot.events, history.value) });
          }
        } else if (id === snapshot.selectedId) report(history.reason);
      }
      running = false;
      if (!lifetime.signal.aborted && pending) timer = window.setTimeout(() => void refresh(), 80);
    }
    function schedule(includeEvents: boolean) {
      pending = true;
      pendingEvents ||= includeEvents;
      if (!running && timer === undefined) timer = window.setTimeout(() => void refresh(), 80);
    }
    scheduleRefresh = schedule;
    void refreshProject().catch(report);
    void refreshRuns().catch(report);
    const source = client.subscribe(
      (event) => {
        if (lifetime.signal.aborted) return;
        if (event.kind === "setup_state") {
          update({
            setupRevision: snapshot.setupRevision + 1,
            usageRevision: snapshot.usageRevision + 1,
          });
          return;
        }
        if (["usage", "model_session_end", "task_state", "run_end"].includes(event.kind)) {
          update({ usageRevision: snapshot.usageRevision + 1 });
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
          const title = snapshot.runs.find((item) => item.id === event.runId)?.title ?? "Workflow";
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
          if (event.kind === "task_state") schedule(false);
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
          update({ events: mergeEvents(snapshot.events, [event]) });
        }
        if (refreshKinds[event.kind]) schedule(false);
      },
      {
        signal: lifetime.signal,
        onOpen: () => {
          if (lifetime.signal.aborted) return;
          update({ connected: true });
          if (!snapshot.project) void refreshProject().catch(report);
          schedule(true);
        },
        onError: () => {
          if (!lifetime.signal.aborted) update({ connected: false });
        },
      },
    );
    if (snapshot.selectedId) schedule(true);
    return () => {
      lifetime.abort();
      source.close();
      window.clearTimeout(timer);
      if (controller === lifetime) {
        controller = undefined;
        scheduleRefresh = undefined;
      }
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
    selectRun: (id?: string) => {
      if (id === snapshot.selectedId) return;
      update({ selectedId: id, run: undefined, events: [], liveText: "", liveTextByNode: {} });
      scheduleRefresh?.(true);
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

/** One reconnecting event stream per mounted application, with revision-guarded refreshes. */
export function useWorkflowData(initialId?: string) {
  const [store] = useState(() => createWorkflowStore(initialId));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => store.start(), [store]);
  return { ...snapshot, ...store };
}
