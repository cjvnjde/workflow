import assert from "node:assert/strict";
import test from "node:test";
import { addUsage, emptyUsage, estimateBudget } from "../src/core/execution/budget.js";
import { budgetSchema } from "../src/contracts/domain.js";
import { createTemplate } from "../src/core/library/templates.js";
import { fixture } from "./helpers.js";

test("budget estimates combine prices, model overrides and iteration limits", async (t) => {
  const { library } = await fixture(t);
  library.config.agent.provider = "test";
  library.config.agent.model = "cheap";
  library.config.agent.maxToolCalls = 2;
  library.config.budget = budgetSchema.parse({
    inputTokensPerCall: 1000,
    outputTokensPerCall: 100,
    callsPerVisit: 2,
    prices: { "test/cheap": { input: 1, output: 2 }, "test/expensive": { input: 5, output: 10 } },
  });
  library.config.maxSteps = 4;
  const plan = createTemplate("Fix", "bug", library);
  plan.nodes[1]!.agent = { model: "expensive" };
  const estimate = estimateBudget(plan, library);
  assert.equal(estimate.expectedVisits, 3);
  assert.equal(estimate.maxVisits, 4);
  assert.ok(Math.abs(estimate.expectedCostUsd! - 0.0168) < 1e-10);
  assert.ok(Math.abs(estimate.worstCaseCostUsd! - (3 * 0.054 + 0.0108)) < 1e-10);
  assert.deepEqual(estimate.unpricedNodes, []);
});

test("unknown prices remain unknown and demo never estimates model spending", async (t) => {
  const { library } = await fixture(t);
  const plan = createTemplate("Fix", "bug", library);
  assert.equal(estimateBudget(plan, library).expectedCostUsd, null);
  assert.equal(estimateBudget(plan, library).worstCaseCostUsd, null);
  assert.equal(estimateBudget(plan, library, "demo").worstCaseCostUsd, 0);
});

test("usage aggregation retains costs from failed requests without double-counting reasoning", () => {
  const usage = addUsage(emptyUsage(), {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    costUsd: 0.3,
    requests: 1,
    unpricedRequests: 0,
  });
  assert.equal(addUsage(usage, usage).costUsd, 0.6);
  assert.equal(addUsage(usage, usage).outputTokens, 100);
});

test("pricing includes context tiers, cached input, and long-retention cache writes", async () => {
  const { priceUsage } = await import("../src/core/execution/budget.js");
  const { priceSchema } = await import("../src/contracts/domain.js");
  const price = priceSchema.parse({
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    tiers: [{ inputTokensAbove: 1000, input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3.75 }],
  });
  const cost = priceUsage(price, 1000, 100, 500, 100, 50);
  assert.ok(Math.abs(cost - (3000 + 600 + 150 + 50 * 3.75 + 50 * 6) / 1_000_000) < 1e-12);
});
