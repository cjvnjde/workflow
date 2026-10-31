import assert from "node:assert/strict";
import { test } from "vitest";
import { chatEventVisible } from "../src/client/chat-visibility.js";
import type { RunEvent } from "../src/contracts/domain.js";

const event = (kind: string, message = "Evidence"): RunEvent => ({
  id: "event",
  runId: "run",
  time: "2026-10-31T00:00:00Z",
  kind,
  message,
});
const hidden = { tools: false, thinking: false };

test("tool and progress visibility are independent and preserve conversation events", () => {
  for (const kind of ["tool_start", "tool_end", "script_output", "function_end", "check_start"]) {
    const source = event(kind);
    assert.equal(chatEventVisible(source, hidden), false, kind);
    assert.equal(chatEventVisible(source, { tools: true, thinking: false }), true, kind);
    assert.equal(chatEventVisible(source, { tools: false, thinking: true }), false, kind);
  }
  for (const kind of [
    "planning",
    "agent_start",
    "node_start",
    "model_session",
    "reasoning_delta",
  ]) {
    const source = event(kind);
    assert.equal(chatEventVisible(source, hidden), false, kind);
    assert.equal(chatEventVisible(source, { tools: false, thinking: true }), true, kind);
    assert.equal(chatEventVisible(source, { tools: true, thinking: false }), false, kind);
  }
  for (const kind of [
    "user_message",
    "agent_message",
    "text_delta",
    "question",
    "node_end",
    "run_end",
    "future_event",
  ]) {
    assert.equal(chatEventVisible(event(kind), hidden), true, kind);
  }
});

test("failure diagnostics and retry warnings cannot be hidden with routine activity", () => {
  for (const [kind, message] of [
    ["tool_end", "bash: error\nCommand failed"],
    ["tool_end", "git push origin: exit 128\nRejected"],
    ["tool_end", "bash: exit unknown\nNo result"],
    ["script_end", "build: timed out · condition NOT met"],
    ["check", "test: condition NOT met\nFailure details"],
    ["planning_error", "Provider unavailable"],
    ["script_error", "Invalid script"],
    ["agent_retry", "Retrying provider"],
    ["plan_validation", "Refining invalid plan"],
  ]) {
    assert.equal(chatEventVisible(event(kind!, message!), hidden), true, `${kind}: ${message}`);
  }
  assert.equal(chatEventVisible(event("tool_end", "bash: exit 0\nSuccess"), hidden), false);
  assert.equal(
    chatEventVisible(event("check", "reproduce: condition met\nExpected exit 1"), hidden),
    false,
  );
});

test("structured AI operations follow progress visibility; failed operations always remain", () => {
  const source: RunEvent = {
    ...event("operation"),
    operation: { id: "op", name: "review", kind: "ai", state: "completed", output: "Evidence" },
  };
  assert.equal(chatEventVisible(source, { tools: true, thinking: false }), false);
  assert.equal(chatEventVisible(source, { tools: false, thinking: true }), true);
  source.operation!.kind = "read";
  assert.equal(chatEventVisible(source, { tools: true, thinking: false }), true);
  assert.equal(chatEventVisible(source, { tools: false, thinking: true }), false);
  for (const state of ["failed", "interrupted"] as const) {
    source.operation!.state = state;
    assert.equal(chatEventVisible(source, hidden), true);
  }
});
