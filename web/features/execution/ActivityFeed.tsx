import { useEffect, useEffectEvent, useRef, useState } from "react";
import { client } from "../../shared/api.js";
import type { RunEvent } from "../../../src/contracts/index.js";
import {
  chatEventVisible,
  defaultChatVisibility,
  type ChatVisibility,
} from "../../../src/client/chat-visibility.js";
import {
  activityCategories,
  describeActivity,
  matchesActivity,
  type ActivityCategory,
} from "./activity.js";
import Icon from "../../shared/Icon.js";
import MarkdownView from "../../shared/MarkdownView.js";

type Props = {
  events: RunEvent[];
  runId?: string;
  liveText?: string;
  liveResponses?: Record<string, string>;
  running?: boolean;
  nodes?: { id: string; label: string }[];
  selected?: string;
  title?: string;
  onSelect?: (id: string | undefined) => void;
};
export default function ActivityFeed(props: Props) {
  const [visibility, setVisibility] = useState<ChatVisibility>({ ...defaultChatVisibility });
  return (
    <ActivityHistory
      key={props.runId ?? "live"}
      {...props}
      visibility={visibility}
      onVisibilityChange={setVisibility}
    />
  );
}
function ActivityHistory({
  events,
  runId,
  liveText,
  liveResponses,
  running,
  nodes,
  selected,
  title = "Workflow activity",
  onSelect,
  visibility,
  onVisibilityChange,
}: Props & {
  visibility: ChatVisibility;
  onVisibilityChange: (visibility: ChatVisibility) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ActivityCategory>("all");
  const [history, setHistory] = useState<{ cursor: number; event: RunEvent }[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [eventPage, setEventPage] = useState(0);
  const request = useRef<{
    controller?: AbortController;
    history: { cursor: number; event: RunEvent }[];
    loading: boolean;
    pending: boolean;
    before?: number;
    asOf?: number;
    disposed: boolean;
  }>({ history: [], loading: false, pending: false, disposed: false });
  async function loadHistory(earlier = false) {
    if (!runId) return;
    const state = request.current;
    if (state.loading) {
      if (!earlier) state.pending = true;
      return;
    }
    const controller = new AbortController();
    state.controller = controller;
    state.loading = true;
    setHistoryLoading(true);
    try {
      const result = await client.history(
        runId,
        earlier ? { before: state.before, asOf: state.asOf, limit: 200 } : { limit: 200 },
        controller.signal,
      );
      if (controller.signal.aborted || state.disposed) return;
      const priorEnd = state.history.at(-1)?.cursor;
      const newStart = result.events[0]?.cursor;
      const gap = priorEnd !== undefined && newStart !== undefined && newStart > priorEnd + 1;
      state.history = [
        ...new Map(
          [...state.history, ...result.events].map((item) => [item.cursor, item]),
        ).values(),
      ].sort((a, b) => a.cursor - b.cursor);
      setHistory(state.history);
      if (earlier || priorEnd === undefined || gap) {
        state.before = result.nextBefore;
        setHasMore(result.hasMore);
      }
      if (!earlier) state.asOf = result.asOf;
      setHistoryError("");
    } catch (failure) {
      if (!controller.signal.aborted && !state.disposed)
        setHistoryError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!controller.signal.aborted && !state.disposed) {
        state.loading = false;
        setHistoryLoading(false);
        if (state.pending) {
          state.pending = false;
          void loadHistory();
        }
      }
    }
  }
  const refreshHistory = useEffectEvent(() => {
    void loadHistory();
  });
  useEffect(() => {
    const state = request.current;
    state.disposed = false;
    refreshHistory();
    return () => {
      state.disposed = true;
      state.controller?.abort();
      state.loading = false;
    };
  }, []);
  const lastId = events.at(-1)?.id;
  useEffect(() => {
    const timer = setTimeout(() => refreshHistory(), 400);
    return () => clearTimeout(timer);
  }, [lastId]);
  const labels = Object.fromEntries((nodes ?? []).map((node) => [node.id, node.label]));
  const allEvents = runId ? history.map((item) => item.event) : events;
  const scoped = allEvents.filter((event) => !selected || event.nodeId === selected);
  const presented = scoped
    .filter((event) => chatEventVisible(event, visibility))
    .map(describeActivity)
    .toReversed();
  const matches = presented.filter((item) =>
    matchesActivity(item, query, labels[item.event.nodeId ?? ""]),
  );
  const visible = matches.filter((item) => category === "all" || item.category === category);
  const eventPages = Math.max(1, Math.ceil(visible.length / 100));
  const page = Math.min(eventPage, eventPages - 1);
  const [previousSelection, setPreviousSelection] = useState(selected);
  if (previousSelection !== selected) {
    setPreviousSelection(selected);
    setEventPage(0);
  }
  const windowed = runId ? visible.slice(page * 100, (page + 1) * 100) : visible.slice(0, 200);
  function reset() {
    setQuery("");
    setCategory("all");
    setEventPage(0);
    onVisibilityChange({ ...defaultChatVisibility });
  }
  return (
    <section className="activity" aria-label={title}>
      <div className="activity-toolbar">
        <div className="activity-heading">
          <div>
            <h2>{selected ? (labels[selected] ?? selected) : title}</h2>
            <p>
              {visible.length} of {scoped.length} loaded events
              {running && (
                <span>
                  {" "}
                  · <span className="live-dot" /> Live
                </span>
              )}
            </p>
          </div>
          {selected && (
            <button className="quiet" onClick={() => onSelect?.(undefined)}>
              Show all steps
            </button>
          )}
          <span className="activity-retention">
            {runId ? "Paged event history" : "Latest 200 events"}
          </span>
        </div>
        <div className="activity-search-row">
          <label className="activity-search">
            <Icon name="search" size={16} />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setEventPage(0);
              }}
              type="search"
              aria-label="Search activity"
              placeholder="Search messages, commands, or files…"
            />
          </label>
          {nodes && (
            <select
              value={selected ?? ""}
              aria-label="Activity step"
              onChange={(event) => onSelect?.(event.target.value || undefined)}
            >
              <option value="">All steps</option>
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="activity-filters" role="group" aria-label="Activity visibility">
          <button
            aria-pressed={visibility.tools}
            onClick={() => {
              onVisibilityChange({ ...visibility, tools: !visibility.tools });
              setEventPage(0);
            }}
          >
            Tools
          </button>
          <button
            aria-pressed={visibility.thinking}
            onClick={() => {
              onVisibilityChange({ ...visibility, thinking: !visibility.thinking });
              setEventPage(0);
            }}
          >
            Thinking / progress
          </button>
        </div>
        <div className="activity-filters" role="group" aria-label="Activity filters">
          {activityCategories.map(([id, label]) => (
            <button
              key={id}
              aria-pressed={category === id}
              onClick={() => {
                setCategory(id);
                setEventPage(0);
              }}
            >
              {label}
              <span>
                {id === "all"
                  ? matches.length
                  : matches.filter((item) => item.category === id).length}
              </span>
            </button>
          ))}
        </div>
      </div>
      {runId && (
        <div className="activity-history-controls">
          <button disabled={historyLoading} onClick={() => void loadHistory()}>
            Refresh history
          </button>
          {hasMore && (
            <button disabled={historyLoading} onClick={() => void loadHistory(true)}>
              {historyLoading ? "Loading…" : "Load earlier events"}
            </button>
          )}
          {historyError && <span role="alert">{historyError}</span>}
          {eventPages > 1 && (
            <>
              <button disabled={page === 0} onClick={() => setEventPage(page - 1)}>
                Newer events
              </button>
              <span>
                Page {page + 1} of {eventPages}
              </span>
              <button disabled={page + 1 >= eventPages} onClick={() => setEventPage(page + 1)}>
                Older events
              </button>
            </>
          )}
        </div>
      )}
      <div className="activity-feed">
        {!query &&
          ["all", "updates"].includes(category) &&
          Object.entries(liveResponses ?? {})
            .filter(([id]) => !selected || id === selected)
            .map(([id, text]) => (
              <div key={id} className="live-output">
                <span className="eyebrow">
                  <span className="live-dot" /> {labels[id] ?? id} · Live response
                </span>
                <MarkdownView content={text} />
              </div>
            ))}
        {liveText && !query && ["all", "updates"].includes(category) && (
          <div className="live-output">
            <span className="eyebrow">
              <span className="live-dot" /> Live response
            </span>
            <MarkdownView content={liveText} />
          </div>
        )}
        {windowed.map((item) => (
          <article key={item.event.id} className={`event ${item.event.kind} ${item.tone}`}>
            <div className="event-mark">
              <Icon name={item.icon} size={15} />
            </div>
            <div className="event-body">
              <div className="event-meta">
                <b>{item.title}</b>
                {item.state && <span className={`event-state ${item.tone}`}>{item.state}</span>}
                <time dateTime={item.event.time}>
                  {new Date(item.event.time).toLocaleTimeString()}
                </time>
              </div>
              {item.event.nodeId && nodes && !selected && (
                <button className="event-step" onClick={() => onSelect?.(item.event.nodeId)}>
                  {labels[item.event.nodeId] ?? item.event.nodeId}
                </button>
              )}
              {item.markdown ? (
                <MarkdownView content={item.event.message} />
              ) : (
                <>
                  <p className="event-preview">{item.preview}</p>
                  {(item.detail !== item.preview ||
                    ["tools", "checks", "usage"].includes(item.category)) && (
                    <details className="event-details">
                      <summary>View details</summary>
                      <pre>{item.detail}</pre>
                    </details>
                  )}
                </>
              )}
            </div>
          </article>
        ))}
        {!visible.length && (
          <div className="panel-empty">
            <Icon name={scoped.length ? "search" : "log"} size={26} />
            <p>
              {scoped.length
                ? "No activity matches these filters."
                : "Activity will appear here as work progresses."}
            </p>
            {(query || category !== "all" || visibility.tools || visibility.thinking) && (
              <button onClick={reset}>Clear filters</button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
