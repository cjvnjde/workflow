import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { RunStore } from "../src/run-store.js";
import { runSchema } from "../src/domain.js";
import { createTemplate } from "../src/templates.js";
import { fixture } from "./helpers.js";

test("concurrent run saves are ordered and publish complete JSON without temporary-file collisions", async (t) => {
  const { project, library } = await fixture(t);
  const directory = path.join(project, ".workflow/runs");
  const store = new RunStore(directory);
  const id = randomUUID();
  const run = runSchema.parse({ id, createdAt: "now", updatedAt: "now", mode: "demo", status: "draft", plan: createTemplate("Concurrent saves", "bug", library), config: library.config, blocks: library.blocks, cursor: "prepare", visits: {}, artifacts: {}, attempts: [] });
  await Promise.all(Array.from({ length: 20 }, (_, revision) => store.save({ ...run, revision })));
  const loaded = runSchema.parse(JSON.parse(await readFile(path.join(directory, id, "run.json"), "utf8")));
  assert.equal(loaded.revision, 19);
});

test("a torn final event does not hide persisted events; complete corrupt records still fail", async (t) => {
  const { project } = await fixture(t);
  const directory = path.join(project, ".workflow/runs");
  const id = randomUUID(); await mkdir(path.join(directory, id), { recursive: true });
  const store = new RunStore(directory);
  const event = { id: randomUUID(), runId: id, time: "now", kind: "node_end", message: "saved" };
  const filename = path.join(directory, id, "events.jsonl");
  await writeFile(filename, JSON.stringify(event) + '\n{"partial":');
  assert.deepEqual(await store.events(id), [event]);
  await writeFile(filename, JSON.stringify(event) + '\ninvalid\n');
  await assert.rejects(store.events(id));
});

test("startup tolerates an initial run directory whose snapshot was never published", async (t) => {
  const { project } = await fixture(t);
  const directory = path.join(project, ".workflow/runs");
  await mkdir(path.join(directory, randomUUID()), { recursive: true });
  assert.deepEqual(await new RunStore(directory).load(), []);
});

test("new events can append after a crash left a torn final record", async (t) => {
  const { project } = await fixture(t);
  const directory = path.join(project, ".workflow/runs");
  const id = randomUUID(); await mkdir(path.join(directory, id), { recursive: true });
  const first = { id: randomUUID(), runId: id, time: "now", kind: "node_end", message: "saved" };
  await writeFile(path.join(directory, id, "events.jsonl"), JSON.stringify(first) + '\n{"partial":');
  const store = new RunStore(directory);
  const second = { ...first, id: randomUUID(), message: "after restart" };
  store.record(second); await store.flush();
  assert.deepEqual(await store.events(id), [first, second]);
});

test("an event persistence failure is reported but does not permanently poison subsequent writes", async (t) => {
  const { rm } = await import("node:fs/promises");
  const { project } = await fixture(t);
  const directory = path.join(project, ".workflow/runs");
  const id = randomUUID(); const filename = path.join(directory, id, "events.jsonl");
  await mkdir(filename, { recursive: true });
  const store = new RunStore(directory);
  const event = { id: randomUUID(), runId: id, time: "now", kind: "node_end", message: "saved" };
  store.record(event); await assert.rejects(store.flush(), /Could not persist/);
  await rm(filename, { recursive: true });
  store.record(event); await store.flush();
  assert.deepEqual(await store.events(id), [event]);
});

test("queued events retain their original values when the caller changes the input", async (t) => {
  const { project } = await fixture(t);
  const store = new RunStore(path.join(project, ".workflow/runs"));
  const id = randomUUID();
  const event = { id: randomUUID(), runId: id, time: "now", kind: "operation", message: "original", operation: {
    id: "call", name: "read", kind: "read" as const, state: "completed" as const, output: { text: "original" },
  } };
  const expected = structuredClone(event);
  store.record(event);
  event.message = "changed";
  event.operation.output.text = "changed";
  await store.flush();
  assert.deepEqual(await store.events(id), [expected]);
});
