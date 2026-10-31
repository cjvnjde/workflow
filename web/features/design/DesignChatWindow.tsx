import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  designScopes,
  designSessionSchema,
  type DesignSession,
  type DesignPageContext,
} from "../../../src/contracts/index.js";
import { request } from "../../shared/api.js";
import { useAutosize } from "../../shared/autosize.js";
import Icon from "../../shared/Icon.js";
import MarkdownView from "../../shared/MarkdownView.js";
import ProposalPreview from "./ProposalPreview.js";
import { resizeWindow, type WindowPoint, type WindowSize } from "./floating-window.js";

type Props = {
  pageContext: DesignPageContext;
  initial: DesignSession;
  draft: string;
  minimized: boolean;
  focused: boolean;
  position: WindowPoint;
  size: WindowSize;
  layer: number;
  hasUnsavedSettings: boolean;
  applyingElsewhere: boolean;
  onApplied: () => Promise<void>;
  onUpdate: (value: DesignSession) => void;
  onDraft: (value: string) => void;
  onMove: (value: WindowPoint) => void;
  onResize: (value: { size: WindowSize; position: WindowPoint }) => void;
  onNew: () => void;
  onMinimize: () => void;
  onClose: () => void;
  onFocus: () => void;
  onApplyingChange: (value: boolean) => void;
};
type DragOrigin = {
  pointer: number;
  x: number;
  y: number;
  left: number;
  top: number;
};
type ResizeOrigin = {
  pointer: number;
  x: number;
  y: number;
  size: WindowSize;
  position: WindowPoint;
  left: boolean;
};

function contextLabel(context: DesignPageContext) {
  if (context.page !== "settings")
    return context.taskId || context.runId ? "Task workspace" : "New task";
  const section =
    context.section === "providers"
      ? "Providers & models"
      : context.section
        ? context.section === "triggers"
          ? "Triggers"
          : context.section === "memory"
            ? "Memory"
            : designScopes[context.section].title
        : "Settings";
  return context.blockId ? `${section} · ${context.blockId}` : section;
}

function occurrenceKey(occurrences: Map<string, number>, identity: string) {
  const occurrence = occurrences.get(identity) ?? 0;
  occurrences.set(identity, occurrence + 1);
  return `${identity}:${occurrence}`;
}

export default function DesignChatWindow({
  pageContext,
  initial,
  draft,
  minimized,
  focused,
  position,
  size,
  layer,
  hasUnsavedSettings,
  applyingElsewhere,
  onApplied,
  onUpdate,
  onDraft,
  onMove,
  onResize,
  onNew,
  onMinimize,
  onClose,
  onFocus,
  onApplyingChange,
}: Props) {
  const [session, setSession] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sessionRef = useRef(initial);
  const draftRef = useRef(draft);
  const busyRef = useRef(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const conversation = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const origin = useRef<DragOrigin | undefined>(undefined);
  const resizing = useRef<ResizeOrigin | undefined>(undefined);
  const autosizeRef = useAutosize(draft, 8);
  const inputRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      input.current = element;
      const dispose = autosizeRef(element);
      return () => {
        input.current = null;
        dispose();
      };
    },
    [autosizeRef],
  );
  const label = designScopes[session.scope];
  const working = session.status === "working";

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const accept = useCallback(
    (value: DesignSession, signal: AbortSignal) => {
      if (
        signal.aborted ||
        !controllerRef.current ||
        controllerRef.current.signal.aborted ||
        value.revision < sessionRef.current.revision
      )
        return;
      sessionRef.current = value;
      setSession(value);
      onUpdate(value);
    },
    [onUpdate],
  );

  useEffect(() => {
    if (!working) return;
    const pollController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const loaded = await request(`/api/design/${session.id}`, designSessionSchema, {
          signal: pollController.signal,
        });
        accept(loaded, pollController.signal);
      } catch (failure) {
        if (!pollController.signal.aborted) setError(String(failure));
      } finally {
        if (!pollController.signal.aborted)
          timer = setTimeout(() => {
            void refresh();
          }, 700);
      }
    }
    void refresh();
    return () => {
      pollController.abort();
      clearTimeout(timer);
    };
  }, [working, session.id, accept]);

  useEffect(() => {
    if (focused && !minimized && !working) input.current?.focus();
  }, [focused, minimized, working]);

  useEffect(() => {
    if (conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [session.messages.length, working]);

  function changeDraft(value: string) {
    draftRef.current = value;
    onDraft(value);
  }

  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action(signal);
    } catch (failure) {
      if (!signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busyRef.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  async function send() {
    const content = draftRef.current.trim();
    const current = sessionRef.current;
    if (!content || current.status === "working" || busyRef.current) return;
    await perform(async (signal) => {
      const updated = await request(`/api/design/${current.id}/messages`, designSessionSchema, {
        method: "POST",
        body: { message: content, revision: current.revision, context: pageContext },
        signal,
      });
      accept(updated, signal);
      if (!signal.aborted && draftRef.current.trim() === content) changeDraft("");
    });
  }

  function keydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function apply() {
    if (hasUnsavedSettings || applyingElsewhere || busyRef.current) return;
    void perform(async (signal) => {
      onApplyingChange(true);
      try {
        const current = sessionRef.current;
        accept(
          await request(`/api/design/${current.id}/apply`, designSessionSchema, {
            method: "POST",
            body: { revision: current.revision },
            signal,
          }),
          signal,
        );
        if (!signal.aborted) await onApplied();
      } finally {
        onApplyingChange(false);
      }
    });
  }

  function stop() {
    void perform(async (signal) => {
      accept(
        await request(`/api/design/${sessionRef.current.id}/cancel`, designSessionSchema, {
          method: "POST",
          body: {},
          signal,
        }),
        signal,
      );
    });
  }

  function discardProposal() {
    void perform(async (signal) => {
      const current = sessionRef.current;
      accept(
        await request(`/api/design/${current.id}/discard`, designSessionSchema, {
          method: "POST",
          body: { revision: current.revision },
          signal,
        }),
        signal,
      );
    });
  }

  function startDrag(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    origin.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: position.x,
      top: position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function drag(event: PointerEvent<HTMLElement>) {
    const start = origin.current;
    if (!start || start.pointer !== event.pointerId) return;
    onMove({ x: start.left + event.clientX - start.x, y: start.top + event.clientY - start.y });
  }

  function endDrag() {
    origin.current = undefined;
  }

  function moveWithKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget || !event.key.startsWith("Arrow")) return;
    event.preventDefault();
    onMove({
      x: position.x + (event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0),
      y: position.y + (event.key === "ArrowDown" ? 20 : event.key === "ArrowUp" ? -20 : 0),
    });
  }

  function startResize(event: PointerEvent<HTMLButtonElement>, left: boolean) {
    if (event.button !== 0) return;
    resizing.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      size: { ...size },
      position: { ...position },
      left,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function resize(event: PointerEvent<HTMLButtonElement>) {
    const start = resizing.current;
    if (!start || start.pointer !== event.pointerId) return;
    onResize(
      resizeWindow(
        start.size,
        start.position,
        { x: event.clientX - start.x, y: event.clientY - start.y },
        start.left,
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }

  function endResize() {
    resizing.current = undefined;
  }

  function resizeWithKeys(event: KeyboardEvent<HTMLButtonElement>, left: boolean) {
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    onResize(
      resizeWindow(
        size,
        position,
        {
          x: event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0,
          y: event.key === "ArrowDown" ? 20 : event.key === "ArrowUp" ? -20 : 0,
        },
        left,
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }

  const style: CSSProperties & { "--chat-compose-max": string } = {
    display: minimized ? "none" : undefined,
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `${size.width}px`,
    height: `${size.height}px`,
    zIndex: layer,
    "--chat-compose-max": `${Math.floor(size.height * 0.25)}px`,
  };
  const messageKeys = new Map<string, number>();
  const toolKeys = new Map<string, number>();

  return (
    <section
      id={`design-${session.id}`}
      className="design-chat"
      style={style}
      role="dialog"
      aria-label={`Design ${label.title.toLowerCase()} with AI`}
      onPointerDown={onFocus}
      onKeyDown={(event) => {
        if (event.key === "Escape") onMinimize();
      }}
    >
      <header
        className="design-chat-heading"
        tabIndex={0}
        aria-label="Move chat window with arrow keys or drag"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={moveWithKeys}
      >
        <span className="design-avatar">
          <Icon name="spark" size={18} />
        </span>
        <div>
          <strong>Design with AI</strong>
          <small>{label.title}</small>
        </div>
        <button
          className="icon-button"
          aria-label="New design conversation"
          title="New conversation"
          onClick={onNew}
        >
          <Icon name="plus" size={17} />
        </button>
        <button className="icon-button" aria-label="Minimize design chat" onClick={onMinimize}>
          <Icon name="minus" size={17} />
        </button>
        <button
          className="icon-button"
          aria-label="Close design chat"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" size={17} />
        </button>
      </header>
      <div
        ref={conversation}
        className="design-conversation"
        aria-label="Design conversation"
        aria-live="polite"
      >
        <div className="design-intro">
          <Icon name="spark" size={22} />
          <h3>Let’s shape {label.title.toLowerCase()}</h3>
          <p>{label.description} Describe what you want, then refine it together.</p>
          <small>Changes are saved when you apply a proposal.</small>
        </div>
        {session.messages.map((entry) => (
          <article
            key={occurrenceKey(
              messageKeys,
              JSON.stringify([entry.time, entry.role, entry.content]),
            )}
            className={`design-message ${entry.role}`}
          >
            <span>{entry.role === "user" ? "You" : "AI designer"}</span>
            {entry.context && (
              <small className="design-page-context">{contextLabel(entry.context)}</small>
            )}
            <MarkdownView content={entry.content} />
          </article>
        ))}
        {session.toolActivity.length > 0 && (
          <details className="design-tool-activity">
            <summary>
              Tools used ·{" "}
              {session.toolActivity.filter((event) => event.kind === "tool_start").length} calls
            </summary>
            {session.toolActivity.map((event) => (
              <p
                key={occurrenceKey(
                  toolKeys,
                  JSON.stringify([event.time, event.kind, event.message]),
                )}
              >
                <small>{event.kind === "tool_start" ? "Called" : "Finished"}</small> {event.message}
              </p>
            ))}
          </details>
        )}
        {working && (
          <div className="design-progress" role="status">
            <span className="spinner" />
            <div>
              <strong>Designing {label.title.toLowerCase()}…</strong>
              <small>{session.activity.slice(0, 160)}</small>
              {session.text && (
                <details>
                  <summary>Live response</summary>
                  <MarkdownView content={session.text} />
                </details>
              )}
            </div>
          </div>
        )}
        {!working && session.proposal && (
          <div className="design-proposal">
            <div className="design-proposal-title">
              <Icon name={session.status === "applied" ? "check" : "workflow"} size={17} />
              <strong>
                {session.status === "applied" ? "Changes applied" : "Proposed changes"}
              </strong>
            </div>
            <p>{session.proposal.summary}</p>
            <ProposalPreview proposal={session.proposal} />
            {session.status === "ready" && (
              <>
                <button
                  className="primary"
                  disabled={busy || hasUnsavedSettings || applyingElsewhere}
                  onClick={apply}
                >
                  <Icon name="check" size={16} />
                  Apply changes
                </button>
                <button disabled={busy} onClick={discardProposal}>
                  Discard proposal
                </button>
                {hasUnsavedSettings && (
                  <p className="muted">
                    Save or discard your form edits before applying this proposal.
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {(error || session.error) && (
          <div className="inline-error" role="alert">
            {error || session.error}
          </div>
        )}
      </div>
      <form
        className="design-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => changeDraft(event.target.value)}
          aria-label="Message AI designer"
          placeholder={
            session.messages.length ? "Refine the proposal, or ask a question…" : label.placeholder
          }
          disabled={busy || working}
          rows={3}
          maxLength={8000}
          onKeyDown={keydown}
        />
        <div>
          <small>{contextLabel(pageContext)} context included · Enter to send</small>
          {!working && draft && (
            <button type="button" disabled={busy} onClick={() => changeDraft("")}>
              Discard message
            </button>
          )}
          {working ? (
            <button type="button" disabled={busy} onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="primary"
              aria-label="Send to AI designer"
              disabled={busy || !draft.trim()}
            >
              <Icon name="arrow" size={17} />
            </button>
          )}
        </div>
      </form>
      {(["left", "right"] as const).map((edge) => (
        <button
          key={edge}
          type="button"
          className={`chat-resize-handle ${edge}`}
          aria-label={`Resize chat from bottom ${edge}`}
          title="Drag to resize · Arrow keys to adjust"
          onPointerDown={(event) => startResize(event, edge === "left")}
          onPointerMove={resize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
          onKeyDown={(event) => resizeWithKeys(event, edge === "left")}
        />
      ))}
    </section>
  );
}
