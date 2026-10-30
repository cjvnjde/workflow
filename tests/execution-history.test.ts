import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { rename, writeFile, readdir, readlink } from "node:fs/promises";
import test from "node:test";
import { projectOperations, operationKey, historyQuerySchema, executionSnapshotSchema } from "../src/execution-history.js";
import type { RunEvent } from "../src/domain.js";
import { RunStore } from "../src/run-store.js";
import { fixture } from "./helpers.js";

function event(id: string, op?: RunEvent["operation"]): RunEvent {
  return { id, runId: "run", nodeId: "inspect", time: "2026-10-30T12:00:00Z", kind: op ? "operation" : "update", message: id, operation: op };
}
const root = (attempt: number, state: "started" | "completed" = "started"): RunEvent["operation"] => ({
  id: "ai", name: "AI session", kind: "ai", state, attempt, visit: 2,
});

test("operation projection consolidates progress while keeping retries and children separate", () => {
  const events = [
    event("a1", root(1)),
    event("c1", { id: "ai/read", parentId: "ai", name: "read_file", kind: "tool", state: "started", input: { path: "one.ts" } }),
    event("c2", { id: "ai/read", parentId: "ai", name: "read_file", kind: "tool", state: "completed", output: "first" }),
    event("a2", root(2)),
    event("c3", { id: "ai/read", parentId: "ai", name: "read_file", kind: "tool", state: "started", input: { path: "two.ts" } }),
    event("c4", { id: "ai/read", parentId: "ai", parentAttempt: 1, visit: 2, name: "read_file", kind: "tool", state: "interrupted" }),
  ];
  const result = projectOperations(events);
  assert.equal(result.length, 4);
  const first = result.find(op => op.key === operationKey("ai/read", 2, 1))!;
  const second = result.find(op => op.key === operationKey("ai/read", 2, 2))!;
  assert.equal(first.state, "interrupted");
  assert.deepEqual(first.operation.input, { path: "one.ts" });
  assert.equal(first.operation.output, "first");
  assert.equal(first.parentKey, operationKey("ai", 2, 1));
  assert.equal(second.state, "started");
  assert.equal(second.operation.output, undefined);
  assert.equal(second.parentKey, operationKey("ai", 2, 2));
});

test("history projection preserves unknown boundaries and never fabricates duration", () => {
  const missingStart = event("only-end", { id: "legacy", kind: "exec", name: "exec", state: "completed", output: "done" });
  const records = projectOperations([missingStart, missingStart]);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.eventCount, 1);
  assert.equal(records[0]!.startedAt, undefined);
  assert.equal(records[0]!.durationMs, undefined);
  assert.equal(records[0]!.attempt, undefined);
});

test("history is pageable beyond 500 records and snapshots exclude later appends", async t => {
  const { project } = await fixture(t);
  const store = new RunStore(path.join(project, ".workflow/runs"));
  const id = randomUUID();
  for (let n = 0; n < 625; n++) await store.record({ ...event(`event-${n}`), runId: id, time: n % 2 ? "2025" : "2026" });
  const tail = await store.history(id, { limit: 100 });
  assert.equal(tail.total, 625);
  assert.equal(tail.asOf, 624);
  assert.equal(tail.nextBefore, 525);
  assert.equal(tail.events[0]!.event.id, "event-525");
  await store.record({ ...event("later"), runId: id });
  const middle = await store.history(id, { before: tail.nextBefore, asOf: tail.asOf, limit: 500 });
  assert.equal(middle.asOf, 624);
  assert.equal(middle.events.length, 500);
  assert.equal(middle.events[0]!.cursor, 25);
  const first = await store.history(id, { before: middle.nextBefore, asOf: tail.asOf, limit: 500 });
  assert.equal(first.hasMore, false);
  assert.equal(first.events.length, 25);
  const all = [...first.events, ...middle.events, ...tail.events];
  assert.equal(new Set(all.map(x => x.event.id)).size, 625);
  assert.deepEqual(all.map(x => x.cursor), Array.from({ length: 625 }, (_, i) => i));
  assert.equal((await store.events(id)).length, 500);
  assert.equal((await store.history(id)).asOf, 625);
});

test("full execution summaries omit payloads and lazily retrieve the exact attempt", async t => {
  const { project } = await fixture(t);
  const store = new RunStore(path.join(project, ".workflow/runs"));
  const id = randomUUID();
  await store.record({ ...event("first", { ...root(1)!, input: "long prompt", output: "x".repeat(16_000) }), runId: id });
  await store.record({ ...event("second", root(2)), runId: id });
  await store.record({ ...event("third", { ...root(2, "completed")!, output: "second result", durationMs: 10 }), runId: id });
  const snapshot = executionSnapshotSchema.parse(await store.execution(id));
  assert.equal(snapshot.operations.length, 2);
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.operations[0]!.operation.output, undefined);
  assert.equal(snapshot.operations[0]!.summary, "long prompt");
  const details = await store.operationEvents(id, snapshot.operations[1]!.key);
  assert.deepEqual(details.events.map(x => x.id), ["second", "third"]);
  assert.equal(details.asOf, snapshot.asOf);
});

test("history query bounds page sizes and cursors", () => {
  assert.equal(historyQuerySchema.parse({}).limit, 200);
  for (const query of [{ limit: 501 }, { before: -1 }, { asOf: -2 }, { limit: 0 }]) assert.equal(historyQuerySchema.safeParse(query).success, false);
});


test("compact request summaries retain bounded timing and late progress cannot reopen a call", () => {
  const events = [
    event("start", { id: "request", name: "Model request", kind: "request", state: "started", attempt: 1 }),
    event("done", { id: "request", name: "Model request", kind: "request", state: "completed", attempt: 1, durationMs: 600, details: { firstTokenMs: 50 }, output: "large body" }),
    event("late", { id: "request", name: "Model request", kind: "request", state: "progress", attempt: 1, summary: "late progress" }),
  ];
  const op = projectOperations(events, true)[0]!;
  assert.equal(op.state, "completed");
  assert.equal(op.operation.state, "completed");
  assert.deepEqual(op.operation.details, { firstTokenMs: 50 });
  assert.equal(op.operation.output, undefined);
  assert.equal(op.durationMs, 600);
});

test("lazy legacy child details retain the parent-derived attempt identity", async t => {
  const { project } = await fixture(t);
  const store = new RunStore(path.join(project, ".workflow/runs"));
  const id = randomUUID();
  for (const item of [event("parent", root(2)), event("child", { id: "ai/legacy", parentId: "ai", name: "read_file", kind: "tool", state: "completed", output: "captured legacy output" })]) await store.record({ ...item, runId: id });
  const details = await store.operationEvents(id, operationKey("ai/legacy", 2, 2));
  assert.equal(details.operation?.key, operationKey("ai/legacy", 2, 2));
  assert.equal(details.operation?.operation.output, "captured legacy output");
  assert.equal(details.operation?.operation.visit, 2);
  assert.equal(details.operation?.operation.attempt, 2);
  assert.equal(details.events[0]?.operation?.attempt, undefined, "raw events stay unchanged");
});


test("execution summaries reuse unchanged and appended prefixes without exposing cached mutable state", async t => {
  const { project } = await fixture(t);
  const store = new RunStore(path.join(project, ".workflow/runs"));
  const id = randomUUID();
  const originalScan = store["scan"];
  let scans = 0;
  store["scan"] = function (runId: string) { scans++; return originalScan.call(this, runId); };
  await store.record({ ...event("start", root(1)), runId: id });
  const first = await store.execution(id);
  first.operations[0]!.name = "caller mutation";
  first.operations[0]!.operation.name = "nested mutation";
  assert.equal((await store.execution(id)).operations[0]!.name, "AI session");
  assert.equal((await store.execution(id)).operations[0]!.operation.name, "AI session");
  await store.record({ ...event("end", root(1, "completed")), runId: id });
  const next = await store.execution(id);
  assert.equal(scans, 1, "the known appended event must fold without rescanning the prefix");
  assert.equal(next.total, 2);
  assert.equal(next.operations[0]!.state, "completed");
  assert.equal(first.total, 1);
  assert.equal(first.operations[0]!.state, "started", "previous published snapshot remains unchanged");
});

test("execution cache rebuilds after truncation and file replacement, then safely resumes appending", async t => {
  const { project } = await fixture(t);
  const store = new RunStore(path.join(project, ".workflow/runs"));
  const id = randomUUID(), filename = path.join(project, ".workflow/runs", id, "events.jsonl");
  await store.record({ ...event("start", root(1)), runId: id });
  await store.record({ ...event("end", root(1, "completed")), runId: id });
  assert.equal((await store.execution(id)).total, 2);
  const replacement = { ...event("replacement", { id: "new", name: "New operation", kind: "read" as const, state: "started" as const }), runId: id };
  await writeFile(filename, JSON.stringify(replacement) + "\n");
  let snapshot = await store.execution(id);
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.operations[0]!.id, "new");
  await writeFile(filename + ".next", JSON.stringify({ ...replacement, id: "replaced", operation: { ...replacement.operation!, id: "other" } }) + "\n");
  await rename(filename + ".next", filename);
  snapshot = await store.execution(id);
  assert.equal(snapshot.operations[0]!.id, "other");
  await writeFile(filename, JSON.stringify(replacement) + '\n{"torn":');
  assert.equal((await store.execution(id)).total, 1);
  await store.record({ ...event("after-repair", { ...replacement.operation!, state: "completed" }), runId: id });
  snapshot = await store.execution(id);
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.operations[0]!.state, "completed");
  assert.equal((await store.history(id)).total, snapshot.total);
});


test("repeated early history returns and parse failures close every log descriptor", async t => {
  const { project } = await fixture(t);
  const store = new RunStore(path.join(project, ".workflow/runs"));
  const id = randomUUID(), filename = path.join(project, ".workflow/runs", id, "events.jsonl");
  for (let i = 0; i < 4; i++) await store.record({ ...event(`event-${i}`), runId: id, message: "🙂".repeat(20_000) });
  const openLogDescriptors = async () => {
    if (process.platform !== "linux") return [];
    const descriptors = await readdir("/proc/self/fd");
    const targets = await Promise.all(descriptors.map(fd => readlink(`/proc/self/fd/${fd}`).catch(() => "")));
    return targets.filter(target => target === filename);
  };
  for (let i = 0; i < 40; i++) {
    const page = await store.history(id, { asOf: 0, limit: 1 });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]!.event.message, "🙂".repeat(20_000));
    assert.equal((await openLogDescriptors()).length, 0);
  }
  await writeFile(filename, "invalid-complete-line\n");
  for (let i = 0; i < 10; i++) {
    await assert.rejects(store.history(id));
    assert.equal((await openLogDescriptors()).length, 0);
  }
  Bun.gc(true);
});
