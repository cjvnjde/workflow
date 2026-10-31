import { useCallback, useEffect, useRef, useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import Icon from "../../shared/Icon.js";

export default function SessionSwitcher({
  onOpen,
}: {
  onOpen: (value: string, signal: AbortSignal) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lookup = useRef<AbortController | undefined>(undefined);
  const form = useForm({
    defaultValues: { reference: "" },
    onSubmit: ({ value }) => open(value.reference),
  });
  const value = useStore(form.store, (state) => state.values.reference);
  const busy = useStore(form.store, (state) => state.isSubmitting);
  const [error, setError] = useState("");
  const cancelLookup = useCallback(() => {
    lookup.current?.abort();
    lookup.current = undefined;
  }, []);
  useEffect(
    () => () => {
      lookup.current?.abort();
    },
    [],
  );
  function dismiss() {
    cancelLookup();
    dialog.current?.close();
  }
  function show() {
    setError("");
    dialog.current?.showModal();
    input.current?.focus();
  }
  async function open(value: string) {
    if (lookup.current || !value.trim()) return;
    const controller = new AbortController();
    lookup.current = controller;
    setError("");
    try {
      await onOpen(value, controller.signal);
      controller.signal.throwIfAborted();
      dialog.current?.close();
      form.reset();
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (lookup.current === controller) {
        lookup.current = undefined;
      }
    }
  }
  return (
    <>
      <button className="session-open-button" onClick={show}>
        <Icon name="terminal" size={16} />
        Open session by ID
      </button>
      <dialog
        ref={dialog}
        className="session-dialog"
        aria-labelledby="session-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          dismiss();
        }}
        onClose={() => {
          if (!dialog.current?.open) cancelLookup();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <div className="session-dialog-heading">
            <span className="session-dialog-icon">
              <Icon name="terminal" size={23} />
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="Close session dialog"
              onClick={dismiss}
            >
              <Icon name="close" />
            </button>
          </div>
          <h2 id="session-dialog-title">Continue in this workspace</h2>
          <p>
            Open the same task from your terminal or another browser. Its graph, activity, and
            results stay in sync.
          </p>
          <label htmlFor="session-reference">Session ID or Workflow link</label>
          <form.Field name="reference">
            {(field) => (
              <input
                id="session-reference"
                name={field.name}
                ref={input}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                placeholder="Paste a task ID, run ID, or link"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            )}
          </form.Field>
          <p className="session-dialog-hint">
            This opens a session in the current project. Opening a paused session leaves it paused
            until you choose Resume.
          </p>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <div className="session-dialog-actions">
            <button type="button" onClick={dismiss}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy || !value.trim()}>
              {busy ? "Opening…" : "Open session"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
