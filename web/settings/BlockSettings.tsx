import {
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import {
  bundleSchema,
  runSchema,
  identifierSchema,
  libraryProposalSchema,
  type BlockBundle,
  type Library,
  type OrchestrationSettings,
} from "../../src/contracts/index.js";
import { request } from "../shared/api.js";
import { useAutosize } from "../shared/autosize.js";
import Field from "../shared/Field.js";
import CodeEditor from "../shared/CodeEditor.js";
import Icon from "../shared/Icon.js";
import "./BlockSettings.css";

const libraryStateSchema = z.object({
  revision: z.string(),
  blocks: z.record(identifierSchema, bundleSchema),
  codeBlocks: z.record(identifierSchema, bundleSchema),
});
type LibraryState = z.infer<typeof libraryStateSchema>;
export interface BlockSettingsHandle {
  discard: () => void;
}
export interface BlockSettingsProps {
  library: Library;
  settings: OrchestrationSettings;
  onSaved: () => Promise<void>;
  onDirty?: (value: boolean) => void;
  onBusy?: (value: boolean) => void;
  onSelected?: (id: string) => void;
  ref?: Ref<BlockSettingsHandle>;
}
const template = `import { block, z } from "workflow";

export default block({
  output: z.object({ exitCode: z.number().nullable(), output: z.string() }),
  async run(ctx) {
    const result = await ctx.exec("git status --short");
    ctx.summary(result.output || "Working tree is clean.");
    return { exitCode: result.exitCode, output: result.output };
  },
});
`;

export default function BlockSettings({
  library,
  settings,
  onSaved,
  onDirty,
  onBusy,
  onSelected,
  ref,
}: BlockSettingsProps) {
  const navigate = useNavigate({ from: "/" });
  const [state, setState] = useState<LibraryState>();
  const [selected, setSelected] = useState("");
  const editor = useForm({
    defaultValues: { bundle: undefined as BlockBundle | undefined },
    onSubmit: async ({ value }) => {
      const active = controller.current;
      if (!active || active.signal.aborted) return;
      setError("");
      setNotice("");
      try {
        await save(value.bundle, active.signal);
      } catch (failure) {
        if (!active.signal.aborted)
          setError(failure instanceof Error ? failure.message : String(failure));
        throw failure;
      }
    },
  });
  const testForm = useForm({
    defaultValues: {
      testInput: "{}",
      testPrompt: "Test this block with the supplied inputs.",
    },
    onSubmit: async ({ value }) => {
      const active = controller.current;
      if (!active || active.signal.aborted) return;
      setError("");
      setNotice("");
      try {
        await playground(active.signal, value);
      } catch (failure) {
        if (!active.signal.aborted)
          setError(failure instanceof Error ? failure.message : String(failure));
        throw failure;
      }
    },
  });
  const bundle = useStore(editor.store, (value) => value.values.bundle);
  const submitting = useStore(editor.store, (value) => value.isSubmitting);
  const { testInput, testPrompt } = useStore(testForm.store, (value) => value.values);
  const testing = useStore(testForm.store, (value) => value.isSubmitting);
  const [actionBusy, setActionBusy] = useState(false);
  const busy = actionBusy || submitting || testing;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const downloads = useRef<Map<string, number> | null>(null);
  const baseline = state?.codeBlocks[selected];
  const dirty = !!bundle && JSON.stringify(bundle) !== JSON.stringify(baseline);
  const definition = bundle?.definition;
  const descriptionRef = useAutosize(definition?.description ?? "");
  const notifyDirty = useEffectEvent((value: boolean) => onDirty?.(value));
  const notifyBusy = useEffectEvent((value: boolean) => onBusy?.(value));
  const notifySelected = useEffectEvent((id: string) => onSelected?.(id));

  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    void request("/api/library", libraryStateSchema, { signal: active.signal })
      .then((value) => {
        if (!active.signal.aborted) setState(value);
      })
      .catch((failure: unknown) => {
        if (!active.signal.aborted) setError(String(failure));
      });
    return () => {
      active.abort();
      notifyDirty(false);
      notifyBusy(false);
      for (const [url, timer] of downloads.current ?? []) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      downloads.current?.clear();
    };
  }, []);
  useEffect(() => {
    notifyDirty(dirty);
  }, [dirty]);
  useEffect(() => {
    notifyBusy(busy);
  }, [busy]);
  useEffect(() => {
    notifySelected(selected);
  }, [selected]);

  const discard = useCallback(() => {
    if (busy) return;
    editor.reset(
      { bundle: baseline ? structuredClone(baseline) : undefined },
      { keepDefaultValues: true },
    );
    if (!baseline) setSelected("");
    setError("");
    setNotice("");
  }, [busy, baseline, editor]);
  useImperativeHandle(ref, () => ({ discard }), [discard]);

  function choose(id: string) {
    if (dirty && !window.confirm("Discard unsaved block changes?")) return;
    setSelected(id);
    editor.reset(
      { bundle: state?.codeBlocks[id] ? structuredClone(state.codeBlocks[id]) : undefined },
      { keepDefaultValues: true },
    );
    setError("");
    setNotice("");
  }
  async function load(signal: AbortSignal) {
    const value = await request("/api/library", libraryStateSchema, { signal });
    if (!signal.aborted) setState(value);
    return value;
  }
  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    const active = controller.current;
    if (!active || active.signal.aborted) return;
    setActionBusy(true);
    setError("");
    setNotice("");
    try {
      await action(active.signal);
    } catch (failure) {
      if (!active.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!active.signal.aborted) {
        setActionBusy(false);
      }
    }
  }
  async function playground(
    signal: AbortSignal,
    { testInput, testPrompt }: { testInput: string; testPrompt: string },
  ) {
    if (!definition) return;
    const inputs = z.record(z.string(), z.json()).parse(JSON.parse(testInput));
    const run = await request("/api/programs", runSchema, {
      method: "POST",
      signal,
      body: {
        title: `Test ${definition.name}`,
        task: testPrompt,
        source: `import {workflow,step} from "workflow"; export default workflow({name:${JSON.stringify(`Test ${definition.name}`)},flow:step("test-block",${JSON.stringify(selected)},{inputs:${JSON.stringify(inputs)},prompt:${JSON.stringify(testPrompt)}})});`,
      },
    });
    if (!signal.aborted) await navigate({ to: "/", search: { run: run.id } });
  }
  function add() {
    if (dirty && !window.confirm("Discard unsaved block changes?")) return;
    const id = `block-${crypto.randomUUID().slice(0, 8)}`;
    setSelected(id);
    editor.reset(
      {
        bundle: bundleSchema.parse({
          definition: {
            id,
            name: "New block",
            description: "Describe when this block should be used",
            executor: { kind: "code", source: template },
          },
          prompt: "Behavior, models, inputs and outputs are defined in TypeScript.",
          skills: [],
        }),
      },
      { keepDefaultValues: true },
    );
    setError("");
    setNotice("");
  }
  async function save(bundle: BlockBundle | undefined, signal: AbortSignal) {
    if (!bundle) return;
    const proposal = await request("/api/library/proposals", libraryProposalSchema, {
      method: "POST",
      signal,
      body: {
        kind: "manual",
        baseHash: state?.revision,
        changes: {
          summary: `Update ${bundle.definition.name}`,
          blocks: [{ bundle, rationale: "Configured in Settings" }],
        },
      },
    });
    await request(`/api/library/proposals/${proposal.id}/apply`, libraryProposalSchema, {
      method: "POST",
      body: {},
      signal,
    });
    const value = await load(signal);
    if (signal.aborted) return;
    const savedBundle = structuredClone(value.codeBlocks[bundle.definition.id]!);
    setSelected(bundle.definition.id);
    editor.setFieldValue("bundle", savedBundle, { dontUpdateMeta: true });
    try {
      await onSaved();
    } finally {
      if (!signal.aborted) editor.reset({ bundle: savedBundle }, { keepDefaultValues: true });
    }
    if (!signal.aborted)
      setNotice(
        "Block saved. New workflows use this definition; existing runs keep their snapshots.",
      );
  }
  function remove() {
    const current = state?.blocks[selected];
    if (
      !current ||
      !window.confirm(
        `Remove “${current.definition.name}” from the reusable library? Existing workflows keep their saved copy.`,
      )
    )
      return;
    void perform(async (signal) => {
      await request(`/api/library/blocks/${selected}`, z.object({ removed: z.boolean() }), {
        method: "DELETE",
        body: { revision: state!.revision },
        signal,
      });
      await load(signal);
      if (signal.aborted) return;
      editor.reset({ bundle: undefined }, { keepDefaultValues: true });
      setSelected("");
      await onSaved();
    });
  }
  async function copy() {
    if (definition?.executor?.kind !== "code") return;
    const signal = controller.current?.signal;
    try {
      await navigator.clipboard.writeText(definition.executor.source);
      if (!signal?.aborted) setNotice("TypeScript copied.");
    } catch {
      if (!signal?.aborted) setError("Clipboard unavailable. Download the source instead.");
    }
  }
  function download() {
    if (definition?.executor?.kind !== "code") return;
    const url = URL.createObjectURL(
      new Blob([definition.executor.source], { type: "text/typescript;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${definition.id}.ts`;
    link.click();
    downloads.current ??= new Map();
    downloads.current.set(
      url,
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        downloads.current?.delete(url);
      }, 1000),
    );
  }
  function updateDefinition(patch: Partial<BlockBundle["definition"]>) {
    editor.setFieldValue("bundle", (current) =>
      current ? { ...current, definition: { ...current.definition, ...patch } } : current,
    );
  }
  function updateContract(
    key: keyof NonNullable<BlockBundle["definition"]["contract"]>,
    value: string,
  ) {
    editor.setFieldValue("bundle", (current) =>
      current?.definition.contract
        ? {
            ...current,
            definition: {
              ...current.definition,
              contract: { ...current.definition.contract, [key]: value },
            },
          }
        : current,
    );
  }
  function updateSource(source: string) {
    editor.setFieldValue("bundle", (current) =>
      current?.definition.executor?.kind === "code"
        ? {
            ...current,
            definition: {
              ...current.definition,
              executor: { ...current.definition.executor, source },
            },
          }
        : current,
    );
  }

  return (
    <section className="block-settings">
      <div className="settings-section-title">
        <div>
          <h2>Reusable blocks</h2>
          <p>
            TypeScript functions with typed inputs and outputs. Call AI, run commands, or combine
            both in the same block.
          </p>
        </div>
        <div className="button-row">
          <button disabled={busy} onClick={add}>
            <Icon name="plus" />
            Add block
          </button>
        </div>
      </div>
      {error && (
        <pre className="inline-error" role="alert">
          {error}
        </pre>
      )}
      {notice && (
        <p className="setup-notice" role="status">
          {notice}
        </p>
      )}
      <div className="block-settings-layout">
        <div className="block-catalog">
          {Object.values(state?.blocks ?? library.blocks).map((item) => (
            <button
              key={item.definition.id}
              className={selected === item.definition.id ? "selected" : undefined}
              disabled={busy}
              onClick={() => choose(item.definition.id)}
            >
              <Icon name="code" />
              <div>
                <strong>{item.definition.name}</strong>
                <small>TypeScript block</small>
              </div>
            </button>
          ))}
        </div>
        {bundle && definition?.executor?.kind === "code" ? (
          <div className="settings-card block-code-card">
            <fieldset disabled={busy}>
              <div className="field-grid">
                <Field label="Block name">
                  {({ id }) => (
                    <input
                      id={id}
                      value={definition.name}
                      onChange={(event) => updateDefinition({ name: event.target.value })}
                    />
                  )}
                </Field>
                <Field label="Block ID" help="Referenced by workflow steps.">
                  {({ id }) => (
                    <input
                      id={id}
                      value={definition.id}
                      disabled={!!state?.blocks[selected]}
                      onChange={(event) => updateDefinition({ id: event.target.value })}
                    />
                  )}
                </Field>
              </div>
              <Field label="When should this block be used?">
                {({ id }) => (
                  <textarea
                    id={id}
                    value={definition.description}
                    ref={descriptionRef}
                    rows={2}
                    onChange={(event) => updateDefinition({ description: event.target.value })}
                  />
                )}
              </Field>
              <details className="script-contract block-code-help">
                <summary>Block contract</summary>
                <p>
                  Document the handoff and effects for callers. Input/output schemas and
                  capability/ownership restrictions in TypeScript enforce the contract; these notes
                  describe it.
                </p>
                {!definition.contract && (
                  <button
                    className="quiet"
                    onClick={() =>
                      updateDefinition({
                        contract: { inputs: "", outputs: "", effects: "", failure: "" },
                      })
                    }
                  >
                    Add contract notes
                  </button>
                )}
                {definition.contract && (
                  <>
                    <Field label="Required inputs">
                      {({ id }) => (
                        <textarea
                          id={id}
                          value={definition.contract?.inputs ?? ""}
                          maxLength={2000}
                          onChange={(event) => updateContract("inputs", event.target.value)}
                        />
                      )}
                    </Field>
                    <Field label="Returned outputs">
                      {({ id }) => (
                        <textarea
                          id={id}
                          value={definition.contract?.outputs ?? ""}
                          maxLength={2000}
                          onChange={(event) => updateContract("outputs", event.target.value)}
                        />
                      )}
                    </Field>
                    <Field label="Tools, file ownership and side effects">
                      {({ id }) => (
                        <textarea
                          id={id}
                          value={definition.contract?.effects ?? ""}
                          maxLength={2000}
                          onChange={(event) => updateContract("effects", event.target.value)}
                        />
                      )}
                    </Field>
                    <Field label="Failure and retry behavior">
                      {({ id }) => (
                        <textarea
                          id={id}
                          value={definition.contract?.failure ?? ""}
                          maxLength={2000}
                          onChange={(event) => updateContract("failure", event.target.value)}
                        />
                      )}
                    </Field>
                  </>
                )}
              </details>
              <div className="editor-actions">
                <strong>Block TypeScript</strong>
                <button className="quiet" onClick={() => void copy()}>
                  <Icon name="copy" size={14} />
                  Copy code
                </button>
                <button className="quiet" onClick={download}>
                  <Icon name="download" size={14} />
                  Download .ts
                </button>
              </div>
              <CodeEditor
                key={selected}
                value={definition.executor.source}
                onChange={updateSource}
                label="Block TypeScript"
                readOnly={busy}
                minLines={12}
                maxLines={32}
              />
              <details className="script-contract block-code-help">
                <summary>Test this block</summary>
                <p>
                  Create a one-step draft using the saved block. Review and approve it before
                  execution. This uses real project tools and records outputs, checks and model
                  calls in the run history.
                </p>
                <Field label="Test request">
                  {({ id }) => (
                    <textarea
                      id={id}
                      value={testPrompt}
                      onChange={(event) => testForm.setFieldValue("testPrompt", event.target.value)}
                    />
                  )}
                </Field>
                <Field label="Input JSON">
                  {({ id }) => (
                    <textarea
                      id={id}
                      value={testInput}
                      rows={5}
                      spellCheck={false}
                      onChange={(event) => testForm.setFieldValue("testInput", event.target.value)}
                    />
                  )}
                </Field>
                <button
                  disabled={busy || dirty || !baseline || !testPrompt.trim()}
                  onClick={() => void testForm.handleSubmit().catch(() => {})}
                >
                  Create block test
                </button>
                {dirty && <p>Save changes before testing this version.</p>}
              </details>
              <details className="script-contract block-code-help">
                <summary>Block API &amp; examples</summary>
                <p>
                  Import <code>block, z</code> from <code>"workflow"</code> and export{" "}
                  <code>{"block({ input, output, async run(ctx) { … } })"}</code>. Schemas are
                  optional; returning a value passes it to the next step.
                </p>
                <p>
                  <code>{"await ctx.ai({ prompt, model, output: z.object({ … }) })"}</code> returns
                  a typed AI result. Omit <code>output</code> for Markdown. Set a model in code,
                  accept one through inputs, or use <code>ctx.model</code> for the step’s default.
                  Omitting <code>model</code> uses the model assigned by the orchestrator or in the
                  workflow editor. An explicit model here takes precedence.
                </p>
                {settings.profiles.some((profile) => profile.enabled) && (
                  <p>
                    Available profiles:{" "}
                    {settings.profiles
                      .filter((item) => item.enabled)
                      .map((profile) => (
                        <code key={profile.id}>ctx.models[{JSON.stringify(profile.id)}] </code>
                      ))}
                  </p>
                )}
                <p>
                  <code>await ctx.exec("bun test")</code> returns{" "}
                  <code>exitCode, stdout, stderr, output, timedOut</code>. Return failure feedback
                  for the workflow to route to implementation. Run project TypeScript files with{" "}
                  <code>ctx.exec("bun scripts/check.ts")</code>.
                </p>
                <p>
                  <code>ctx.readFile(path)</code>, <code>ctx.writeFile(path, text)</code> and{" "}
                  <code>ctx.log(message)</code> are awaited operations.{" "}
                  <code>ctx.summary(markdown)</code> and <code>ctx.artifact(name, text)</code> make
                  results easy to find. Set <code>timeoutMs</code> and <code>maxOperations</code> on
                  the block when needed.
                </p>
                <p>
                  Source and imports are frozen with each workflow. Commands run in the project with
                  its environment. Use context operations for host effects so the engine can record
                  and recover work.
                </p>
              </details>
              <div className="button-row">
                <button
                  className="primary"
                  disabled={!dirty}
                  onClick={() => void editor.handleSubmit().catch(() => {})}
                >
                  {busy ? "Typechecking…" : "Save block"}
                </button>
                {dirty && (
                  <button onClick={discard}>
                    {state?.blocks[selected] ? "Discard block changes" : "Cancel new block"}
                  </button>
                )}
                {state?.blocks[selected] && (
                  <button className="danger-quiet" onClick={remove}>
                    Remove block
                  </button>
                )}
              </div>
            </fieldset>
          </div>
        ) : (
          <div className="settings-card empty-state">
            <Icon name="code" />
            <h2>Choose a block</h2>
            <p>Edit a reusable TypeScript function or design one with AI.</p>
          </div>
        )}
      </div>
    </section>
  );
}
