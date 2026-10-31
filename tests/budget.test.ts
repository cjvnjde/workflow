import assert from "node:assert/strict";
import { test } from "vitest";
import { addUsage, emptyUsage, estimateBudget, priceUsage } from "../src/core/execution/budget.js";
import { budgetSchema, priceSchema } from "../src/contracts/domain.js";
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
  assert.equal(estimate.dynamicNodes, undefined);
  assert.match(estimate.assumptions, /1000 input \+ 100 output tokens\/call/);
});

test("unknown prices remain unknown and demo never estimates model spending", async (t) => {
  const { library } = await fixture(t);
  const plan = createTemplate("Fix", "bug", library);
  assert.equal(estimateBudget(plan, library).expectedCostUsd, null);
  assert.equal(estimateBudget(plan, library).worstCaseCostUsd, null);
  assert.deepEqual(estimateBudget(plan, library).unpricedNodes, ["prepare", "work", "review"]);
  const demoEstimate = estimateBudget(plan, library, "demo");
  assert.equal(demoEstimate.expectedCostUsd, 0);
  assert.equal(demoEstimate.worstCaseCostUsd, 0);
  assert.deepEqual(demoEstimate.unpricedNodes, []);
  assert.equal(demoEstimate.dynamicNodes, undefined);
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

test("pricing aggregates cached input, uses the highest matching tier, and keeps the threshold strict", () => {
  const price = priceSchema.parse({
    input: 1,
    output: 1,
    tiers: [
      { inputTokensAbove: 1000, input: 2, output: 3 },
      { inputTokensAbove: 2000, input: 4, output: 5 },
    ],
  });

  // Include cache writes in the context size and select the highest matching tier.
  assert.equal(priceUsage(price, 1900, 0, 0, 200), 0.0076);
  // Exactly at the lower threshold still uses base pricing.
  assert.equal(priceUsage(price, 900, 0, 0, 100), 0.0009);
  // Crossing the threshold through cache writes selects the tier.
  assert.equal(priceUsage(price, 900, 0, 0, 101), 0.0018);
});

test("expected visits stop at both the node visit cap and the workflow step cap", async (t) => {
  const { library } = await fixture(t);
  library.config.agent.provider = "test";
  library.config.agent.model = "known";
  library.config.budget = budgetSchema.parse({
    inputTokensPerCall: 100,
    outputTokensPerCall: 1,
    callsPerVisit: 1,
    prices: { "test/known": { input: 10, output: 0 } },
  });

  const plan = createTemplate("Repeat", "bug", library);
  const node = plan.nodes[0]!;
  plan.nodes = [node];
  plan.entry = node.id;
  node.on.pass = node.id;
  node.maxVisits = 2;
  library.config.maxSteps = 5;

  const visitLimited = estimateBudget(plan, library);
  assert.equal(visitLimited.expectedVisits, 2);
  assert.equal(visitLimited.expectedCostUsd, 0.002);

  node.maxVisits = 5;
  library.config.maxSteps = 2;
  const stepLimited = estimateBudget(plan, library);
  assert.equal(stepLimited.expectedVisits, 2);
  assert.equal(stepLimited.expectedCostUsd, 0.002);
});

test("dynamic code costs stay unknown in live mode and disappear in demo mode", async (t) => {
  const { library } = await fixture(t);
  library.config.agent.provider = "test";
  library.config.agent.model = "known";
  library.config.budget = budgetSchema.parse({
    inputTokensPerCall: 100,
    outputTokensPerCall: 1,
    callsPerVisit: 1,
    prices: { "test/known": { input: 10, output: 0 } },
  });

  const plan = createTemplate("Dynamic cost", "bug", library);
  const [dynamicNode, pricedNode] = plan.nodes;
  assert.ok(dynamicNode && pricedNode);
  plan.nodes = [dynamicNode, pricedNode];
  plan.entry = dynamicNode.id;
  dynamicNode.on.pass = pricedNode.id;
  pricedNode.on.pass = "$complete";
  for (const node of plan.nodes) node.maxVisits = 1;
  library.blocks[dynamicNode.block]!.definition.executor = {
    kind: "code",
    source: 'export default async function run() { return "done"; }',
    timeoutMs: 600_000,
    maxOperations: 100,
  };

  const liveEstimate = estimateBudget(plan, library);
  assert.equal(liveEstimate.expectedCostUsd, null);
  assert.equal(liveEstimate.worstCaseCostUsd, null);
  assert.deepEqual(liveEstimate.dynamicNodes, [dynamicNode.id]);
  assert.deepEqual(liveEstimate.unpricedNodes, []);

  const demoEstimate = estimateBudget(plan, library, "demo");
  assert.equal(demoEstimate.expectedCostUsd, 0);
  assert.equal(demoEstimate.worstCaseCostUsd, 0);
  assert.equal(demoEstimate.dynamicNodes, undefined);
  assert.deepEqual(demoEstimate.unpricedNodes, []);

  plan.nodes = [dynamicNode];
  dynamicNode.on.pass = "$complete";
  library.blocks[dynamicNode.block]!.definition.executor = {
    kind: "command",
    command: "verify",
    expect: "success",
  };
  const commandEstimate = estimateBudget(plan, library);
  assert.equal(commandEstimate.expectedCostUsd, 0);
  assert.equal(commandEstimate.worstCaseCostUsd, 0);
  assert.deepEqual(commandEstimate.unpricedNodes, []);
  assert.equal(commandEstimate.dynamicNodes, undefined);
});

test("missing block definitions retain project pricing and node overrides, including unknown prices", async (t) => {
  const { library } = await fixture(t);
  library.config.agent.provider = "test";
  library.config.agent.model = "cheap";
  library.config.agent.maxToolCalls = 2;
  library.config.maxSteps = 1;
  library.config.budget = budgetSchema.parse({
    inputTokensPerCall: 1000,
    outputTokensPerCall: 100,
    callsPerVisit: 2,
    prices: { "test/cheap": { input: 1, output: 2 }, "test/expensive": { input: 5, output: 10 } },
  });
  const plan = createTemplate("Missing block", "bug", library);
  const node = plan.nodes[0]!;
  plan.nodes = [node];
  node.on.pass = "$complete";
  node.maxVisits = 1;
  delete library.blocks[node.block];

  const inherited = estimateBudget(plan, library);
  assert.ok(Math.abs(inherited.expectedCostUsd! - 0.0024) < 1e-12);
  assert.ok(Math.abs(inherited.worstCaseCostUsd! - 0.0108) < 1e-12);
  assert.equal(inherited.expectedVisits, 1);
  assert.equal(inherited.maxVisits, 1);
  assert.deepEqual(inherited.unpricedNodes, []);
  assert.equal(inherited.dynamicNodes, undefined);

  node.agent = { model: "expensive" };
  const overridden = estimateBudget(plan, library);
  assert.ok(Math.abs(overridden.expectedCostUsd! - 0.012) < 1e-12);
  assert.ok(Math.abs(overridden.worstCaseCostUsd! - 0.054) < 1e-12);

  node.agent = { model: "unknown" };
  const unknown = estimateBudget(plan, library);
  assert.equal(unknown.expectedCostUsd, null);
  assert.equal(unknown.worstCaseCostUsd, null);
  assert.deepEqual(unknown.unpricedNodes, [node.id]);
  assert.equal(unknown.dynamicNodes, undefined);
});

test("default execution estimates match live mode and retain the approved inputs", async (t) => {
  const { library } = await fixture(t);
  library.config.agent.provider = "test";
  library.config.agent.model = "known";
  library.config.budget = budgetSchema.parse({
    prices: { "test/known": { input: 1, output: 2 } },
  });
  const plan = createTemplate("Live spending", "bug", library);
  const snapshot = structuredClone({ plan, library });
  const implicit = estimateBudget(plan, library);
  assert.deepEqual(implicit, estimateBudget(plan, library, "live"));
  assert.ok(implicit.expectedCostUsd! > 0);
  assert.ok(implicit.worstCaseCostUsd! >= implicit.expectedCostUsd!);
  assert.equal(estimateBudget(plan, library, "demo").expectedCostUsd, 0);
  assert.deepEqual({ plan, library }, snapshot);
});

test("base pricing handles absent or empty tiers, cached tokens, omitted caches and free rates", () => {
  const price = priceSchema.parse({ input: 2, output: 7, cacheRead: 0.2, cacheWrite: 3 });
  const emptyTiers = { ...price, tiers: [] };
  for (const rates of [price, emptyTiers]) {
    assert.equal(priceUsage(rates, 100, 20), 0.00034);
    assert.equal(priceUsage(rates, 100, 20, 30, 40, 10), 0.000476);
    assert.equal(priceUsage(rates, 0, 0), 0);
  }
  const free = priceSchema.parse({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(priceUsage(free, 1000, 200, 300, 400, 100), 0);
});

test("unsorted pricing tiers keep strict boundaries without mutating the shared snapshot", () => {
  const price = priceSchema.parse({
    input: 1,
    output: 1,
    tiers: [
      { inputTokensAbove: 3000, input: 8, output: 13 },
      { inputTokensAbove: 1000, input: 2, output: 3 },
      { inputTokensAbove: 2000, input: 4, output: 5 },
    ],
  });
  const snapshot = structuredClone(price);
  for (const [input, expected] of [
    [1000, (1000 + 20) / 1_000_000],
    [1001, (1001 * 2 + 20 * 3) / 1_000_000],
    [2000, (2000 * 2 + 20 * 3) / 1_000_000],
    [2001, (2001 * 4 + 20 * 5) / 1_000_000],
    [3000, (3000 * 4 + 20 * 5) / 1_000_000],
    [3001, (3001 * 8 + 20 * 13) / 1_000_000],
  ] as const) {
    assert.equal(priceUsage(price, input, 20), expected);
    assert.deepEqual(price, snapshot);
  }
});

test("usage aggregation includes every counter without changing either request", () => {
  const left = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    costUsd: 0.25,
    requests: 2,
    unpricedRequests: 1,
  };
  const right = {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    costUsd: 0.5,
    requests: 3,
    unpricedRequests: 2,
  };
  const snapshot = structuredClone({ left, right });
  assert.deepEqual(addUsage(left, right), {
    inputTokens: 101,
    outputTokens: 22,
    cacheReadTokens: 33,
    cacheWriteTokens: 44,
    costUsd: 0.75,
    requests: 5,
    unpricedRequests: 3,
  });
  assert.deepEqual({ left, right }, snapshot);
  assert.deepEqual(addUsage(left, emptyUsage()), left);
});

test("each empty usage value is independent and contains every zeroed counter", () => {
  const first = emptyUsage();
  const second = emptyUsage();
  assert.notEqual(first, second);
  first.inputTokens = 1;
  assert.deepEqual(second, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    requests: 0,
    unpricedRequests: 0,
  });
});
