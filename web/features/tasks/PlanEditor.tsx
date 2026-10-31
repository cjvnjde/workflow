import { useEffect, useState } from "react";
import {
  agentSchema,
  resolveAgentSettings,
  modelCatalogSchema,
  modelKey,
  type AvailableModel,
  type WorkflowNode,
  type WorkflowPlan,
  type WorkflowRun,
} from "../../../src/contracts/index.js";
import { request } from "../../shared/api.js";
import type { PlanDraft } from "./use-draft.js";
import CodeEditor from "../../shared/CodeEditor.js";
import Field from "../../shared/Field.js";
import { useAutosize } from "../../shared/autosize.js";
import { executionLabel } from "../execution/execution-label.js";

type PlanEditorProps = {
  run: WorkflowRun;
  draft: PlanDraft;
  busy: boolean;
  live: boolean;
  coordinatorActivity: string;
  coordinatorText: string;
  refining: boolean;
  onSave: () => void;
  onRefine: (instructions: string) => void;
  onCancelRefinement: () => void;
  onSetup: () => void;
};
const outcomes = ["pass", "retry", "fail"] as const;

function handoffKeys(node: WorkflowNode, previous: readonly string[]): readonly string[] {
  if (previous.length === node.inputs.length) return previous;
  const keys = previous.slice(0, node.inputs.length);
  const used = new Set(keys);
  for (let position = keys.length; position < node.inputs.length; position++) {
    const input = node.inputs[position]!;
    const base = JSON.stringify([node.id, input.as ?? input.artifact]);
    let key = base;
    for (let occurrence = 2; used.has(key); occurrence++) key = `${base}:${occurrence}`;
    keys.push(key);
    used.add(key);
  }
  return keys;
}

export default function PlanEditor({
  run,
  draft,
  busy,
  live,
  coordinatorActivity,
  coordinatorText,
  refining,
  onSave,
  onRefine,
  onCancelRefinement,
  onSetup,
}: PlanEditorProps) {
  const [mode, setMode] = useState<"steps" | "json">("steps");
  const [selected, setSelected] = useState(run.plan.entry);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [modelError, setModelError] = useState("");
  const [refinement, setRefinement] = useState("");
  const plan = draft.plan;
  const node = plan?.nodes.find((item) => item.id === selected) ?? plan?.nodes[0];
  const executor = node && run.blocks[node.block]?.definition.executor;
  const canCallAI = !executor || executor.kind === "code";
  const locked = busy || run.status !== "draft";
  const inherited = node
    ? resolveAgentSettings(run.config.agent, run.blocks[node.block]?.definition.agent)
    : run.config.agent;
  const effective = resolveAgentSettings(inherited, node?.agent);
  const model = models.find(
    (item) => item.provider === effective.provider && item.id === effective.model,
  );
  const overrideModel =
    node?.agent?.model || node?.agent?.provider
      ? `${effective.provider ?? ""}/${effective.model ?? ""}`
      : "";
  const thinkingLevels =
    model?.thinkingLevels.filter((level) => agentSchema.shape.thinking.safeParse(level).success) ??
    agentSchema.shape.thinking.unwrap().options;
  const taskRef = useAutosize(plan?.task);
  const goalRef = useAutosize(node?.goal);
  const refinementRef = useAutosize(refinement);

  // Freeze each handoff's initial semantic identity while its alias and source are edited.
  const [inputIdentity, setInputIdentity] = useState(() => ({
    runId: run.id,
    nodeId: node?.id,
    source: node?.inputs,
    keys: node ? handoffKeys(node, []) : [],
  }));
  let currentInputs = inputIdentity;
  if (
    inputIdentity.runId !== run.id ||
    inputIdentity.nodeId !== node?.id ||
    inputIdentity.source !== node?.inputs
  ) {
    currentInputs = {
      runId: run.id,
      nodeId: node?.id,
      source: node?.inputs,
      keys: node
        ? handoffKeys(
            node,
            inputIdentity.runId === run.id && inputIdentity.nodeId === node.id
              ? inputIdentity.keys
              : [],
          )
        : [],
    };
    setInputIdentity(currentInputs);
  }

  useEffect(() => {
    const controller = new AbortController();
    void request("/api/models", modelCatalogSchema, { signal: controller.signal })
      .then((catalog) => {
        if (controller.signal.aborted) return;
        setModels(catalog.models);
        setModelError(catalog.warnings.join(" "));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setModelError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, []);

  function edit(value: Partial<WorkflowPlan>) {
    if (plan) draft.edit(JSON.stringify({ ...plan, ...value }, null, 2));
  }
  function editNode(value: Partial<WorkflowNode>) {
    if (plan && node)
      edit({
        nodes: plan.nodes.map((item) => (item.id === node.id ? { ...item, ...value } : item)),
      });
  }
  function setModel(key: string) {
    if (!node) return;
    const agent = { ...node.agent };
    delete agent.provider;
    delete agent.model;
    const chosen = models.find((item) => modelKey(item) === key);
    if (chosen) {
      agent.provider = chosen.provider;
      agent.model = chosen.id;
      if (!chosen.thinkingLevels.includes(agent.thinking ?? inherited.thinking)) {
        agent.thinking = agentSchema.shape.thinking.parse(
          chosen.thinkingLevels.includes("off") ? "off" : (chosen.thinkingLevels[0] ?? "off"),
        );
      }
    }
    editNode({ agent: Object.keys(agent).length ? agent : undefined });
  }
  function setThinking(value: string) {
    const agent = { ...node?.agent };
    if (value) agent.thinking = agentSchema.shape.thinking.parse(value);
    else delete agent.thinking;
    editNode({ agent: Object.keys(agent).length ? agent : undefined });
  }
  function changeInput(index: number, patch: Partial<WorkflowNode["inputs"][number]>) {
    if (node)
      editNode({
        inputs: node.inputs.map((item, i) => (i === index ? { ...item, ...patch } : item)),
      });
  }
  function addInput() {
    if (!node || !plan) return;
    const source = plan.nodes.find((item) => item.id !== node.id) ?? node;
    const aliases = new Set(node.inputs.map((input) => input.as ?? input.artifact));
    let alias = "summary";
    for (let suffix = 2; aliases.has(alias); suffix++) alias = `summary-${suffix}`;
    editNode({
      inputs: [
        ...node.inputs,
        {
          node: source.id,
          artifact: "summary",
          required: false,
          ...(alias === "summary" ? {} : { as: alias }),
        },
      ],
    });
  }

  return (
    <div className="plan-editor">
      <div className="editor-heading">
        <div>
          <h2>Workflow editor</h2>
          <p>Adjust steps before approval. Changes stay in this draft until you save.</p>
        </div>
        <div className="editor-switch" role="group" aria-label="Graph editing mode">
          <button aria-pressed={mode === "steps"} onClick={() => setMode("steps")}>
            Step controls
          </button>
          <button aria-pressed={mode === "json"} onClick={() => setMode("json")}>
            JSON
          </button>
        </div>
      </div>
      {draft.error && (
        <div className="validation-error" role="alert">
          {draft.error}
        </div>
      )}
      {mode === "steps" && plan && node ? (
        <>
          <fieldset disabled={locked} className="editor-fields">
            <div className="field-grid">
              <Field className="editor-field" label="Workflow title">
                {({ id }) => (
                  <input
                    id={id}
                    value={plan.title}
                    maxLength={200}
                    onChange={(event) => edit({ title: event.currentTarget.value })}
                  />
                )}
              </Field>
              <Field className="editor-field" label="Starting step">
                {({ id }) => (
                  <select
                    id={id}
                    value={plan.entry}
                    onChange={(event) => edit({ entry: event.currentTarget.value })}
                  >
                    {plan.nodes.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label || item.id}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <div className="editor-field">
              <label htmlFor="editor-workflow-task">Workflow task</label>
              <textarea
                id="editor-workflow-task"
                ref={taskRef}
                rows={3}
                maxLength={32_000}
                value={plan.task}
                onChange={(event) => edit({ task: event.currentTarget.value })}
              />
            </div>
          </fieldset>
          <div className="step-editor-layout">
            <nav className="step-list" aria-label="Workflow steps">
              {plan.nodes.map((item, index) => (
                <button
                  key={item.id}
                  aria-current={node.id === item.id ? "step" : undefined}
                  onClick={() => setSelected(item.id)}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{item.label || "Untitled step"}</strong>
                    <small>
                      {item.block}
                      {item.id === plan.entry ? " · start" : ""}
                    </small>
                  </div>
                </button>
              ))}
            </nav>
            <fieldset disabled={locked} className="editor-fields step-fields">
              <div className="step-heading">
                <h3>{node.block} step</h3>
                <code>{node.id}</code>
              </div>
              <Field className="editor-field" label="Step name">
                {({ id }) => (
                  <input
                    id={id}
                    maxLength={120}
                    value={node.label}
                    onChange={(event) => editNode({ label: event.currentTarget.value })}
                  />
                )}
              </Field>
              <div className="editor-field">
                <label htmlFor="editor-step-goal">Step goal</label>
                <textarea
                  id="editor-step-goal"
                  ref={goalRef}
                  rows={4}
                  maxLength={8000}
                  value={node.goal}
                  onChange={(event) => editNode({ goal: event.currentTarget.value })}
                />
              </div>
              <div className="field-grid">
                <Field className="editor-field" label="Maximum visits">
                  {({ id }) => (
                    <input
                      id={id}
                      type="number"
                      min="1"
                      max="30"
                      step="1"
                      value={node.maxVisits || ""}
                      onChange={(event) =>
                        editNode({ maxVisits: Number(event.currentTarget.value) })
                      }
                    />
                  )}
                </Field>
                {canCallAI && (
                  <Field className="editor-field" label="Step model">
                    {({ id }) => (
                      <select
                        id={id}
                        value={overrideModel}
                        onChange={(event) => setModel(event.currentTarget.value)}
                      >
                        <option value="">
                          Use block / project default
                          {inherited.model ? ` · ${inherited.model}` : ""}
                        </option>
                        {overrideModel &&
                          !models.some((item) => modelKey(item) === overrideModel) && (
                            <option value={overrideModel}>{overrideModel} · unavailable</option>
                          )}
                        {models.map((item) => (
                          <option key={modelKey(item)} value={modelKey(item)}>
                            {item.name} · {modelKey(item)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                )}
              </div>
              {executor && !canCallAI && (
                <p className="muted">{executionLabel(executor)} · no model call</p>
              )}
              {executor?.kind === "code" && (
                <p className="muted">
                  This model is the default for ctx.ai calls in this step. An explicit ctx.ai(
                  {"{ model: ... }"}) in the block source takes precedence. Code without AI calls
                  uses no model.
                </p>
              )}
              {canCallAI && (
                <Field className="editor-field" label="Step thinking">
                  {({ id }) => (
                    <select
                      id={id}
                      value={node.agent?.thinking ?? ""}
                      onChange={(event) => setThinking(event.currentTarget.value)}
                    >
                      <option value="">Use block / project default · {inherited.thinking}</option>
                      {node.agent?.thinking && !thinkingLevels.includes(node.agent.thinking) && (
                        <option value={node.agent.thinking}>
                          {node.agent.thinking} · unsupported
                        </option>
                      )}
                      {thinkingLevels.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
              {canCallAI && model && !model.thinkingLevels.includes(effective.thinking) && (
                <p className="warning">
                  This model does not support {effective.thinking} thinking. Select a supported
                  level before execution.
                </p>
              )}
              <h3>Where to go next</h3>
              <div className="route-fields">
                {outcomes.map((outcome) => (
                  <Field key={outcome} className="editor-field" label={`On ${outcome}`}>
                    {({ id }) => (
                      <select
                        id={id}
                        value={node.on[outcome]}
                        onChange={(event) =>
                          editNode({ on: { ...node.on, [outcome]: event.currentTarget.value } })
                        }
                      >
                        <option value="$complete">Complete workflow</option>
                        <option value="$failed">Stop as failed</option>
                        {plan.nodes.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label || item.id}
                            {item.id === node.id ? " (repeat this step)" : ""}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                ))}
              </div>
              <h3>Context handoffs</h3>
              <p className="muted">
                Choose which artifacts this step receives. Optional inputs can be missing on the
                first visit.
              </p>
              {!node.inputs.length && (
                <p className="muted">No artifacts are passed to this step.</p>
              )}
              {currentInputs.keys.map((key, index) => {
                const input = node.inputs[index]!;
                const source = plan.nodes.find((item) => item.id === input.node);
                const artifacts = [
                  ...new Set([
                    "summary",
                    ...(source && run.blocks[source.block]?.definition.executor?.kind === "code"
                      ? ["data"]
                      : []),
                    ...(source ? (run.blocks[source.block]?.definition.outputs ?? []) : []),
                  ]),
                ];
                return (
                  <div key={key} className="handoff-fields">
                    <div className="field-grid">
                      <Field className="editor-field" label={`Source step ${index + 1}`}>
                        {({ id }) => (
                          <select
                            id={id}
                            value={input.node}
                            onChange={(event) =>
                              changeInput(index, {
                                node: event.currentTarget.value,
                                artifact: "summary",
                              })
                            }
                          >
                            {plan.nodes.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.label || item.id}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                      <Field className="editor-field" label={`Artifact ${index + 1}`}>
                        {({ id }) => (
                          <select
                            id={id}
                            value={input.artifact}
                            onChange={(event) =>
                              changeInput(index, { artifact: event.currentTarget.value })
                            }
                          >
                            {!artifacts.includes(input.artifact) && (
                              <option value={input.artifact}>{input.artifact} · unavailable</option>
                            )}
                            {artifacts.map((artifact) => (
                              <option key={artifact} value={artifact}>
                                {artifact}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                    </div>
                    <Field className="editor-field" label={`Input alias ${index + 1}`}>
                      {({ id }) => (
                        <input
                          id={id}
                          value={input.as ?? ""}
                          placeholder={input.artifact}
                          onChange={(event) =>
                            changeInput(index, { as: event.currentTarget.value || undefined })
                          }
                        />
                      )}
                    </Field>
                    <div className="handoff-actions">
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={input.required}
                          onChange={(event) =>
                            changeInput(index, { required: event.currentTarget.checked })
                          }
                        />
                        Required
                      </label>
                      <button
                        onClick={() => {
                          setInputIdentity({
                            ...currentInputs,
                            keys: currentInputs.keys.filter((keyToKeep) => keyToKeep !== key),
                          });
                          editNode({ inputs: node.inputs.filter((_, i) => i !== index) });
                        }}
                      >
                        Remove handoff {index + 1}
                      </button>
                    </div>
                  </div>
                );
              })}
              <button onClick={addInput}>Add handoff</button>
            </fieldset>
          </div>
          {canCallAI && (
            <div className="editor-help">
              <span>
                {modelError ||
                  (models.length
                    ? "Model choices come from your connected providers."
                    : "Connect ChatGPT or add an API key to choose models here.")}
              </span>
              <button disabled={busy} onClick={onSetup}>
                Providers &amp; models
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p>
            Edit the complete graph, including step IDs and blocks. Block instructions and required
            checks stay fixed to this run&apos;s saved library.
          </p>
          <CodeEditor
            label="Workflow graph JSON"
            language="json"
            value={draft.text}
            readOnly={locked}
            minLines={12}
            onChange={draft.edit}
          />
        </>
      )}
      <div className="editor-actions">
        <button
          className="primary"
          disabled={locked || !draft.dirty || draft.stale || !draft.validPlan}
          onClick={onSave}
        >
          Validate &amp; save draft
        </button>
        {draft.dirty && (
          <button disabled={busy} onClick={draft.reset}>
            {draft.stale ? "Discard edits & load latest draft" : "Discard graph edits"}
          </button>
        )}
        <small>
          {run.status === "draft"
            ? "Saving does not execute the workflow."
            : "This workflow is read only. Create a new draft to make changes."}
        </small>
      </div>
      {live && run.status === "draft" && (
        <details className="refinement-editor">
          <summary>Refine this workflow with AI</summary>
          <label htmlFor="workflow-refinement">Tell AI what to change in this draft</label>
          <textarea
            id="workflow-refinement"
            ref={refinementRef}
            value={refinement}
            onChange={(event) => setRefinement(event.currentTarget.value)}
            maxLength={8000}
            disabled={busy}
            rows={3}
            placeholder="Split implementation into smaller steps, or add another verification step…"
          />
          <button
            disabled={busy || draft.dirty || !refinement.trim()}
            onClick={() => onRefine(refinement)}
          >
            Update draft with AI
          </button>
          {refining ? (
            <button onClick={onCancelRefinement}>Cancel refinement</button>
          ) : refinement ? (
            <button disabled={busy} onClick={() => setRefinement("")}>
              Discard refinement
            </button>
          ) : null}
          {busy && (
            <div className="coordinator-progress">
              <pre>{coordinatorActivity}</pre>
              <pre>{coordinatorText}</pre>
            </div>
          )}
        </details>
      )}
    </div>
  );
}
