import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionTiming } from "../src/core/execution/session-timing.js";
import type { OperationRecord } from "../src/contracts/operation-schema.js";

test("request timing separates first token, generation, retries and missing tokens", () => {
  const records: OperationRecord[] = [];
  let now = 0;
  const timing = new SessionTiming(
    "operation",
    "session",
    (record) => records.push(record),
    () => now,
  );
  timing.start("provider", "model");
  now = 20;
  timing.token();
  now = 80;
  timing.token();
  now = 100;
  timing.finish("completed", 10);
  assert.equal(records[1]?.durationMs, 100);
  assert.deepEqual(records[1]?.details, {
    timingSource: "client-observed provider invocation",
    firstTokenMs: 20,
    generationMs: 60,
    outputTokens: 10,
  });
  timing.wait("Provider retry backoff");
  now = 150;
  timing.endWait("Provider retry backoff");
  assert.equal(records.at(-1)?.durationMs, 50);
  timing.start("provider", "model");
  now = 175;
  timing.finish("failed");
  assert.equal(records.at(-1)?.durationMs, 25);
  assert.equal(Object.hasOwn(records.at(-1)!.details as object, "firstTokenMs"), false);
  assert.notEqual(records[0]?.id, records.at(-1)?.id);
});

test("closing interrupted sessions settles outstanding requests and waits only once", () => {
  const records: OperationRecord[] = [];
  let now = 2;
  const timing = new SessionTiming(
    "operation",
    "session",
    (record) => records.push(record),
    () => now,
  );
  timing.start("provider", "model");
  timing.wait("Context compaction");
  now = 12;
  timing.close();
  timing.close();
  assert.equal(records.length, 4);
  assert.deepEqual(
    records.slice(2).map((record) => record.state),
    ["interrupted", "interrupted"],
  );
  assert.ok(records.every((record) => record.sessionId === "session"));
});

test("provider observation handles streamed and result-only compaction requests without stealing events", async () => {
  const records: OperationRecord[] = [];
  let now = 0;
  const timing = new SessionTiming(
    "operation",
    "session",
    (record) => records.push(record),
    () => now,
  );
  const message = { stopReason: "stop", usage: { output: 9 } };
  timing.start("provider", "model");
  const streamed = timing.observe({
    async result() {
      return message;
    },
    async *[Symbol.asyncIterator]() {
      now = 15;
      yield { type: "text_delta" };
      now = 30;
      yield { type: "text_delta" };
      now = 40;
      yield { type: "done" };
    },
  });
  const received: string[] = [];
  for await (const event of streamed) received.push(event.type);
  assert.deepEqual(received, ["text_delta", "text_delta", "done"]);
  assert.equal(await streamed.result(), message);
  assert.equal(records.length, 2);
  assert.deepEqual(records[1]?.details, {
    timingSource: "client-observed provider invocation",
    firstTokenMs: 15,
    generationMs: 15,
    outputTokens: 9,
  });
  timing.wait("Context compaction", { reason: "threshold" });
  timing.start("provider", "model");

  const compact = timing.observe({
    async result() {
      now = 60;
      return message;
    },
    // eslint-disable-next-line require-yield -- Exercise completion without streamed token events.
    async *[Symbol.asyncIterator]() {
      throw new Error("must not consume result-only stream");
    },
  });
  await compact.result();
  timing.endWait("Context compaction", "completed", {
    tokensBefore: 100,
    estimatedTokensAfter: 20,
  });
  assert.equal(records[4]?.state, "completed");
  assert.equal(records[4]?.durationMs, 20);
  assert.equal(Object.hasOwn(records[4]?.details as object, "firstTokenMs"), false);
  assert.deepEqual(records[5]?.details, { tokensBefore: 100, estimatedTokensAfter: 20 });
});
