import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import type { UsageTotals, WorkflowRun } from "../src/contracts/domain.js";
import {
  usageReportSchema,
  usageSessionSchema,
  type UsageReport,
  type UsageSession,
} from "../src/contracts/usage-schema.js";
import {
  readAutomationAccounting,
  type AutomationAccountingEngine,
} from "../src/core/automations/accounting.js";
import { emptyUsage } from "../src/core/execution/budget.js";
import { createAccountingContext, UsageStore } from "../src/core/storage/usage-store.js";
import { fixture } from "./helpers.js";

const spent = (costUsd: number, requests = 1): UsageTotals => ({
  ...emptyUsage(),
  costUsd,
  requests,
});
const run = (id: string, costUsd: number, status: WorkflowRun["status"] = "running") => ({
  id,
  status,
  usage: spent(costUsd),
});
const job = (runId: string, priorRunIds: string[] = []) => ({
  id: randomUUID(),
  runId,
  priorRunIds,
  usage: emptyUsage(),
});
const model = {
  provider: "fixture",
  model: "small",
  thinking: "off",
  pricing: {
    source: "catalog" as const,
    rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  },
};
const session = (runId: string, status: UsageSession["status"], usage = emptyUsage()) =>
  usageSessionSchema.parse({
    id: randomUUID(),
    scopeId: runId,
    runId,
    phase: "execution",
    operationId: "execution:call",
    ...model,
    usage,
    status,
    startedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
const report = (
  total: UsageTotals,
  sessions: UsageSession[] = [],
  overrides: Partial<UsageReport> = {},
) =>
  usageReportSchema.parse({
    scope: { kind: "project" },
    total,
    phases: [],
    models: [],
    sessions,
    sessionCount: sessions.length,
    sessionsTruncated: false,
    legacyExecution: emptyUsage(),
    limits: { remainingCostUsd: null },
    incomplete: false,
    warnings: [],
    ...overrides,
  });
function executor(
  runs: Pick<WorkflowRun, "id" | "status" | "usage">[],
  reports?: Map<string, UsageReport>,
  sessions: UsageSession[] = [],
): AutomationAccountingEngine {
  return {
    list: (includeDeleted) => {
      assert.equal(includeDeleted, true, "History visibility must not hide accounting evidence");
      return runs;
    },
    get: (id) => {
      const value = runs.find((candidate) => candidate.id === id);
      assert.ok(value, "Unexpected missing execution snapshot");
      return value;
    },
    usage: reports
      ? {
          sessions: async () => sessions,
          report: async ({ runId } = {}) => {
            const value = reports.get(runId!);
            assert.ok(value, "Unexpected missing ledger report");
            return value;
          },
        }
      : undefined,
  };
}

test("live spending and remaining reservations use the same snapshot, without double counting the ledger", async () => {
  const id = randomUUID();
  const candidate = job(id);
  const ledger = report(spent(0.4));
  const snapshot = (
    await readAutomationAccounting(executor([run(id, 0.5)], new Map([[id, ledger]])), [candidate])
  ).get(candidate.id)!;
  assert.equal(snapshot.usage.costUsd, 0.5);
  assert.equal(snapshot.currentUsage.costUsd, 0.5);
  const remainingReservation = Math.max(0, 0.6 - snapshot.currentUsage.costUsd);
  assert.ok(
    snapshot.usage.costUsd + remainingReservation + 0.6 > 1,
    "A second $0.60 run must not fit under a $1 aggregate cap",
  );
  assert.equal(
    candidate.usage.costUsd,
    0,
    "Reading accounting does not mutate scheduler persistence",
  );
});

test("prior attempts remain spent while only current usage reduces the new attempt reservation", async () => {
  const oldId = randomUUID(),
    currentId = randomUUID();
  const candidate = job(currentId, [oldId]);
  const engine = executor(
    [run(oldId, 0.4, "failed"), run(currentId, 0.1)],
    new Map([
      [oldId, report(spent(0.5))],
      [currentId, report(spent(0.2))],
    ]),
  );
  const snapshot = (await readAutomationAccounting(engine, [candidate])).get(candidate.id)!;
  assert.equal(snapshot.usage.costUsd, 0.7);
  assert.equal(snapshot.currentUsage.costUsd, 0.2);
  assert.ok(
    Math.abs(snapshot.usage.costUsd + Math.max(0, 0.6 - snapshot.currentUsage.costUsd) - 1.1) <
      1e-9,
  );
});

test("fully reserved running sessions do not block other fully reserved work", async () => {
  const id = randomUUID(),
    candidate = job(id);
  const running = session(id, "running", spent(0.1));
  const ledger = report(running.usage, [running], {
    incomplete: true,
    warnings: ["Model requests are still in flight; their final usage may not be reported yet."],
  });
  const engine = executor([run(id, 0.1)], new Map([[id, ledger]]), [running]);
  const reserved = (
    await readAutomationAccounting(engine, [candidate], { reservedRunIds: new Set([id]) })
  ).get(candidate.id)!;
  assert.equal(reserved.usageIncomplete, false);
  assert.equal(
    (await readAutomationAccounting(engine, [candidate])).get(candidate.id)!.usageIncomplete,
    true,
    "Without a reservation the missing in-flight cost is not free",
  );
});

test("a reservation cannot excuse historical, unpriced, or interrupted usage", async () => {
  const id = randomUUID(),
    candidate = job(id);
  const running = session(id, "running");
  for (const ledger of [
    report(emptyUsage(), [running], {
      incomplete: true,
      warnings: ["In flight", "Historical planning costs may be unavailable"],
    }),
    report({ ...emptyUsage(), unpricedRequests: 1 }, [running], {
      incomplete: true,
      warnings: ["In flight", "Unknown pricing"],
    }),
    report(emptyUsage(), [running, session(id, "interrupted")], {
      incomplete: true,
      warnings: ["In flight", "Interrupted"],
    }),
  ]) {
    const engine = executor([run(id, 0)], new Map([[id, ledger]]), ledger.sessions);
    assert.equal(
      (await readAutomationAccounting(engine, [candidate], { reservedRunIds: new Set([id]) })).get(
        candidate.id,
      )!.usageIncomplete,
      true,
    );
  }
});

test("truncated reports cannot hide older interrupted sessions with zero reported charges", async () => {
  const id = randomUUID(),
    candidate = job(id);
  const interrupted = session(id, "interrupted");
  const ledger = report(emptyUsage(), [session(id, "completed")], {
    incomplete: true,
    warnings: ["Interrupted"],
    sessionCount: 501,
    sessionsTruncated: true,
  });
  const engine = executor([run(id, 0, "cancelled")], new Map([[id, ledger]]), [interrupted]);
  const snapshot = (await readAutomationAccounting(engine, [candidate])).get(candidate.id)!;
  assert.equal(snapshot.usage.unpricedRequests, 0);
  assert.equal(snapshot.usage.costUsd, 0);
  assert.equal(snapshot.usageIncomplete, true);
});

test("cancelling or retrying a still-running session retains accounting uncertainty", async () => {
  const oldId = randomUUID(),
    nextId = randomUUID();
  const running = session(oldId, "running");
  const ledger = report(emptyUsage(), [running], { incomplete: true, warnings: ["In flight"] });
  const engine = executor(
    [run(oldId, 0, "cancelled"), run(nextId, 0)],
    new Map([
      [oldId, ledger],
      [nextId, report(emptyUsage())],
    ]),
    [running],
  );
  const cancelled = job(oldId),
    retried = job(nextId, [oldId]);
  const snapshots = await readAutomationAccounting(engine, [cancelled, retried], {
    reservedRunIds: new Set([oldId, nextId]),
  });
  assert.equal(snapshots.get(cancelled.id)!.usageIncomplete, true);
  assert.equal(snapshots.get(retried.id)!.usageIncomplete, true);
});

test("persisted totals and uncertainty survive missing retained attempts and test-only executors", async () => {
  const candidate = {
    ...job(randomUUID(), [randomUUID()]),
    usage: spent(0.8),
    usageIncomplete: true,
  };
  const snapshot = (await readAutomationAccounting(executor([]), [candidate])).get(candidate.id)!;
  assert.equal(snapshot.usage.costUsd, 0.8);
  assert.equal(snapshot.usageIncomplete, true);
  assert.equal(snapshot.currentUsage.costUsd, 0);
  const pending = job(randomUUID());
  assert.equal(
    (await readAutomationAccounting(executor([]), [pending])).get(pending.id)!.usageIncomplete,
    false,
  );
});

test("reports preserve authoritative model details and reads are cached only within one snapshot", async () => {
  const id = randomUUID(),
    first = job(id),
    second = job(id);
  const completed = session(id, "completed", spent(0.7));
  const ledger = report(completed.usage, [completed], {
    models: [
      { provider: model.provider, model: model.model, usage: completed.usage, sessionCount: 1 },
    ],
  });
  const engine = executor([run(id, 0.2)], new Map([[id, ledger]]), [completed]);
  let reportReads = 0,
    sessionReads = 0;
  engine.usage = {
    report: async () => {
      reportReads++;
      return ledger;
    },
    sessions: async () => {
      sessionReads++;
      return [completed];
    },
  };
  const snapshots = await readAutomationAccounting(engine, [first, second]);
  assert.equal(reportReads, 1);
  assert.equal(sessionReads, 1);
  assert.equal(snapshots.get(first.id)!.reports[0], ledger);
  assert.equal(snapshots.get(first.id)!.reports[0]!.models[0]!.usage.costUsd, 0.7);
  assert.deepEqual(snapshots.get(first.id)!.reports[0]!.sessions[0]!.pricing, model.pricing);
  await readAutomationAccounting(engine, [first]);
  assert.equal(reportReads, 2, "Do not reuse stale spending between admissions");
  assert.equal(sessionReads, 2);
});

test("real ledger failures are propagated instead of treating unreadable accounting as free", async () => {
  const id = randomUUID(),
    candidate = job(id);
  const engine = executor([run(id, 0)]);
  engine.usage = {
    sessions: async () => {
      throw new Error("Unreadable usage sessions");
    },
    report: async () => report(emptyUsage()),
  };
  await assert.rejects(readAutomationAccounting(engine, [candidate]), /Unreadable usage sessions/);
  engine.usage = {
    sessions: async () => [],
    report: async () => {
      throw new Error("Unreadable usage report");
    },
  };
  await assert.rejects(readAutomationAccounting(engine, [candidate]), /Unreadable usage report/);
});

test("the real usage ledger classifies orphaned zero-usage sessions as uncertain", async (t) => {
  const { project } = await fixture(t);
  const id = randomUUID(),
    candidate = job(id);
  const context = await createAccountingContext(project, "execution", {
    owner: { kind: "run", id },
    runId: id,
    operationId: "orphaned-model-call",
  });
  const store = new UsageStore(project);
  const orphan = { ...session(id, "running"), scopeId: context.scopeId, pid: 2_147_483_647 };
  await writeFile(
    path.join(store.directory, "sessions", `${orphan.id}.json`),
    JSON.stringify(orphan),
  );
  const engine = executor([run(id, 0, "cancelled")]);
  engine.usage = store;
  const snapshot = (await readAutomationAccounting(engine, [candidate])).get(candidate.id)!;
  assert.equal(snapshot.usage.costUsd, 0);
  assert.equal(snapshot.usage.unpricedRequests, 0);
  assert.equal(snapshot.usageIncomplete, true);
  assert.equal(snapshot.reports[0]!.sessions[0]!.status, "interrupted");
});
