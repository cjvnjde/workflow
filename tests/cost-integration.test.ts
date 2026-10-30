import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkflowEngine } from "../src/core/engine.js";
import { agentSchema, budgetSchema, priceSchema } from "../src/contracts/domain.js";
import { emptyUsage } from "../src/core/execution/budget.js";
import { runAgentSession } from "../src/core/models/agent-session.js";
import { createAccountingContext, UsageStore } from "../src/core/storage/usage-store.js";
import { fixture } from "./helpers.js";

async function settledRun(engine: WorkflowEngine, id: string) {
  for (let i = 0; i < 1000; i++) {
    const run = engine.get(id);
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return run;
    await delay(10);
  }
  throw new Error(`Run did not settle: ${JSON.stringify(engine.get(id))}`);
}

test("a dynamic TypeScript AI estimate stays unknown without blocking a priced execution budget", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  library.config.agent = { ...library.config.agent, provider: "cost-fixture", model: "small" };
  library.config.budget = budgetSchema.parse({
    maxCostUsd: 1,
    prices: { "cost-fixture/small": { input: 1, output: 1 } },
  });
  let calls = 0;
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    calls++;
    assert.equal(execution.maxCostUsd, 1);
    await execution.onUsage?.({ ...emptyUsage(), requests: 1, inputTokens: 100, costUsd: 0.25 });
    return {
      outcome: "pass",
      summary: "Computed the requested value",
      artifacts: { data: JSON.stringify({ answer: 42 }) },
    };
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const draft = await engine.createProgram(
    "Dynamic AI cost",
    "Compute a value",
    {
      source: `import { workflow, block, step, z } from "workflow";
      export default workflow({ name: "Dynamic AI cost", flow: step("answer", block({
        async run(ctx) { return await ctx.ai({ prompt: "Compute a value", tools: "none", output: z.object({ answer: z.number() }) }); }
      })) });`,
    },
    library,
  );
  assert.equal(draft.estimate?.expectedCostUsd, null);
  assert.deepEqual(draft.estimate?.unpricedNodes, []);
  assert.ok(draft.estimate?.dynamicNodes?.includes("answer"));
  await engine.approve(draft.id, draft.revision);
  const run = await settledRun(engine, draft.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(calls, 1);
  assert.equal(run.usage?.costUsd, 0.25);
  assert.deepEqual(JSON.parse(run.artifacts.answer!.data!), { answer: 42 });
});

test("real model-session accounting follows the original project rather than its execution cwd", async (t) => {
  const { project } = await fixture(t);
  const workspace = path.join(project, "alternate-worktree");
  const home = path.join(project, "isolated-provider");
  await Promise.all([mkdir(workspace), mkdir(home)]);
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = {
        id: "cost-fixture-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "tiny",
        choices: [
          { index: 0, delta: { role: "assistant", content: "Completed." }, finish_reason: null },
        ],
      };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write(
        `data: ${JSON.stringify({
          ...chunk,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(
    path.join(home, "models.json"),
    JSON.stringify({
      providers: {
        "loopback-cost": {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "local-test-only",
          models: [
            {
              id: "tiny",
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const previous = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.WORKFLOW_HOME;
    else process.env.WORKFLOW_HOME = previous;
  });
  const taskId = crypto.randomUUID();
  const accounting = await createAccountingContext(project, "planning", {
    owner: { kind: "task", id: taskId },
    taskId,
    maxCostUsd: 0.01,
    operationId: "planning:fixture",
  });
  const sessionEvents: Record<string, unknown>[] = [];
  await runAgentSession({
    project: workspace,
    accounting,
    settings: agentSchema.parse({ provider: "loopback-cost", model: "tiny", thinking: "off" }),
    tools: [],
    systemPrompt: "Return one short sentence.",
    prompt: "Report completion.",
    signal: AbortSignal.timeout(10_000),
    emit: (kind, message) => {
      if (kind === "model_session" || kind === "model_session_end")
        sessionEvents.push(JSON.parse(message));
    },
  });
  const report = await new UsageStore(project).report({ taskId });
  assert.equal(report.sessionCount, 1);
  assert.equal(report.total.requests, 1);
  assert.equal(report.total.inputTokens, 100);
  assert.equal(report.total.outputTokens, 50);
  assert.ok(Math.abs(report.total.costUsd - 0.0002) < 1e-10);
  assert.equal(report.sessions[0]?.status, "completed");
  assert.equal(report.sessions[0]?.operationId, "planning:fixture");
  assert.equal(report.sessions[0]?.phase, "planning");
  assert.equal(report.sessions[0]?.taskId, taskId);
  assert.equal(report.sessions[0]?.pricing.source, "catalog");
  assert.equal(sessionEvents.length, 2);
  assert.ok(sessionEvents.every((event) => event.sessionId === report.sessions[0]?.id));
  assert.equal(report.incomplete, false);
  await assert.rejects(stat(path.join(workspace, ".workflow", "usage")), /ENOENT/);
});

test("ledger sessions and retained custom-runner usage aggregate once across reloads", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  library.config.agent = { ...library.config.agent, provider: "cost-fixture", model: "small" };
  let calls = 0;
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    const usage =
      ++calls === 1
        ? { ...emptyUsage(), requests: 1, inputTokens: 40, costUsd: 0.1 }
        : { ...emptyUsage(), requests: 1, inputTokens: 60, costUsd: 0.15 };
    await execution.onUsage?.(usage);
    return { outcome: "pass", summary: "Done", artifacts: { data: JSON.stringify(calls) } };
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const draft = await engine.createProgram(
    "Retained usage",
    "Combine two calls",
    {
      source: `import { workflow, block, step, z } from "workflow";
      export default workflow({ name: "Retained usage", flow: step("combine", block({ async run(ctx) {
        const first = await ctx.ai({ prompt: "First", tools: "none", output: z.number() });
        const second = await ctx.ai({ prompt: "Second", tools: "none", output: z.number() });
        return { first, second };
      }})) });`,
    },
    library,
  );
  await engine.approve(draft.id, draft.revision);
  const run = await settledRun(engine, draft.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.usage?.requests, 2);
  const store = new UsageStore(project);
  const scope = await store.ensureRun(run);
  const session = await store.beginSession(
    {
      project,
      scopeId: scope.id,
      phase: "execution",
      operationId: "retained-call",
      runId: run.id,
      nodeId: "combine",
      visit: 1,
    },
    {
      provider: "cost-fixture",
      model: "small",
      thinking: "off",
      pricing: { source: "override", rates: priceSchema.parse({ input: 2500, output: 0 }) },
    },
    AbortSignal.timeout(5000),
  );
  try {
    await session.update({ ...emptyUsage(), requests: 1, inputTokens: 40, costUsd: 0.1 });
    await session.finish("completed");
  } finally {
    session.release();
  }
  for (const filter of [{ runId: run.id }, {}]) {
    const report = await new UsageStore(project).report(filter);
    assert.equal(report.total.requests, 2);
    assert.equal(report.total.inputTokens, 100);
    assert.ok(Math.abs(report.total.costUsd - 0.25) < 1e-10);
    assert.equal(report.legacyExecution.requests, 1);
    assert.equal(report.legacyExecution.inputTokens, 60);
    assert.ok(Math.abs(report.legacyExecution.costUsd - 0.15) < 1e-10);
    assert.equal(report.sessionCount, 1);
    assert.equal(report.phases.find((phase) => phase.phase === "execution")?.usage.requests, 2);
  }
});

test("planning spending reduces execution allowance and reported overshoot blocks later calls", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  library.config.agent = { ...library.config.agent, provider: "cost-fixture", model: "small" };
  library.config.budget = budgetSchema.parse({
    maxTaskCostUsd: 1,
    prices: { "cost-fixture/small": { input: 1, output: 1 } },
  });
  const taskId = crypto.randomUUID();
  const store = new UsageStore(project);
  const scope = await store.ensureScope({
    owner: { kind: "task", id: taskId },
    taskId,
    maxCostUsd: 1,
  });
  const planning = await store.beginSession(
    { project, scopeId: scope.id, phase: "planning", taskId, operationId: "planner" },
    {
      provider: "cost-fixture",
      model: "planner",
      thinking: "off",
      pricing: { source: "override", rates: priceSchema.parse({ input: 10000, output: 0 }) },
    },
    AbortSignal.timeout(5000),
  );
  try {
    await planning.update({ ...emptyUsage(), inputTokens: 60, requests: 1, costUsd: 0.6 });
    await planning.finish("completed");
  } finally {
    planning.release();
  }
  const allowances: number[] = [];
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    assert.equal(execution.accounting?.project, project);
    assert.equal(execution.accounting?.taskId, taskId);
    allowances.push(execution.maxCostUsd!);
    await execution.onUsage?.({ ...emptyUsage(), inputTokens: 10, requests: 1, costUsd: 0.3 });
    return { outcome: "pass", summary: "One result", artifacts: { data: "1" } };
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const draft = await engine.createProgram(
    "Shared task cap",
    "Reuse the remaining planning allowance",
    {
      source: `import { workflow, block, step, z } from "workflow";
      export default workflow({ name: "Shared task cap", flow: step("work", block({ async run(ctx) {
        const values: unknown[] = [];
        for (let i = 0; i < 3; i++) values.push(await ctx.ai({ prompt: "One value", tools: "none", output: z.number() }));
        return values;
      }})) });`,
    },
    library,
    undefined,
    undefined,
    { scopeId: scope.id, taskId },
  );
  await engine.approve(draft.id, draft.revision);
  const run = await settledRun(engine, draft.id);
  assert.equal(run.status, "interrupted");
  assert.match(run.error!, /spending limit reached/i);
  assert.equal(
    allowances.length,
    2,
    "No third model call may start after the reported total exceeds the cap",
  );
  assert.ok(Math.abs(allowances[0]! - 0.4) < 1e-10);
  assert.ok(Math.abs(allowances[1]! - 0.1) < 1e-10);
  const report = await new UsageStore(project).report({ runId: run.id });
  assert.equal(report.scope.kind, "task");
  assert.equal(report.scope.id, taskId);
  assert.ok(
    Math.abs(report.total.costUsd - 1.2) < 1e-10,
    "Reported spend must not be clamped to the configured cap",
  );
  assert.equal(report.total.requests, 3);
  assert.equal(report.limits.totalCostUsd, 1);
});
