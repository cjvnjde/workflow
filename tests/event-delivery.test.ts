import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "vitest";
import { setImmediate } from "node:timers/promises";
import { WorkflowEngine } from "../src/core/engine.js";
import type { RunEvent } from "../src/contracts/domain.js";
import { createTemplate } from "../src/core/library/templates.js";
import { fixture, passingRunner } from "./helpers.js";

async function setup(t: TestContext) {
  const context = await fixture(t);
  const engine = new WorkflowEngine(context.project, "demo", passingRunner);
  context.cleanup(() => engine.shutdown());
  return { ...context, engine };
}

test("run events are readable on disk before subscribers see them", async (t) => {
  const { project, library, engine } = await setup(t);
  const observations: { event: RunEvent; persisted: RunEvent[] }[] = [];
  engine.subscribe((event) => {
    let persisted: RunEvent[] = [];
    try {
      persisted = readFileSync(
        path.join(project, ".workflow/runs", event.runId, "events.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      /* Captured below without throwing from the subscriber. */
    }
    observations.push({ event, persisted });
  });
  const run = await engine.create(
    createTemplate("Persist before delivery", "bug", library),
    library,
  );
  await engine.reject(run.id);
  assert.deepEqual(
    observations.map(({ event }) => event.kind),
    ["draft", "rejected"],
  );
  for (const { event, persisted } of observations) {
    assert.ok(
      persisted.some((saved) => saved.id === event.id),
      `${event.kind} was published before its write finished`,
    );
  }
});

test("failed event writes never publish success and later writes can still be delivered", async (t) => {
  const { project, library, engine } = await setup(t);
  const run = await engine.create(createTemplate("Storage failure", "bug", library), library);
  const filename = path.join(project, ".workflow/runs", run.id, "events.jsonl");
  await rm(filename);
  await mkdir(filename);
  const delivered: RunEvent[] = [];
  engine.subscribe((event) => delivered.push(event));
  engine["emit"](run, "agent_message", "Must not be delivered");
  await assert.rejects(engine.events(run.id), /Could not persist/);
  assert.equal(delivered.length, 0);
  await rm(filename, { recursive: true });
  engine["emit"](run, "agent_message", "Storage recovered");
  assert.deepEqual(await engine.events(run.id), JSON.parse(JSON.stringify(delivered)));
  assert.deepEqual(
    delivered.map((event) => event.message),
    ["Storage recovered"],
  );
});

test("streamed text stays in order with persisted messages and is drained on shutdown", async (t) => {
  const { library, engine } = await setup(t);
  const run = await engine.create(createTemplate("Streaming order", "bug", library), library);
  const delivered: RunEvent[] = [];
  engine.subscribe((event) => delivered.push(event));
  for (const [kind, message] of [
    ["agent_start", "start"],
    ["text_delta", "first"],
    ["agent_message", "first"],
    ["text_delta", "second"],
    ["agent_message", "second"],
  ])
    engine["emit"](run, kind!, message!);
  await engine.shutdown();
  assert.deepEqual(
    delivered.map((event) => event.kind),
    ["agent_start", "text_delta", "agent_message", "text_delta", "agent_message"],
  );
  const persisted = await engine.events(run.id);
  assert.equal(persisted[0]?.kind, "draft");
  assert.deepEqual(
    persisted.slice(1),
    JSON.parse(JSON.stringify(delivered.filter((event) => event.kind !== "text_delta"))),
  );
});

test("throwing, rejecting, and mutating subscribers cannot fail operations or affect other subscribers", async (t) => {
  const { library, engine } = await setup(t);
  const run = await engine.create(createTemplate("Isolated subscribers", "bug", library), library);
  const delivered: RunEvent[] = [];
  const unsubscribe = engine.subscribe(() => {
    throw new Error("Broken view");
  });
  const unsubscribeAsync = engine.subscribe(async () => {
    throw new Error("Broken async view");
  });
  engine.subscribe((event) => {
    event.message = "mutated";
    if (event.operation) event.operation.state = "failed";
  });
  engine.subscribe((event) => delivered.push(event));
  await engine["recordOperation"](run, run.cursor, {
    id: "call",
    name: "read",
    kind: "read",
    state: "completed",
    output: "done",
  });
  assert.equal(delivered[0]?.message, "read: completed");
  assert.equal(delivered[0]?.operation?.state, "completed");
  unsubscribe();
  unsubscribeAsync();
  engine.coordinatorActivity("planning", "Still working");
  await setImmediate();
  assert.equal(delivered[1]?.message, "Still working");
  const saved = await engine.events(run.id);
  assert.equal(saved.at(-1)?.operation?.state, "completed");
});
