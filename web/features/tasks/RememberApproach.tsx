import { useEffect, useId, useRef, useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { createPortal } from "react-dom";
import type { StrategyPreview, RememberStrategyResult } from "../../../src/contracts/index.js";
import { WorkflowApiError } from "../../../src/client/client.js";
import { client } from "../../shared/api.js";
import Field from "../../shared/Field.js";
import Icon from "../../shared/Icon.js";
import StrategyFacts from "./StrategyFacts.js";
import "./RememberApproach.css";

export default function RememberApproach({
  runId,
  onSettings,
}: {
  runId: string;
  onSettings: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [portalRoot] = useState(() =>
    typeof document === "undefined"
      ? null
      : (document.querySelector(".workflow-workspace") ?? document.body),
  );
  const [preview, setPreview] = useState<StrategyPreview>();
  const [saved, setSaved] = useState<RememberStrategyResult>();
  const editor = useForm({
    defaultValues: { title: "", description: "", details: "", tags: "" },
    onSubmit: () => save(),
  });
  const form = useStore(editor.store, (state) => state.values);
  const saving = useStore(editor.store, (state) => state.isSubmitting);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [remembered, setRemembered] = useState(false);
  const read = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);
  const readVersion = useRef(0);
  const disposed = useRef(false);
  const savingNow = useRef(false);
  const existing = saved?.entry ?? preview?.existingEntry;
  const metadata = saved?.entry.strategy ?? preview?.existingEntry?.strategy ?? preview?.metadata;

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      read.current?.abort();
      write.current?.abort();
    };
  }, []);

  function stopRead() {
    readVersion.current++;
    read.current?.abort();
    read.current = null;
    setLoading(false);
  }
  async function load(preserve = false) {
    stopRead();
    const version = ++readVersion.current;
    const controller = new AbortController();
    read.current = controller;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const value = await client.strategyPreview(runId, controller.signal);
      if (controller.signal.aborted || disposed.current || version !== readVersion.current) return;
      setPreview(value);
      setRemembered(!!value.existingEntry);
      setConflict(false);
      if (!preserve)
        editor.reset(
          { ...value.entry, tags: value.entry.tags.join(", ") },
          { keepDefaultValues: true },
        );
      else
        setNotice(
          "Latest source facts and memory revision loaded. Your draft is unchanged; review before saving.",
        );
    } catch (failure) {
      if (!controller.signal.aborted && !disposed.current && version === readVersion.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (!controller.signal.aborted && version === readVersion.current && !disposed.current) {
        setLoading(false);
        read.current = null;
      }
    }
  }
  function show() {
    setPreview(undefined);
    setSaved(undefined);
    setConflict(false);
    setError("");
    setNotice("");
    dialog.current?.showModal();
    void load();
  }
  function dismiss() {
    if (savingNow.current) return;
    stopRead();
    dialog.current?.close();
    trigger.current?.focus();
  }
  function fields() {
    const tags = form.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (tags.length > 8 || tags.some((tag) => tag.length > 40)) {
      throw new Error("Use at most 8 tags, with at most 40 characters each.");
    }
    return {
      title: form.title.trim(),
      description: form.description.trim(),
      details: form.details,
      tags,
    };
  }
  async function save() {
    if (!preview || savingNow.current || loading || existing || conflict) return;
    savingNow.current = true;
    setError("");
    setNotice("");
    const controller = new AbortController();
    write.current = controller;
    try {
      const result = await client.rememberStrategy(
        runId,
        {
          ...fields(),
          sourceRunRevision: preview.sourceRunRevision,
          memoryRevision: preview.memoryRevision,
        },
        controller.signal,
      );
      if (disposed.current || controller.signal.aborted) return;
      setSaved(result);
      setRemembered(true);
      setNotice(
        result.state.enabled
          ? "Approach remembered. Future planning can consult this strategy."
          : "Approach saved. Project memory remains off. Enable it in Settings → Memory when you want future planning to consult this strategy.",
      );
    } catch (failure) {
      if (!disposed.current && !controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setConflict(failure instanceof WorkflowApiError && failure.status === 409);
      }
    } finally {
      savingNow.current = false;
      if (write.current === controller) write.current = null;
    }
  }
  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(fields(), null, 2));
      if (!disposed.current) setNotice("Draft copied.");
    } catch {
      if (!disposed.current)
        setError("The clipboard is unavailable. Your draft remains in the fields below.");
    }
  }

  return (
    <>
      <button ref={trigger} className="quiet" onClick={show}>
        <Icon name="file" size={14} />
        {remembered ? "Approach remembered" : "Remember this approach"}
      </button>
      {portalRoot &&
        createPortal(
          <dialog
            ref={dialog}
            className="workflow-workspace remember-dialog"
            aria-labelledby={titleId}
            onCancel={(event) => {
              event.preventDefault();
              dismiss();
            }}
            onClose={() => {
              if (!dialog.current?.open) stopRead();
            }}
          >
            <div className="remember-heading">
              <div>
                <span className="eyebrow">REUSABLE STRATEGY</span>
                <h2 id={titleId}>Remember this approach</h2>
              </div>
              <button
                className="icon-button"
                disabled={saving}
                aria-label="Close strategy preview"
                onClick={dismiss}
              >
                <Icon name="close" />
              </button>
            </div>
            <p className="remember-intro">
              Keep the approach you found useful as concise guidance. Future tasks get a fresh
              workflow using current blocks, models and approvals.
            </p>
            <p className="remember-boundary">
              This preview uses recorded metadata and makes no model requests. It stores no
              executable graph, source code, conversation or artifact contents. Saving is your
              endorsement, not a quality rating.
            </p>
            {loading && <p role="status">Loading strategy preview…</p>}
            {error && (
              <div className="inline-error" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <p className="setup-notice" role="status">
                {notice}
              </p>
            )}
            {error && !preview && (
              <button disabled={loading} onClick={() => void load()}>
                Retry strategy preview
              </button>
            )}
            {preview ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void editor.handleSubmit();
                }}
              >
                {existing && (
                  <div className="setup-notice" role="status">
                    <strong>Already remembered</strong>
                    <p>
                      A strategy is already saved for this source workflow. Edit or delete it in
                      Settings → Memory. Opening this preview does not create another entry.
                    </p>
                    <small>Entry {existing.id}</small>
                  </div>
                )}
                <p className="remember-mode">
                  {(saved?.state.enabled ?? preview.memoryEnabled)
                    ? "Project memory is enabled."
                    : existing
                      ? "Project memory is off. Saved strategies are retained, but future planning will not read them."
                      : "Project memory is off. Saving this strategy will keep it off."}
                  {!existing && <> Nothing is saved until you choose Save strategy.</>}
                </p>
                <fieldset className="settings-fields" disabled={saving || loading || !!existing}>
                  <Field label="Strategy title">
                    {({ id }) => (
                      <input
                        id={id}
                        value={form.title}
                        onChange={(event) =>
                          editor.setFieldValue("title", event.currentTarget.value)
                        }
                        required
                        maxLength={100}
                      />
                    )}
                  </Field>
                  <Field
                    label="When this is useful"
                    help="Up to 300 characters. Future planners see this description before loading details."
                  >
                    {({ id }) => (
                      <textarea
                        id={id}
                        value={form.description}
                        onChange={(event) =>
                          editor.setFieldValue("description", event.currentTarget.value)
                        }
                        required
                        rows={2}
                        maxLength={300}
                      />
                    )}
                  </Field>
                  <Field
                    label="Reusable guidance"
                    help="Up to 4,000 characters. Describe the approach, roles and checks worth repeating."
                  >
                    {({ id }) => (
                      <textarea
                        id={id}
                        value={form.details}
                        onChange={(event) =>
                          editor.setFieldValue("details", event.currentTarget.value)
                        }
                        rows={6}
                        maxLength={4000}
                      />
                    )}
                  </Field>
                  <Field
                    label="Strategy tags"
                    help="Optional, comma separated. Up to 8 tags of 40 characters each."
                  >
                    {({ id }) => (
                      <input
                        id={id}
                        value={form.tags}
                        onChange={(event) =>
                          editor.setFieldValue("tags", event.currentTarget.value)
                        }
                      />
                    )}
                  </Field>
                </fieldset>
                {conflict && (
                  <div className="remember-conflict" role="status">
                    <p>The source workflow or saved memory changed. Your draft is preserved.</p>
                    <button
                      type="button"
                      disabled={loading || saving}
                      onClick={() => void load(true)}
                    >
                      Review latest source &amp; memory
                    </button>
                  </div>
                )}
                {existing && !saved && (
                  <details className="remember-existing">
                    <summary>Saved strategy text</summary>
                    <strong>{existing.title}</strong>
                    <p>{existing.description}</p>
                    <pre>{existing.details}</pre>
                  </details>
                )}
                {metadata && (
                  <details className="remember-evidence" open>
                    <summary>Review source facts</summary>
                    <StrategyFacts metadata={metadata} />
                  </details>
                )}
                <div className="remember-actions">
                  {(existing || conflict) && (
                    <button type="button" disabled={saving} onClick={() => void copyDraft()}>
                      Copy my draft
                    </button>
                  )}
                  {existing && (
                    <button
                      type="button"
                      onClick={() => {
                        dismiss();
                        onSettings();
                      }}
                    >
                      Open Settings
                    </button>
                  )}
                  <button type="button" disabled={saving} onClick={dismiss}>
                    {saved || existing ? "Done" : "Cancel"}
                  </button>
                  {!existing && (
                    <button
                      type="submit"
                      className="primary"
                      disabled={
                        saving ||
                        loading ||
                        conflict ||
                        !form.title.trim() ||
                        !form.description.trim()
                      }
                    >
                      {saving ? "Saving…" : "Save strategy"}
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <div className="remember-actions">
                <button type="button" onClick={dismiss}>
                  Cancel
                </button>
              </div>
            )}
          </dialog>,
          portalRoot,
        )}
    </>
  );
}
