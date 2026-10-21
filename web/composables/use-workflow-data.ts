import { onMounted, onScopeDispose, shallowRef } from "vue";
import { z } from "zod";
import {
  eventSchema,
  runSchema,
  type RunEvent,
  type WorkflowRun,
} from "../../src/domain.js";
import { projectSchema, request, runListSchema } from "../api.js";
import {
  mergeEvents,
  mergeRuns,
  newerRun,
  type RunList,
} from "../run-state.js";

const refreshKinds = new Set([
  "draft",
  "approved",
  "node_start",
  "node_end",
  "group_state",
  "run_end",
  "rejected",
  "paused",
  "resumed",
  "interrupted",
  "recovery",
  "usage",
  "run_deleted",
]);
export type WorkflowNotice = {
  id: string;
  runId: string;
  title: string;
  message: string;
  time: string;
  read: boolean;
};
export type TaskStream = {
  activity: string;
  text: string;
  kind: string;
  time: string;
};

/** One event stream per application; refreshes are coalesced and revision guarded. */
export function useWorkflowData() {
  const project = shallowRef<z.infer<typeof projectSchema>>();
  const runs = shallowRef<RunList>([]);
  const selectedId = shallowRef<string>();
  const run = shallowRef<WorkflowRun>();
  const events = shallowRef<RunEvent[]>([]);
  const liveText = shallowRef("");
  const liveTextByNode = shallowRef<Record<string, string>>({});
  const coordinatorText = shallowRef("");
  const coordinatorActivity = shallowRef("");
  const connected = shallowRef(false);
  const error = shallowRef("");
  const taskStreams = shallowRef<Record<string, TaskStream>>({});
  const notices = shallowRef<WorkflowNotice[]>([]);
  const stepSummaries = new Map<string, string>();
  function markNoticesRead() {
    notices.value = notices.value.map((item) => ({ ...item, read: true }));
  }
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let source: EventSource | undefined;
  let running = false;
  let pending = false;
  let pendingEvents = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loadError = "";
  const report = (failure: unknown) => {
    if (!controller.signal.aborted) {
      error.value =
        failure instanceof Error ? failure.message : String(failure);
      loadError = error.value;
    }
  };

  function selectRun(id?: string) {
    if (id === selectedId.value) {
      return;
    }
    selectedId.value = id;
    run.value = undefined;
    events.value = [];
    liveText.value = "";
    liveTextByNode.value = {};
    schedule(true);
  }
  function applyRun(loaded: WorkflowRun) {
    run.value = newerRun(run.value, loaded, selectedId.value);
    const {
      id,
      status,
      mode,
      createdAt,
      updatedAt,
      revision,
      cursor,
      deletedAt,
    } = loaded;
    runs.value = mergeRuns(runs.value, [
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
    ]);
  }
  async function refreshRuns() {
    const loaded = await request("/api/runs", runListSchema, options);
    if (!controller.signal.aborted) {
      runs.value = mergeRuns(runs.value, loaded);
    }
  }
  async function refreshProject() {
    const loaded = await request("/api/project", projectSchema, options);
    if (!controller.signal.aborted) {
      project.value = loaded;
      if (error.value === loadError) error.value = "";
    }
  }
  async function refresh() {
    timer = undefined;
    if (controller.signal.aborted || running) {
      return;
    }
    running = true;
    const id = selectedId.value;
    const includeEvents = pendingEvents;
    pending = false;
    pendingEvents = false;
    const [list, detail, history] = await Promise.allSettled([
      request("/api/runs", runListSchema, options),
      id
        ? request(`/api/runs/${id}`, runSchema, options)
        : Promise.resolve(undefined),
      id && includeEvents
        ? request(`/api/runs/${id}/events`, z.array(eventSchema), options)
        : Promise.resolve(undefined),
    ]);
    if (!controller.signal.aborted) {
      if (
        [list, detail, history].every(
          (result) => result.status === "fulfilled",
        ) &&
        error.value === loadError
      )
        error.value = "";
      if (list.status === "fulfilled") {
        runs.value = mergeRuns(runs.value, list.value);
      } else {
        report(list.reason);
      }
      if (detail.status === "fulfilled") {
        if (detail.value) {
          applyRun(detail.value);
        }
      } else if (id === selectedId.value) {
        report(detail.reason);
      }
      if (history.status === "fulfilled") {
        if (history.value && id === selectedId.value) {
          events.value = mergeEvents(events.value, history.value);
        }
      } else if (id === selectedId.value) {
        report(history.reason);
      }
    }
    running = false;
    if (!controller.signal.aborted && pending) {
      timer = setTimeout(() => {
        void refresh();
      }, 80);
    }
  }
  function schedule(includeEvents: boolean) {
    pending = true;
    pendingEvents ||= includeEvents;
    if (!running && timer === undefined) {
      timer = setTimeout(() => {
        void refresh();
      }, 80);
    }
  }
  onMounted(() => {
    void refreshProject().catch(report);
    void refreshRuns().catch(report);
    source = new EventSource("/api/stream");
    source.onopen = () => {
      connected.value = true;
      if (!project.value) void refreshProject().catch(report);
      schedule(true);
    };
    source.onerror = () => {
      connected.value = false;
    };
    source.onmessage = (message) => {
      if (controller.signal.aborted) {
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = eventSchema.safeParse(data);
      if (!parsed.success) {
        return;
      }
      const event = parsed.data;
      if (event.kind === "run_deleted") {
        notices.value = notices.value.filter(
          (item) => item.runId !== event.runId,
        );
        stepSummaries.delete(event.runId);
      }
      if (event.kind === "node_end")
        stepSummaries.set(
          event.runId,
          event.message.split("\n").slice(1).join("\n"),
        );
      if (
        ["run_end", "interrupted", "paused"].includes(event.kind) &&
        !notices.value.some((item) => item.id === event.id)
      ) {
        const title =
          runs.value.find((item) => item.id === event.runId)?.title ??
          "Workflow";
        notices.value = [
          {
            id: event.id,
            runId: event.runId,
            title,
            time: event.time,
            read: false,
            message: `${event.message}${stepSummaries.get(event.runId) ? ` · ${stepSummaries.get(event.runId)}` : ""}`,
          },
          ...notices.value,
        ].slice(0, 30);
      }
      if (event.runId.startsWith("task:")) {
        const id = event.runId.slice(5);
        const previous = taskStreams.value[id];
        taskStreams.value = {
          ...taskStreams.value,
          [id]: {
            activity:
              event.kind === "text_delta"
                ? (previous?.activity ?? "Understanding your request…")
                : event.message,
            text:
              event.kind === "text_delta"
                ? ((previous?.text ?? "") + event.message).slice(-8000)
                : event.kind === "agent_message"
                  ? event.message
                  : (previous?.text ?? ""),
            kind:
              event.kind === "text_delta"
                ? (previous?.kind ?? "planning")
                : event.kind,
            time: event.time,
          },
        };
        if (event.kind === "task_state") {
          schedule(false);
        }
        return;
      }
      if (event.runId === "coordinator") {
        if (event.kind === "text_delta") {
          coordinatorText.value = (coordinatorText.value + event.message).slice(
            -8000,
          );
        } else {
          coordinatorActivity.value = event.message.slice(0, 2000);
          if (event.kind === "agent_message") {
            coordinatorText.value = event.message.slice(-8000);
          }
        }
        return;
      }
      if (event.runId === selectedId.value) {
        if (event.kind === "text_delta") {
          if (event.nodeId)
            liveTextByNode.value = {
              ...liveTextByNode.value,
              [event.nodeId]: (
                (liveTextByNode.value[event.nodeId] ?? "") + event.message
              ).slice(-16_000),
            };
          else liveText.value = (liveText.value + event.message).slice(-16_000);
          return;
        }
        if (
          [
            "agent_message",
            "node_start",
            "node_end",
            "run_end",
            "interrupted",
          ].includes(event.kind)
        ) {
          if (event.kind === "run_end") {
            liveText.value = "";
            liveTextByNode.value = {};
          } else if (event.nodeId) {
            const next = { ...liveTextByNode.value };
            delete next[event.nodeId];
            liveTextByNode.value = next;
          } else liveText.value = "";
        }
        events.value = mergeEvents(events.value, [event]);
      }
      if (refreshKinds.has(event.kind)) {
        schedule(false);
      }
    };
  });
  onScopeDispose(() => {
    controller.abort();
    source?.close();
    clearTimeout(timer);
  });
  return {
    project,
    runs,
    selectedId,
    selectRun,
    run,
    applyRun,
    refreshRuns,
    refreshProject,
    events,
    liveText,
    liveTextByNode,
    coordinatorText,
    coordinatorActivity,
    connected,
    error,
    taskStreams,
    notices,
    markNoticesRead,
  };
}
