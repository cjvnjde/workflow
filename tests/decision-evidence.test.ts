import { test } from "vitest";
import assert from "node:assert/strict";
import { block, step, repeatUntil, when, describeFlow } from "../src/sdk/workflow-sdk.js";
import { executeFlow, type GroupState } from "../src/core/execution/composition-runtime.js";

test("loop evidence distinguishes false, early exit, explicit repeat and exhausted limit", async () => {
  for (const mode of ["early", "limit", "explicit"] as const) {
    let calls = 0,
      predicates = 0;
    const evidence: NonNullable<GroupState["decision"]>[] = [];
    const body = step("work", block({ run: () => true }), {
      maxVisits: 4,
      on: { retry: mode === "explicit" ? "repeat" : "continue" },
    });
    const flow = repeatUntil("repair", {
      body,
      maxIterations: 4,
      until: () => {
        predicates++;
        return mode === "early" && calls === 2;
      },
    });
    const execute = executeFlow({
      flow,
      structure: describeFlow(flow),
      input: {},
      request: "Fix the bug",
      models: {},
      group: async (_id, state) => {
        if (state.decision) evidence.push(state.decision);
      },
      step: async () => {
        calls++;
        return { outcome: "retry", summary: "Repair", artifacts: {} };
      },
    });
    if (mode === "early") {
      await execute;
      assert.equal(calls, 2);
      assert.deepEqual(
        evidence.map((e) => e.route),
        ["repeat", "exit"],
      );
      assert.deepEqual(
        evidence.map((e) => e.result),
        [false, true],
      );
    } else {
      await assert.rejects(execute, /after 4 iterations/);
      assert.equal(calls, 4);
      assert.equal(evidence.at(-1)?.route, "limit");
    }
    if (mode === "explicit") {
      assert.equal(predicates, 0);
      assert.ok(evidence.every((e) => e.result === undefined));
    }
  }
});

test("conditional evidence records the selected route and replay compatibility suppresses new events", async () => {
  for (const recordDecisions of [true, false]) {
    const events: GroupState[] = [];
    const flow = when(
      "choose",
      () => false,
      step("yes", block({ run: () => true })),
      step("no", block({ run: () => false })),
    );
    const calls: string[] = [];
    await executeFlow({
      recordDecisions,
      flow,
      structure: describeFlow(flow),
      input: {},
      request: "Check",
      models: {},
      group: async (_id, state) => {
        events.push(state);
      },
      step: async (node) => {
        calls.push(node.id);
        return { outcome: "pass", summary: "Done", artifacts: {} };
      },
    });
    assert.deepEqual(calls, ["no"]);
    assert.equal(events.filter((e) => e.decision).length, recordDecisions ? 1 : 0);
    if (recordDecisions) assert.equal(events.find((e) => e.decision)?.decision?.route, "otherwise");
  }
});
