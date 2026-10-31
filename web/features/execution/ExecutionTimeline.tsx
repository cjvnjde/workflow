import { Fragment, useState, type PointerEvent } from "react";
import type { ExecutionOperation, WorkflowRun } from "../../../src/contracts/index.js";
import { executionTimeline, type TimelineRow } from "./execution-timeline.js";
import { durationLabel } from "./operation-presentation.js";
import "./ExecutionTimeline.css";

type Range = { start: number; end: number };
type Props = {
  run: WorkflowRun;
  operations: ExecutionOperation[];
  selected?: string;
  selectedKey?: string;
  visit?: number;
  onSelect?: (key: string) => void;
  onStep?: (nodeId: string, visit: number) => void;
  onRange?: (value: Range | undefined) => void;
};
export default function ExecutionTimeline(props: Props) {
  const { run, operations, selected, selectedKey, visit, onSelect, onStep, onRange } = props;
  const [mode, setMode] = useState<"time" | "sequence">("time");
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(0);
  const [startSelection, setStartSelection] = useState<number>();
  const [selectedRange, setSelectedRange] = useState<Range>();
  const [previous, setPrevious] = useState({ selected, visit, selectedKey, mode });
  const model = executionTimeline(run, operations, mode);
  const rows = model.rows.filter(
    (row) => (!selected || row.nodeId === selected) && (visit === undefined || row.visit === visit),
  );
  if (
    previous.selected !== selected ||
    previous.visit !== visit ||
    previous.mode !== mode ||
    previous.selectedKey !== selectedKey
  ) {
    setPrevious({ selected, visit, selectedKey, mode });
    const index = rows.findIndex((row) => row.operationKey === selectedKey);
    setPage(index >= 0 ? Math.floor(index / 80) : 0);
    if (previous.selected !== selected || previous.visit !== visit || previous.mode !== mode)
      setSelectedRange(undefined);
  }
  const pages = Math.max(1, Math.ceil(rows.length / 80));
  const currentPage = Math.min(page, pages - 1);
  const visible = rows.slice(currentPage * 80, (currentPage + 1) * 80);
  function select(row: TimelineRow) {
    if (row.operationKey) onSelect?.(row.operationKey);
    else if (row.nodeId && row.visit) onStep?.(row.nodeId, row.visit);
  }
  function position(value: number) {
    return ((value - model.start) / (model.end - model.start)) * 100;
  }
  function pointerTime(event: PointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return (
      model.start +
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * (model.end - model.start)
    );
  }
  function down(event: PointerEvent<HTMLElement>) {
    if (mode !== "time" || event.button !== 0) return;
    setStartSelection(pointerTime(event));
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function up(event: PointerEvent<HTMLElement>) {
    if (startSelection === undefined) return;
    const end = pointerTime(event);
    setStartSelection(undefined);
    if (Math.abs(end - startSelection) < (model.end - model.start) / 200) return;
    const value = { start: Math.min(startSelection, end), end: Math.max(startSelection, end) };
    setSelectedRange(value);
    onRange?.(value);
  }
  function clearRange() {
    setSelectedRange(undefined);
    onRange?.(undefined);
  }
  function title(row: TimelineRow) {
    return `${row.label} · ${row.state} · ${row.settled && mode === "time" ? durationLabel(row.end - row.start) : "No completed duration"}${mode === "time" ? " · " + new Date(row.start).toLocaleTimeString() : ""}`;
  }
  return (
    <section className="execution-timeline" aria-label="Execution timeline">
      <div className="timeline-toolbar">
        <h3>Timeline</h3>
        <label>
          Display
          <select
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as "time" | "sequence");
              clearRange();
            }}
          >
            <option value="time">Wall-clock time</option>
            <option value="sequence">Operation sequence</option>
          </select>
        </label>
        <label>
          Zoom
          <input
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            aria-label="Timeline zoom"
            type="range"
            min="1"
            max="8"
            step="0.5"
          />
        </label>
        <button
          className="quiet"
          onClick={() => {
            setZoom(1);
            clearRange();
          }}
        >
          Reset view
        </button>
      </div>
      <p>
        Each step visit has its own lane. Select a span to inspect it.
        {mode === "time" && (
          <>
            {" "}
            Drag across the time ruler to filter calls; scroll horizontally when zoomed. Unfinished
            operations show their recorded start only.
          </>
        )}
      </p>
      <div className="timeline-scroll">
        <div className="timeline-grid" style={{ minWidth: `${Math.max(600, 600 * zoom)}px` }}>
          <div className="timeline-ruler-label">
            {mode === "time" ? "Recorded time" : "Call order"}
          </div>
          <div
            className="timeline-ruler"
            aria-label="Select time range"
            onPointerDown={down}
            onPointerUp={up}
            onPointerCancel={() => setStartSelection(undefined)}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
              <span key={fraction} style={{ left: `${fraction * 100}%` }}>
                {mode === "time"
                  ? durationLabel((model.end - model.start) * fraction)
                  : Math.round(model.start + (model.end - model.start) * fraction)}
              </span>
            ))}
            {selectedRange && (
              <div
                className="range-highlight"
                style={{
                  left: `${position(selectedRange.start)}%`,
                  width: `${position(selectedRange.end) - position(selectedRange.start)}%`,
                }}
              />
            )}
          </div>
          {visible.map((row) => (
            <Fragment key={row.key}>
              <button
                className={`timeline-label${row.operationKey ? " child" : ""}`}
                title={row.label}
                onClick={() => select(row)}
              >
                {row.label}
              </button>
              <div className="timeline-lane">
                <button
                  className={`timeline-span ${row.state}${row.operationKey ? " child" : ""}${selectedKey === row.operationKey ? " selected" : ""}${!row.settled && mode === "time" ? " marker" : ""}`}
                  style={{
                    left: `${position(row.start)}%`,
                    width: `${Math.max(0, position(row.end) - position(row.start))}%`,
                  }}
                  aria-label={title(row)}
                  title={title(row)}
                  onClick={() => select(row)}
                >
                  <span className="sr-only">{row.label}</span>
                </button>
              </div>
            </Fragment>
          ))}
        </div>
      </div>
      {!rows.length && <p>No recorded timing for this selection.</p>}
      {pages > 1 && (
        <div className="timeline-pages">
          <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
            Previous lanes
          </button>
          <span>
            Lanes {currentPage * 80 + 1}–{Math.min((currentPage + 1) * 80, rows.length)} of{" "}
            {rows.length}
          </span>
          <button disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>
            Next lanes
          </button>
        </div>
      )}
    </section>
  );
}
