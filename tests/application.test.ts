import assert from "node:assert/strict";
import { test } from "vitest";
import { createApplication } from "../src/core/application.js";
import { createHttpServer } from "../src/http/http-server.js";
import { WorkflowClient, waitForRun } from "../src/client/client.js";
import type { RunEvent } from "../src/contracts/index.js";
import { fixture, passingRunner } from "./helpers.js";

const source = `import { workflow, block, step } from "workflow";
const check = block({
  run(ctx) {
    ctx.summary("No GUI needed");
    return { passed: true };
  },
});
export default workflow({ name: "Headless", flow: step("check", check) });`;

test("an application executes and persists a workflow without an HTTP server, then reopens it", async (t) => {
  const { project } = await fixture(t);
  const app = await createApplication({ project, mode: "demo", runner: passingRunner });
  const events: RunEvent[] = [];
  const unsubscribe = app.subscribe((event) => events.push(event));
  let id: string;
  try {
    const draft = await app.createProgram({ title: "Headless", task: "Run without a GUI", source });
    id = draft.id;
    await assert.rejects(app.approve(id, draft.revision + 1), /Draft changed/);
    await app.approve(id, draft.revision);
    const result = await waitForRun(() => app.getRun(id), { signal: AbortSignal.timeout(15_000) });
    assert.equal(result.status, "completed");
    assert.equal(result.attempts[0]?.result?.summary, "No GUI needed");
    assert.ok(events.some((event) => event.kind === "run_end"));
    assert.ok((await app.events(id)).some((event) => event.kind === "node_end"));
  } finally {
    unsubscribe();
    await app.close();
    await app.close();
  }
  const reopened = await createApplication({ project, mode: "demo", runner: passingRunner });
  try {
    assert.equal(reopened.getRun(id!).status, "completed");
  } finally {
    await reopened.close();
  }
});

test("HTTP clients share application state and events; closing an adapter leaves the engine usable", async (t) => {
  const { project, cleanup } = await fixture(t);
  const app = await createApplication({ project, mode: "demo", runner: passingRunner });
  cleanup(() => app.close());
  const http = await createHttpServer(app, 0);
  cleanup(() => http.close());
  const address = await http.listen({ port: 0, host: "127.0.0.1" });
  assert.equal((await fetch(address)).status, 404);
  const client = new WorkflowClient({ baseUrl: address });
  assert.equal((await client.project()).project, app.project);
  const controller = new AbortController();
  let opened!: () => void;
  const open = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const events: RunEvent[] = [];
  const stream = client.subscribe((event) => events.push(event), {
    signal: controller.signal,
    onOpen: opened,
  });
  try {
    await Promise.race([
      open,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SSE did not open")), 5000).unref(),
      ),
    ]);
    const draft = await client.createProgram({
      title: "Shared",
      task: "Use another client",
      source,
    });
    assert.equal(app.getRun(draft.id).status, "draft");
    await assert.rejects(client.action(draft.id, "approve", draft.revision + 1), /Draft changed/);
    await client.action(draft.id, "approve", draft.revision);
    const run = await waitForRun(() => client.run(draft.id), {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(run.status, "completed");
    assert.ok(events.some((event) => event.runId === run.id));
    assert.equal(
      (await client.events(run.id)).some((event) => event.kind === "run_end"),
      true,
    );
  } finally {
    controller.abort();
    stream.close();
    await stream.done;
  }
  await http.close();
  const draft = await app.createProgram({ title: "Still alive", task: "Keep the engine", source });
  await app.approve(draft.id, draft.revision);
  assert.equal(
    (await waitForRun(() => app.getRun(draft.id), { signal: AbortSignal.timeout(15_000) })).status,
    "completed",
  );
});

test("headless application shutdown cancels pending coordinator work", async (t) => {
  const { project } = await fixture(t);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const app = await createApplication({
    project,
    mode: "live",
    runner: passingRunner,
    catalog: async () => ({ models: [], warnings: [] }),
    plan: async ({ signal }) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      throw new Error("unreachable");
    },
  });
  const work = app.createRun({ task: "Pending planning", strategy: "ai" });
  const failed = assert.rejects(work, /Application closing/);
  try {
    await ready;
    await app.close();
    await failed;
    assert.equal(app.listRuns().length, 0);
    assert.throws(() => app.approve("unused"), /Application closing/);
  } finally {
    await app.close();
  }
});
