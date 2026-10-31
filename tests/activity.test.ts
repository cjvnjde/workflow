import assert from "node:assert/strict";
import { test } from "vitest";
import { describeActivity, matchesActivity } from "../web/features/execution/activity.js";
import type { RunEvent } from "../src/contracts/domain.js";

const event = (kind: string, message: string): RunEvent => ({
  id: "event",
  runId: "run",
  nodeId: "review",
  time: "2026-01-01T00:00:00Z",
  kind,
  message,
});

test("activity summarizes tool arguments while keeping complete evidence searchable", () => {
  const original = event("tool_start", 'bash {"command":"bun test\\ngit status","timeout":60}');
  const item = describeActivity(original);
  assert.equal(item.title, "Run command");
  assert.equal(item.preview, "bun test");
  assert.equal(item.state, "Started");
  assert.equal(item.event, original);
  assert.match(item.detail, /timeout/);
  assert.equal(matchesActivity(item, "GIT STATUS"), true);
  assert.equal(matchesActivity(item, "Independent review", "Independent review"), true);
  assert.equal(matchesActivity(item, "unrelated"), false);
});

test("failed tools and unmet checks never appear successful, including unfamiliar event formats", () => {
  assert.equal(
    describeActivity(event("tool_end", "bash: error\nCommand exited with code 1")).tone,
    "error",
  );
  assert.equal(
    describeActivity(event("tool_end", "git push origin: exit 128\nRejected")).tone,
    "error",
  );
  assert.equal(
    describeActivity(event("tool_end", "git push origin: exit 0\nDone")).tone,
    "success",
  );
  assert.equal(describeActivity(event("tool_end", "bash: unknown response")).tone, undefined);
  assert.equal(
    describeActivity(event("check", "test: condition NOT met\nTests failed")).tone,
    "error",
  );
  assert.equal(
    describeActivity(event("check", "reproduce: condition met\nExpected exit 1")).tone,
    "success",
  );
  assert.equal(describeActivity(event("check", "Unfamiliar check format")).tone, undefined);
  assert.equal(
    describeActivity(event("node_end", "RETRY → work\nFix the regression")).tone,
    "warning",
  );
});

test("usage summaries include caches once and malformed or truncated data remains readable", () => {
  const usage = describeActivity(
    event(
      "usage",
      JSON.stringify({
        requests: 2,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
        costUsd: 0.0123,
      }),
    ),
  );
  assert.equal(usage.preview, "2 requests · 1,500 tokens · $0.0123 reported");
  for (const [kind, message] of [
    ["usage", '{"requests":'],
    ["tool_start", 'submit_plan {"json":"truncated'],
  ]) {
    const item = describeActivity(event(kind!, message!));
    assert.equal(item.detail, message);
    assert.equal(item.preview, message);
  }
  assert.equal(
    describeActivity(event("usage", '{"requests":-1,"costUsd":"unknown"}')).preview,
    '{"requests":-1,"costUsd":"unknown"}',
  );
});

test("structured session and decision events have human readable previews", () => {
  const event = {
    id: "x",
    runId: "run",
    time: "2026-10-25",
    kind: "model_session",
    message: JSON.stringify({
      provider: "openai",
      model: "gpt-6-luna",
      thinking: "low",
      tools: ["submit_result"],
    }),
  };
  assert.equal(describeActivity(event).preview, "openai/gpt-6-luna · thinking low");
  assert.equal(
    describeActivity({
      ...event,
      kind: "flow_decision",
      message: '{"groupId":"repair","result":false,"route":"repeat"}',
    }).preview,
    "repair: false → repeat",
  );
});
