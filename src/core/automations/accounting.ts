import type { AutomationJob } from "../../contracts/automation-schema.js";
import type { UsageTotals, WorkflowRun } from "../../contracts/domain.js";
import type { UsageReport, UsageSession } from "../../contracts/usage-schema.js";
import { addUsage, emptyUsage } from "../execution/budget.js";
import type { UsageStore } from "../storage/usage-store.js";

/** Only test executors may omit the real host's durable usage ledger. */
export interface AutomationAccountingEngine {
  get(id: string): Pick<WorkflowRun, "id" | "status" | "usage">;
  list(includeDeleted?: boolean): { id: string }[];
  usage?: Pick<UsageStore, "report" | "sessions">;
}

type AccountingJob = Pick<AutomationJob, "id" | "runId" | "priorRunIds" | "usage" | "runStatus"> & {
  usageIncomplete?: boolean;
};

export interface AutomationJobAccounting {
  /** All attempts, including the current attempt. Use this for aggregate spending. */
  usage: UsageTotals;
  /** Current attempt only. Subtract this from its remaining reservation. */
  currentUsage: UsageTotals;
  /** Persist this on the job before releasing or replacing its reservation. */
  usageIncomplete: boolean;
  /** Original ledger reports retain model attribution and captured prices. */
  reports: UsageReport[];
}

function maximum(left: UsageTotals, right: UsageTotals): UsageTotals {
  return Object.fromEntries(
    Object.entries(left).map(([key, value]) => [
      key,
      Math.max(value, right[key as keyof UsageTotals]),
    ]),
  ) as UsageTotals;
}

/**
 * Read one admission/reconciliation snapshot, never a long-lived cache. Live totals
 * and ledger totals overlap, so take their maximum rather than billing them twice.
 * Reservation arithmetic must use both totals from this same returned snapshot.
 */
export async function readAutomationAccounting(
  engine: AutomationAccountingEngine,
  jobs: readonly AccountingJob[],
  options: { reservedRunIds?: ReadonlySet<string> } = {},
): Promise<Map<string, AutomationJobAccounting>> {
  const knownRuns = new Set(engine.list(true).map((run) => run.id));
  const ids = new Set(jobs.flatMap((job) => [job.runId, ...job.priorRunIds]));
  const runs = new Map(
    [...ids].filter((id) => knownRuns.has(id)).map((id) => [id, engine.get(id)]),
  );
  // Reports truncate their session lists. Read sessions separately so an old
  // orphan cannot disappear behind 500 newer completed model calls.
  const sessions = engine.usage ? await engine.usage.sessions() : [];
  const sessionsByRun = new Map<string, UsageSession[]>();
  for (const session of sessions) {
    if (!session.runId || !ids.has(session.runId)) continue;
    const values = sessionsByRun.get(session.runId) ?? [];
    values.push(session);
    sessionsByRun.set(session.runId, values);
  }
  const reports = new Map<string, UsageReport>();
  if (engine.usage) {
    const ledger = engine.usage;
    await Promise.all(
      [...ids]
        .filter(
          (id) =>
            knownRuns.has(id) ||
            sessionsByRun.has(id) ||
            jobs.some((job) => job.priorRunIds.includes(id) || (job.runId === id && job.runStatus)),
        )
        .map(async (id) => {
          reports.set(id, await ledger.report({ runId: id, limit: 500 }));
        }),
    );
  }
  const result = new Map<string, AutomationJobAccounting>();
  for (const job of jobs) {
    let usage = emptyUsage();
    let currentUsage = emptyUsage();
    let usageIncomplete = job.usageIncomplete ?? false;
    const jobReports: UsageReport[] = [];
    for (const id of new Set([...job.priorRunIds, job.runId])) {
      const run = runs.get(id);
      const report = reports.get(id);
      const runSessions = [...(sessionsByRun.get(id) ?? []), ...(report?.sessions ?? [])];
      const total = maximum(run?.usage ?? emptyUsage(), report?.total ?? emptyUsage());
      usage = addUsage(usage, total);
      if (id === job.runId) currentUsage = total;
      if (report) jobReports.push(report);
      const running = runSessions.some((session) => session.status === "running");
      const interrupted = runSessions.some((session) => session.status === "interrupted");
      const covered =
        id === job.runId &&
        options.reservedRunIds?.has(id) &&
        !!run &&
        ["running", "pausing"].includes(run.status);
      // An incomplete report is exempt only when in-flight usage is its sole
      // warning. Historical/custom usage, unknown prices and interrupted calls
      // remain uncertain even when another call is currently running.
      const onlyInFlight =
        running &&
        !interrupted &&
        report?.warnings.length === 1 &&
        report.total.unpricedRequests === 0 &&
        !Object.values(report.legacyExecution).some((value) => value > 0);
      usageIncomplete ||=
        total.unpricedRequests > 0 ||
        interrupted ||
        (running && !covered) ||
        (!!report?.incomplete && !(covered && onlyInFlight)) ||
        (!run && (id !== job.runId || !!job.runStatus));
    }
    // Never erase a durable job total if a run snapshot was removed or lagged.
    usage = maximum(usage, job.usage ?? emptyUsage());
    usageIncomplete ||= usage.unpricedRequests > 0;
    result.set(job.id, { usage, currentUsage, usageIncomplete, reports: jobReports });
  }
  return result;
}
