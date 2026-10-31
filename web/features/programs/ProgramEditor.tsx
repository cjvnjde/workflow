import { useEffect, useRef, useState } from "react";
import type { WorkflowRun } from "../../../src/contracts/index.js";
import type { PlanDraft } from "../tasks/use-draft.js";
import Icon from "../../shared/Icon.js";
import CodeEditor from "../../shared/CodeEditor.js";
import { useAutosize } from "../../shared/autosize.js";

type ProgramEditorProps = {
  run: WorkflowRun;
  draft: PlanDraft;
  busy: boolean;
  live: boolean;
  refining: boolean;
  activity: string;
  onSave: () => void;
  onRefine: (instructions: string) => void;
  onCancelRefinement: () => void;
};

export default function ProgramEditor({
  run,
  draft,
  busy,
  live,
  refining,
  activity,
  onSave,
  onRefine,
  onCancelRefinement,
}: ProgramEditorProps) {
  const locked = busy || run.status !== "draft";
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [refinement, setRefinement] = useState("");
  const refinementRef = useAutosize(refinement);
  const downloads = useRef<Map<number, string> | null>(null);

  useEffect(
    () => () => {
      if (!downloads.current) return;
      for (const [timer, url] of downloads.current) {
        window.clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      downloads.current.clear();
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(draft.text);
      setCopied(true);
      setError("");
    } catch {
      setError("Clipboard unavailable. Download the source instead.");
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([draft.text], { type: "text/typescript;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = run.program?.filename.split("/").at(-1) ?? "workflow.ts";
    link.click();
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      downloads.current?.delete(timer);
    }, 1000);
    downloads.current ??= new Map();
    downloads.current.set(timer, url);
  }

  return (
    <div className="plan-editor program-editor">
      <div className="editor-heading">
        <div>
          <h2>TypeScript workflow</h2>
          <p>
            Compose steps, sequences, branches, parallel groups and loops. The engine saves each
            step&apos;s results.
          </p>
        </div>
        <span className="program-language">TS · {run.program?.filename}</span>
      </div>
      <div className="editor-actions">
        <button className="quiet" onClick={() => void copy()}>
          <Icon name="copy" size={14} />
          {copied ? "Copied" : "Copy TypeScript"}
        </button>
        <button className="quiet" onClick={download}>
          <Icon name="download" size={14} />
          Download .ts
        </button>
        <small>{draft.dirty ? "Unsaved changes" : "Typechecked · source and imports frozen"}</small>
      </div>
      {(error || draft.error) && (
        <div className="validation-error" role="alert">
          {error || draft.error}
        </div>
      )}
      <div className="editor-field">
        <span>Workflow TypeScript</span>
        <CodeEditor
          key={run.id}
          label="Workflow TypeScript"
          value={draft.text}
          readOnly={locked}
          onChange={(text) => {
            draft.edit(text);
            setCopied(false);
          }}
        />
      </div>
      <div className="editor-field">
        <span>Workflow inputs (JSON)</span>
        <CodeEditor
          label="Workflow inputs (JSON)"
          language="json"
          minLines={3}
          maxLines={12}
          value={draft.inputText}
          readOnly={locked}
          onChange={draft.editInput}
        />
      </div>
      <div className="editor-actions">
        {run.status === "draft" && (
          <button
            className="primary"
            disabled={busy || !draft.dirty || draft.stale || !draft.validProgram}
            onClick={onSave}
          >
            Typecheck &amp; save draft
          </button>
        )}
        {draft.dirty && (
          <button disabled={busy} onClick={draft.reset}>
            Discard code edits
          </button>
        )}
        <small>
          {run.status === "draft"
            ? "Saving does not execute any steps."
            : "This source is the approved execution version."}
        </small>
      </div>
      <details className="script-contract">
        <summary>Workflow API</summary>
        <p>
          Import <code>workflow, block, step, sequence, parallel, when, repeatUntil, z</code> from{" "}
          <code>&quot;workflow&quot;</code>. Define a block with{" "}
          <code>{"block({ input, output, async run(ctx) { … } })"}</code>, then call{" "}
          <code>{"step(id, block, { inputs })"}</code> and compose it inside{" "}
          <code>{"workflow({ name, flow })"}</code>.
        </p>
        <p>
          Inside a block, <code>{"ctx.ai({ prompt, model, output })"}</code> calls a model,{" "}
          <code>ctx.exec(command)</code> runs Bash, and <code>ctx.readFile/writeFile</code> handles
          files. Use <code>ctx.summary(markdown)</code>, <code>ctx.artifact(name, text)</code> and{" "}
          <code>await ctx.log(message)</code> for visible results.
        </p>
        <p>
          Conditions and deferred inputs read typed results with <code>ctx.output(step)</code> and
          explicit outcomes with <code>ctx.result(step)?.outcome</code>. Use{" "}
          <code>repeatUntil</code> with a condition and iteration limit, and <code>parallel</code>{" "}
          for independent work. Saved blocks can be referenced by ID. Parallel branches share the
          project; serialize overlapping writes and Git operations. Inside each block, await every
          operation.
        </p>
      </details>
      {live && run.status === "draft" && (
        <details className="refinement-editor">
          <summary>Refine this workflow with AI</summary>
          <label className="editor-field">
            Tell AI what to change in this draft
            <textarea
              ref={refinementRef}
              value={refinement}
              onChange={(event) => setRefinement(event.currentTarget.value)}
              disabled={busy}
              rows={3}
              maxLength={8000}
              placeholder="Add a test step, change the review loop, or choose a different model…"
            />
          </label>
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
          {refining && <p role="status">{activity || "Refining TypeScript…"}</p>}
        </details>
      )}
    </div>
  );
}
