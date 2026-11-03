import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { automationExecutionSchema } from "../src/contracts/automation-schema.js";
import { agentSchema, budgetSchema } from "../src/contracts/domain.js";
import { WorkflowEngine } from "../src/core/engine.js";
import { runPiBlock } from "../src/core/execution/block-runner.js";
import { runAgentSession } from "../src/core/models/agent-session.js";
import { UsageStore } from "../src/core/storage/usage-store.js";
import { automationBoundary } from "../src/infrastructure/automation-boundary.js";
import { fixture } from "./helpers.js";

const cap = 0.104;
const billedCost = 0.066;
const scenarios = [
  { name: "explicit automation cap", executionCap: cap, savedBudget: undefined },
  {
    name: "tighter saved run cap",
    executionCap: 0.3,
    savedBudget: { maxCostUsd: cap, maxTaskCostUsd: 0.2 },
  },
  {
    name: "inherited run cap without an automation override",
    executionCap: undefined,
    savedBudget: { maxCostUsd: cap, maxTaskCostUsd: 0.2 },
  },
  {
    name: "tighter saved total cap",
    executionCap: 0.3,
    savedBudget: { maxCostUsd: 0.2, maxTaskCostUsd: cap },
  },
  {
    name: "one-hour cache cost ceiling",
    executionCap: 0.08,
    savedBudget: undefined,
    rejectBeforeRequest: true,
    api: "anthropic-messages",
  },
];

for (const scenario of scenarios) {
  test(`concurrent model sessions enforce the ${scenario.name}`, async (t) => {
    const { project, library, cleanup } = await fixture(t);
    let requests = 0;
    let started = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        await request.json();
        assert.equal(started, 2, "Both sessions must compete for the initial allowance");
        const turn = ++requests;
        const item = {
          type: "message",
          id: `msg_${turn}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Finished.", annotations: [] }],
        };
        const response = {
          id: `resp_${turn}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 30000, output_tokens: 1800, total_tokens: 31800 },
        };
        const events = [
          { type: "response.created", response: { id: response.id, status: "in_progress" } },
          { type: "response.output_item.added", output_index: 0, item },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    cleanup(async () => {
      server.stop(true);
    });
    const home = path.join(project, "budget-provider");
    await mkdir(home);
    await writeFile(
      path.join(home, "models.json"),
      JSON.stringify({
        providers: {
          "automation-budget-fixture": {
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            api: scenario.api ?? "openai-responses",
            apiKey: "local-fixture-only",
            models: [
              {
                id: "bounded",
                contextWindow: 32000,
                maxTokens: 2000,
                cost: { input: 1, output: 20, cacheRead: 0, cacheWrite: 0 },
                compat: scenario.api ? { supportsLongCacheRetention: true } : undefined,
              },
            ],
          },
        },
      }),
    );
    const previous = process.env.WORKFLOW_HOME;
    const previousCacheRetention = process.env.PI_CACHE_RETENTION;
    cleanup(async () => {
      if (previous === undefined) delete process.env.WORKFLOW_HOME;
      else process.env.WORKFLOW_HOME = previous;
      if (previousCacheRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previousCacheRetention;
    });
    library.config.agent = agentSchema.parse({
      provider: "automation-budget-fixture",
      model: "bounded",
      thinking: "off",
    });
    library.config.budget = scenario.savedBudget
      ? budgetSchema.parse(scenario.savedBudget)
      : undefined;
    const engine = new WorkflowEngine(project, "live", runPiBlock);
    cleanup(() => engine.shutdown());
    await engine.initialize();
    process.env.WORKFLOW_HOME = home;
    process.env.PI_CACHE_RETENTION = scenario.api ? "long" : "short";
    const draft = await engine.createProgram(
      "Shared automation allowance",
      "Keep concurrent model spending within the saved limits",
      {
        source: `import { workflow, block, step } from "workflow";
          export default workflow({ name: "Shared automation allowance", flow: step("work", block({
            async run(ctx) { return await ctx.ai({ prompt: "Finish.", tools: "none" }); }
          })) });`,
      },
      library,
    );
    const savedBudget = structuredClone(draft.config.budget);
    const execution = automationExecutionSchema.parse({
      workspace: "project",
      maxCostUsd: scenario.executionCap,
    });
    const template = await engine.snapshotForAutomation(
      { kind: "workflow", runId: draft.id },
      execution,
    );
    const run = await engine.createAutomatedRun(
      template,
      crypto.randomUUID(),
      {},
      {
        automationId: crypto.randomUUID(),
        jobId: crypto.randomUUID(),
        workspace: execution.workspace,
        baseRef: execution.baseRef,
        execution,
      },
    );
    assert.deepEqual(engine.get(draft.id).config.budget, savedBudget);
    assert.equal(run.executionVersion, draft.executionVersion);
    const store = new UsageStore(project);
    const scope = await store.ensureRun(run);

    // Test the shared ledger API directly, not structured-branch reachability:
    // structured steps have a budget queue, and code blocks reject overlapping
    // ctx.ai effects. Neither guard should mask competing Pi sessions here.
    const outcomes = await automationBoundary.run(
      { environment: execution.environment, consume: async () => {} },
      () =>
        Promise.allSettled(
          ["first", "second"].map((operationId) => {
            started++;
            return runAgentSession({
              project,
              settings: run.config.agent,
              systemPrompt: "Return one short result.",
              prompt: "Finish the bounded local fixture.",
              tools: [],
              signal: AbortSignal.timeout(20_000),
              emit: () => {},
              maxCostUsd: run.config.budget?.maxCostUsd,
              accounting: {
                project,
                phase: "execution",
                scopeId: scope.id,
                runId: run.id,
                operationId,
              },
            });
          }),
        ),
    );
    const affordable = !scenario.rejectBeforeRequest;
    assert.equal(requests, affordable ? 1 : 0);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status).sort(),
      affordable ? ["fulfilled", "rejected"] : ["rejected", "rejected"],
    );
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.match(String(rejected.reason), /Automation spending limit cannot reserve/);
    const report = await store.report({ scopeId: scope.id });
    assert.equal(report.sessionCount, 2);
    assert.deepEqual(
      report.sessions.map((session) => session.status).sort(),
      affordable ? ["completed", "failed"] : ["failed", "failed"],
    );
    assert.ok(Math.abs(report.total.costUsd - (affordable ? billedCost : 0)) < 1e-10);
    assert.ok(report.total.costUsd <= cap, "Recorded spend must respect the tightest saved cap");
    assert.equal(report.total.unpricedRequests, 0);
    assert.equal(report.sessions.find((session) => session.status === "failed")?.usage.costUsd, 0);
  });
}
