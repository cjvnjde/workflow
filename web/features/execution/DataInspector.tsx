import { Fragment, useEffect, useEffectEvent, useRef, useState } from "react";
import type {
  AttemptEvidence,
  EvidenceContentRef,
  EvidenceDependency,
  EvidenceValue as PlannedValue,
  StoredEvidenceValue,
  WorkflowRun,
  RunEvent,
} from "../../../src/contracts/index.js";
import { client } from "../../shared/api.js";
import { findGroup } from "../graph/graph-layout.js";
import { usageCost, usageTokens } from "../usage/usage-presentation.js";
import EvidenceValue from "../../shared/EvidenceValue.js";
import "./DataInspector.css";

type Props = {
  run: WorkflowRun;
  selected?: string;
  focus?: { nodeId: string; visit: number; operationId: string; sessionId?: string };
  events: RunEvent[];
  onSelect?: (id: string) => void;
  onEditor?: () => void;
  onActivity?: () => void;
};
const captured = (ref: EvidenceContentRef): StoredEvidenceValue => ({ state: "captured", ref });
function preview(value: PlannedValue | undefined) {
  return value?.state === "json"
    ? JSON.stringify(value.value, null, 2)
    : value?.state === "unavailable"
      ? value.reason
      : "No value (undefined)";
}
export default function DataInspector(props: Props) {
  const { run, selected, focus, onSelect, onEditor } = props;
  const node =
    run.plan.nodes.find((item) => item.id === selected) ??
    run.plan.nodes.find((item) => item.id === run.activeNodes?.[0]) ??
    run.plan.nodes.find((item) => item.id === run.attempts.at(-1)?.nodeId) ??
    run.plan.nodes[0];
  const visits = run.attempts
    .filter((item) => item.nodeId === node?.id)
    .sort((a, b) => b.visit - a.visit);
  const [selection, setSelection] = useState({
    runId: run.id,
    nodeId: node?.id,
    visit: focus?.nodeId === node?.id ? focus?.visit : undefined,
    focus,
  });
  if (selection.runId !== run.id || selection.nodeId !== node?.id || selection.focus !== focus)
    setSelection({
      runId: run.id,
      nodeId: node?.id,
      visit:
        focus !== selection.focus && focus?.nodeId === node?.id
          ? focus?.visit
          : selection.nodeId === node?.id && selection.runId === run.id
            ? selection.visit
            : focus?.nodeId === node?.id
              ? focus?.visit
              : undefined,
      focus,
    });
  const visit = selection.visit ?? visits[0]?.visit;
  const attempt = visits.find((item) => item.visit === visit);
  const shape = node && findGroup(run.program?.structure, node.id)?.step;
  function select(id: string) {
    setSelection({ runId: run.id, nodeId: id, visit: undefined, focus });
    onSelect?.(id);
  }
  function producer(dependency: EvidenceDependency) {
    if (!dependency.producerVisit) return;
    setSelection({
      runId: run.id,
      nodeId: dependency.producerNodeId,
      visit: dependency.producerVisit,
      focus,
    });
    if (node?.id !== dependency.producerNodeId) onSelect?.(dependency.producerNodeId);
  }
  const label = (id: string) => run.plan.nodes.find((item) => item.id === id)?.label ?? id;
  const [refresh, setRefresh] = useState(0);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  return (
    <section className="data-inspector" aria-label="Step data inspector">
      <div className="data-toolbar">
        <label>
          Step
          <select value={node?.id ?? ""} onChange={(event) => select(event.target.value)}>
            {run.plan.nodes.map((step) => (
              <option key={step.id} value={step.id}>
                {step.label} · {step.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Visit
          <select
            value={visit ?? ""}
            disabled={!visits.length}
            onChange={(event) => setSelection({ ...selection, visit: Number(event.target.value) })}
          >
            {!visits.length && <option value="">Not started</option>}
            {visits.map((item) => (
              <option key={item.visit} value={item.visit}>
                Visit {item.visit} ·{" "}
                {item.error ? "error" : (item.result?.outcome ?? "in progress")}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!node || !visit || evidenceLoading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh data
        </button>
      </div>
      <p className="data-explanation">
        Each visit has its own stored values. Open a value to load it; copy and download retain the
        full stored content.
      </p>
      {node ? (
        <>
          <details className="data-planned" open={!attempt}>
            <summary>Planned inputs &amp; sources{attempt ? "" : " · not executed"}</summary>
            <p>
              These declarations describe what the step will receive. Deferred expressions are shown
              as source and are evaluated only during execution.
            </p>
            <h3>Input declaration</h3>
            {shape?.inputPreview ? (
              shape.inputPreview.kind === "none" ? (
                <p>
                  No explicit inputs. The block's input schema may supply defaults when it starts.
                </p>
              ) : shape.inputPreview.kind === "literal" ? (
                <>
                  <span className="data-tag">
                    {shape.inputPreview.value?.state === "unavailable"
                      ? "Literal value unavailable"
                      : "Literal value"}
                  </span>
                  <pre>{preview(shape.inputPreview.value)}</pre>
                </>
              ) : (
                <>
                  <span className="data-tag">Deferred · resolved when this step starts</span>
                  <pre>{shape.inputPreview.expression}</pre>
                  {shape.inputPreview.truncated && (
                    <p className="data-warning">
                      Source preview truncated. Open the editor for the complete workflow source.
                    </p>
                  )}
                </>
              )
            ) : shape?.options.inputs !== undefined ? (
              <>
                <span className="data-tag">Literal value</span>
                <pre>{JSON.stringify(shape.options.inputs, null, 2)}</pre>
              </>
            ) : node.inputs.length ? (
              <div className="data-sources">
                {node.inputs.map((input) => (
                  <p key={`${input.node}/${input.artifact}/${input.as ?? ""}`}>
                    <strong>{input.as ?? input.artifact}</strong> ← {label(input.node)} /{" "}
                    {input.artifact} · {input.required ? "required" : "optional"}
                  </p>
                ))}
              </div>
            ) : run.program || !node.context || !Object.keys(node.context).length ? (
              <p className="data-warning">
                Input source metadata was not recorded for this workflow. Inspect its source;
                current step context is not an exact historical input snapshot.
              </p>
            ) : null}
            {!run.program && node.context && !!Object.keys(node.context).length && (
              <>
                <span className="data-tag">Declared literal string inputs</span>
                <pre>{JSON.stringify(node.context, null, 2)}</pre>
              </>
            )}
            <h3>Prompt declaration</h3>
            {shape?.promptPreview?.kind === "deferred" ? (
              <>
                <span className="data-tag">Deferred prompt</span>
                <pre>{shape.promptPreview.expression}</pre>
                {shape.promptPreview.truncated && (
                  <p className="data-warning">Prompt source preview truncated.</p>
                )}
              </>
            ) : shape?.promptPreview?.kind === "literal" &&
              shape.promptPreview.value?.state === "unavailable" ? (
              <p className="data-warning">{shape.promptPreview.value.reason}</p>
            ) : shape?.promptPreview?.kind === "literal" ? (
              <pre>{preview(shape.promptPreview.value)}</pre>
            ) : shape && !shape.promptPreview && shape.options.prompt === undefined ? (
              <p className="data-warning">
                Prompt source metadata was not recorded for this workflow.
              </p>
            ) : (
              <pre>{shape?.options.prompt ?? node.goal}</pre>
            )}
            <button className="quiet" onClick={onEditor}>
              Open workflow editor
            </button>
          </details>
          {!attempt && (
            <p className="data-empty">
              Resolved inputs, outputs and model sessions will appear after this step starts.
            </p>
          )}
          {visit !== undefined && (
            <VisitEvidence
              key={`${run.id}/${node.id}/${visit}`}
              {...props}
              node={node}
              visit={visit}
              refresh={refresh}
              onProducer={producer}
              onLoading={setEvidenceLoading}
            />
          )}
        </>
      ) : (
        <p className="data-empty">Steps will appear when the workflow declares them.</p>
      )}
    </section>
  );
}

function VisitEvidence({
  run,
  events,
  focus,
  onActivity,
  node,
  visit,
  refresh,
  onProducer,
  onLoading,
}: Props & {
  node: WorkflowRun["plan"]["nodes"][number];
  visit: number;
  refresh: number;
  onProducer: (dependency: EvidenceDependency) => void;
  onLoading: (value: boolean) => void;
}) {
  const [evidence, setEvidence] = useState<AttemptEvidence>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  const identity = { runId: run.id, nodeId: node.id, visit };
  const attempt = run.attempts.find((item) => item.nodeId === node.id && item.visit === visit);
  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    onLoading(true);
    try {
      const value = await client.attemptEvidence(run.id, node.id, visit, controller.signal);
      if (controller.signal.aborted) return;
      if (value.runId !== run.id || value.nodeId !== node.id || value.visit !== visit)
        throw new Error(
          "The server returned evidence for a different step visit. Refresh to try again.",
        );
      setEvidence(value);
      setError("");
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        onLoading(false);
      }
    }
  }
  const refreshEvidence = useEffectEvent(() => {
    void load();
  });
  const lastId = events.at(-1)?.id;
  useEffect(() => {
    const timer = setTimeout(() => refreshEvidence(), 0);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
    };
  }, [run.id, node.id, visit, run.revision, lastId, refresh]);
  const current =
    !!attempt &&
    !attempt.finishedAt &&
    ["running", "pausing", "paused", "interrupted"].includes(run.status);
  const poll = useEffectEvent(() => {
    if (current && !loading && document.visibilityState === "visible") void load();
  });
  useEffect(() => {
    const timer = setInterval(() => poll(), 3000);
    return () => clearInterval(timer);
  }, []);
  const label = (id: string) => run.plan.nodes.find((item) => item.id === id)?.label ?? id;
  return (
    <>
      {loading && !evidence && <p role="status">Loading this visit's evidence…</p>}
      {error && (
        <p className="data-warning" role="status">
          {evidence ? "Showing the last loaded evidence. " : ""}
          {error}
        </p>
      )}
      {evidence && (
        <div className="data-visit">
          <div className="data-visit-heading">
            <h2>
              {node.label} · visit {visit}
            </h2>
            <span>
              {attempt?.error ? "Execution error" : (attempt?.result?.outcome ?? "In progress")}
            </span>
          </div>
          {attempt?.error && <p className="data-warning">{attempt.error}</p>}
          <h3>Resolved inputs</h3>
          {evidence.inputs.state === "available" ? (
            <>
              <p>
                Raw inputs are the resolved handoff. Effective inputs include the block's schema
                defaults or transformations.
              </p>
              {evidence.inputs.value.inputError && (
                <p className="data-warning">Input validation: {evidence.inputs.value.inputError}</p>
              )}
              {evidence.inputs.value.captureWarning && (
                <p className="data-warning">{evidence.inputs.value.captureWarning}</p>
              )}
              <div className="data-inputs">
                <EvidenceValue
                  identity={identity}
                  value={evidence.inputs.value.raw}
                  label="Raw inputs"
                  named
                />
                <EvidenceValue
                  identity={identity}
                  value={evidence.inputs.value.effective}
                  label="Effective inputs"
                  named
                />
              </div>
              <EvidenceValue
                identity={identity}
                value={evidence.inputs.value.prompt}
                label="Resolved step prompt"
              />
              {!!evidence.inputs.value.dependencies.length && (
                <div className="data-dependencies">
                  <h4>Source steps</h4>
                  <p>
                    Computed reads identify source steps. Field-level mapping is shown only when
                    explicitly recorded.
                  </p>
                  {evidence.inputs.value.dependencies.map((dependency) => (
                    <div key={JSON.stringify(dependency)}>
                      <span>
                        {dependency.inputName
                          ? `Input ${dependency.inputName}`
                          : dependency.usedBy === "prompt"
                            ? "Prompt computed from"
                            : "Inputs computed from"}
                      </span>
                      <button
                        className="quiet"
                        disabled={
                          !dependency.producerVisit ||
                          !run.plan.nodes.some((step) => step.id === dependency.producerNodeId)
                        }
                        onClick={() => onProducer(dependency)}
                      >
                        {label(dependency.producerNodeId)} ·{" "}
                        {dependency.producerVisit
                          ? `visit ${dependency.producerVisit}`
                          : "no completed visit"}
                      </button>
                      <small>{dependency.artifact ?? dependency.kind}</small>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="data-unavailable">
              <p>{evidence.inputs.reason}</p>
              {evidence.inputs.state === "unavailable" && (
                <p>
                  Activity from older runs may contain shortened previews. Those are not exact
                  stored inputs.
                </p>
              )}
              <button className="quiet" onClick={onActivity}>
                View activity
              </button>
            </div>
          )}
          <h3>Output for this visit</h3>
          {evidence.output.state === "available" ? (
            <>
              <EvidenceValue
                identity={identity}
                value={evidence.output.value.data}
                label="Typed output"
                named
              />
              <EvidenceValue
                identity={identity}
                value={captured(evidence.output.value.summary)}
                label="Result summary"
              />
              {Object.entries(evidence.output.value.artifacts).map(([name, value]) => (
                <EvidenceValue
                  key={name}
                  identity={identity}
                  value={captured(value)}
                  label={`Artifact: ${name}`}
                />
              ))}
            </>
          ) : (
            <p className="data-unavailable">{evidence.output.reason}</p>
          )}
          <h3>Model sessions · {evidence.sessions.length}</h3>
          <p>
            Inspect the context supplied by Workflow, selected tools and reported usage. Tool
            results and continuation prompts can add context within a session.
          </p>
          {!evidence.sessions.length && (
            <p className="data-unavailable">
              No model session evidence recorded for this visit. Deterministic code may run without
              a model; older sessions may not have captured context.
            </p>
          )}
          {evidence.sessions.map((session) => (
            <details
              key={session.sessionId}
              className="data-session"
              open={
                !!focus &&
                (focus.sessionId
                  ? focus.sessionId === session.sessionId
                  : focus.operationId === session.operationId ||
                    focus.operationId.startsWith(session.operationId + "/"))
              }
              aria-label={`AI session ${session.sessionId}`}
            >
              <summary>
                <strong>
                  {session.usage
                    ? `${session.usage.provider}/${session.usage.model}`
                    : `Model session ${session.sessionId.slice(0, 8)}`}
                </strong>
                <span>
                  {session.usage?.status ?? "Usage unavailable"}
                  {session.usage && (
                    <>
                      {" "}
                      ·{" "}
                      {usageCost(
                        session.usage.usage,
                        ["running", "interrupted"].includes(session.usage.status),
                      )}
                    </>
                  )}
                </span>
              </summary>
              <p className="data-session-meta">
                Session {session.sessionId} · operation {session.operationId}
                {session.activityAttempt && <> · activity attempt {session.activityAttempt}</>}
              </p>
              {session.usage && (
                <p>
                  {session.usage.thinking} thinking · {session.usage.usage.requests}{" "}
                  {session.usage.usage.requests === 1 ? "request" : "requests"} ·{" "}
                  {usageTokens(session.usage.usage).toLocaleString()} tokens ·{" "}
                  {session.usage.pricing.source === "unknown"
                    ? "Price unavailable"
                    : session.usage.pricing.source === "override"
                      ? "Configured price"
                      : "Model catalog price"}
                  {session.usage.endedAt && (
                    <>
                      {" "}
                      ·{" "}
                      {(
                        (Date.parse(session.usage.endedAt) - Date.parse(session.usage.startedAt)) /
                        1000
                      ).toFixed(1)}
                      s
                    </>
                  )}
                </p>
              )}
              {session.usage?.error && <p className="data-warning">{session.usage.error}</p>}
              {session.call.state === "available" ? (
                <>
                  <h4>
                    Declared AI call ·{" "}
                    {session.call.value.contextMode === "none"
                      ? "explicit context only"
                      : "workflow context"}
                  </h4>
                  <EvidenceValue
                    identity={identity}
                    value={session.call.value.prompt}
                    label="Original call prompt"
                  />
                  <EvidenceValue
                    identity={identity}
                    value={session.call.value.instructions}
                    label="Call instructions"
                  />
                </>
              ) : (
                <p className="data-unavailable">{session.call.reason}</p>
              )}
              {session.context.state === "available" ? (
                <>
                  <h4>Supplied session context</h4>
                  <p>
                    {session.context.value.contextMode === "none"
                      ? "Inherited workflow context is disabled for this call."
                      : session.context.value.contextMode === "workflow"
                        ? "This call includes its configured workflow context."
                        : "Context mode was not recorded."}
                  </p>
                  <EvidenceValue
                    identity={identity}
                    value={captured(session.context.value.systemPrompt)}
                    label="System instructions"
                  />
                  <EvidenceValue
                    identity={identity}
                    value={captured(session.context.value.tools)}
                    label="Available tool definitions"
                  />
                  <details className="data-settings">
                    <summary>Session settings</summary>
                    <pre>{JSON.stringify(session.context.value.settings, null, 2)}</pre>
                  </details>
                </>
              ) : (
                <p className="data-unavailable">{session.context.reason}</p>
              )}
              {session.prompts.map((prompt) => (
                <Fragment key={prompt.index}>
                  <EvidenceValue
                    identity={identity}
                    value={prompt.text}
                    label={`Session prompt ${prompt.index + 1} (${prompt.kind})`}
                  />
                  {prompt.images.map((image, index) => (
                    <EvidenceValue
                      key={image.state === "captured" ? image.ref.id : JSON.stringify(image)}
                      identity={identity}
                      value={image}
                      label={`Prompt ${prompt.index + 1} image ${index + 1}`}
                    />
                  ))}
                </Fragment>
              ))}
              {!!session.tools.length && (
                <details className="data-tools" open={!!focus}>
                  <summary>Tool calls · {session.tools.length}</summary>
                  {session.tools.map((tool) => (
                    <article
                      key={tool.callId}
                      className={
                        focus?.operationId.endsWith("/" + tool.callId) ? "focused-call" : undefined
                      }
                    >
                      <h4>
                        {tool.name ?? tool.callId} · {tool.state}
                      </h4>
                      {tool.error && <p className="data-warning">{tool.error}</p>}
                      {tool.input && (
                        <EvidenceValue identity={identity} value={tool.input} label="Tool input" />
                      )}
                      {tool.output && (
                        <EvidenceValue
                          identity={identity}
                          value={tool.output}
                          label="Tool output"
                        />
                      )}
                      {tool.details && (
                        <EvidenceValue
                          identity={identity}
                          value={tool.details}
                          label="Tool details"
                        />
                      )}
                    </article>
                  ))}
                </details>
              )}
            </details>
          ))}
        </div>
      )}
    </>
  );
}
