import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { emptyUsage } from "../src/budget.js";
import { createAccountingContext, UsageStore } from "../src/usage-store.js";
import { runSchema } from "../src/domain.js";
import { createTemplate } from "../src/templates.js";
import { RunStore } from "../src/run-store.js";
import { fixture } from "./helpers.js";

const model = { provider: "fixture", model: "small", thinking: "off", pricing: { source: "catalog" as const, rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } };
const spent = (costUsd: number, requests = 1) => ({ ...emptyUsage(), inputTokens: requests * 100, outputTokens: requests * 20, costUsd, requests });
const signal = () => AbortSignal.timeout(5000);

test("cumulative session snapshots replace previous usage and preserve failed attempts after reload", async t => {
  const { project } = await fixture(t);
  const taskId = randomUUID();
  const context = await createAccountingContext(project, "planning", { owner: { kind: "task", id: taskId }, taskId, operationId: "plan:initial" });
  const store = new UsageStore(project);
  const first = await store.beginSession(context, model, signal());
  await first.update(spent(0.1));
  await first.update(spent(0.1));
  await first.update(spent(0.3, 2));
  await assert.rejects(first.update(spent(0.1)), /cannot decrease/);
  await first.finish("failed", "Provider failed after reported usage"); first.release();
  const retry = await store.beginSession({ ...context, operationId: "plan:retry" }, model, signal());
  await retry.update(spent(0.2)); await retry.finish("completed"); retry.release();
  const report = await new UsageStore(project).report({ taskId });
  assert.equal(report.total.costUsd, 0.5);
  assert.equal(report.total.requests, 3);
  assert.equal(report.total.inputTokens, 300);
  assert.equal(report.sessionCount, 2);
  assert.equal(report.phases[0]?.phase, "planning");
  assert.equal(report.models[0]?.usage.costUsd, 0.5);
  assert.equal(report.sessions.find(session => session.id === first.id)?.status, "failed");
  assert.equal(report.incomplete, false);
});

test("a shared cap serializes model admission, retains overshoot, and stops a queued later phase", async t => {
  const { project } = await fixture(t);
  const context = await createAccountingContext(project, "planning", { maxCostUsd: 0.1 });
  const store = new UsageStore(project);
  const first = await store.beginSession(context, model, signal());
  let admitted = false;
  const second = store.beginSession({ ...context, phase: "execution", operationId: "execution:later" }, model, signal()).then(value => { admitted = true; return value; });
  // Attach rejection immediately while the second call waits for the first.
  const rejected = assert.rejects(second, /Total spending limit reached/);
  await first.update(spent(0.12));
  assert.equal(admitted, false);
  await first.finish("completed"); first.release();
  await rejected;
  const report = await store.report({ scopeId: context.scopeId });
  assert.equal(report.total.costUsd, 0.12, "Actual cost must never be clamped to the limit");
  assert.equal(report.limits.remainingCostUsd, 0);
  assert.equal(report.sessionCount, 1);
});

test("unknown prices stay visible and are rejected before starting a capped session", async t => {
  const { project } = await fixture(t);
  const store = new UsageStore(project);
  const unknown = { ...model, pricing: { source: "unknown" as const, rates: null } };
  const unlimited = await createAccountingContext(project, "design");
  const session = await store.beginSession(unlimited, unknown, signal());
  await session.update({ ...spent(0), unpricedRequests: 1 });
  await session.finish("completed"); session.release();
  const report = await store.report();
  assert.equal(report.incomplete, true);
  assert.match(report.warnings.join(" "), /unknown pricing/);
  const capped = await createAccountingContext(project, "setup", { maxCostUsd: 1 });
  await assert.rejects(store.beginSession(capped, unknown, signal()), /without model pricing/);
  assert.equal((await store.report({ scopeId: capped.scopeId })).sessionCount, 0);
});

test("cancelling a queued budgeted session releases its place for subsequent work", async t => {
  const { project } = await fixture(t);
  const store = new UsageStore(project);
  const context = await createAccountingContext(project, "setup", { maxCostUsd: 1 });
  const first = await store.beginSession(context, model, signal());
  const controller = new AbortController();
  const queued = store.beginSession(context, model, controller.signal);
  const rejected = assert.rejects(queued, /Stopped waiting/);
  controller.abort(new Error("Stopped waiting"));
  await rejected;
  await first.finish("completed"); first.release();
  const later = await store.beginSession(context, model, signal());
  await later.finish("completed"); later.release();
  assert.equal((await store.report()).sessionCount, 2);
});

test("scoped reports and admission ignore unrelated large or malformed run snapshots", async t => {
  const { project } = await fixture(t);
  const store = new UsageStore(project);
  const context = await createAccountingContext(project, "planning", { maxCostUsd: 1 });
  const unrelated = path.join(project, ".workflow/runs", randomUUID());
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, "run.json"), "unrelated malformed snapshot");
  assert.equal((await store.report({ scopeId: context.scopeId })).total.costUsd, 0);
  const session = await store.beginSession(context, model, signal());
  await session.finish("completed"); session.release();
});

test("a ledger-only new attempt cannot erase older custom-runner spending from a different node", async t => {
  const { project, library } = await fixture(t);
  const runId = randomUUID(), now = new Date().toISOString();
  const run = runSchema.parse({ id: runId, createdAt: now, updatedAt: now, mode: "live", status: "failed",
    plan: createTemplate("Recover costs", "bug", library), config: library.config, blocks: library.blocks,
    cursor: "implementation", visits: {}, artifacts: {}, usage: spent(5),
    attempts: [{ nodeId: "legacy", visit: 1, startedAt: now, usage: spent(5) }],
  });
  await new RunStore(path.join(project, ".workflow/runs")).save(run);
  const store = new UsageStore(project);
  const scope = await store.ensureRun(run);
  const accounting = await createAccountingContext(project, "execution", { scopeId: scope.id, runId, nodeId: "new-call", visit: 1 });
  const session = await store.beginSession(accounting, model, signal());
  await session.update(spent(10)); await session.finish("failed", "Interrupted before compatibility write"); session.release();
  const report = await store.report({ runId });
  assert.equal(report.total.costUsd, 15);
  assert.equal(report.total.requests, 2);
  assert.equal(report.legacyExecution.costUsd, 5);
  assert.equal(report.incomplete, true, "Legacy planning coverage is unavailable");
});
