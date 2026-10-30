import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { emptyUsage } from "../src/budget.js";
import { WorkflowEngine } from "../src/engine.js";
import { Tasks } from "../src/tasks.js";
import { UsageStore } from "../src/usage-store.js";
import { fixture, passingRunner } from "./helpers.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); }
  throw new Error("Planning state transition timed out");
}

test("task clarification and retry reuse the original total budget and retain earlier planning cost", async t => {
  const { project, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  const accountingIds: string[] = [];
  const tasks = new Tasks(engine, async () => ({ models: [], warnings: [] }), async options => {
    assert.ok(options.accounting);
    accountingIds.push(options.accounting.scopeId);
    const session = await new UsageStore(project).beginSession(options.accounting, {
      provider: "test", model: "small", thinking: "off", pricing: { source: "catalog", rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    }, options.signal);
    await session.update({ ...emptyUsage(), inputTokens: 100, requests: 1, costUsd: 0.06 });
    await session.finish("completed"); session.release();
    return { kind: "question", question: { question: "Which behavior?", options: [] } };
  });
  await tasks.initialize(); cleanup(() => tasks.close());
  const task = await tasks.create({ prompt: "Clarify the change", maxTaskCostUsd: 0.1 });
  await until(() => tasks.get(task.id).status === "needs_input");
  await tasks.answer(task.id, { answer: "Preserve it", revision: tasks.get(task.id).revision });
  await until(() => tasks.get(task.id).status === "needs_input");
  await tasks.answer(task.id, { answer: "Use the existing behavior", revision: tasks.get(task.id).revision });
  await until(() => tasks.get(task.id).status === "failed");
  assert.match(tasks.get(task.id).error!, /Total spending limit reached/);
  await tasks.retry(task.id);
  await until(() => tasks.get(task.id).status === "failed");
  assert.equal(new Set(accountingIds).size, 1);
  assert.equal(accountingIds.length, 4);
  const report = await new UsageStore(project).report({ taskId: task.id });
  assert.equal(report.total.costUsd, 0.12);
  assert.equal(report.sessionCount, 2);
  assert.equal(report.limits.totalCostUsd, 0.1);
  assert.equal(report.limits.remainingCostUsd, 0);
});
