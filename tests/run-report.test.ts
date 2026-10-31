import { test } from "vitest";
import assert from "node:assert/strict";
import { recoveryAdvice, runReport } from "../web/features/execution/run-report.js";
import type { WorkflowRun, RunEvent } from "../src/contracts/domain.js";
test("report separates acceptance from success, uses latest failures and pairs actual model calls", () => {
  const run = {
    status: "completed",
    attempts: [
      { nodeId: "repair", visit: 1, result: { outcome: "retry" }, checks: [] },
      {
        nodeId: "repair",
        visit: 2,
        result: { outcome: "pass", disposition: "work-completed" },
        checks: [],
      },
      {
        nodeId: "review",
        visit: 1,
        result: { outcome: "pass", disposition: "accepted" },
        checks: [],
      },
    ],
  } as unknown as WorkflowRun;
  const events = [
    {
      id: "one",
      time: "2026-10-25T10:00:00Z",
      nodeId: "repair",
      kind: "model_session",
      message: JSON.stringify({
        provider: "openai",
        model: "gpt-6-luna",
        thinking: "low",
        tools: ["submit_result"],
      }),
    },
    {
      id: "two",
      time: "2026-10-25T10:00:01Z",
      nodeId: "review",
      kind: "model_session",
      message: JSON.stringify({
        provider: "openai",
        model: "gpt-6.1-sol",
        thinking: "high",
        tools: ["read"],
      }),
    },
    {
      time: "2026-10-25T10:00:03Z",
      nodeId: "repair",
      kind: "model_session_end",
      message: '{"durationMs":400}',
    },
    {
      time: "2026-10-25T10:00:04Z",
      nodeId: "review",
      kind: "model_session_end",
      message: '{"durationMs":700}',
    },
  ] as RunEvent[];
  const report = runReport(run, events);
  assert.equal(report.accepted.length, 1);
  assert.equal(report.unresolved.length, 0);
  assert.deepEqual(
    report.calls.map((c) => c.durationMs),
    [400, 700],
  );
  assert.match(report.calls[0]!.description, /luna.*low/);
  assert.equal(report.modelOverlaps[0]?.seconds, 2);
  assert.equal(report.modelOverlaps[0]?.isolated, false);
  assert.equal(recoveryAdvice(run), undefined);
});
test("recovery diagnoses ownership without encouraging repair to rewrite reproductions", () => {
  const advice = recoveryAdvice({
    status: "failed",
    error: "Protected files changed: regression.test.ts",
    attempts: [],
  });
  assert.equal(advice?.category, "File ownership");
  assert.match(advice!.action, /preserve the reproduction tests/);
});

test("explicit blocked results outrank incidental diagnostic keywords", () => {
  const run = {
    status: "failed",
    error: "Review output: missing implementation; provide input",
    attempts: [{ result: { disposition: "blocked", summary: "No implementation exists" } }],
  } as unknown as WorkflowRun;
  assert.equal(recoveryAdvice(run)?.category, "Missing prerequisite");
});
