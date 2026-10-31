import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "../../shared/Icon.js";

export default function SessionSwitcher({
  onOpen,
}: {
  onOpen: (value: string, signal: AbortSignal) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lookup = useRef<AbortController | undefined>(undefined);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const cancelLookup = useCallback(() => {
    lookup.current?.abort();
    lookup.current = undefined;
    setBusy(false);
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
  async function open() {
    if (lookup.current || !value.trim()) return;
    const controller = new AbortController();
    lookup.current = controller;
    setBusy(true);
    setError("");
    try {
      await onOpen(value, controller.signal);
      controller.signal.throwIfAborted();
      dialog.current?.close();
      setValue("");
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (lookup.current === controller) {
        lookup.current = undefined;
        setBusy(false);
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
            void open();
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
          <input
            id="session-reference"
            ref={input}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste a task ID, run ID, or link"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
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
