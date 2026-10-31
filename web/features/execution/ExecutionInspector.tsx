import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  type ExecutionOperation,
  type RunEvent,
  type WorkflowRun,
  projectOperations,
} from "../../../src/contracts/index.js";
import { client } from "../../shared/api.js";
import { operationBody, durationLabel } from "./operation-presentation.js";
import ExecutionTimeline from "./ExecutionTimeline.js";
import "./ExecutionInspector.css";

type Range = { start: number; end: number };
type Props = {
  run: WorkflowRun;
  events: RunEvent[];
  selected?: string;
  timeline?: boolean;
  onSelect?: (id: string | undefined) => void;
  onEvidence?: (nodeId: string, visit: number, operationId: string, sessionId?: string) => void;
};
export default function ExecutionInspector(props: Props) {
  return <RunInspector key={props.run.id} {...props} />;
}
function RunInspector({ run, events, selected, timeline, onSelect, onEvidence }: Props) {
  const [operations, setOperations] = useState<ExecutionOperation[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string>();
  const [selectedVisit, setSelectedVisit] = useState<number>();
  const [folded, setFolded] = useState(() => new Set<string>());
  const [page, setPage] = useState(0);
  const [followLatest, setFollowLatest] = useState(true);
  const [range, setRange] = useState<Range>();
  const [previousSelected, setPreviousSelected] = useState(selected);
  if (previousSelected !== selected) {
    setPreviousSelected(selected);
    setPage(0);
    setRange(undefined);
  }
  const request = useRef<AbortController | undefined>(undefined);
  async function refresh() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const result = await client.execution(run.id, controller.signal);
      if (controller.signal.aborted) return;
      setOperations(result.operations);
      setError("");
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  const refreshHistory = useEffectEvent(() => {
    void refresh();
  });
  useEffect(() => {
    const timer = setTimeout(() => refreshHistory(), 0);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
    };
  }, [run.id]);
  const lastId = events.at(-1)?.id;
  useEffect(() => {
    const timer = setTimeout(() => refreshHistory(), 400);
    return () => clearTimeout(timer);
  }, [run.revision, lastId]);
  const selectedOperation = operations.find((item) => item.key === selectedKey);
  const allKeys = new Set(operations.map((item) => item.key));
  const children = new Map<string, ExecutionOperation[]>();
  const parents = new Map(operations.map((item) => [item.key, item.parentKey]));
  for (const item of operations) {
    let ancestor = item.parentKey;
    const seen = new Set([item.key]);
    let cycle = false;
    while (ancestor) {
      if (seen.has(ancestor)) {
        cycle = true;
        break;
      }
      seen.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    const key = !cycle && item.parentKey && allKeys.has(item.parentKey) ? item.parentKey : "";
    const siblings = children.get(key);
    if (siblings) siblings.push(item);
    else children.set(key, [item]);
  }
  const visits = run.attempts.filter((item) => !selected || item.nodeId === selected);
  const scoped: { item: ExecutionOperation; depth: number }[] = [];
  const seen = new Set<string>();
  function traverse(items: ExecutionOperation[], depth: number) {
    for (const item of items) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      const start = item.startedAt ? Date.parse(item.startedAt) : undefined;
      const end = item.finishedAt ? Date.parse(item.finishedAt) : start;
      if (
        (!selected || item.nodeId === selected) &&
        (selectedVisit === undefined || item.visit === selectedVisit) &&
        (!range ||
          (start !== undefined && end !== undefined && start <= range.end && end >= range.start)) &&
        (!query ||
          `${item.name} ${item.summary ?? ""} ${item.nodeId ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase()))
      )
        scoped.push({ item, depth });
      if (query || range || !folded.has(item.key))
        traverse(children.get(item.key) ?? [], depth + 1);
    }
  }
  traverse(children.get("") ?? [], 0);
  const pages = Math.max(1, Math.ceil(scoped.length / 80));
  const currentPage = followLatest && !selectedKey ? pages - 1 : Math.min(page, pages - 1);
  const visible = scoped.slice(currentPage * 80, (currentPage + 1) * 80);
  function selectOperation(item: ExecutionOperation) {
    setSelectedKey(item.key);
    setFollowLatest(false);
  }
  function reveal(key: string) {
    const item = operations.find((value) => value.key === key);
    if (!item) return;
    const next = new Set(folded);
    let ancestor = item.parentKey;
    const ancestors = new Set<string>();
    while (ancestor && !ancestors.has(ancestor)) {
      ancestors.add(ancestor);
      next.delete(ancestor);
      ancestor = parents.get(ancestor);
    }
    setFolded(next);
    setSelectedVisit(item.visit);
    setRange(undefined);
    setPage(0);
    onSelect?.(item.nodeId);
    selectOperation(item);
  }
  return (
    <section className="execution-inspector" aria-label="Execution inspector">
      <div className="inspection-controls">
        <label>
          Step
          <select
            value={selected ?? ""}
            onChange={(event) => onSelect?.(event.target.value || undefined)}
          >
            <option value="">All steps</option>
            {run.plan.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Visit
          <select
            value={selectedVisit ?? ""}
            onChange={(event) => {
              setSelectedVisit(event.target.value ? Number(event.target.value) : undefined);
              setRange(undefined);
              setPage(0);
            }}
          >
            <option value="">All visits</option>
            {[...new Set(visits.map((item) => item.visit))].map((visit) => (
              <option key={visit} value={visit}>
                Visit {visit}
              </option>
            ))}
          </select>
        </label>
        <label className="search">
          Search calls
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            type="search"
            placeholder="Tool, step, or summary…"
          />
        </label>
        <button disabled={loading} onClick={() => void refresh()}>
          {loading ? "Refreshing…" : "Refresh history"}
        </button>
      </div>
      <p className="inspection-note">
        {operations.length} recorded operation attempts across the run · saved run history. Search
        covers names and summaries. Open a call for its recorded details.
      </p>
      {error && (
        <p className="inspection-error" role="alert">
          {error}
        </p>
      )}
      {timeline && (
        <ExecutionTimeline
          run={run}
          operations={operations}
          selected={selected}
          selectedKey={selectedKey}
          visit={selectedVisit}
          onSelect={reveal}
          onStep={(id, visit) => {
            onSelect?.(id);
            setSelectedVisit(visit);
            setPage(0);
            setRange(undefined);
          }}
          onRange={(value) => {
            setRange(value);
            setPage(0);
          }}
        />
      )}
      {range && (
        <button
          className="quiet"
          onClick={() => {
            setRange(undefined);
            setPage(0);
          }}
        >
          Clear selected time range
        </button>
      )}
      <div className="inspection-layout">
        <section className="call-ledger" aria-label="Recorded tool calls">
          <div className="ledger-heading">
            <strong>Calls · {scoped.length}</strong>
            <label className="follow-control">
              <input
                checked={followLatest}
                type="checkbox"
                onChange={(event) => {
                  setFollowLatest(event.target.checked);
                  if (event.target.checked) {
                    setSelectedKey(undefined);
                    setPage(pages - 1);
                  }
                }}
              />
              Follow latest
            </label>
            <button
              className="quiet"
              onClick={() =>
                setFolded(
                  folded.size
                    ? new Set()
                    : new Set(
                        operations.filter((item) => children.has(item.key)).map((item) => item.key),
                      ),
                )
              }
            >
              {folded.size ? "Expand calls" : "Fold calls"}
            </button>
          </div>
          {!scoped.length && (
            <p className="inspection-note">
              {operations.length
                ? "No calls match this selection."
                : "No structured operations recorded. Step timing and legacy activity remain available."}
            </p>
          )}
          {visible.map(({ item, depth }) => (
            <div
              key={item.key}
              className={`call-row${selectedKey === item.key ? " chosen" : ""}`}
              style={{ paddingLeft: `${Math.min(depth, 8) * 14 + 8}px` }}
            >
              {children.has(item.key) ? (
                <button
                  className="fold"
                  aria-label={`${folded.has(item.key) ? "Expand" : "Fold"} ${item.name}`}
                  aria-expanded={!folded.has(item.key)}
                  onClick={() => {
                    setFollowLatest(false);
                    const next = new Set(folded);
                    if (next.has(item.key)) next.delete(item.key);
                    else next.add(item.key);
                    setFolded(next);
                  }}
                >
                  {folded.has(item.key) ? "▸" : "▾"}
                </button>
              ) : (
                <span className="fold-placeholder" />
              )}
              <button
                className="call-select"
                aria-pressed={selectedKey === item.key}
                onClick={() => selectOperation(item)}
              >
                <span className="call-title">{item.name}</span>
                <span className={`call-state ${item.state}`}>{item.state}</span>
                <span className="call-meta">
                  {item.nodeId ?? "Run"}
                  {item.visit && <> · visit {item.visit}</>}
                  {item.attempt && <> · attempt {item.attempt}</>} ·{" "}
                  {durationLabel(item.durationMs)}
                </span>
                {item.summary && <span className="call-summary">{item.summary}</span>}
              </button>
            </div>
          ))}
          {pages > 1 && (
            <div className="ledger-pages">
              <button
                disabled={currentPage === 0}
                onClick={() => {
                  setFollowLatest(false);
                  setPage(currentPage - 1);
                }}
              >
                Previous calls
              </button>
              <span>
                Page {currentPage + 1} of {pages}
              </span>
              <button
                disabled={currentPage + 1 >= pages}
                onClick={() => {
                  setFollowLatest(false);
                  setPage(currentPage + 1);
                }}
              >
                Next calls
              </button>
            </div>
          )}
        </section>
        <aside className="call-detail" aria-label="Selected call details">
          {selectedOperation ? (
            <OperationDetail
              key={`${selectedOperation.key}/${selectedOperation.lastCursor}`}
              runId={run.id}
              item={selectedOperation}
              onEvidence={onEvidence}
            />
          ) : (
            <p className="inspection-note">
              Select a call or timeline span to inspect its recorded input, output, and timing.
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
function OperationDetail({
  runId,
  item,
  onEvidence,
}: {
  runId: string;
  item: ExecutionOperation;
  onEvidence?: Props["onEvidence"];
}) {
  const [detail, setDetail] = useState<ExecutionOperation>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .operationEvents(runId, item.key, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted)
          setDetail(
            result.operation ??
              projectOperations(result.events).find((value) => value.key === item.key) ??
              item,
          );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [runId, item]);
  const body = detail ? operationBody(detail.operation) : undefined;
  const value = detail?.operation.details;
  const timing =
    detail?.kind === "request" && value && typeof value === "object" && !Array.isArray(value)
      ? {
          first: typeof value.firstTokenMs === "number" ? value.firstTokenMs : undefined,
          generation: typeof value.generationMs === "number" ? value.generationMs : undefined,
          tokens: typeof value.outputTokens === "number" ? value.outputTokens : undefined,
        }
      : undefined;
  return (
    <>
      <div className="ledger-heading">
        <h3>{body?.title ?? item.name}</h3>
        <button
          className="quiet"
          disabled={!item.nodeId || !item.visit}
          onClick={() => {
            const current = detail ?? item;
            if (current.nodeId && current.visit)
              onEvidence?.(current.nodeId, current.visit, current.id, current.sessionId);
          }}
        >
          Open exact evidence
        </button>
      </div>
      <p className="inspection-note">
        {item.state} · {durationLabel(item.durationMs)}
        {item.environmentId && <> · {item.environmentId}</>}
      </p>
      {item.startedAt && <p>Started {new Date(item.startedAt).toLocaleString()}</p>}
      {item.finishedAt && <p>Finished {new Date(item.finishedAt).toLocaleString()}</p>}
      {loading && <p role="status">Loading recorded call…</p>}
      {error && <p role="alert">{error}</p>}
      {timing && (
        <>
          <dl className="request-timing">
            <dt>Time to first output (TTFT)</dt>
            <dd>{durationLabel(timing.first)}</dd>
            <dt>Recorded streaming span</dt>
            <dd>{durationLabel(timing.generation)}</dd>
            {timing.tokens !== undefined && (
              <>
                <dt>Reported output tokens</dt>
                <dd>{timing.tokens}</dd>
              </>
            )}
          </dl>
          <p className="inspection-note">
            Timing is observed by this client. It includes provider response latency and does not
            measure server-only processing.
          </p>
        </>
      )}
      {detail?.operation.outputRef && detail.nodeId && detail.visit && (
        <CapturedOutput key={detail.operation.outputRef.id} runId={runId} item={detail} />
      )}
      {body && (
        <>
          {body.command && (
            <div className="command-card">
              {body.cwd && <small>{body.cwd}</small>}
              <pre>{body.command}</pre>
              {body.exitCode !== undefined && (
                <span className={body.exitCode !== 0 ? "inspection-error" : undefined}>
                  Exit {body.exitCode}
                </span>
              )}
            </div>
          )}
          {body.path && <p className="recorded-path">{body.path}</p>}
          {body.oldText !== undefined && body.newText !== undefined && (
            <div className="recorded-diff">
              <section>
                <h4>Before this call</h4>
                <pre>{body.oldText}</pre>
              </section>
              <section>
                <h4>After this call</h4>
                <pre>{body.newText}</pre>
              </section>
            </div>
          )}
          {body.input && (
            <details>
              <summary>Recorded input</summary>
              <pre>{body.input}</pre>
            </details>
          )}
          {!!body.matches?.length && (
            <div className="search-matches">
              {[...new Set(body.matches.map((match) => match.path))].map((path) => (
                <details key={path} open>
                  <summary>{path}</summary>
                  {body.matches
                    ?.filter((match) => match.path === path)
                    .map((match) => (
                      <p key={`${match.path}/${match.line ?? ""}/${match.text}`}>
                        <code>
                          {match.line ? match.line + " · " : ""}
                          {match.text}
                        </code>
                      </p>
                    ))}
                </details>
              ))}
            </div>
          )}
          {body.result !== undefined && (
            <section>
              <h4>Recorded output</h4>
              <pre>{body.result}</pre>
            </section>
          )}
          {body.details && (
            <details>
              <summary>Additional details</summary>
              <pre>{body.details}</pre>
            </details>
          )}
          {detail?.truncated && (
            <p className="inspection-note">
              This activity preview was shortened. Open exact evidence for complete captured values
              where available.
            </p>
          )}
        </>
      )}
    </>
  );
}
function CapturedOutput({ runId, item }: { runId: string; item: ExecutionOperation }) {
  const [text, setText] = useState("");
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  const outputRef = item.operation.outputRef;
  async function load() {
    if (!item.nodeId || !item.visit || !outputRef || loading) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const result = await client.commandOutput(
        runId,
        item.nodeId,
        item.visit,
        outputRef.id,
        "output",
        { offset },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setText(result.text);
      setOffset(result.nextOffset);
      setMore(result.hasMore);
      setError("");
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  if (!item.nodeId || !item.visit || !outputRef) return null;
  return (
    <div className="captured-output">
      <a
        href={client.commandOutputUrl(runId, item.nodeId, item.visit, outputRef.id, "output", true)}
        download
      >
        Download captured output
      </a>
      <button disabled={loading || !more} onClick={() => void load()}>
        {loading ? "Loading output…" : offset ? "Next output page" : "Read captured output"}
      </button>
      {outputRef.truncated && (
        <p className="inspection-note">
          Capture reached its size limit; the download contains retained output.
        </p>
      )}
      {text && <pre>{text}</pre>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
