import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { EvidenceStore } from "../src/evidence-store.js";
import { serializeEvidenceValue, serializeStepEvidence, EVIDENCE_CHUNK_MAX_BYTES, type AttemptEvidence, type StoredEvidenceValue } from "../src/evidence-schema.js";
import { runSchema } from "../src/domain.js";
import { createTemplate } from "../src/templates.js";
import { RunStore } from "../src/run-store.js";
import { usageSessionSchema } from "../src/usage-schema.js";
import { emptyUsage } from "../src/budget.js";
import { createHttpServer } from "../src/http-server.js";
import type { WorkflowApplication } from "../src/application.js";
import { WorkflowClient } from "../src/client.js";
import { fixture } from "./helpers.js";

async function sample(t: test.TestContext) {
  const { project, library } = await fixture(t);
  const id = randomUUID();
  const run = runSchema.parse({ id, createdAt: "now", updatedAt: "now", mode: "demo", status: "completed", plan: createTemplate("Evidence", "bug", library), config: library.config, blocks: library.blocks, cursor: "$complete", visits: { prepare: 2 }, artifacts: { prepare: { data: '"latest"' } }, attempts: [
    { nodeId: "prepare", visit: 1, startedAt: "now", finishedAt: "now", result: { outcome: "pass", summary: "First visit", artifacts: { data: '{"count":2,"ok":true,"nested":[null,"2"]}', notes: "Complete notes" } } },
    { nodeId: "prepare", visit: 2, startedAt: "later", finishedAt: "later", result: { outcome: "pass", summary: "Second visit", artifacts: { data: '"latest"' } } },
  ] });
  const identity = { runId: id, nodeId: "prepare", visit: 1 };
  return { project, run, identity, store: new EvidenceStore(project) };
}
async function content(store: EvidenceStore, evidence: AttemptEvidence, value: StoredEvidenceValue) {
  assert.equal(value.state, "captured");
  if (value.state !== "captured") throw new Error("not captured");
  return (await store.content(evidence, value.ref.id)).data.toString("utf8");
}

test("typed snapshots preserve JSON and explicitly reject lossy values without invoking getters", () => {
  const input = { count: 123, label: "123", enabled: false, empty: null, values: [1, { n: 2 }] };
  assert.deepEqual(serializeEvidenceValue(input), { state: "json", value: input });
  assert.deepEqual(serializeEvidenceValue(undefined), { state: "undefined" });
  let calls = 0;
  const getter = { get value() { calls++; return 1; } };
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const value of [new Date(), NaN, Infinity, -0, { missing: undefined }, [undefined], Array(1), getter, circular, 1n, () => 1]) assert.equal(serializeEvidenceValue(value).state, "unavailable");
  assert.equal(calls, 0);
  const large = serializeEvidenceValue("x".repeat(2 * 1024 * 1024));
  assert.equal(large.state, "unavailable");
  if (large.state === "unavailable") assert.equal(large.reasonCode, "oversized");
});

test("chunked Unicode inputs publish atomically, survive restart, and preserve exact effective values", async t => {
  const { project, store, run, identity } = await sample(t);
  const raw = { frontend: { files: ["ui.ts"], tests: 2 }, backend: { files: ["api.ts"], tests: 3 }, text: "😀Привіт".repeat(45_000) };
  const effective = { ...raw, defaulted: true };
  const packets = serializeStepEvidence({ kind: "inputs", raw: serializeEvidenceValue(raw), effective: serializeEvidenceValue(effective), prompt: "Join results", dependencies: [
    { producerNodeId: "frontend", producerVisit: 1, kind: "output", usedBy: "inputs" },
    { producerNodeId: "backend", producerVisit: 2, kind: "result", usedBy: "inputs" },
  ] });
  assert.ok(packets.length > 1);
  for (const packet of packets) if (packet.kind === "chunk") assert.ok(Buffer.byteLength(packet.data) <= EVIDENCE_CHUNK_MAX_BYTES);
  await store.captureStep(identity, packets[0]!);
  assert.equal((await store.readAttempt(run, identity)).inputs.state, "unavailable");
  const restarted = new EvidenceStore(project);
  for (const packet of packets) await restarted.captureStep(identity, packet);
  const evidence = await restarted.readAttempt(run, identity);
  assert.equal(evidence.inputs.state, "available");
  if (evidence.inputs.state !== "available") return;
  assert.deepEqual(JSON.parse(await content(store, evidence, evidence.inputs.value.raw)), raw);
  assert.deepEqual(JSON.parse(await content(store, evidence, evidence.inputs.value.effective)), effective);
  assert.equal(evidence.inputs.value.dependencies[1]!.producerVisit, 2);
  assert.equal(await content(store, evidence, evidence.inputs.value.prompt), "Join results");
  const ref = evidence.inputs.value.raw;
  if (ref.state === "captured") assert.equal((await stat(path.join(project, ".workflow/runs", run.id, "attempts/prepare-1/evidence/content", ref.ref.id))).mode & 0o777, 0o600);
});

test("historical output comes from selected attempt and survives more than 500 activity events", async t => {
  const { project, store, run, identity } = await sample(t);
  const events = new RunStore(path.join(project, ".workflow/runs"));
  for (let index = 0; index < 510; index++) events.record({ id: String(index), runId: run.id, time: "now", kind: "text_delta", message: String(index) });
  await events.flush();
  const evidence = await store.readAttempt(run, identity);
  assert.equal(evidence.inputs.state, "unavailable");
  assert.equal(evidence.output.state, "available");
  if (evidence.output.state !== "available") return;
  assert.deepEqual(JSON.parse(await content(store, evidence, evidence.output.value.data)), { count: 2, ok: true, nested: [null, "2"] });
  assert.equal((await store.content(evidence, evidence.output.value.artifacts.notes!.id)).data.toString(), "Complete notes");
  assert.equal((await events.events(run.id)).length, 500);
});

test("AI context uses cost session identity and stores full prompts, continuations, tools and images", async t => {
  const { store, run, identity } = await sample(t);
  const sessionId = randomUUID(), operationId = `${run.id}/activity-7`;
  const session = { ...identity, sessionId, operationId, activityAttempt: 2 };
  const long = "application context ".repeat(3000);
  const usage = usageSessionSchema.parse({ id: sessionId, scopeId: randomUUID(), phase: "execution", operationId, runId: run.id, nodeId: identity.nodeId, visit: 1, activityAttempt: 2,
    provider: "provider", model: "model", thinking: "low", pricing: { source: "unknown", rates: null }, usage: emptyUsage(), status: "completed", startedAt: "now", updatedAt: "now", endedAt: "later" });
  await store.captureCall(identity, operationId, { prompt: long, instructions: "Focused instructions", contextMode: "none" });
  await store.captureSessionContext(session, { systemPrompt: long, settings: { provider: "provider", model: "model", thinking: "low", timeoutMs: 1000, maxToolCalls: 4 }, tools: [{ name: "inspect", description: "Inspect", parameters: { type: "object" } }], contextMode: "none" });
  await store.captureSessionPrompt(session, { index: 0, kind: "initial", text: long, images: [{ mimeType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") }] });
  await store.captureSessionPrompt(session, { index: 1, kind: "continuation", text: "Submit the collected result" });
  await store.captureSessionTool(session, { callId: "read/1", state: "started", input: { path: "README.md" } });
  await store.captureSessionTool(session, { callId: "read/1", state: "completed", output: [{ type: "text", text: long }], details: { lines: 123 } });
  const mutable = { path: "original" };
  const pending = store.captureSessionTool(session, { callId: "mutable", name: "inspect", state: "started", input: mutable });
  mutable.path = "mutated after submission";
  await pending;
  const evidence = await store.readAttempt(run, identity, [usage]);
  const captured = evidence.sessions[0]!;
  assert.equal(captured.sessionId, usage.id);
  assert.equal(captured.operationId, operationId);
  assert.equal(captured.activityAttempt, 2);
  assert.deepEqual(captured.usage, usage);
  assert.equal(captured.context.state, "available");
  if (captured.context.state === "available") assert.equal((await store.content(evidence, captured.context.value.systemPrompt.id)).data.toString(), long);
  assert.equal(await content(store, evidence, captured.prompts[0]!.text), long);
  assert.equal(await content(store, evidence, captured.prompts[1]!.text), "Submit the collected result");
  const read = captured.tools.find(tool => tool.callId === "read/1")!;
  assert.deepEqual(JSON.parse(await content(store, evidence, read.input!)), { path: "README.md" });
  assert.deepEqual(JSON.parse(await content(store, evidence, read.output!)), [{ type: "text", text: long }]);
  const inspect = captured.tools.find(tool => tool.callId === "mutable")!;
  assert.equal(inspect.name, "inspect");
  assert.deepEqual(JSON.parse(await content(store, evidence, inspect.input!)), { path: "original" });
  assert.equal(captured.call.state, "available");
});

test("input validation failure is distinct from missing historical evidence", async t => {
  const { store, run, identity } = await sample(t);
  await store.captureStep(identity, { kind: "inputs", raw: serializeEvidenceValue({ count: "wrong" }), effective: { state: "unavailable", reasonCode: "validation-failed", reason: "Expected a number" }, prompt: "Validate input", dependencies: [], inputError: "count: Expected a number" });
  const evidence = await store.readAttempt(run, identity);
  assert.equal(evidence.inputs.state, "available");
  if (evidence.inputs.state !== "available") return;
  assert.equal(evidence.inputs.value.inputError, "count: Expected a number");
  assert.equal(evidence.inputs.value.effective.state, "unavailable");
  assert.deepEqual(JSON.parse(await content(store, evidence, evidence.inputs.value.raw)), { count: "wrong" });
});

test("content rejects traversal, other visits, symlink escapes and tampering; metadata is immutable", async t => {
  const { project, store, run, identity } = await sample(t);
  const capture = { kind: "inputs" as const, raw: serializeEvidenceValue({ exact: 1 }), effective: serializeEvidenceValue({ exact: 1 }), prompt: "Test", dependencies: [] };
  await Promise.all([store.captureStep(identity, capture), new EvidenceStore(project).captureStep(identity, capture)]);
  await assert.rejects(store.captureStep(identity, { ...capture, prompt: "Changed" }), /immutable/);
  const evidence = await store.readAttempt(run, identity);
  assert.equal(evidence.inputs.state, "available");
  if (evidence.inputs.state !== "available" || evidence.inputs.value.raw.state !== "captured") return;
  const id = evidence.inputs.value.raw.ref.id;
  await assert.rejects(store.content(evidence, "../run.json"));
  const other = await store.readAttempt(run, { ...identity, visit: 2 });
  await assert.rejects(store.content(other, id), /not found in this attempt/);
  const filename = path.join(project, ".workflow/runs", run.id, "attempts/prepare-1/evidence/content", id);
  const bytes = await readFile(filename);
  await writeFile(filename, "tampered");
  await assert.rejects(store.content(evidence, id), /integrity/);
  await rm(filename);
  const external = path.join(project, "outside-evidence");
  await writeFile(external, bytes); await symlink(external, filename);
  await assert.rejects(store.content(evidence, id), /outside/);
});

test("API and shared client expose complete content with download headers and safe IDs", async t => {
  const { store, run, identity } = await sample(t);
  const evidence = await store.readAttempt(run, identity);
  const app = {
    attemptEvidence: async (id: string, nodeId: string, visit: number) => store.readAttempt(run, { runId: id, nodeId, visit }),
    evidenceContent: async (id: string, nodeId: string, visit: number, contentId: string) => store.content(await store.readAttempt(run, { runId: id, nodeId, visit }), contentId),
  } as unknown as WorkflowApplication;
  const server = await createHttpServer(app);
  t.after(() => server.close());
  const prefix = `/api/runs/${run.id}/attempts/prepare/1`;
  const headers = { host: "127.0.0.1:4310" };
  assert.equal((await server.inject({ url: `${prefix}/evidence`, headers })).statusCode, 200);
  assert.equal((await server.inject({ url: `/api/runs/${run.id}/attempts/prepare/-1/evidence`, headers })).statusCode, 400);
  assert.equal((await server.inject({ url: `/api/runs/${run.id}/attempts/prepare/3/evidence`, headers })).statusCode, 404);
  assert.equal((await server.inject({ url: `${prefix}/content/${"a".repeat(64)}`, headers })).statusCode, 404);
  assert.equal(evidence.output.state, "available");
  if (evidence.output.state !== "available") return;
  const ref = evidence.output.value.summary;
  const response = await server.inject({ url: `${prefix}/content/${ref.id}?download=1`, headers });
  assert.equal(response.body, "First visit");
  assert.match(String(response.headers["content-disposition"]), /^attachment/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  const client = new WorkflowClient({ baseUrl: "http://127.0.0.1:4310", fetch: Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const response = await server.inject({ url: new URL(String(input)).pathname, headers });
    return new Response(response.body, { status: response.statusCode });
  }, { preconnect: fetch.preconnect }) });
  assert.deepEqual(await client.attemptEvidence(run.id, "prepare", 1), evidence);
  assert.equal(await client.evidenceContent(run.id, "prepare", 1, ref.id), "First visit");
  assert.match(client.evidenceContentUrl(run.id, "prepare", 1, ref.id, true), /\?download=1$/);
});
