<script setup lang="ts">
import { isSourceWorkflow } from "./features/execution/execution-label.js";
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from "vue";
import { runSchema } from "../src/contracts/index.js";
import { taskSchema, taskListSchema, runListSchema } from "../src/contracts/index.js";
import { orchestrationStateSchema } from "../src/contracts/index.js";
import { libraryProposalSchema } from "../src/contracts/index.js";
import type { DesignScope } from "../src/contracts/index.js";
import { apiUrl, request } from "./shared/api.js";
import { useDraft } from "./features/tasks/use-draft.js";
import { useTaskDraft } from "./features/tasks/use-task-draft.js";
import { useWorkflowData } from "./app/use-workflow-data.js";
import { useTasks } from "./features/tasks/use-tasks.js";
import { useSetupJobs } from "./features/setup/use-setup-jobs.js";
import { statusLabel } from "./features/execution/workflow-status.js";
import type { DesignRequest } from "./features/design/design-types.js";
import TaskComposer from "./features/tasks/TaskComposer.vue";
import ProgramComposer from "./features/programs/ProgramComposer.vue";
import type { ProgramSource } from "../src/contracts/index.js";
import TaskPlanning from "./features/tasks/TaskPlanning.vue";
import RunWorkspace from "./features/execution/RunWorkspace.vue";
import Icon from "./shared/Icon.vue";
import SessionSwitcher from "./features/sessions/SessionSwitcher.vue";
import SetupProgress from "./features/setup/SetupProgress.vue";
import UsageSummary from "./features/usage/UsageSummary.vue";
import { parseSessionLocation, sessionLink } from "./features/sessions/session-location.js";
const SettingsPage = defineAsyncComponent(() => import("./settings/SettingsPage.vue"));
const refinementController = ref<AbortController>();
const DesignDock = defineAsyncComponent(() => import("./features/design/DesignDock.vue"));
const initialLocation = new URLSearchParams(window.location.hash.slice(1));
const initialSession = new URLSearchParams(window.location.search).get("session");
const copiedSession = ref("");
const {
  project,
  run,
  runs,
  selectedId,
  selectRun,
  applyRun,
  refreshProject,
  refreshRuns,
  error,
  connected,
  taskStreams,
  events,
  usageRevision,
  setupRevision,
  liveText,
  liveTextByNode,
  coordinatorActivity,
  coordinatorText,
  notices,
  markNoticesRead,
} = useWorkflowData();
const notificationsOpen = ref(false);
const dismissedNotice = ref("");
const unread = computed(() => notices.value.filter((item) => !item.read).length);
const latestNotice = computed(() => {
  const item = notices.value[0];
  return item && !item.read && item.id !== dismissedNotice.value ? item : undefined;
});
watch(
  () => latestNotice.value?.id,
  (id, _old, cleanup) => {
    if (!id) return;
    const timer = setTimeout(() => {
      dismissedNotice.value = id;
    }, 8000);
    cleanup(() => clearTimeout(timer));
  },
);
function openNotice(id: string) {
  const linked = tasks.value.find((item) => item.runId === id);
  navigate("task", () => {
    selectedTask.value = linked?.id;
    selectRun(id);
  });
  markNoticesRead();
  notificationsOpen.value = false;
}
const view = ref<"task" | "settings">(initialLocation.has("settings") ? "settings" : "task");
const selectedTask = ref<string | undefined>(initialLocation.get("task") ?? undefined);
const { tasks, task, apply: applyTask, error: taskError } = useTasks(selectedTask);
const draft = useDraft(run);
const busy = ref(false);
const automatic = ref(false);
const settingsDirty = ref(false);
const designRequest = ref<DesignRequest>();
const settingsContext = ref<{
  section:
    | "providers"
    | "profiles"
    | "cases"
    | "blocks"
    | "capabilities"
    | "execution"
    | "triggers"
    | "memory";
  blockId?: string;
}>({ section: "providers" });
const settingsRevision = ref(0);
const setupJobs = useSetupJobs({
  revision: () =>
    `${setupRevision.value}:${settingsRevision.value}:${JSON.stringify(project.value?.config.agent)}`,
  completed: async () => {
    await settingsSaved();
    settingsRevision.value++;
  },
});
const applyingDesign = ref(false);
const designChatCount = ref(0);
const sidebar = ref(false);
const composerKey = ref(0);
const {
  draft: taskDraft,
  text: setTaskDraftText,
  files: setTaskDraftFiles,
  clear: clearTaskDraft,
  clearSubmitted,
} = useTaskDraft(() => project.value?.project);
const filter = ref("");
async function readSettings() {
  automatic.value =
    (await request("/api/settings/orchestration", orchestrationStateSchema)).settings.approval ===
    "automatic";
}
onMounted(() => {
  if (initialSession) void perform(() => openSession(initialSession));
  void readSettings().catch((failure: unknown) => {
    error.value = String(failure);
  });
});
watch(
  () => task.value?.runId,
  (id) => {
    if (id) {
      selectRun(id);
    }
  },
);
if (!initialLocation.has("task") && initialLocation.get("run")) {
  selectRun(initialLocation.get("run")!);
}
watch([view, selectedTask, selectedId], syncLocation, { immediate: true });
function syncLocation() {
  const location =
    view.value === "settings"
      ? "settings"
      : selectedTask.value
        ? `task=${selectedTask.value}`
        : selectedId.value
          ? `run=${selectedId.value}`
          : "";
  const query = new URLSearchParams(window.location.search);
  query.delete("session");
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query.size ? `?${query}` : ""}${location ? `#${location}` : ""}`,
  );
}
function readLocation() {
  const location = new URLSearchParams(window.location.hash.slice(1));
  const next = location.has("settings") ? "settings" : "task";
  navigate(next, () => {
    selectedTask.value = location.get("task") ?? undefined;
    selectRun(selectedTask.value ? undefined : (location.get("run") ?? undefined));
  });
  // Restore the current URL if the user declines to discard settings.
  syncLocation();
}
onMounted(() => window.addEventListener("hashchange", readLocation));
onUnmounted(() => window.removeEventListener("hashchange", readLocation));
function navigate(next: "task" | "settings", action?: () => void) {
  if (next === view.value && !action) {
    sidebar.value = false;
    return;
  }
  if (
    view.value === "settings" &&
    settingsDirty.value &&
    !window.confirm("Discard unsaved settings changes?")
  ) {
    return;
  }
  view.value = next;
  sidebar.value = false;
  action?.();
}
function newTask(text?: string) {
  if (
    text !== undefined &&
    (taskDraft.value.text || taskDraft.value.files.length) &&
    !window.confirm("Replace the unsent task draft with this request?")
  )
    return;
  navigate("task", () => {
    selectedTask.value = undefined;
    selectRun(undefined);
    if (text !== undefined) {
      clearTaskDraft();
      setTaskDraftText(text);
    }
    composerKey.value++;
  });
}
async function perform(action: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  try {
    await action();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    busy.value = false;
  }
}
const entries = computed(() => {
  const linked = new Set(tasks.value.map((item) => item.runId));
  return [
    ...tasks.value
      .filter(
        (item) =>
          !item.deletedAt && !runs.value.some((run) => run.id === item.runId && run.deletedAt),
      )
      .map((item) => {
        const execution = runs.value.find((entry) => entry.id === item.runId);
        return {
          id: item.id,
          runId: item.runId,
          title: execution?.title ?? item.prompt,
          status: execution?.status ?? item.status,
          createdAt: item.createdAt,
        };
      }),
    ...runs.value
      .filter((item) => !item.deletedAt && !linked.has(item.id))
      .map((item) => ({
        id: `run:${item.id}`,
        runId: item.id,
        title: item.title,
        status: item.status,
        createdAt: item.createdAt,
      })),
  ]
    .filter((item) => item.title.toLowerCase().includes(filter.value.toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});
const activeStatuses = new Set([
  "queued",
  "planning",
  "needs_input",
  "draft",
  "running",
  "pausing",
  "paused",
  "interrupted",
]);
const groups = computed(() => [
  {
    label: "Active",
    items: entries.value.filter((item) => activeStatuses.has(item.status)),
    empty: "No active tasks",
  },
  {
    label: "Previous",
    items: entries.value.filter((item) => !activeStatuses.has(item.status)),
    empty: "Completed tasks appear here",
  },
]);
const selectedEntry = computed(
  () => selectedTask.value ?? (selectedId.value ? `run:${selectedId.value}` : ""),
);
const selectedItem = computed(() => entries.value.find((item) => item.id === selectedEntry.value));
const cannotDelete = (status: string) =>
  ["queued", "planning", "needs_input", "running", "pausing", "paused", "interrupted"].includes(
    status,
  );
function deleteEntry(item: (typeof entries.value)[number]) {
  if (busy.value || cannotDelete(item.status)) return;
  if (
    !window.confirm(
      `Delete “${item.title}” from task history? Project files are not undone. Recovery records and execution history are retained on disk.`,
    )
  )
    return;
  void perform(async () => {
    if (item.id.startsWith("run:")) {
      applyRun(
        await request(`/api/runs/${item.runId}`, runSchema, {
          method: "DELETE",
        }),
      );
    } else {
      applyTask(
        await request(`/api/tasks/${item.id}`, taskSchema, {
          method: "DELETE",
        }),
      );
    }
    if (selectedEntry.value === item.id) {
      selectedTask.value = undefined;
      selectRun(undefined);
    }
    await refreshRuns();
  });
}
watch([tasks, runs], () => {
  if (
    (selectedTask.value &&
      tasks.value.some((item) => item.id === selectedTask.value && item.deletedAt)) ||
    (selectedId.value && runs.value.some((item) => item.id === selectedId.value && item.deletedAt))
  ) {
    selectedTask.value = undefined;
    selectRun(undefined);
  }
});
const projectName = computed(
  () => project.value?.project.split("/").filter(Boolean).at(-1) ?? "Workspace",
);
async function openSession(value: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const session = parseSessionLocation(value);
  const [knownTasks, knownRuns] = await Promise.all([
    request("/api/tasks", taskListSchema, { signal }),
    request("/api/runs", runListSchema, { signal }),
  ]);
  signal?.throwIfAborted();
  const foundTask =
    session.kind !== "run" && knownTasks.find((item) => item.id === session.id && !item.deletedAt);
  const foundRun =
    session.kind !== "task" && knownRuns.find((item) => item.id === session.id && !item.deletedAt);
  if (!foundTask && !foundRun)
    throw new Error(
      "Session not found in this project. Check the full ID and the project server you connected to.",
    );
  navigate("task", () => {
    selectedTask.value = foundTask ? foundTask.id : undefined;
    selectRun(foundTask ? foundTask.runId : session.id);
  });
}
const sessionId = computed(() => selectedTask.value ?? selectedId.value);
async function copySession(kind: "link" | "terminal" | "id") {
  if (!sessionId.value) return;
  const value =
    kind === "id"
      ? sessionId.value
      : kind === "terminal"
        ? `workflow attach ${sessionId.value} --server ${new URL(apiUrl("/api/project"), window.location.href).href.replace(/\/api\/project$/, "")}`
        : sessionLink(window.location.href, {
            id: sessionId.value,
            kind: selectedTask.value ? "task" : "run",
          });
  try {
    await navigator.clipboard.writeText(value);
    copiedSession.value =
      kind === "link"
        ? "Session link copied"
        : kind === "terminal"
          ? "Terminal command copied"
          : "Session ID copied";
  } catch {
    copiedSession.value = "Clipboard unavailable. Select and copy the session ID below.";
  }
}
watch(sessionId, () => {
  copiedSession.value = "";
});
function selectEntry(item: (typeof entries.value)[number]) {
  navigate("task", () => {
    selectedTask.value = item.id.startsWith("run:") ? undefined : item.id;
    selectRun(item.runId);
  });
}
async function submitTask(prompt: string, attachments: string[]) {
  const submittedComposer = composerKey.value;
  const submittedDraft = taskDraft.value;
  const created = await request("/api/tasks", taskSchema, {
    method: "POST",
    body: { prompt, attachments },
  });
  clearSubmitted(submittedDraft);
  // Creation may finish after the user has opened another task or a new draft.
  // Keep the created task in history without replacing that newer workspace.
  if (
    view.value === "task" &&
    !selectedTask.value &&
    !selectedId.value &&
    composerKey.value === submittedComposer
  ) {
    selectedTask.value = created.id;
    selectRun(undefined);
  }
  applyTask(created);
}
async function submitProgram(
  value: ProgramSource & { title: string; task: string },
  signal: AbortSignal,
) {
  const created = await request("/api/programs", runSchema, {
    method: "POST",
    body: value,
    signal,
  });
  selectedTask.value = undefined;
  applyRun(created);
  selectRun(created.id);
  await refreshRuns();
}
function taskAction(action: "answer" | "cancel" | "retry", answer?: string) {
  const current = task.value;
  if (!current) {
    return;
  }
  void perform(async () => {
    applyTask(
      await request(`/api/tasks/${current.id}/${action}`, taskSchema, {
        method: "POST",
        body: action === "answer" ? { answer, revision: current.revision } : {},
      }),
    );
  });
}
function runAction(action: string) {
  const current = run.value;
  if (!current) {
    return;
  }
  void perform(async () => {
    if (action === "plan-recovery") {
      const created = await request("/api/tasks", taskSchema, {
        method: "POST",
        body: { prompt: current.plan.task, sourceRunId: current.id },
      });
      if (view.value === "task" && selectedId.value === current.id) {
        selectedTask.value = created.id;
        selectRun(undefined);
      }
      applyTask(created);
      await refreshRuns();
      return;
    }
    applyRun(
      await request(`/api/runs/${current.id}/${action}`, runSchema, {
        method: "POST",
        body: {},
        revision: action === "approve" ? current.revision : undefined,
      }),
    );
    await refreshRuns();
  });
}
function savePlan() {
  const current = run.value;
  const edit = draft.value;
  if (!current) {
    return;
  }
  void perform(async () => {
    const saved = await request(
      `/api/runs/${current.id}/${isSourceWorkflow(current) ? "program" : "plan"}`,
      runSchema,
      {
        method: "PUT",
        body: isSourceWorkflow(current) ? edit.validProgram : JSON.parse(edit.text),
        revision: edit.revision,
      },
    );
    applyRun(saved);
    edit.saved(saved);
  });
}
function refine(instructions: string) {
  const current = run.value;
  const edit = draft.value;
  if (!current) {
    return;
  }
  void perform(async () => {
    const controller = new AbortController();
    refinementController.value = controller;
    coordinatorText.value = "";
    coordinatorActivity.value = "Refining the workflow…";
    try {
      const updated = await request(`/api/runs/${current.id}/refine`, runSchema, {
        method: "POST",
        body: { instructions },
        revision: current.revision,
        signal: controller.signal,
      });
      applyRun(updated);
      edit.saved(updated);
      await refreshRuns();
    } catch (failure) {
      if (!controller.signal.aborted) throw failure;
      coordinatorActivity.value = "Refinement cancelled.";
    } finally {
      refinementController.value = undefined;
    }
  });
}
function saveSuggestedBlocks() {
  const currentTask = task.value;
  const currentRun = run.value;
  if (!currentTask || !currentRun) {
    return;
  }
  void perform(async () => {
    const proposal = await request("/api/library/proposals", libraryProposalSchema, {
      method: "POST",
      body: {
        kind: "manual",
        changes: {
          summary: "Save task-specific blocks for reuse",
          blocks: currentTask.suggestedBlocks.map((item) => ({
            bundle: currentRun.program?.catalog[item.id] ?? currentRun.blocks[item.id],
            rationale: item.rationale,
          })),
        },
      },
    });
    await request(`/api/library/proposals/${proposal.id}/apply`, libraryProposalSchema, {
      method: "POST",
      body: {},
    });
    await refreshProject();
  });
}
async function settingsSaved() {
  await refreshProject();
  await readSettings();
}
function design(scope: DesignScope, prompt?: string) {
  designRequest.value = {
    scope,
    prompt,
    key: (designRequest.value?.key ?? 0) + 1,
  };
}
async function designApplied() {
  await settingsSaved();
  settingsRevision.value++;
}
</script>

<template>
  <div
    class="app-shell"
    :class="{
      'sidebar-open': sidebar,
      'has-design-chats': designChatCount > 0,
    }"
  >
    <button
      v-if="sidebar"
      class="sidebar-backdrop"
      aria-label="Close navigation"
      @click="sidebar = false"
    />
    <aside class="task-sidebar">
      <button class="brand" @click="newTask()">
        <span class="brand-mark"><Icon name="workflow" :size="21" /></span
        ><strong>workflow<span>from intent to done</span></strong>
      </button>
      <button class="new-task-button" aria-label="New task" @click="newTask()">
        <Icon name="plus" :size="19" />New task
      </button>
      <SessionSwitcher :on-open="openSession" />
      <div class="sidebar-search">
        <Icon name="search" :size="15" /><input
          v-model="filter"
          aria-label="Search tasks"
          placeholder="Search tasks"
        />
      </div>
      <div class="task-history">
        <section v-for="group in groups" :key="group.label">
          <div class="history-heading">
            {{ group.label }}<span>{{ group.items.length }}</span>
          </div>
          <div v-for="item in group.items" :key="item.id" class="task-history-entry">
            <button
              class="task-item"
              :class="{
                selected: view === 'task' && selectedEntry === item.id,
              }"
              :title="item.title"
              @click="selectEntry(item)"
            >
              <span class="status-dot" :class="item.status" /><span
                ><strong>{{ item.title }}</strong
                ><small>{{ statusLabel(item.status) }}</small></span
              >
            </button>
            <button
              class="history-delete icon-button"
              :aria-label="`Delete ${item.title}`"
              :disabled="busy || cannotDelete(item.status)"
              :title="
                cannotDelete(item.status)
                  ? 'Stop this task before deleting it'
                  : 'Delete from history'
              "
              @click="deleteEntry(item)"
            >
              <Icon name="trash" :size="14" />
            </button>
          </div>
          <p v-if="!group.items.length" class="sidebar-empty">
            {{ group.empty }}
          </p>
        </section>
      </div>
      <div class="sidebar-bottom">
        <div class="workspace-label">
          <Icon name="folder" /><span :title="project?.project"
            >{{ projectName }}<small>Local workspace</small></span
          ><span
            class="connection-dot"
            :class="{ online: connected }"
            :title="connected ? 'Connected' : 'Reconnecting'"
          />
        </div>
        <button
          class="settings-button"
          :class="{ selected: view === 'settings' }"
          @click="navigate('settings')"
        >
          <Icon name="settings" />Settings
        </button>
      </div>
    </aside>
    <div class="main-shell">
      <header class="workspace-topbar">
        <button
          class="icon-button mobile-menu"
          aria-label="Open navigation"
          @click="sidebar = true"
        >
          <Icon name="menu" />
        </button>
        <div class="workspace-breadcrumb">
          <span>{{ projectName }}</span
          ><Icon name="chevron" :size="12" /><strong>{{
            view === "settings" ? "Settings" : selectedEntry ? "Task workspace" : "New task"
          }}</strong>
        </div>
        <div class="topbar-right">
          <button class="ai-button" aria-label="Open AI designer" @click="design('project')">
            <Icon name="spark" />Design with AI
          </button>
          <div class="notifications">
            <button
              class="icon-button"
              aria-label="Notifications"
              :aria-expanded="notificationsOpen"
              @click="notificationsOpen = !notificationsOpen"
            >
              <Icon name="bell" /><span v-if="unread" class="notification-count">{{ unread }}</span>
            </button>
            <section
              v-if="notificationsOpen"
              class="notification-panel"
              aria-label="Workflow notifications"
            >
              <div class="card-title">
                <strong>Notifications</strong
                ><button class="quiet" @click="markNoticesRead">Mark all read</button>
              </div>
              <p v-if="!notices.length" class="muted">
                Workflow completions, failures and pauses appear here.
              </p>
              <button
                v-for="notice in notices"
                :key="notice.id"
                class="notification-item"
                :class="{ unread: !notice.read }"
                @click="openNotice(notice.runId)"
              >
                <strong>{{ notice.title }}</strong
                ><span>{{ notice.message }}</span
                ><small>{{ new Date(notice.time).toLocaleTimeString() }}</small>
              </button>
            </section>
          </div>
          <span v-if="project?.mode === 'demo'" class="demo-badge">DEMO</span
          ><span class="connection-text"
            ><span class="connection-dot" :class="{ online: connected }" />{{
              connected ? "Connected" : "Reconnecting"
            }}</span
          >
        </div>
      </header>
      <div v-if="error || taskError" class="error-banner" role="alert">
        <span>{{ error || taskError }}</span
        ><button
          @click="
            error = '';
            taskError = '';
          "
        >
          Dismiss
        </button>
      </div>
      <main
        :class="view === 'settings' ? 'settings-main' : !selectedEntry ? 'home-main' : 'task-main'"
      >
        <SettingsPage
          v-if="view === 'settings' && project"
          :library="project"
          :on-saved="settingsSaved"
          :design-revision="settingsRevision"
          :applying-design="applyingDesign"
          :usage-revision="usageRevision"
          :setup-controller="setupJobs"
          :demo="project.mode === 'demo'"
          @dirty="settingsDirty = $event"
          @context="settingsContext = $event"
          @design="design"
        />
        <div v-else-if="!selectedEntry" class="task-home">
          <div class="home-symbol"><Icon name="workflow" :size="30" /></div>
          <div class="home-eyebrow">YOUR PROJECT. A CLEAR PLAN.</div>
          <h1>What should we work on?</h1>
          <p>Share the goal. Choose what flows between steps. Follow the work anywhere.</p>
          <SetupProgress
            v-if="project"
            :controller="setupJobs"
            compact
            :demo="project.mode === 'demo'"
            @settings="navigate('settings')"
          />
          <TaskComposer
            v-if="project"
            :key="composerKey"
            :text="taskDraft.text"
            :files="taskDraft.files"
            :automatic="automatic"
            :on-submit="submitTask"
            @update:text="setTaskDraftText"
            @update:files="setTaskDraftFiles"
            @discard="clearTaskDraft"
            @settings="navigate('settings')"
          />
          <ProgramComposer :on-submit="submitProgram" />
          <p v-if="project?.mode === 'demo'" class="demo-note">
            Demo mode simulates planning, agents and checks. Task files stay unchanged.
          </p>
        </div>
        <div v-else class="task-content">
          <div class="task-request">
            <div class="request-heading">
              <span class="eyebrow">YOUR REQUEST</span>
              <div class="request-actions">
                <button
                  v-if="selectedItem"
                  class="quiet danger-quiet"
                  :disabled="busy || cannotDelete(selectedItem.status)"
                  :title="
                    cannotDelete(selectedItem.status)
                      ? 'Stop this task before deleting it'
                      : 'Remove from history'
                  "
                  @click="deleteEntry(selectedItem)"
                >
                  <Icon name="trash" :size="14" />Delete workflow</button
                ><button
                  class="quiet"
                  :disabled="busy"
                  @click="newTask(task?.prompt ?? run?.plan.task ?? '')"
                >
                  Use in a new task<Icon name="plus" :size="14" />
                </button>
              </div>
            </div>
            <p>{{ task?.prompt ?? run?.plan.task ?? "Loading request…" }}</p>
            <div v-if="sessionId" class="session-access" aria-label="Shared session">
              <span class="session-id"
                ><Icon name="terminal" :size="14" /><span>Session</span
                ><code>{{ sessionId }}</code></span
              >
              <div class="session-access-actions">
                <button class="quiet" title="Copy session ID" @click="copySession('id')">
                  <Icon name="copy" :size="13" />Copy ID
                </button>
                <button class="quiet" @click="copySession('link')">Copy link</button>
                <button class="quiet" @click="copySession('terminal')">
                  <Icon name="terminal" :size="13" />Continue in terminal
                </button>
              </div>
              <span v-if="copiedSession" class="session-copy-notice" role="status">{{
                copiedSession
              }}</span>
            </div>
            <div v-if="task?.attachments.length" class="request-attachments">
              <a
                v-for="file in task.attachments"
                :key="file.id"
                :href="apiUrl(`/api/attachments/${file.id}`)"
                target="_blank"
                rel="noreferrer"
                ><img
                  v-if="file.kind === 'image'"
                  :src="apiUrl(`/api/attachments/${file.id}`)"
                  :alt="file.name"
                /><Icon v-else name="file" /><span>{{ file.name }}</span></a
              >
            </div>
            <details v-for="(answer, index) in task?.answers" :key="index">
              <summary>{{ answer.question }}</summary>
              <p>{{ answer.answer }}</p>
            </details>
          </div>
          <UsageSummary
            v-if="task || run"
            :key="task?.id ?? run?.id"
            :scope="task ? 'task' : 'run'"
            :scope-id="task?.id ?? run?.id"
            :revision="`${usageRevision}:${task?.updatedAt}:${run?.revision}`"
            :active="
              !!refinementController ||
              !!(task && ['queued', 'planning'].includes(task.status)) ||
              !!(run && ['running', 'pausing'].includes(run.status))
            "
          />
          <div v-if="task?.error && task.runId" class="inline-error" role="alert">
            {{ task.error }}
          </div>
          <TaskPlanning
            v-if="task && !task.runId"
            :key="task.id"
            :task="task"
            :stream="taskStreams[task.id]"
            :busy="busy"
            @answer="taskAction('answer', $event)"
            @cancel="taskAction('cancel')"
            @retry="taskAction('retry')"
          />
          <div v-if="task?.rationale" class="plan-rationale">
            <Icon name="spark" :size="17" />
            <div>
              <span>{{ task.caseName ?? "Task plan" }}</span>
              <p>{{ task.rationale }}</p>
            </div>
          </div>
          <details v-if="task?.suggestedBlocks.length && run" class="suggested-blocks">
            <summary>
              {{ task.suggestedBlocks.length }} new block{{
                task.suggestedBlocks.length === 1 ? "" : "s"
              }}
              suggested for this task
            </summary>
            <article v-for="item in task.suggestedBlocks" :key="item.id">
              <h3>
                {{
                  (run.program?.catalog[item.id] ?? run.blocks[item.id])?.definition.name ?? item.id
                }}
              </h3>
              <p>{{ item.rationale }}</p>
              <pre>{{
                JSON.stringify(run.program?.catalog[item.id] ?? run.blocks[item.id], null, 2)
              }}</pre>
            </article>
            <button :disabled="busy" @click="saveSuggestedBlocks">
              Save these blocks to the reusable library
            </button>
          </details>
          <RunWorkspace
            v-if="run"
            :run="run"
            :draft="draft"
            :events="events"
            :live-text="liveText"
            :live-text-by-node="liveTextByNode"
            :busy="busy"
            :live="project?.mode === 'live'"
            :coordinator-activity="coordinatorActivity"
            :coordinator-text="coordinatorText"
            :refining="!!refinementController"
            @cancel-refinement="refinementController?.abort()"
            @settings="navigate('settings')"
            @action="runAction"
            @save="savePlan"
            @refine="refine"
          />
          <div v-else-if="!task || task.runId" class="panel-empty" role="status">
            <span class="spinner" />
            <p>Loading workflow…</p>
          </div>
        </div>
      </main>
    </div>
    <div v-if="latestNotice && !notificationsOpen" class="notification-toast" role="status">
      <Icon name="bell" /><button class="quiet" @click="openNotice(latestNotice.runId)">
        <strong>{{ latestNotice.title }}</strong
        ><span>{{ latestNotice.message }}</span>
      </button>
      <button
        class="icon-button"
        aria-label="Dismiss notification"
        @click="dismissedNotice = latestNotice.id"
      >
        <Icon name="close" :size="16" />
      </button>
    </div>
    <DesignDock
      :requested="designRequest"
      :page-context="{
        page: view,
        ...(view === 'task' ? { taskId: task?.id, runId: run?.id } : settingsContext),
      }"
      :has-unsaved-settings="settingsDirty"
      :on-applied="designApplied"
      @applying-change="applyingDesign = $event"
      @chats-change="designChatCount = $event"
    />
  </div>
</template>
