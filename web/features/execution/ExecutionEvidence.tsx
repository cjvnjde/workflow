import type { RunEvent, WorkflowRun } from "../../../src/contracts/index.js";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import { runReport } from "./run-report.js";
import { executionEvidence, type StepAttemptInterval } from "./execution-evidence.js";
import { useReportEvidence } from "./use-report-evidence.js";
import "./ExecutionEvidence.css";

function ownershipText(event: RunEvent) {
  if (event.kind === "ownership_violation") return event.message;
  try {
    const value = JSON.parse(event.message);
    if (event.kind === "ownership_contract")
      return `Assigned role: ${value.role}. Allowed writes: ${value.writablePaths === undefined ? "outside protected patterns" : value.writablePaths.join(", ") || "none"}. Protected: ${value.protectedPaths?.join(", ") || "all paths outside the allowlist"}.`;
    return `${value.checkedFileCount ?? value.checkedFiles?.length ?? 0} protected files verified unchanged. Allowed writes: ${value.writablePaths === undefined ? "not restricted by an allowlist" : value.writablePaths.join(", ") || "none"}. Protected patterns: ${value.protectedPaths.join(", ") || "all paths outside the allowlist"}.`;
  } catch {
    return "Ownership evidence is incomplete; inspect activity.";
  }
}
export default function ExecutionEvidence({
  run,
  events,
  now,
}: {
  run: WorkflowRun;
  events: RunEvent[];
  now: number;
}) {
  const {
    events: savedEvents,
    complete,
    available,
    loading,
    error,
    refresh,
  } = useReportEvidence(run, events);
  const report = runReport(run, savedEvents);
  const evidence = executionEvidence(run, now);
  const files = savedEvents
    .filter((event) => ["file_evidence", "file_evidence_unavailable"].includes(event.kind))
    .map((event) => {
      try {
        return {
          event,
          evidence:
            event.kind === "file_evidence"
              ? (JSON.parse(event.message) as {
                  changedFileCount: number;
                  workspace: string;
                  changes: { path: string; before: unknown; after: unknown }[];
                })
              : undefined,
        };
      } catch {
        return { event, evidence: undefined };
      }
    });
  const ownership = savedEvents.filter((event) =>
    ["ownership_evidence", "ownership_violation", "ownership_contract"].includes(event.kind),
  );
  return (
    <details className="result-checks" open>
      <summary>Execution evidence · {evidence.intervals.length} step attempts</summary>
      {loading ? (
        <p role="status">Loading complete saved evidence…</p>
      ) : error ? (
        <div className="inline-error" role="alert">
          Could not load complete execution evidence: {error} Missing records have not been
          established. <button onClick={refresh}>Retry evidence loading</button>
        </div>
      ) : !available ? (
        <p>Saved execution history is unavailable. Missing records have not been established.</p>
      ) : null}
      <p>
        Step success is separate from task acceptance. Authoring can complete with valid failing
        tests; acceptance depends on the workflow’s checks and review.
      </p>
      <h3>Result summary</h3>
      <p>
        {report.accepted.length} latest step results explicitly accepted; {report.unresolved.length}{" "}
        latest results unresolved. {report.checks.length} host checks recorded.
      </p>
      {!report.accepted.length && (
        <p>
          No explicit acceptance result recorded. A completed workflow alone does not establish
          verified acceptance.
        </p>
      )}
      <ul>
        {report.unresolved.map((attempt) => (
          <li key={attempt.nodeId}>
            <details>
              <summary>
                {attempt.nodeId} ·{" "}
                {attempt.result?.disposition || attempt.result?.outcome || "Execution error"}
              </summary>
              <pre>{attempt.error || attempt.result?.summary}</pre>
            </details>
          </li>
        ))}
      </ul>
      {!!report.checks.length && (
        <details>
          <summary>Host check evidence</summary>
          <ul>
            {report.checks.map((check) => (
              <li
                key={`${check.nodeId}/${check.visit}/${check.outputRef?.id ?? check.command}/${check.expected}`}
              >
                {check.nodeId} · visit {check.visit} · {check.command} · expected {check.expected} ·
                exit {check.exitCode} · {check.matched ? "matched" : "NOT matched"}
                <pre>{check.output}</pre>
              </li>
            ))}
          </ul>
        </details>
      )}
      <h3>Decisions</h3>
      {complete && !report.decisions.length ? (
        <p>
          No predicate evaluations recorded. Older runs retain their group state but not decision
          history.
        </p>
      ) : (
        <ol>
          {report.decisions.map((decision) => (
            <li key={decision.id}>
              {decision.groupId}
              {decision.iteration ? <> · round {decision.iteration}</> : null}:{" "}
              {decision.result === undefined ? "not evaluated" : String(decision.result)} →{" "}
              <strong>{decision.route}</strong>. {decision.reason}
            </li>
          ))}
        </ol>
      )}
      {savedEvents.some((event) => event.kind === "capability_warning") && (
        <details open>
          <summary>Capability warnings</summary>
          <ul>
            {savedEvents
              .filter((event) => event.kind === "capability_warning")
              .map((event) => (
                <li key={event.id}>{event.message}</li>
              ))}
          </ul>
        </details>
      )}
      <h3>Actual model calls</h3>
      {complete && !report.calls.length && (
        <p>
          No detailed model-session records. See agent-start activity for older runs; step defaults
          may differ from inner calls.
        </p>
      )}
      {report.calls.map((call) => (
        <details key={call.id}>
          <summary>
            {call.nodeId} · {call.description}
            {call.durationMs !== undefined && <> · {(call.durationMs / 1000).toFixed(1)}s</>}
          </summary>
          <p>Exposed tools: {call.tools.join(", ") || "none"}</p>
          {call.usage && (
            <p>
              {call.usage.inputTokens} input / {call.usage.outputTokens} output tokens ·{" "}
              {call.usage.requests} requests ·{" "}
              {call.usage.unpricedRequests
                ? "cost incomplete"
                : "$" + call.usage.costUsd.toFixed(4)}
            </p>
          )}
        </details>
      ))}
      <StepAttemptsTable attempts={evidence.intervals} />
      <h3>Concurrent execution</h3>
      {!evidence.overlaps.length ? (
        <p>No overlapping step attempts recorded.</p>
      ) : (
        <ul>
          {evidence.overlaps.map((overlap) => (
            <li key={overlap.id}>
              {overlap.first} + {overlap.second}: {overlap.seconds.toFixed(1)}s overlap
            </li>
          ))}
        </ul>
      )}
      <p>
        Overlapping attempts prove scheduling overlap, not simultaneous model calls or safe
        integration. Inspect separate workspaces and the verification after the join before
        accepting concurrent edits.
      </p>
      <h3>Concurrent model sessions</h3>
      {complete && !report.modelOverlaps.length ? (
        <p>No completed overlapping model sessions recorded.</p>
      ) : (
        <ul>
          {report.modelOverlaps.map((overlap) => (
            <li key={overlap.id}>
              {overlap.first} + {overlap.second}: {overlap.seconds.toFixed(1)}s ·{" "}
              {overlap.isolated
                ? "different execution workspaces"
                : "workspace isolation not established"}
            </li>
          ))}
        </ul>
      )}
      <h3>Execution workspaces</h3>
      {complete && !savedEvents.some((item) => item.kind === "execution_workspace") && (
        <p>No workspace records captured for this run.</p>
      )}
      <ul>
        {savedEvents
          .filter((item) => item.kind === "execution_workspace")
          .map((event) => (
            <li key={event.id}>
              {event.nodeId}: {event.message}
            </li>
          ))}
      </ul>
      <h3>File changes</h3>
      <p>
        Snapshots compare files before and after each AI call. Shared-workspace changes may include
        other concurrent writers; isolated worktrees provide separate evidence. Runtime/dependency
        trees and transient edits are excluded.
      </p>
      {run.attempts.some((attempt) => attempt.recovery && attempt.recovery.status !== "none") && (
        <ul>
          {run.attempts
            .filter((attempt) => attempt.recovery && attempt.recovery.status !== "none")
            .map((attempt) => (
              <li key={`recovery-${attempt.nodeId}-${attempt.visit}`}>
                {attempt.nodeId} · visit {attempt.visit} · file recovery: {attempt.recovery?.status}
                .{" "}
                {!!attempt.recovery?.restored.length && (
                  <>Restored: {attempt.recovery.restored.join(", ")}.</>
                )}{" "}
                {!!attempt.recovery?.conflicts.length && (
                  <>Conflicts retained: {attempt.recovery.conflicts.join(", ")}.</>
                )}
              </li>
            ))}
        </ul>
      )}
      {complete && !files.length && <p>No file-change snapshots recorded.</p>}
      {files.map((item) => (
        <details key={item.event.id}>
          <summary>
            {item.event.nodeId} ·{" "}
            {item.evidence
              ? `${item.evidence.changedFileCount} files changed`
              : "Evidence unavailable"}
          </summary>
          {item.evidence ? (
            <>
              <p>{item.evidence.workspace}</p>
              <ul>
                {item.evidence.changes.map((change) => (
                  <li key={change.path}>
                    {change.path} ·{" "}
                    {change.before === null
                      ? "added"
                      : change.after === null
                        ? "deleted"
                        : "modified"}
                  </li>
                ))}
              </ul>
              {item.evidence.changedFileCount > 100 && <p>Showing the first 100 files.</p>}
            </>
          ) : (
            <p>{item.event.message}</p>
          )}
        </details>
      ))}
      <h3>File ownership</h3>
      {complete && !ownership.length ? (
        <p>
          No file-ownership evidence recorded for this run. This does not establish that files were
          unchanged.
        </p>
      ) : (
        <ul>
          {ownership.map((event) => (
            <li key={event.id}>
              <strong>{event.nodeId}</strong>: {ownershipText(event)}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

const attemptFeatures = tableFeatures({});
const attemptColumn = createColumnHelper<typeof attemptFeatures, StepAttemptInterval>();
const attemptColumns = attemptColumn.columns([
  attemptColumn.accessor("label", { header: "Step" }),
  attemptColumn.accessor("visit", { header: "Visit" }),
  attemptColumn.accessor((attempt) => (attempt.end - attempt.start) / 1000, {
    id: "duration",
    header: "Duration",
    cell: (cell) => `${cell.getValue().toFixed(1)}s`,
  }),
  attemptColumn.accessor("outcome", { header: "Result" }),
]);

function StepAttemptsTable({ attempts }: { attempts: StepAttemptInterval[] }) {
  const table = useTable({
    features: attemptFeatures,
    columns: attemptColumns,
    data: attempts,
    getRowId: (attempt) => `${attempt.nodeId}-${attempt.visit}`,
  });
  return (
    <Table>
      <TableCaption className="sr-only">Step attempts</TableCaption>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead key={header.id} scope="col">
                {header.isPlaceholder ? null : <table.FlexRender header={header} />}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getAllCells().map((cell) => (
              <TableCell key={cell.id}>
                <table.FlexRender cell={cell} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
