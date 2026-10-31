import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import {
  usageReportSchema,
  type UsageReport,
  type UsagePhase,
} from "../../../src/contracts/index.js";
import { request } from "../../shared/api.js";
import { usageCost, usagePhaseLabels, usageTokens } from "./usage-presentation.js";
import Icon from "../../shared/Icon.js";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import "./UsageSummary.css";

type UsageSummaryProps = {
  scope: "project" | "task" | "run" | "setup";
  scopeId?: string;
  revision?: string | number;
  active?: boolean;
};

export default function UsageSummary(props: UsageSummaryProps) {
  const endpoint =
    props.scope === "project"
      ? "/api/usage"
      : props.scopeId
        ? `/api/${props.scope === "task" ? "tasks" : props.scope === "setup" ? "setup-jobs" : "runs"}/${encodeURIComponent(props.scopeId)}/usage`
        : undefined;
  return <UsageDetails key={endpoint ?? props.scope} {...props} endpoint={endpoint} />;
}

function UsageDetails({
  scope,
  revision,
  active = false,
  endpoint,
}: UsageSummaryProps & { endpoint: string | undefined }) {
  const queryClient = useQueryClient();
  const queryKey = ["usage", scope, endpoint];
  const query = useQuery({
    queryKey,
    enabled: !!endpoint,
    queryFn: ({ signal }) => request(endpoint!, usageReportSchema, { signal }),
    refetchInterval: ({ state }) =>
      active || state.data?.sessions.some((session) => session.status === "running") ? 5000 : false,
  });
  const report = query.data;
  const error = query.error?.message ?? "";
  const loading = query.isFetching;
  const refresh = () => query.refetch();
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["usage", scope, endpoint] });
  }, [queryClient, scope, endpoint, revision]);
  const title =
    scope === "project"
      ? "Project AI usage"
      : scope === "setup"
        ? "Setup cost"
        : (report?.scope.kind ?? scope) === "task"
          ? "Task cost"
          : "Workflow cost";
  const partial = !!report && (report.incomplete || report.total.unpricedRequests > 0);
  const warnings = report ? [...report.warnings] : [];
  if (report && report.total.unpricedRequests > 0 && !warnings.some((item) => /pric/i.test(item)))
    warnings.unshift(
      `${report.total.unpricedRequests} model requests have no recorded price. Their cost is unknown.`,
    );
  if (report?.incomplete && !warnings.length)
    warnings.push("Some historical or interrupted activity has incomplete usage records.");
  const uniqueWarnings = [...new Set(warnings)];
  function unfinished(phase?: UsagePhase, provider?: string, model?: string) {
    return (
      report?.sessions.some(
        (session) =>
          ["running", "interrupted"].includes(session.status) &&
          (phase === undefined || session.phase === phase) &&
          (provider === undefined || (session.provider === provider && session.model === model)),
      ) ?? false
    );
  }
  return (
    <section className="usage-summary" aria-label={title} aria-busy={loading}>
      <div className="usage-heading">
        <div className="usage-title">
          <Icon name="chart" size={17} />
          <span>{title}</span>
        </div>
        {report ? (
          <strong className={`usage-total${partial ? " partial" : ""}`}>
            {usageCost(report.total, report.incomplete)}
          </strong>
        ) : (
          <span className="usage-loading">{error ? "Unavailable" : "Loading usage…"}</span>
        )}
        <button
          className="quiet"
          disabled={loading}
          aria-label={`Refresh ${title.toLowerCase()}`}
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </div>
      {report && (
        <>
          <p className="usage-scope-note">
            {scope === "project"
              ? "Recorded across this project, including setup, settings design and retained task history."
              : scope === "setup"
                ? "All recorded stages and retries in this setup operation share this total."
                : report.scope.kind === "task"
                  ? "Planning, refinement and execution for this task, including retries and recovery."
                  : "Recorded planning, refinement and execution for this workflow."}
          </p>
          {!!report.phases.length && (
            <div className="usage-phases" aria-label="Cost by phase">
              {report.phases.map((phase) => (
                <span key={phase.phase}>
                  <span>{usagePhaseLabels[phase.phase]}</span>
                  <strong>{usageCost(phase.usage, unfinished(phase.phase))}</strong>
                </span>
              ))}
            </div>
          )}
          {(report.limits.totalCostUsd !== undefined ||
            report.limits.executionCostUsd !== undefined) && (
            <div className="usage-limits">
              {report.limits.totalCostUsd !== undefined && (
                <span>
                  Total limit <strong>${report.limits.totalCostUsd.toFixed(4)}</strong>
                </span>
              )}
              {report.limits.remainingCostUsd !== null ? (
                <span>
                  Remaining <strong>${report.limits.remainingCostUsd.toFixed(4)}</strong>
                </span>
              ) : (
                report.limits.totalCostUsd !== undefined && (
                  <span>Remaining amount unavailable</span>
                )
              )}
              {report.limits.executionCostUsd !== undefined && (
                <span>
                  Execution limit <strong>${report.limits.executionCostUsd.toFixed(4)}</strong>
                </span>
              )}
            </div>
          )}
          {partial && (
            <p className="usage-warning">
              <Icon name="alert" size={14} />
              Incomplete cost coverage. Missing usage or pricing is not counted as free.
            </p>
          )}
          <details className="usage-breakdown">
            <summary>
              Usage details · {report.sessionCount} model{" "}
              {report.sessionCount === 1 ? "session" : "sessions"} ·{" "}
              {usageTokens(report.total).toLocaleString()} tokens
            </summary>
            <p>
              Amounts use reported token usage and recorded model prices; they may differ from your
              provider's invoice.
            </p>
            {!!uniqueWarnings.length && (
              <ul className="usage-warnings">
                {uniqueWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            {!!report.models.length && <ModelUsageTable report={report} />}
            {!!(
              report.legacyExecution.requests ||
              usageTokens(report.legacyExecution) ||
              report.legacyExecution.costUsd
            ) && (
              <p className="usage-legacy">
                Historical execution: {usageCost(report.legacyExecution)} is already included in
                this total. Model session details were not recorded for that activity.
              </p>
            )}
            {!report.sessionCount && !report.total.requests && !report.incomplete && (
              <p>No model usage recorded yet.</p>
            )}
            {!!report.sessions.length && (
              <details className="usage-sessions">
                <summary>
                  Model sessions
                  {report.sessionsTruncated
                    ? ` · latest ${report.sessions.length} of ${report.sessionCount}`
                    : ""}
                </summary>
                {report.sessionsTruncated && <p>Totals include all retained sessions.</p>}
                {report.sessions.map((session) => (
                  <article key={session.id} className="usage-session">
                    <div>
                      <strong>{session.model}</strong>
                      <span>
                        {usageCost(
                          session.usage,
                          ["running", "interrupted"].includes(session.status),
                        )}
                      </span>
                    </div>
                    <p>
                      {usagePhaseLabels[session.phase]} · {session.status}
                      {session.nodeId && (
                        <>
                          {" "}
                          · {session.nodeId}
                          {!!session.visit && <> · visit {session.visit}</>}
                        </>
                      )}
                    </p>
                    <small>
                      {session.provider} · {session.thinking} thinking · {session.usage.requests}{" "}
                      {session.usage.requests === 1 ? "request" : "requests"} ·{" "}
                      {usageTokens(session.usage).toLocaleString()} tokens
                    </small>
                    <small>
                      {new Date(session.startedAt).toLocaleString()} ·{" "}
                      {session.pricing.source === "unknown"
                        ? "Price unavailable"
                        : session.pricing.source === "override"
                          ? "Configured price"
                          : "Model catalog price"}
                    </small>
                    {session.error && <p className="usage-session-error">{session.error}</p>}
                  </article>
                ))}
              </details>
            )}
          </details>
        </>
      )}
      {error && (
        <p className="usage-fetch-error" role="status">
          {report ? "Showing the last loaded usage. " : "Could not load usage. "}
          {error}
        </p>
      )}
    </section>
  );
}

type ModelUsageRow = UsageReport["models"][number] & { unfinished: boolean };
const modelFeatures = tableFeatures({});
const modelColumn = createColumnHelper<typeof modelFeatures, ModelUsageRow>();
const modelColumns = modelColumn.columns([
  modelColumn.accessor("model", {
    header: "Model",
    cell: ({ row }) => (
      <>
        <strong>{row.original.model}</strong>
        <small>{row.original.provider}</small>
      </>
    ),
  }),
  modelColumn.accessor("sessionCount", { header: "Sessions" }),
  modelColumn.accessor((model) => usageTokens(model.usage), {
    id: "tokens",
    header: "Tokens",
    cell: (cell) => cell.getValue().toLocaleString(),
  }),
  modelColumn.accessor("usage", {
    header: "Recorded cost",
    cell: ({ row }) => usageCost(row.original.usage, row.original.unfinished),
  }),
]);

function ModelUsageTable({ report }: { report: UsageReport }) {
  const data = useMemo(
    () =>
      report.models.map((model) => ({
        ...model,
        unfinished: report.sessions.some(
          (session) =>
            ["running", "interrupted"].includes(session.status) &&
            session.provider === model.provider &&
            session.model === model.model,
        ),
      })),
    [report.models, report.sessions],
  );
  const table = useTable({
    features: modelFeatures,
    columns: modelColumns,
    data,
    getRowId: (model) => `${model.provider}/${model.model}`,
  });
  return (
    <Table className="usage-table">
      <TableCaption>Cost by model</TableCaption>
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
            {row.getAllCells().map((cell) =>
              cell.column.id === "model" ? (
                <TableHead key={cell.id} scope="row">
                  <table.FlexRender cell={cell} />
                </TableHead>
              ) : (
                <TableCell key={cell.id}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ),
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
