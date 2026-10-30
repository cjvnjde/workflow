import assert from "node:assert/strict";
import test from "node:test";
import { agentSchema, nodeSchema, validatePlan } from "../src/contracts/domain.js";
import { createTemplate } from "../src/core/library/templates.js";
import { fixture } from "./helpers.js";

test("model-only overrides preserve project thinking and execution budgets", () => {
  const override = nodeSchema.parse({
    id: "fix",
    block: "fix",
    label: "Fix",
    goal: "Fix bug",
    agent: { model: "custom-model" },
    on: { pass: "$complete", retry: "fix", fail: "$failed" },
  }).agent;
  const resolved = agentSchema.parse({
    provider: "anthropic",
    thinking: "high",
    timeoutMs: 12_000,
    maxToolCalls: 7,
    ...override,
  });
  assert.equal(resolved.thinking, "high");
  assert.equal(resolved.timeoutMs, 12_000);
  assert.equal(resolved.maxToolCalls, 7);
});

test("bug and feature recipes use different preparation and test steps", async (t) => {
  const { library } = await fixture(t);
  const bug = createTemplate("Bug", "bug", library);
  const feature = createTemplate("Feature", "feature", library);
  assert.deepEqual(
    bug.nodes.map((node) => node.block),
    ["reproduce", "fix", "review"],
  );
  assert.deepEqual(
    feature.nodes.map((node) => node.block),
    ["requirements", "implement", "verify", "review"],
  );
  assert.equal(feature.nodes.find((node) => node.id === "verify")?.on.retry, "work");
  assert.equal(
    bug.nodes.find((node) => node.id === "work")?.inputs.find((input) => input.node === "review")
      ?.required,
    false,
  );
});

test("graph validation rejects undeclared routes, unreachable steps and invalid artifact sharing", async (t) => {
  const { library } = await fixture(t);
  const plan = createTemplate("Task", "bug", library);
  const first = plan.nodes[0];
  assert.ok(first);
  assert.throws(
    () =>
      validatePlan(
        {
          ...plan,
          nodes: [{ ...first, on: { ...first.on, pass: "missing" } }, ...plan.nodes.slice(1)],
        },
        library,
      ),
    /Unknown transition target/,
  );
  assert.throws(
    () => validatePlan({ ...plan, nodes: [...plan.nodes, { ...first, id: "orphan" }] }, library),
    /reachable/,
  );
  assert.throws(
    () =>
      validatePlan(
        {
          ...plan,
          nodes: [
            {
              ...first,
              inputs: [{ node: "review", artifact: "private-conversation" }],
            },
            ...plan.nodes.slice(1),
          ],
        },
        library,
      ),
    /Invalid handoff/,
  );
  assert.throws(() => validatePlan({ ...plan, nodes: [...plan.nodes, first] }, library), /unique/);
});

test("provider changes clear inherited models at every settings layer", async () => {
  const { resolveAgentSettings } = await import("../src/contracts/domain.js");
  const base = agentSchema.parse({
    provider: "openai",
    model: "openai-model",
    thinking: "high",
    timeoutMs: 12_000,
    maxToolCalls: 7,
  });
  const changed = resolveAgentSettings(base, { provider: "anthropic" });
  assert.equal(changed.provider, "anthropic");
  assert.equal(changed.model, undefined);
  assert.equal(changed.thinking, "high");
  assert.equal(changed.timeoutMs, 12_000);
  assert.equal(changed.maxToolCalls, 7);
  assert.equal(resolveAgentSettings(base, { provider: "openai" }).model, "openai-model");
  assert.equal(resolveAgentSettings(base, { model: "other-model" }).model, "other-model");
  assert.equal(
    resolveAgentSettings(base, { provider: "anthropic", model: "claude" }, { provider: "openai" })
      .model,
    undefined,
  );
  assert.equal(
    resolveAgentSettings(base, { provider: "anthropic" }, { model: "claude" }).model,
    "claude",
  );
});
