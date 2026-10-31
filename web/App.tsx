import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useBlocker, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import {
  libraryProposalSchema,
  orchestrationStateSchema,
  runListSchema,
  runSchema,
  taskListSchema,
  taskSchema,
  type DesignScope,
  type ProgramSource,
} from "../src/contracts/index.js";
import { useWorkflowData } from "./app/use-workflow-data.js";
import type { DesignRequest } from "./features/design/design-types.js";
import { isSourceWorkflow } from "./features/execution/execution-label.js";
import RunWorkspace from "./features/execution/RunWorkspace.js";
import { statusLabel } from "./features/execution/workflow-status.js";
import { ProgramComposerReact } from "./features/programs/ProgramComposerReact.js";
import SessionSwitcher from "./features/sessions/SessionSwitcher.js";
import { parseSessionLocation, sessionLink } from "./features/sessions/session-location.js";
import SetupProgress from "./features/setup/SetupProgress.js";
import { useSetupJobs } from "./features/setup/use-setup-jobs.js";
import { TaskComposerReact } from "./features/tasks/TaskComposerReact.js";
import TaskPlanning from "./features/tasks/TaskPlanning.js";
import { useDraft } from "./features/tasks/use-draft.js";
import { useTaskDraft } from "./features/tasks/use-task-draft.js";
import { useTasks } from "./features/tasks/use-tasks.js";
import UsageSummary from "./features/usage/UsageSummary.js";
import { apiUrl, request } from "./shared/api.js";
import Icon from "./shared/Icon.js";

const SettingsPage = lazy(() => import("./settings/SettingsPage.js"));
const DesignDock = lazy(() => import("./features/design/DesignDock.js"));
type Workspace = {
  view: "task" | "settings";
  selectedTask: string | undefined;
  composerKey: number;
};
type SettingsContext = {
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
};
type HistoryEntry = {
  id: string;
  runId: string | undefined;
  title: string;
  status: string;
  createdAt: string;
};
const activeStatuses: Record<string, true> = {
  queued: true,
  planning: true,
  needs_input: true,
  draft: true,
  running: true,
  pausing: true,
  paused: true,
  interrupted: true,
};
const cannotDelete = (status: string) =>
  ["queued", "planning", "needs_input", "running", "pausing", "paused", "interrupted"].includes(
    status,
  );

type ResolvedSession = { selectedTask: string | undefined; runId: string | undefined };

async function resolveSession(value: string, signal?: AbortSignal): Promise<ResolvedSession> {
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
  if (!foundTask && !foundRun) {
    throw new Error(
      "Session not found in this project. Check the full ID and the project server you connected to.",
    );
  }
  return {
    selectedTask: foundTask ? foundTask.id : undefined,
    runId: foundTask ? foundTask.runId : session.id,
  };
}

export default function App() {
  const search = useSearch({ from: "/" });
  const router = useRouter();
  const routeNavigate = useNavigate({ from: "/" });
  const [composerKey, setComposerKey] = useState(0);
  const view = search.view === "settings" ? "settings" : "task";
  const selectedTask = search.task;
  const workspaceRef = useRef<Workspace>({ view, selectedTask, composerKey });
  useEffect(() => {
    workspaceRef.current = { view, selectedTask, composerKey };
  }, [view, selectedTask, composerKey]);
  const data = useWorkflowData(search.run);
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
    setError,
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
    setCoordinatorText,
    setCoordinatorActivity,
  } = data;
  const {
    tasks,
    task,
    apply: applyTask,
    error: taskError,
    setError: setTaskError,
  } = useTasks(selectedTask);
  const draft = useDraft(run);
  const [pendingActions, setPendingActions] = useState(0);
  const [resolvedSession, setResolvedSession] = useState<string>();
  const busy = pendingActions > 0 || (!!search.session && resolvedSession !== search.session);
  const [automatic, setAutomatic] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const settingsChanged = useCallback((dirty: boolean) => {
    setSettingsDirty(dirty);
  }, []);
  useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (!("view" in current.search) || current.search.view !== "settings" || !settingsDirty)
        return false;
      if ("view" in next.search && next.search.view === "settings") return false;
      return !window.confirm("Discard unsaved settings changes?");
    },
    enableBeforeUnload: view === "settings" && settingsDirty,
  });
  const [designRequest, setDesignRequest] = useState<DesignRequest>();
  const [settingsContext, setSettingsContext] = useState<SettingsContext>({ section: "providers" });
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [applyingDesign, setApplyingDesign] = useState(false);
  const [designChatCount, setDesignChatCount] = useState(0);
  const [sidebar, setSidebar] = useState(false);
  const [filter, setFilter] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [dismissedNotice, setDismissedNotice] = useState("");
  const [copied, setCopied] = useState({ id: "", message: "" });
  const [refining, setRefining] = useState(false);
  const refinementController = useRef<AbortController | undefined>(undefined);
  const lifetimeController = useRef<AbortController | undefined>(undefined);
  const {
    draft: taskDraft,
    text: setTaskDraftText,
    files: setTaskDraftFiles,
    clear: clearTaskDraft,
    clearSubmitted,
  } = useTaskDraft(project?.project);
  const setupJobs = useSetupJobs({
    revision: `${setupRevision}:${settingsRevision}:${JSON.stringify(project?.config.agent)}`,
    completed: async () => {
      await settingsSaved();
      setSettingsRevision((revision) => revision + 1);
    },
  });
  const unread = notices.filter((item) => !item.read).length;
  const latest = notices[0];
  const latestNotice = latest && !latest.read && latest.id !== dismissedNotice ? latest : undefined;
  const latestNoticeId = latestNotice?.id;
  useEffect(() => {
    if (!latestNoticeId) return;
    const timer = window.setTimeout(() => setDismissedNotice(latestNoticeId), 8000);
    return () => window.clearTimeout(timer);
  }, [latestNoticeId]);

  function actionSignal(signal?: AbortSignal) {
    const lifetime = lifetimeController.current?.signal;
    return signal && lifetime ? AbortSignal.any([signal, lifetime]) : (signal ?? lifetime);
  }
  async function readSettings(signal?: AbortSignal) {
    const loaded = await request("/api/settings/orchestration", orchestrationStateSchema, {
      signal,
    });
    if (!signal?.aborted) setAutomatic(loaded.settings.approval === "automatic");
  }
  const commitInitialization = useEffectEvent(
    (
      session: ResolvedSession | undefined,
      automaticApproval: boolean | undefined,
      failures: unknown[],
      signal: AbortSignal,
    ) => {
      if (signal.aborted) return;
      if (session) {
        void navigate("task", session, undefined, true);
      }
      if (automaticApproval !== undefined) setAutomatic(automaticApproval);
      for (const failure of failures) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
      setResolvedSession(search.session);
    },
  );
  useEffect(() => {
    const controller = new AbortController();
    lifetimeController.current = controller;
    void Promise.allSettled([
      search.session
        ? resolveSession(search.session, controller.signal)
        : Promise.resolve(undefined),
      request("/api/settings/orchestration", orchestrationStateSchema, {
        signal: controller.signal,
      }),
    ]).then(([session, settings]) => {
      const failures: unknown[] = [];
      if (session.status === "rejected") failures.push(session.reason);
      if (settings.status === "rejected") failures.push(settings.reason);
      commitInitialization(
        session.status === "fulfilled" ? session.value : undefined,
        settings.status === "fulfilled"
          ? settings.value.settings.approval === "automatic"
          : undefined,
        failures,
        controller.signal,
      );
    });
    return () => {
      controller.abort();
      refinementController.current?.abort();
      lifetimeController.current = undefined;
    };
  }, [search.session]);

  async function navigate(
    next: "task" | "settings",
    selection?: ResolvedSession,
    accepted?: () => void,
    replace = false,
  ) {
    const target = {
      view: next === "settings" ? ("settings" as const) : undefined,
      task: selection ? selection.selectedTask : search.task,
      run: selection ? (selection.selectedTask ? undefined : selection.runId) : search.run,
    };
    await routeNavigate({ to: "/", search: target, hash: "", replace });
    const current = router.state.location.search;
    if (
      current.view !== target.view ||
      current.task !== target.task ||
      current.run !== target.run
    ) {
      return false;
    }
    setSidebar(false);
    accepted?.();
    return true;
  }

  useEffect(() => {
    selectRun(selectedTask ? task?.runId : search.run);
  }, [selectedTask, task?.runId, search.run, selectRun]);
  const reconcileSelection = useEffectEvent(() => {
    if (
      (selectedTask && tasks.some((item) => item.id === selectedTask && item.deletedAt)) ||
      (selectedId && runs.some((item) => item.id === selectedId && item.deletedAt))
    ) {
      void navigate("task", { selectedTask: undefined, runId: undefined }, undefined, true);
    }
  });
  useEffect(() => {
    reconcileSelection();
  }, [tasks, runs, task?.runId]);

  function newTask(text?: string) {
    if (
      text !== undefined &&
      (taskDraft.text || taskDraft.files.length) &&
      !window.confirm("Replace the unsent task draft with this request?")
    )
      return;
    void navigate("task", { selectedTask: undefined, runId: undefined }, () => {
      setComposerKey((key) => key + 1);
      if (text !== undefined) {
        clearTaskDraft();
        setTaskDraftText(text);
      }
    });
  }
  async function perform(action: () => Promise<void>) {
    setPendingActions((count) => count + 1);
    setError("");
    try {
      await action();
    } catch (failure) {
      if (
        !lifetimeController.current?.signal.aborted &&
        !(failure instanceof DOMException && failure.name === "AbortError")
      ) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      setPendingActions((count) => count - 1);
    }
  }

  const linked = new Set(tasks.map((item) => item.runId));
  const executions = new Map(runs.map((item) => [item.id, item]));
  const entries: HistoryEntry[] = [
    ...tasks
      .filter((item) => !item.deletedAt && !executions.get(item.runId ?? "")?.deletedAt)
      .map((item) => {
        const execution = executions.get(item.runId ?? "");
        return {
          id: item.id,
          runId: item.runId,
          title: execution?.title ?? item.prompt,
          status: execution?.status ?? item.status,
          createdAt: item.createdAt,
        };
      }),
    ...runs
      .filter((item) => !item.deletedAt && !linked.has(item.id))
      .map((item) => ({
        id: `run:${item.id}`,
        runId: item.id,
        title: item.title,
        status: item.status,
        createdAt: item.createdAt,
      })),
  ]
    .filter((item) => item.title.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const groups = [
    {
      label: "Active",
      items: entries.filter((item) => activeStatuses[item.status]),
      empty: "No active tasks",
    },
    {
      label: "Previous",
      items: entries.filter((item) => !activeStatuses[item.status]),
      empty: "Completed tasks appear here",
    },
  ];
  const selectedEntry = selectedTask ?? (selectedId ? `run:${selectedId}` : "");
  const selectedItem = entries.find((item) => item.id === selectedEntry);
  const projectName = project?.project.split("/").filter(Boolean).at(-1) ?? "Workspace";
  const sessionId = selectedTask ?? selectedId;
  const copiedSession = copied.id === sessionId ? copied.message : "";
  const answerOccurrences = new Map<string, number>();
  const answers = task?.answers.map((answer) => {
    const identity = JSON.stringify([answer.question, answer.answer]);
    const occurrence = answerOccurrences.get(identity) ?? 0;
    answerOccurrences.set(identity, occurrence + 1);
    return { key: `${identity}:${occurrence}`, value: answer };
  });

  function deleteEntry(item: HistoryEntry) {
    if (busy || cannotDelete(item.status)) return;
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
            signal: actionSignal(),
          }),
        );
      } else {
        applyTask(
          await request(`/api/tasks/${item.id}`, taskSchema, {
            method: "DELETE",
            signal: actionSignal(),
          }),
        );
      }
      const current =
        workspaceRef.current.selectedTask ??
        (data.getSnapshot().selectedId ? `run:${data.getSnapshot().selectedId}` : "");
      if (current === item.id) {
        await navigate("task", { selectedTask: undefined, runId: undefined }, undefined, true);
      }
      await refreshRuns();
    });
  }
  async function openSession(value: string, signal?: AbortSignal) {
    const session = await resolveSession(value, actionSignal(signal));
    await navigate("task", session);
  }
  async function copySession(kind: "link" | "terminal" | "id") {
    if (!sessionId) return;
    const value =
      kind === "id"
        ? sessionId
        : kind === "terminal"
          ? `workflow attach ${sessionId} --server ${new URL(apiUrl("/api/project"), window.location.href).href.replace(/\/api\/project$/, "")}`
          : sessionLink(window.location.href, {
              id: sessionId,
              kind: selectedTask ? "task" : "run",
            });
    try {
      await navigator.clipboard.writeText(value);
      setCopied({
        id: sessionId,
        message:
          kind === "link"
            ? "Session link copied"
            : kind === "terminal"
              ? "Terminal command copied"
              : "Session ID copied",
      });
    } catch {
      setCopied({
        id: sessionId,
        message: "Clipboard unavailable. Select and copy the session ID below.",
      });
    }
  }
  function selectEntry(item: HistoryEntry) {
    void navigate("task", {
      selectedTask: item.id.startsWith("run:") ? undefined : item.id,
      runId: item.runId,
    });
  }
  function openNotice(id: string) {
    const linkedTask = tasks.find((item) => item.runId === id);
    void navigate("task", { selectedTask: linkedTask?.id, runId: id });
    markNoticesRead();
    setNotificationsOpen(false);
  }
  async function submitTask(prompt: string, attachments: string[]) {
    const submittedComposer = composerKey;
    const submittedDraft = taskDraft;
    const signal = actionSignal();
    const created = await request("/api/tasks", taskSchema, {
      method: "POST",
      body: { prompt, attachments },
      signal,
    });
    signal?.throwIfAborted();
    clearSubmitted(submittedDraft);
    const current = workspaceRef.current;
    if (
      current.view === "task" &&
      !current.selectedTask &&
      !data.getSnapshot().selectedId &&
      current.composerKey === submittedComposer
    ) {
      await navigate("task", { selectedTask: created.id, runId: undefined });
    }
    applyTask(created);
  }
  async function submitProgram(
    value: ProgramSource & { title: string; task: string },
    signal: AbortSignal,
  ) {
    const combined = actionSignal(signal);
    const created = await request("/api/programs", runSchema, {
      method: "POST",
      body: value,
      signal: combined,
    });
    combined?.throwIfAborted();
    await navigate("task", { selectedTask: undefined, runId: created.id });
    applyRun(created);
    await refreshRuns();
  }
  function taskAction(action: "answer" | "cancel" | "retry", answer?: string) {
    if (!task) return;
    const current = task;
    void perform(async () => {
      applyTask(
        await request(`/api/tasks/${current.id}/${action}`, taskSchema, {
          method: "POST",
          body: action === "answer" ? { answer, revision: current.revision } : {},
          signal: actionSignal(),
        }),
      );
    });
  }
  function runAction(action: string) {
    if (!run) return;
    const current = run;
    void perform(async () => {
      if (action === "plan-recovery") {
        const created = await request("/api/tasks", taskSchema, {
          method: "POST",
          body: { prompt: current.plan.task, sourceRunId: current.id },
          signal: actionSignal(),
        });
        if (workspaceRef.current.view === "task" && data.getSnapshot().selectedId === current.id) {
          await navigate("task", { selectedTask: created.id, runId: undefined });
        }
        applyTask(created);
      } else {
        applyRun(
          await request(`/api/runs/${current.id}/${action}`, runSchema, {
            method: "POST",
            body: {},
            revision: action === "approve" ? current.revision : undefined,
            signal: actionSignal(),
          }),
        );
      }
      await refreshRuns();
    });
  }
  function savePlan() {
    if (!run) return;
    const current = run;
    const edit = draft;
    void perform(async () => {
      const saved = await request(
        `/api/runs/${current.id}/${isSourceWorkflow(current) ? "program" : "plan"}`,
        runSchema,
        {
          method: "PUT",
          body: isSourceWorkflow(current) ? edit.validProgram : JSON.parse(edit.text),
          revision: edit.revision,
          signal: actionSignal(),
        },
      );
      applyRun(saved);
      edit.saved(saved);
    });
  }
  function refine(instructions: string) {
    if (!run) return;
    const current = run;
    const edit = draft;
    void perform(async () => {
      const controller = new AbortController();
      refinementController.current = controller;
      setRefining(true);
      setCoordinatorText("");
      setCoordinatorActivity("Refining the workflow…");
      try {
        const updated = await request(`/api/runs/${current.id}/refine`, runSchema, {
          method: "POST",
          body: { instructions },
          revision: current.revision,
          signal: actionSignal(controller.signal),
        });
        applyRun(updated);
        edit.saved(updated);
        await refreshRuns();
      } catch (failure) {
        if (!controller.signal.aborted) throw failure;
        setCoordinatorActivity("Refinement cancelled.");
      } finally {
        if (refinementController.current === controller) {
          refinementController.current = undefined;
          setRefining(false);
        }
      }
    });
  }
  function saveSuggestedBlocks() {
    if (!task || !run) return;
    const currentTask = task;
    const currentRun = run;
    void perform(async () => {
      const proposal = await request("/api/library/proposals", libraryProposalSchema, {
        method: "POST",
        signal: actionSignal(),
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
        signal: actionSignal(),
      });
      await refreshProject();
    });
  }
  async function settingsSaved() {
    await refreshProject();
    await readSettings(actionSignal());
  }
  function design(scope: DesignScope, prompt?: string) {
    setDesignRequest((previous) => ({ scope, prompt, key: (previous?.key ?? 0) + 1 }));
  }
  async function designApplied() {
    await settingsSaved();
    setSettingsRevision((revision) => revision + 1);
  }

  return (
    <div
      className={`app-shell${sidebar ? " sidebar-open" : ""}${designChatCount > 0 ? " has-design-chats" : ""}`}
    >
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className="task-sidebar">
        <button className="brand" onClick={() => newTask()}>
          <span className="brand-mark">
            <Icon name="workflow" size={21} />
          </span>
          <strong>
            workflow<span>from intent to done</span>
          </strong>
        </button>
        <button className="new-task-button" aria-label="New task" onClick={() => newTask()}>
          <Icon name="plus" size={19} />
          New task
        </button>
        <SessionSwitcher onOpen={openSession} />
        <div className="sidebar-search">
          <Icon name="search" size={15} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            aria-label="Search tasks"
            placeholder="Search tasks"
          />
        </div>
        <div className="task-history">
          {groups.map((group) => (
            <section key={group.label}>
              <div className="history-heading">
                {group.label}
                <span>{group.items.length}</span>
              </div>
              {group.items.map((item) => (
                <div key={item.id} className="task-history-entry">
                  <button
                    className={`task-item${view === "task" && selectedEntry === item.id ? " selected" : ""}`}
                    title={item.title}
                    onClick={() => selectEntry(item)}
                  >
                    <span className={`status-dot ${item.status}`} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{statusLabel(item.status)}</small>
                    </span>
                  </button>
                  <button
                    className="history-delete icon-button"
                    aria-label={`Delete ${item.title}`}
                    disabled={busy || cannotDelete(item.status)}
                    title={
                      cannotDelete(item.status)
                        ? "Stop this task before deleting it"
                        : "Delete from history"
                    }
                    onClick={() => deleteEntry(item)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
              {!group.items.length && <p className="sidebar-empty">{group.empty}</p>}
            </section>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="workspace-label">
            <Icon name="folder" />
            <span title={project?.project}>
              {projectName}
              <small>Local workspace</small>
            </span>
            <span
              className={`connection-dot${connected ? " online" : ""}`}
              title={connected ? "Connected" : "Reconnecting"}
            />
          </div>
          <button
            className={`settings-button${view === "settings" ? " selected" : ""}`}
            onClick={() => navigate("settings")}
          >
            <Icon name="settings" />
            Settings
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="workspace-topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setSidebar(true)}
          >
            <Icon name="menu" />
          </button>
          <div className="workspace-breadcrumb">
            <span>{projectName}</span>
            <Icon name="chevron" size={12} />
            <strong>
              {view === "settings" ? "Settings" : selectedEntry ? "Task workspace" : "New task"}
            </strong>
          </div>
          <div className="topbar-right">
            <button
              className="ai-button"
              aria-label="Open AI designer"
              onClick={() => design("project")}
            >
              <Icon name="spark" />
              Design with AI
            </button>
            <div className="notifications">
              <button
                className="icon-button"
                aria-label="Notifications"
                aria-expanded={notificationsOpen}
                onClick={() => setNotificationsOpen((open) => !open)}
              >
                <Icon name="bell" />
                {unread > 0 && <span className="notification-count">{unread}</span>}
              </button>
              {notificationsOpen && (
                <section className="notification-panel" aria-label="Workflow notifications">
                  <div className="card-title">
                    <strong>Notifications</strong>
                    <button className="quiet" onClick={markNoticesRead}>
                      Mark all read
                    </button>
                  </div>
                  {!notices.length && (
                    <p className="muted">Workflow completions, failures and pauses appear here.</p>
                  )}
                  {notices.map((notice) => (
                    <button
                      key={notice.id}
                      className={`notification-item${!notice.read ? " unread" : ""}`}
                      onClick={() => openNotice(notice.runId)}
                    >
                      <strong>{notice.title}</strong>
                      <span>{notice.message}</span>
                      <small>{new Date(notice.time).toLocaleTimeString()}</small>
                    </button>
                  ))}
                </section>
              )}
            </div>
            {project?.mode === "demo" && <span className="demo-badge">DEMO</span>}
            <span className="connection-text">
              <span className={`connection-dot${connected ? " online" : ""}`} />
              {connected ? "Connected" : "Reconnecting"}
            </span>
          </div>
        </header>
        {(error || taskError) && (
          <div className="error-banner" role="alert">
            <span>{error || taskError}</span>
            <button
              onClick={() => {
                setError("");
                setTaskError("");
              }}
            >
              Dismiss
            </button>
          </div>
        )}
        <main
          className={
            view === "settings" ? "settings-main" : !selectedEntry ? "home-main" : "task-main"
          }
        >
          {view === "settings" && project ? (
            <Suspense fallback={null}>
              <SettingsPage
                library={project}
                onSaved={settingsSaved}
                designRevision={settingsRevision}
                applyingDesign={applyingDesign}
                usageRevision={usageRevision}
                setupController={setupJobs}
                demo={project.mode === "demo"}
                onDirty={settingsChanged}
                onContext={setSettingsContext}
                onDesign={design}
              />
            </Suspense>
          ) : !selectedEntry ? (
            <div className="task-home">
              <div className="home-symbol">
                <Icon name="workflow" size={30} />
              </div>
              <div className="home-eyebrow">YOUR PROJECT. A CLEAR PLAN.</div>
              <h1>What should we work on?</h1>
              <p>Share the goal. Choose what flows between steps. Follow the work anywhere.</p>
              {project && (
                <SetupProgress
                  controller={setupJobs}
                  compact
                  demo={project.mode === "demo"}
                  onSettings={() => navigate("settings")}
                />
              )}
              {project && (
                <TaskComposerReact
                  key={composerKey}
                  text={taskDraft.text}
                  files={taskDraft.files}
                  automatic={automatic}
                  onSubmit={submitTask}
                  onTextChange={setTaskDraftText}
                  onFilesChange={setTaskDraftFiles}
                  onDiscard={clearTaskDraft}
                  onSettings={() => navigate("settings")}
                />
              )}
              <ProgramComposerReact onSubmit={submitProgram} />
              {project?.mode === "demo" && (
                <p className="demo-note">
                  Demo mode simulates planning, agents and checks. Task files stay unchanged.
                </p>
              )}
            </div>
          ) : (
            <div className="task-content">
              <div className="task-request">
                <div className="request-heading">
                  <span className="eyebrow">YOUR REQUEST</span>
                  <div className="request-actions">
                    {selectedItem && (
                      <button
                        className="quiet danger-quiet"
                        disabled={busy || cannotDelete(selectedItem.status)}
                        title={
                          cannotDelete(selectedItem.status)
                            ? "Stop this task before deleting it"
                            : "Remove from history"
                        }
                        onClick={() => deleteEntry(selectedItem)}
                      >
                        <Icon name="trash" size={14} />
                        Delete workflow
                      </button>
                    )}
                    <button
                      className="quiet"
                      disabled={busy}
                      onClick={() => newTask(task?.prompt ?? run?.plan.task ?? "")}
                    >
                      Use in a new task
                      <Icon name="plus" size={14} />
                    </button>
                  </div>
                </div>
                <p>{task?.prompt ?? run?.plan.task ?? "Loading request…"}</p>
                {sessionId && (
                  <div className="session-access" aria-label="Shared session">
                    <span className="session-id">
                      <Icon name="terminal" size={14} />
                      <span>Session</span>
                      <code>{sessionId}</code>
                    </span>
                    <div className="session-access-actions">
                      <button
                        className="quiet"
                        title="Copy session ID"
                        onClick={() => void copySession("id")}
                      >
                        <Icon name="copy" size={13} />
                        Copy ID
                      </button>
                      <button className="quiet" onClick={() => void copySession("link")}>
                        Copy link
                      </button>
                      <button className="quiet" onClick={() => void copySession("terminal")}>
                        <Icon name="terminal" size={13} />
                        Continue in terminal
                      </button>
                    </div>
                    {copiedSession && (
                      <span className="session-copy-notice" role="status">
                        {copiedSession}
                      </span>
                    )}
                  </div>
                )}
                {!!task?.attachments.length && (
                  <div className="request-attachments">
                    {task.attachments.map((file) => (
                      <a
                        key={file.id}
                        href={apiUrl(`/api/attachments/${file.id}`)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {file.kind === "image" ? (
                          <img src={apiUrl(`/api/attachments/${file.id}`)} alt={file.name} />
                        ) : (
                          <Icon name="file" />
                        )}
                        <span>{file.name}</span>
                      </a>
                    ))}
                  </div>
                )}
                {answers?.map(({ key, value: answer }) => (
                  <details key={key}>
                    <summary>{answer.question}</summary>
                    <p>{answer.answer}</p>
                  </details>
                ))}
              </div>
              {(task || run) && (
                <UsageSummary
                  key={task?.id ?? run?.id}
                  scope={task ? "task" : "run"}
                  scopeId={task?.id ?? run!.id}
                  revision={`${usageRevision}:${task?.updatedAt}:${run?.revision}`}
                  active={
                    refining ||
                    !!(task && ["queued", "planning"].includes(task.status)) ||
                    !!(run && ["running", "pausing"].includes(run.status))
                  }
                />
              )}
              {task?.error && task.runId && (
                <div className="inline-error" role="alert">
                  {task.error}
                </div>
              )}
              {task && !task.runId && (
                <TaskPlanning
                  key={task.id}
                  task={task}
                  stream={taskStreams[task.id]}
                  busy={busy}
                  onAnswer={(answer) => taskAction("answer", answer)}
                  onCancel={() => taskAction("cancel")}
                  onRetry={() => taskAction("retry")}
                />
              )}
              {task?.rationale && (
                <div className="plan-rationale">
                  <Icon name="spark" size={17} />
                  <div>
                    <span>{task.caseName ?? "Task plan"}</span>
                    <p>{task.rationale}</p>
                  </div>
                </div>
              )}
              {!!task?.suggestedBlocks.length && run && (
                <details className="suggested-blocks">
                  <summary>
                    {task.suggestedBlocks.length} new block
                    {task.suggestedBlocks.length === 1 ? "" : "s"} suggested for this task
                  </summary>
                  {task.suggestedBlocks.map((item) => (
                    <article key={item.id}>
                      <h3>
                        {(run.program?.catalog[item.id] ?? run.blocks[item.id])?.definition.name ??
                          item.id}
                      </h3>
                      <p>{item.rationale}</p>
                      <pre>
                        {JSON.stringify(
                          run.program?.catalog[item.id] ?? run.blocks[item.id],
                          null,
                          2,
                        )}
                      </pre>
                    </article>
                  ))}
                  <button disabled={busy} onClick={saveSuggestedBlocks}>
                    Save these blocks to the reusable library
                  </button>
                </details>
              )}
              {run ? (
                <RunWorkspace
                  run={run}
                  draft={draft}
                  events={events}
                  liveText={liveText}
                  liveTextByNode={liveTextByNode}
                  busy={busy}
                  live={project?.mode === "live"}
                  coordinatorActivity={coordinatorActivity}
                  coordinatorText={coordinatorText}
                  refining={refining}
                  onCancelRefinement={() => refinementController.current?.abort()}
                  onSettings={() => navigate("settings")}
                  onAction={runAction}
                  onSave={savePlan}
                  onRefine={refine}
                />
              ) : (
                (!task || task.runId) && (
                  <div className="panel-empty" role="status">
                    <span className="spinner" />
                    <p>Loading workflow…</p>
                  </div>
                )
              )}
            </div>
          )}
        </main>
      </div>
      {latestNotice && !notificationsOpen && (
        <div className="notification-toast" role="status">
          <Icon name="bell" />
          <button className="quiet" onClick={() => openNotice(latestNotice.runId)}>
            <strong>{latestNotice.title}</strong>
            <span>{latestNotice.message}</span>
          </button>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setDismissedNotice(latestNotice.id)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      <Suspense fallback={null}>
        <DesignDock
          requested={designRequest}
          pageContext={{
            page: view,
            ...(view === "task" ? { taskId: task?.id, runId: run?.id } : settingsContext),
          }}
          hasUnsavedSettings={settingsDirty}
          onApplied={designApplied}
          onApplyingChange={setApplyingDesign}
          onChatsChange={setDesignChatCount}
        />
      </Suspense>
    </div>
  );
}
