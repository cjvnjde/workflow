import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { eventSchema, runSchema } from "../src/domain.js";
import { WorkflowEngine } from "../src/engine.js";
import { createServer } from "../src/server.js";
import { createTemplate } from "../src/templates.js";
import { fixture, passingRunner } from "./helpers.js";

const headers = { host: "127.0.0.1:4310", "x-workflow-client": "1" };

test("API proposes, edits, approves and persists a workflow", async (t) => {
  const { project, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "demo", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const server = await createServer(engine);
  cleanup(() => server.close());
  const proposed = await server.inject({
    method: "POST",
    url: "/api/runs",
    headers,
    payload: { task: "Add feature", strategy: "feature" },
  });
  assert.equal(proposed.statusCode, 200);
  const run = runSchema.parse(proposed.json());
  assert.equal(run.status, "draft");
  const edited = await server.inject({
    method: "PUT",
    url: `/api/runs/${run.id}/plan`,
    headers,
    payload: { ...run.plan, title: "Reviewed graph" },
  });
  assert.equal(edited.statusCode, 200);
  const approved = await server.inject({
    method: "POST",
    url: `/api/runs/${run.id}/approve`,
    headers,
    payload: {},
  });
  assert.equal(approved.statusCode, 200);
  await engine.waitForIdle();
  const loaded = await server.inject({
    method: "GET",
    url: `/api/runs/${run.id}`,
    headers,
  });
  const completed = runSchema.parse(loaded.json());
  assert.equal(completed.status, "completed");
  assert.equal(completed.plan.title, "Reviewed graph");
  const list = await server.inject({ method: "GET", url: "/api/runs", headers });
  assert.equal(list.json()[0].revision, completed.revision);
  const logs = await server.inject({
    method: "GET",
    url: `/api/runs/${run.id}/events`,
    headers,
  });
  assert.ok(
    z
      .array(eventSchema)
      .parse(logs.json())
      .some((event) => event.kind === "run_end"),
  );
});

test("API blocks cross-origin mutations and DNS-rebinding hostnames", async (t) => {
  const { project, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "demo", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const server = await createServer(engine);
  cleanup(() => server.close());
  const missingHeader = await server.inject({
    method: "POST",
    url: "/api/runs",
    headers: { host: "127.0.0.1:4310" },
    payload: { task: "Task" },
  });
  assert.equal(missingHeader.statusCode, 403);
  const crossOrigin = await server.inject({
    method: "POST",
    url: "/api/runs",
    headers: { ...headers, origin: "https://evil.example" },
    payload: { task: "Task" },
  });
  assert.equal(crossOrigin.statusCode, 403);
  const foreignHost = await server.inject({
    method: "GET",
    url: "/api/project",
    headers: { host: "evil.example" },
  });
  assert.equal(foreignHost.statusCode, 403);
  const invalid = await server.inject({
    method: "POST",
    url: "/api/runs",
    headers,
    payload: { task: "" },
  });
  assert.equal(invalid.statusCode, 400);
});

test("auto-approval is explicit and AI planning cannot silently use demo results", async (t) => {
  const { project, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "demo", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const server = await createServer(engine);
  cleanup(() => server.close());
  const auto = await server.inject({
    method: "POST",
    url: "/api/runs",
    headers,
    payload: { task: "Bug", strategy: "bug", autoApprove: true },
  });
  assert.equal(auto.statusCode, 200);
  const started = runSchema.parse(auto.json());
  await engine.waitForIdle();
  assert.equal(engine.get(started.id).status, "completed");
  const ai = await server.inject({
    method: "POST",
    url: "/api/runs",
    headers,
    payload: { task: "Bug", strategy: "ai" },
  });
  assert.equal(ai.statusCode, 409);
  assert.match(
    z.object({ error: z.string() }).parse(ai.json()).error,
    /needs live mode/,
  );
});

test("SSE stays subscribed after the HTTP request completes and closes cleanly", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "demo", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const server = await createServer(engine);
  cleanup(() => server.close());
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(5000),
  ]);
  const response = await fetch(`http://127.0.0.1:${address.port}/api/stream`, {
    signal,
  });
  assert.ok(response.body);
  const reader = response.body.getReader();
  await reader.read();
  const draft = await engine.create(
    createTemplate("Bug", "bug", library),
    library,
  );
  const next = await reader.read();
  const text = new TextDecoder().decode(next.value);
  assert.match(text, /data:/);
  assert.match(text, new RegExp(draft.id));
  engine.coordinatorActivity("tool_start", "Reading project context");
  const coordinator = new TextDecoder().decode((await reader.read()).value);
  assert.match(coordinator, /"runId":"coordinator"/);
  assert.match(coordinator, /Reading project context/);
  controller.abort();
  await reader.cancel().catch(() => {});
  reader.releaseLock();
});

test("API preserves HTTP errors for oversized and unsupported request bodies", async (t) => {
  const { project, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "demo", passingRunner);
  const server = await createServer(engine);
  cleanup(() => server.close());
  const oversized = await server.inject({ method: "POST", url: "/api/runs", headers, payload: { task: "x".repeat(1_000_001) } });
  assert.equal(oversized.statusCode, 413);
  const unsupported = await server.inject({ method: "POST", url: "/api/runs", headers: { ...headers, "content-type": "application/octet-stream" }, payload: "data" });
  assert.equal(unsupported.statusCode, 415);
  const malformed = await server.inject({ method: "POST", url: "/api/runs", headers: { ...headers, "content-type": "application/json" }, payload: "{" });
  assert.equal(malformed.statusCode, 400);
});

test("stale browser revisions cannot overwrite or approve a newer draft", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "demo", passingRunner);
  const server = await createServer(engine);
  cleanup(() => server.close());
  const draft = await engine.create(createTemplate("Review revision", "feature", library), library);
  const loaded = await server.inject({ method: "GET", url: `/api/runs/${draft.id}`, headers });
  assert.equal(loaded.headers.etag, '"0"');
  const reviewed = { ...headers, "if-match": '"0"' };
  const first = await server.inject({ method: "PUT", url: `/api/runs/${draft.id}/plan`, headers: reviewed, payload: { ...draft.plan, title: "First tab's changes" } });
  assert.equal(first.statusCode, 200);
  const staleSave = await server.inject({ method: "PUT", url: `/api/runs/${draft.id}/plan`, headers: reviewed, payload: { ...draft.plan, title: "Stale tab" } });
  assert.equal(staleSave.statusCode, 409);
  assert.match(staleSave.json().error, /Draft changed/);
  const staleApproval = await server.inject({ method: "POST", url: `/api/runs/${draft.id}/approve`, headers: reviewed, payload: {} });
  assert.equal(staleApproval.statusCode, 409);
  assert.match(staleApproval.json().error, /Draft changed/);
  assert.equal(engine.get(draft.id).status, "draft");
  assert.equal(engine.get(draft.id).plan.title, "First tab's changes");
  const malformed = await server.inject({ method: "PUT", url: `/api/runs/${draft.id}/plan`, headers: { ...headers, "if-match": "invalid" }, payload: draft.plan });
  assert.equal(malformed.statusCode, 400);
  const blank = await server.inject({ method: "POST", url: "/api/runs", headers, payload: { task: " \n\t " } });
  assert.equal(blank.statusCode, 400);
});

test("deletion API removes a task and its draft together and returns durable revision markers", async t => {
  const { project, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "demo", passingRunner);
  cleanup(() => engine.shutdown()); await engine.initialize();
  const server = await createServer(engine); cleanup(() => server.close());
  const created = (await server.inject({ method: "POST", url: "/api/tasks", headers, payload: { prompt: "Delete a proposed task" } })).json();
  let task = created;
  for (let i = 0; i < 100 && !task.runId; i++) {
    await new Promise(resolve => setTimeout(resolve, 30));
    task = (await server.inject({ method: "GET", url: `/api/tasks/${created.id}`, headers })).json();
  }
  assert.ok(task.runId);
  const missingHeader = await server.inject({ method: "DELETE", url: `/api/runs/${task.runId}`, headers: { host: "127.0.0.1:4310" } });
  assert.equal(missingHeader.statusCode, 403);
  const removed = await server.inject({ method: "DELETE", url: `/api/runs/${task.runId}`, headers });
  assert.equal(removed.statusCode, 200); assert.ok(removed.json().deletedAt);
  const tasks = (await server.inject({ method: "GET", url: "/api/tasks", headers })).json();
  assert.ok(tasks[0].deletedAt); assert.ok(tasks[0].revision > task.revision);
  assert.equal(engine.list().length, 0);
  const again = await server.inject({ method: "DELETE", url: `/api/tasks/${task.id}`, headers });
  assert.equal(again.statusCode, 200); assert.equal(again.json().revision, tasks[0].revision);
  const health = await server.inject({ method: "GET", url: "/api/health", headers });
  assert.equal(health.json().pid, process.pid);
});

test("cancelling HTTP refinement stops its model work and cannot publish a late graph", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  const draft = await engine.create(createTemplate("Cancellable refinement", "feature", library), library);
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const server = await createServer(engine, 0, {
    catalog: async () => ({ models: [], warnings: [] }),
    plan: async (options) => {
      calls++;
      if (calls === 1) { entered.resolve(options.signal); await release.promise; }
      return { ...options.previousPlan!, title: "Refined graph" };
    },
  });
  cleanup(() => server.close());
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  const controller = new AbortController();
  const options = { method: "POST", headers: { "content-type": "application/json", "x-workflow-client": "1" }, body: JSON.stringify({ instructions: "Simplify the graph" }) };
  const response = fetch(`${address}/api/runs/${draft.id}/refine`, { ...options, signal: controller.signal });
  const rejected = assert.rejects(response, /abort/i);
  const modelSignal = await entered.promise;
  controller.abort();
  await rejected;
  for (let tries = 0; !modelSignal.aborted && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(modelSignal.aborted, true);
  release.resolve();
  let retried: Response | undefined;
  for (let tries = 0; tries < 100; tries++) {
    assert.equal(engine.get(draft.id).revision, draft.revision, "Cancelled result must never replace the draft");
    retried = await fetch(`${address}/api/runs/${draft.id}/refine`, options);
    if (retried.ok) break;
    assert.match(await retried.text(), /in progress/);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(retried?.status, 200);
  assert.equal(engine.get(draft.id).plan.title, "Refined graph");
  assert.equal(calls, 2);
});

test("cancelling HTTP workflow creation stops planning and cannot publish or auto-approve its result", async t => {
  const { project, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  let approvals = 0;
  engine.approve = async () => { approvals++; throw new Error("Cancelled requests must not start workflows"); };
  const server = await createServer(engine, 0, {
    catalog: async () => ({ models: [], warnings: [] }),
    plan: async options => {
      entered.resolve(options.signal); await release.promise;
      return createTemplate(options.task, "feature", options.library);
    },
  });
  cleanup(() => server.close()); cleanup(async () => { release.resolve(); });
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  const controller = new AbortController();
  const response = fetch(`${address}/api/runs`, {
    method: "POST", headers: { "content-type": "application/json", "x-workflow-client": "1" },
    body: JSON.stringify({ task: "Cancelled request", strategy: "ai", autoApprove: true }), signal: controller.signal,
  });
  const rejected = assert.rejects(response, /abort/i);
  const signal = await entered.promise;
  controller.abort(); await rejected;
  for (let tries = 0; !signal.aborted && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  release.resolve();
  assert.equal(signal.aborted, true);
  let refreshed;
  for (let tries = 0; tries < 100; tries++) {
    refreshed = await server.inject({ method: "POST", url: "/api/models/refresh", headers });
    if (refreshed.statusCode === 200) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(refreshed?.statusCode, 200);
  assert.equal(engine.list(true).length, 0);
  assert.equal(approvals, 0);
});

test("cancelling HTTP creation while saving a draft removes it before auto-approval", async t => {
  const { project, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const create = engine.create.bind(engine);
  const disconnected = Promise.withResolvers<void>();
  let approvals = 0;
  engine.create = async (...args) => { entered.resolve(); await release.promise; return await create(...args); };
  engine.approve = async () => { approvals++; throw new Error("Cancelled requests must not start workflows"); };
  const server = await createServer(engine, 0, { catalog: async () => ({ models: [], warnings: [] }) });
  server.addHook("onRequest", async (request, reply) => {
    if (request.method === "POST" && request.url === "/api/runs") reply.raw.once("close", () => disconnected.resolve());
  });
  cleanup(() => server.close()); cleanup(async () => { release.resolve(); });
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  const controller = new AbortController();
  const response = fetch(`${address}/api/runs`, {
    method: "POST", headers: { "content-type": "application/json", "x-workflow-client": "1" },
    body: JSON.stringify({ task: "Cancel during storage", strategy: "feature", autoApprove: true }), signal: controller.signal,
  });
  const rejected = assert.rejects(response, /abort/i);
  await entered.promise;
  controller.abort(); await rejected;
  await disconnected.promise;
  release.resolve();
  let refreshed;
  for (let tries = 0; tries < 100; tries++) {
    refreshed = await server.inject({ method: "POST", url: "/api/models/refresh", headers });
    if (refreshed.statusCode === 200) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(refreshed?.statusCode, 200);
  assert.equal(engine.list().length, 0);
  assert.equal(engine.list(true).length, 1);
  assert.ok(engine.list(true)[0]!.deletedAt);
  assert.equal(approvals, 0);
});
