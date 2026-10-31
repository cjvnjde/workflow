import { lazy, Suspense, useLayoutEffect, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  resolveAgentSettings,
  type RunEvent,
  type WorkflowRun,
} from "../../../src/contracts/index.js";
import type { PlanDraft } from "../tasks/use-draft.js";
import { currentActivity, statusLabel, stepState } from "./workflow-status.js";
import { recoveryAdvice } from "./run-report.js";
import ExecutionEvidence from "./ExecutionEvidence.js";
import ExecutionInspector from "./ExecutionInspector.js";
import Icon from "../../shared/Icon.js";
import { executionLabel, isSourceWorkflow } from "./execution-label.js";
import MarkdownView from "../../shared/MarkdownView.js";
import MarkdownActions from "../../shared/MarkdownActions.js";
import ActivityFeed from "./ActivityFeed.js";
import { describeActivity } from "./activity.js";
import { findGroup } from "../graph/graph-layout.js";
import { usageCost } from "../usage/usage-presentation.js";

const WorkflowGraph = lazy(() => import("../graph/WorkflowGraph.js"));
const PlanEditor = lazy(() => import("../tasks/PlanEditor.js"));
const ProgramEditor = lazy(() => import("../programs/ProgramEditor.js"));
const DataInspector = lazy(() => import("./DataInspector.js"));
const RememberApproach = lazy(() => import("../tasks/RememberApproach.js"));

interface RunWorkspaceProps {
  run: WorkflowRun;
  draft: PlanDraft;
  events: RunEvent[];
  liveText: string;
  liveTextByNode?: Record<string, string>;
  busy: boolean;
  live: boolean;
  coordinatorActivity: string;
  coordinatorText: string;
  refining: boolean;
  onAction: (action: string) => void;
  onSave: () => void;
  onRefine: (instructions: string) => void;
  onCancelRefinement: () => void;
  onSettings: () => void;
}

type EvidenceSelection = {
  nodeId: string;
  visit: number;
  operationId: string;
  sessionId?: string;
};
const tabs = [
  ["results", "Results", "file"],
  ["workflow", "Workflow", "workflow"],
  ["data", "Data", "search"],
  ["timeline", "Timeline", "clock"],
  ["activity", "Activity", "log"],
  ["artifacts", "Artifacts", "folder"],
  ["edit", "Editor", "code"],
] as const;
type WorkspaceTab = (typeof tabs)[number][0];

export default function RunWorkspace(props: RunWorkspaceProps) {
  const [groupedActivity, setGroupedActivity] = useState(false);
  return (
    <RunWorkspaceView
      key={props.run.id}
      {...props}
      groupedActivity={groupedActivity}
      onGroupedActivity={setGroupedActivity}
    />
  );
}

function RunWorkspaceView({
  run,
  draft,
  events,
  liveText,
  liveTextByNode,
  busy,
  live,
  coordinatorActivity,
  coordinatorText,
  refining,
  onAction,
  onSave,
  onRefine,
  onCancelRefinement,
  onSettings,
  groupedActivity,
  onGroupedActivity,
}: RunWorkspaceProps & {
  groupedActivity: boolean;
  onGroupedActivity: (grouped: boolean) => void;
}) {
  const [tab, setTab] = useState<WorkspaceTab>(() =>
    isSourceWorkflow(run) && !run.program?.structure && run.status === "draft"
      ? "edit"
      : "workflow",
  );
  const [selected, setSelected] = useState<string>();
  const [evidenceSelection, setEvidenceSelection] = useState<EvidenceSelection>();
  const [expanded, setExpanded] = useState(false);
  const [previousStatus, setPreviousStatus] = useState(run.status);
  const [now, setNow] = useState(Date.now);
  const focusDialog = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const inlineMount = useRef<HTMLDivElement>(null);
  const graph = useRef<{ fit: () => void }>(null);
  // Keep one portal container while moving between the page and native dialog.
  // Moving the same DOM subtree preserves editor state, searches and graph position.
  const [workspaceHost] = useState(() => {
    const host = document.createElement("div");
    host.style.display = "contents";
    return host;
  });

  if (previousStatus !== run.status) {
    setPreviousStatus(run.status);
    if (run.program && previousStatus === "draft" && run.approvedAt && tab === "edit") {
      setTab("workflow");
    }
  }

  useEffect(() => {
    if (!["running", "pausing"].includes(run.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.status]);

  useLayoutEffect(() => {
    const dialog = focusDialog.current;
    const inline = inlineMount.current;
    if (!dialog || !inline) return;
    const overflow = document.body.style.overflow;
    const mounted = workspaceHost.isConnected;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing) return;
      // Capture before search fields clear their query, including portal children.
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
    }
    if (expanded) {
      dialog.append(workspaceHost);
      document.body.style.overflow = "hidden";
      dialog.addEventListener("keydown", closeOnEscape, true);
      dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
      inline.append(workspaceHost);
    }
    if (expanded || mounted) expandButton.current?.focus({ preventScroll: true });
    const frame =
      expanded || mounted ? requestAnimationFrame(() => graph.current?.fit()) : undefined;
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (expanded) {
        dialog.removeEventListener("keydown", closeOnEscape, true);
        document.body.style.overflow = overflow;
        if (dialog.open) dialog.close();
      }
    };
  }, [expanded, workspaceHost]);

  const plan = draft.dirty && draft.validPlan ? draft.validPlan : run.plan;
  const node = plan.nodes.find((item) => item.id === selected);
  const bundle = node && run.blocks[node.block];
  const selectedGroup = selected ? findGroup(run.program?.structure, selected) : undefined;
  const activeLabels = run.plan.nodes
    .filter((item) => stepState(run, item.id) === "running")
    .map((item) => item.label);
  const agent = bundle
    ? resolveAgentSettings(run.config.agent, bundle.definition.agent, node?.agent)
    : undefined;
  const active = run.plan.nodes.find((item) => item.id === run.cursor);
  const latestEvent = events
    .filter((event) => event.kind !== "usage" && (!event.nodeId || event.nodeId === run.cursor))
    .at(-1);
  const latestActivity = latestEvent && describeActivity(latestEvent);
  const activeAttempt = run.attempts.filter((item) => item.nodeId === run.cursor).at(-1);
  const elapsed = activeAttempt
    ? Math.max(0, Math.floor((now - new Date(activeAttempt.startedAt).getTime()) / 1000))
    : 0;
  const completed = run.plan.nodes.filter((item) => stepState(run, item.id) === "pass").length;
  const skipped = run.plan.nodes.filter((item) => stepState(run, item.id) === "skipped").length;
  const activeStepCount = activeLabels.length;
  const running = ["running", "pausing"].includes(run.status) || !!run.activeNodes?.length;
  const artifacts = Object.entries(run.artifacts).flatMap(([nodeId, items]) =>
    Object.entries(items).map(([name, content]) => ({ nodeId, name, content })),
  );
  const finished = [
    "completed",
    "failed",
    "cancelled",
    "rejected",
    "interrupted",
    "paused",
  ].includes(run.status);
  const orderedAttempts = [...run.attempts].sort((a, b) =>
    (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt),
  );
  const lastAttempt =
    orderedAttempts.find((attempt) => {
      const latest = run.attempts.filter((other) => other.nodeId === attempt.nodeId).at(-1);
      return (
        latest === attempt &&
        (attempt.recovery?.status === "conflict" ||
          (["interrupted", "failed", "cancelled"].includes(run.status) && attempt.error))
      );
    }) ?? orderedAttempts[0];
  const recoveryNeeded = run.attempts.some(
    (attempt) =>
      attempt.recovery?.status === "conflict" ||
      (run.status === "interrupted" && attempt.error && !attempt.recovery),
  );
  const liveResponses = Object.fromEntries(
    Object.entries(liveTextByNode ?? {}).filter(
      ([id, text]) => !!text && (!selected || selected === id),
    ),
  );
  const resultSummary =
    run.error ??
    run.output ??
    lastAttempt?.error ??
    lastAttempt?.result?.summary ??
    (run.status === "completed"
      ? "All workflow completion conditions were met."
      : run.status === "rejected"
        ? "The proposed workflow was rejected. No steps were executed."
        : run.status === "paused"
          ? "Execution is paused. Review the step results before continuing."
          : "Execution stopped. Review the step activity before retrying.");
  const resultTitle =
    lastAttempt?.result?.disposition === "blocked" && run.status === "failed"
      ? "Blocked: prerequisites unavailable"
      : ({
          completed: "Workflow completed",
          failed: "Workflow failed",
          interrupted: "Execution interrupted",
          cancelled: "Workflow stopped",
          rejected: "Workflow rejected",
          paused: "Workflow paused",
        }[run.status as "completed"] ?? "Latest results");
  const resultArtifacts = [...artifacts].sort(
    (a, b) => Number(b.nodeId === lastAttempt?.nodeId) - Number(a.nodeId === lastAttempt?.nodeId),
  );
  const report = [
    `# ${run.plan.title}`,
    `Status: ${statusLabel(run.status)}`,
    resultSummary,
    ...resultArtifacts.map(
      (artifact) => `## ${artifact.nodeId} / ${artifact.name}\n\n${artifact.content}`,
    ),
  ].join("\n\n");
  const selectedAttempt = run.attempts.filter((attempt) => attempt.nodeId === selected).at(-1);
  const advice = recoveryAdvice(run);

  function openEvidence(nodeId: string, visit: number, operationId: string, sessionId?: string) {
    setSelected(nodeId);
    setEvidenceSelection({ nodeId, visit, operationId, sessionId });
    setTab("data");
  }
  function resume() {
    if (
      run.status === "interrupted" &&
      !window.confirm(
        "Review step logs and any command side effects first. Retry the interrupted step?",
      )
    )
      return;
    onAction("resume");
  }
  function selectStep(id: string) {
    setEvidenceSelection(undefined);
    setSelected(
      plan.nodes.some((item) => item.id === id) || findGroup(run.program?.structure, id)
        ? id
        : undefined,
    );
    if (tab === "edit") setTab("workflow");
  }

  const details = (
    <section className="details-panel">
      {expanded && (
        <header className="expanded-heading">
          <div>
            <span className="eyebrow">WORKFLOW WORKSPACE</span>
            <h2>{run.plan.title}</h2>
          </div>
          <span className={`status-pill ${run.status}`}>
            <span className={`status-dot ${run.status}`} />
            {statusLabel(run.status)}
          </span>
        </header>
      )}
      <nav className="tabs" aria-label="Workflow views">
        {tabs.map(([id, label, icon]) => (
          <button key={id} className={tab === id ? "active" : undefined} onClick={() => setTab(id)}>
            <Icon name={icon} size={15} />
            {label}
          </button>
        ))}
        <span>
          {running
            ? "Live"
            : run.program && !run.plan.nodes.length
              ? "Steps appear during execution"
              : `${completed}/${run.plan.nodes.length - skipped} ${run.plan.nodes.length - skipped === 1 ? "block" : "blocks"} passed${skipped ? ` · ${skipped} skipped` : ""}`}
        </span>
        <button
          ref={expandButton}
          className="expand-workspace"
          aria-label={expanded ? "Close expanded view" : "Expand workspace"}
          title={expanded ? "Close expanded view (Esc)" : "Expand workflow, results and activity"}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name={expanded ? "close" : "expand"} size={16} />
          <span>{expanded ? "Close" : "Expand"}</span>
        </button>
      </nav>
      <Suspense fallback={null}>
        {tab === "results" && (
          <div className="results-panel">
            <div className="card-title">
              <h2>{finished ? resultTitle : "Results so far"}</h2>
              <MarkdownActions content={report} filename={`${run.id}-results.md`} />
            </div>
            <ExecutionEvidence run={run} events={events} now={now} />
            {finished && <MarkdownView content={resultSummary} />}
            {run.attempts.some((attempt) => attempt.checks.length) && (
              <details className="result-checks">
                <summary>
                  Verification checks ·{" "}
                  {run.attempts.reduce((sum, attempt) => sum + attempt.checks.length, 0)} recorded
                </summary>
                {run.attempts.flatMap((attempt) =>
                  attempt.checks.map((check) => (
                    <details
                      key={`${attempt.nodeId}-${attempt.visit}-${check.command}-${check.expected}`}
                    >
                      <summary>
                        {check.matched ? "✓ Met expectation" : "× Did not meet expectation"} ·{" "}
                        {attempt.nodeId} / visit {attempt.visit} · {check.command} · exit{" "}
                        {check.exitCode ?? "unknown"}
                      </summary>
                      <pre>{check.output}</pre>
                    </details>
                  )),
                )}
              </details>
            )}
            {!artifacts.length && !finished && (
              <div className="panel-empty">Step results will appear here as the workflow runs.</div>
            )}
            {resultArtifacts.map((artifact) => (
              <article key={`${artifact.nodeId}/${artifact.name}`} className="result-artifact">
                <div className="card-title">
                  <h3>
                    {run.plan.nodes.find((item) => item.id === artifact.nodeId)?.label ??
                      artifact.nodeId}{" "}
                    / {artifact.name}
                  </h3>
                  <MarkdownActions
                    content={artifact.content}
                    filename={`${artifact.nodeId}-${artifact.name}${artifact.name.endsWith(".md") ? "" : ".md"}`}
                  />
                </div>
                <MarkdownView content={artifact.content} />
              </article>
            ))}
          </div>
        )}
        {tab === "workflow" && (
          <div className={`workflow-canvas${node || selectedGroup ? " inspecting" : ""}`}>
            <div className="graph-panel">
              {!plan.nodes.length ? (
                <div className="panel-empty">
                  <Icon name="code" size={28} />
                  <p>The graph appears as the TypeScript workflow reaches each step.</p>
                  <button onClick={() => setTab("edit")}>View TypeScript</button>
                </div>
              ) : (
                <WorkflowGraph
                  ref={graph}
                  key={run.id}
                  run={{ ...run, plan }}
                  selected={selected}
                  onSelect={selectStep}
                />
              )}
              <div className="graph-legend">
                {draft.dirty && draft.validPlan && <strong>Unsaved preview</strong>}
                {run.program?.structure ? (
                  <>
                    <span>― next</span>
                    <span>┄ repeat until satisfied</span>
                    <span>Groups show branches and concurrency</span>
                  </>
                ) : (
                  <>
                    <span>― pass</span>
                    <span>┄ retry with feedback</span>
                    <span>― fail</span>
                  </>
                )}
              </div>
            </div>
            {node && bundle ? (
              <aside className="step-inspector">
                <div className="card-title">
                  <span className="eyebrow">STEP DETAILS</span>
                  <button
                    className="icon-button"
                    aria-label="Close step details"
                    onClick={() => setSelected(undefined)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <h2>{node.label}</h2>
                <p>{node.goal}</p>
                {(selectedAttempt?.result || selectedAttempt?.error) && (
                  <div className="step-result">
                    <h3>Latest step result · {selectedAttempt.result?.outcome ?? "error"}</h3>
                    <MarkdownView
                      content={selectedAttempt.error ?? selectedAttempt.result?.summary ?? ""}
                    />
                    <button className="quiet" onClick={() => setTab("results")}>
                      View results &amp; artifacts
                    </button>
                  </div>
                )}
                <div className="detail-row">
                  <span>Execution</span>
                  <strong>
                    {bundle.definition.executor
                      ? executionLabel(bundle.definition.executor)
                      : (agent?.model ?? "Project model")}
                  </strong>
                </div>
                {bundle.definition.executor?.kind === "code" && agent?.model && (
                  <div className="detail-row">
                    <span>Default AI model</span>
                    <strong>
                      {agent.model} · {agent.thinking}
                    </strong>
                  </div>
                )}
                {bundle.definition.executor?.kind === "code" && (
                  <p className="muted">
                    Calls to ctx.ai inherit this step's model. An explicit model in the block source
                    takes precedence.
                  </p>
                )}
                <div className="detail-row">
                  <span>Visits</span>
                  <strong>
                    {run.visits[node.id] ?? 0} / {node.maxVisits}
                  </strong>
                </div>
                <h3>Inputs &amp; outputs</h3>
                <p className="muted">
                  Review declared sources before execution, then inspect each visit's stored values
                  and model context.
                </p>
                <button
                  className="quiet"
                  onClick={() => {
                    setEvidenceSelection(undefined);
                    setTab("data");
                  }}
                >
                  Inspect step data
                </button>
                <button className="quiet" onClick={() => setTab("timeline")}>
                  View step timeline
                </button>
                {selectedGroup?.step && (
                  <>
                    <h3>Outcome actions</h3>
                    {(["pass", "retry", "fail"] as const).map((outcome) => (
                      <div key={outcome} className="detail-row">
                        <span>{outcome}</span>
                        <strong>
                          {selectedGroup.step!.options.on?.[outcome] ??
                            (outcome === "pass" ? "continue" : "stop")}
                        </strong>
                      </div>
                    ))}
                    {Object.values(selectedGroup.step.options.on ?? {}).includes("repeat") && (
                      <p className="muted">
                        Repeat starts the next iteration of the nearest enclosing loop.
                      </p>
                    )}
                  </>
                )}
                <button onClick={() => setTab("activity")}>
                  <Icon name="log" size={15} />
                  View step activity
                </button>
                <details>
                  <summary>Instructions &amp; tools</summary>
                  <pre>{bundle.prompt}</pre>
                  {!bundle.definition.executor && (
                    <p>
                      Full file access, Bash, Git and enabled MCP servers. Step instructions define
                      the work to perform.
                    </p>
                  )}
                  <h3>Host checks</h3>
                  <pre>{JSON.stringify(bundle.definition.checks, null, 2)}</pre>
                </details>
              </aside>
            ) : (
              selectedGroup && (
                <aside className="step-inspector">
                  <div className="card-title">
                    <span className="eyebrow">{selectedGroup.kind}</span>
                    <button
                      className="icon-button"
                      aria-label="Close group details"
                      onClick={() => setSelected(undefined)}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                  <h2>{selectedGroup.label}</h2>
                  {selectedGroup.concurrency && (
                    <p>
                      Runs up to {selectedGroup.concurrency} independent branches at once, then
                      waits for the group to finish.
                    </p>
                  )}
                  {selectedGroup.maxIterations && (
                    <p>
                      Repeats until its condition is true, with at most{" "}
                      {selectedGroup.maxIterations} iterations. Each step's visit limit still
                      applies.
                    </p>
                  )}
                  {selectedGroup.condition && (
                    <>
                      <h3>Condition</h3>
                      <pre>{selectedGroup.condition}</pre>
                    </>
                  )}
                  <p>{run.groups?.[selectedGroup.id]?.state ?? "Not started"}</p>
                  <button onClick={() => setTab("edit")}>View TypeScript</button>
                </aside>
              )
            )}
          </div>
        )}
        {tab === "timeline" && (
          <ExecutionInspector
            run={run}
            events={events}
            selected={selected}
            timeline
            onSelect={setSelected}
            onEvidence={openEvidence}
          />
        )}
        {tab === "data" && (
          <DataInspector
            run={run}
            events={events}
            selected={selected}
            focus={evidenceSelection}
            onSelect={setSelected}
            onEditor={() => setTab("edit")}
            onActivity={() => setTab("activity")}
          />
        )}
        {tab === "activity" && (
          <div className="inspection-mode" role="group" aria-label="Activity presentation">
            <button aria-pressed={groupedActivity} onClick={() => onGroupedActivity(true)}>
              Grouped calls
            </button>
            <button aria-pressed={!groupedActivity} onClick={() => onGroupedActivity(false)}>
              Event history
            </button>
          </div>
        )}
        {tab === "activity" && groupedActivity && (
          <ExecutionInspector
            run={run}
            events={events}
            selected={selected}
            onSelect={setSelected}
            onEvidence={openEvidence}
          />
        )}
        {tab === "activity" && !groupedActivity && (
          <ActivityFeed
            key={run.id}
            runId={run.id}
            events={events}
            nodes={plan.nodes}
            selected={selected}
            running={running}
            liveText={!selected || selected === run.cursor ? liveText : ""}
            liveResponses={liveResponses}
            onSelect={setSelected}
          />
        )}
        {tab === "artifacts" && (
          <div className="artifact-list">
            <p className="muted">Each step receives only the context selected in the workflow.</p>
            {artifacts.map((artifact) => (
              <details key={`${artifact.nodeId}-${artifact.name}`}>
                <summary>
                  <Icon name="file" size={16} />
                  {artifact.nodeId} / {artifact.name}
                </summary>
                <MarkdownActions
                  content={artifact.content}
                  filename={`${artifact.nodeId}-${artifact.name}${artifact.name.endsWith(".md") ? "" : ".md"}`}
                />
                <MarkdownView content={artifact.content} />
              </details>
            ))}
            {!artifacts.length && (
              <div className="panel-empty">
                <Icon name="folder" size={26} />
                <p>No artifacts yet.</p>
              </div>
            )}
          </div>
        )}
        {tab === "edit" &&
          (isSourceWorkflow(run) ? (
            <ProgramEditor
              run={run}
              draft={draft}
              busy={busy}
              live={live}
              refining={refining}
              activity={coordinatorActivity}
              onSave={onSave}
              onRefine={onRefine}
              onCancelRefinement={onCancelRefinement}
            />
          ) : (
            <PlanEditor
              run={run}
              draft={draft}
              busy={busy}
              live={live}
              coordinatorActivity={coordinatorActivity}
              coordinatorText={coordinatorText}
              refining={refining}
              onCancelRefinement={onCancelRefinement}
              onSave={onSave}
              onRefine={onRefine}
              onSetup={onSettings}
            />
          ))}
      </Suspense>
    </section>
  );

  return (
    <section className="run-workspace">
      <div className="workflow-heading">
        <div>
          <div className="eyebrow">
            {run.status === "draft" ? "PROPOSED WORKFLOW" : "EXECUTION"}
          </div>
          <h1>{run.plan.title}</h1>
        </div>
        <span className={`status-pill ${run.status}`}>
          <span className={`status-dot ${run.status}`} />
          {statusLabel(run.status)}
        </span>
      </div>
      {advice && (
        <aside className="setup-notice">
          <strong>{advice.category}</strong>
          <p>{advice.action}</p>
          <p>{advice.reuse}</p>
        </aside>
      )}
      <div className="workflow-actions">
        {run.status === "draft" && (
          <>
            <button
              className="primary"
              disabled={busy || draft.dirty}
              title={draft.dirty ? "Save or discard your edits first" : undefined}
              onClick={() => onAction("approve")}
            >
              <Icon name="play" size={16} />
              Approve &amp; start
            </button>
            <button disabled={busy} onClick={() => setTab("edit")}>
              <Icon name="workflow" size={16} />
              Edit workflow
            </button>
            <button className="quiet" disabled={busy} onClick={() => onAction("reject")}>
              Reject
            </button>
          </>
        )}
        {["failed", "cancelled"].includes(run.status) && (
          <button
            disabled={busy}
            title="Create a new reviewed continuation with prior evidence. Validate current files before reusing completed work."
            onClick={() => onAction("plan-recovery")}
          >
            Plan recovery with prior evidence
          </button>
        )}
        {run.status === "running" && (
          <button disabled={busy} onClick={() => onAction("pause")}>
            <Icon name="pause" size={16} />
            Pause after active steps
          </button>
        )}
        {["paused", "interrupted"].includes(run.status) && run.temporalWorkflowId && (
          <button className="primary" disabled={busy} onClick={resume}>
            <Icon name="play" size={16} />
            {run.status === "interrupted" ? "Retry interrupted step" : "Resume workflow"}
          </button>
        )}
        {["running", "pausing", "paused", "interrupted"].includes(run.status) && (
          <button className="danger-quiet" disabled={busy} onClick={() => onAction("cancel")}>
            Stop execution
          </button>
        )}
        {["cancelled", "failed", "interrupted"].includes(run.status) &&
          run.executionProtocol === 2 &&
          run.config.recovery?.rollbackOnFailure !== false &&
          recoveryNeeded && (
            <button disabled={busy} onClick={() => onAction("recover")}>
              Retry file recovery
            </button>
          )}
        {["cancelled", "failed"].includes(run.status) &&
          run.attempts.some((attempt) => attempt.recovery?.status === "conflict") && (
            <button
              disabled={busy}
              title="Retain current files and release this stopped run's file claims. This does not accept the implementation or restart execution."
              onClick={() => onAction("keep-recovery-files")}
            >
              Keep current files
            </button>
          )}
        <span className="workflow-counts">
          {run.plan.nodes.length} {run.plan.nodes.length === 1 ? "block" : "blocks"} ·{" "}
          {run.attempts.length}/{run.config.maxSteps} step visits
          {activeStepCount > 1 && <span> · {activeStepCount} steps running in parallel</span>}
        </span>
      </div>
      {draft.dirty && (
        <div className="draft-notice" role="status">
          <span>
            {draft.stale
              ? "This workflow changed in another session. Your edits are preserved; load the latest draft before saving."
              : "Unsaved workflow changes. Save or discard them before execution."}
          </span>
          <button onClick={() => setTab("edit")}>Review edits</button>
        </div>
      )}
      {run.error && !finished && (
        <div className="inline-error" role="alert">
          {run.error}
        </div>
      )}
      {running && (
        <div className="working-card" role="status">
          <div className="working-orb">
            <Icon name={latestEvent?.kind.startsWith("check") ? "shield" : "spark"} size={23} />
          </div>
          <div>
            <span className="eyebrow">{currentActivity(latestEvent)}</span>
            <strong>
              {activeLabels.length > 1
                ? activeLabels.join(" · ")
                : (active?.label ?? "Preparing execution")}
            </strong>
            <span>
              {run.status === "pausing"
                ? "Finishing active steps, then pausing"
                : (latestActivity?.preview.slice(0, 140) ?? "Starting…")}
            </span>
          </div>
          <time>
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </time>
        </div>
      )}
      {finished && (
        <div className={`result-banner ${run.status}`} role="status">
          <div className="result-icon">
            <Icon name={run.status === "completed" ? "check" : "file"} size={22} />
          </div>
          <div>
            <strong>{resultTitle}</strong>
            <MarkdownView content={resultSummary} />
            <div className="result-links">
              {run.status === "completed" && (
                <Suspense fallback={null}>
                  <RememberApproach key={run.id} runId={run.id} onSettings={onSettings} />
                </Suspense>
              )}
              <button onClick={() => setTab("results")}>
                View full results
                {artifacts.length > 0 && <span> · {artifacts.length} artifacts</span>}
              </button>
              <button
                className="quiet"
                onClick={() => {
                  setSelected(lastAttempt?.nodeId);
                  setTab("activity");
                }}
              >
                View last step activity
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="step-progress" aria-label="Workflow progress">
        {run.plan.nodes.map((item, index) => {
          const state = stepState(run, item.id);
          const definition = run.blocks[item.block]?.definition;
          return (
            <button
              key={item.id}
              className={`progress-step ${state}${selected === item.id ? " selected" : ""}`}
              onClick={() => selectStep(item.id)}
            >
              <span className="step-number">
                {state === "pass" ? (
                  <Icon name="check" size={13} />
                ) : state === "running" ? (
                  <span className="spinner" />
                ) : (
                  index + 1
                )}
              </span>
              <span>
                {item.label}
                <small>
                  {definition?.executor
                    ? executionLabel(definition.executor)
                    : (resolveAgentSettings(run.config.agent, definition?.agent, item.agent)
                        .model ?? "Project model")}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      <dialog
        ref={focusDialog}
        className="workflow-dialog"
        aria-label="Expanded workflow workspace"
        onCancel={(event) => {
          event.preventDefault();
          setExpanded(false);
        }}
        onClose={(event) => {
          if (!event.currentTarget.open) setExpanded(false);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) setExpanded(false);
        }}
      />
      <div ref={inlineMount} style={{ display: "contents" }} />
      {createPortal(details, workspaceHost)}
      <details className="run-metrics">
        <summary>
          <Icon name="clock" size={14} />
          Execution details · {run.attempts.length} visits ·{" "}
          {(
            (run.usage?.inputTokens ?? 0) +
            (run.usage?.outputTokens ?? 0) +
            (run.usage?.cacheReadTokens ?? 0) +
            (run.usage?.cacheWriteTokens ?? 0)
          ).toLocaleString()}{" "}
          tokens
        </summary>
        <div className="metrics-grid">
          <div>
            <small>ESTIMATED EXECUTION COST</small>
            <strong>
              {run.estimate?.expectedCostUsd == null
                ? "Pricing unavailable"
                : `$${run.estimate.expectedCostUsd.toFixed(4)}`}
            </strong>
          </div>
          <div>
            <small>REPORTED EXECUTION COST</small>
            <strong>{run.usage ? usageCost(run.usage) : "Not reported"}</strong>
          </div>
          <div>
            <small>EXECUTION LIMIT</small>
            <strong>
              {run.config.budget?.maxCostUsd === undefined
                ? "None"
                : `$${run.config.budget.maxCostUsd}`}
            </strong>
          </div>
        </div>
        <p>{run.estimate?.assumptions}</p>
        <small>
          Version {run.executionVersion?.slice(0, 12) ?? "legacy"} · {run.id}
          {run.usage?.unpricedRequests
            ? ` · ${run.usage.unpricedRequests} requests without pricing`
            : ""}
        </small>
      </details>
    </section>
  );
}
