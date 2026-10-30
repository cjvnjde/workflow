import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MemoryStore } from "../src/memory-store.js";
import { assertStrategyRun, previewStrategy, strategyMetadata } from "../src/workflow-strategy.js";
import { rememberStrategySchema } from "../src/memory-schema.js";
import { runSchema, type WorkflowRun } from "../src/domain.js";
import { emptyUsage } from "../src/budget.js";
import { usageSessionSchema } from "../src/usage-schema.js";
import { createTemplate } from "../src/templates.js";
import { fixture } from "./helpers.js";

async function sample(t: test.TestContext) {
  const { project, library } = await fixture(t);
  const run = runSchema.parse({ id: randomUUID(), revision: 7, executionProtocol: 2, createdAt: "2026-10-30T10:00:00Z", updatedAt: "2026-10-30T10:02:00Z", approvedAt: "2026-10-30T10:01:00Z",
    mode: "live", status: "completed", plan: createTemplate("PRIVATE_TASK_REQUEST", "bug", library), config: library.config, blocks: library.blocks,
    cursor: "$complete", visits: { prepare: 1 }, artifacts: { prepare: { data: "PRIVATE_LATEST_ARTIFACT" } }, attempts: [{ nodeId: "prepare", visit: 1, startedAt: "2026-10-30T10:01:00Z", finishedAt: "2026-10-30T10:02:00Z",
      result: { outcome: "pass", disposition: "accepted", summary: "PRIVATE_RESULT", artifacts: { data: '"PRIVATE_ARTIFACT"' } }, checks: [{ command: "PRIVATE_COMMAND", expected: "failure", exitCode: 1, matched: true, output: "PRIVATE_CHECK_OUTPUT" }],
    }] });
  run.plan.title = "PRIVATE_RUN_TITLE"; run.plan.nodes.forEach(node => node.goal = "PRIVATE_GOAL");
  Object.values(run.blocks).forEach(bundle => bundle.prompt = "PRIVATE_PROMPT");
  run.config.agent = { provider: "test", model: "configured", thinking: "low", timeoutMs: 1000, maxToolCalls: 10 };
  return { project, run, store: new MemoryStore(project) };
}
function modelSession(run: WorkflowRun, model = "actual") {
  return usageSessionSchema.parse({ id: randomUUID(), scopeId: randomUUID(), operationId: run.id + "/call", phase: "execution", runId: run.id, nodeId: "prepare", visit: 1,
    provider: "test", model, thinking: "low", pricing: { source: "catalog", rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    usage: { ...emptyUsage(), inputTokens: 10, requests: 1, costUsd: 0.01 }, status: "completed", startedAt: "now", updatedAt: "now",
  });
}
async function request(store: MemoryStore, run: WorkflowRun) {
  const preview = await previewStrategy(store, run, [modelSession(run)]);
  return { preview, body: { sourceRunRevision: preview.sourceRunRevision, memoryRevision: preview.memoryRevision, ...preview.entry } };
}

test("strategy preview is deterministic and read-only without retaining private payloads", async t => {
  const { project, store, run } = await sample(t);
  const actual = modelSession(run);
  const first = await previewStrategy(store, run, [actual], { id: randomUUID(), caseId: "bugfix", caseName: "Bug fixing" });
  const again = await previewStrategy(store, run, [actual], { id: first.metadata.sourceTaskId!, caseId: "bugfix", caseName: "Bug fixing" });
  assert.deepEqual(first, again); assert.equal(first.memoryEnabled, false); assert.equal(first.existingEntry, null);
  assert.equal(first.metadata.roles.length, 1); assert.equal(first.metadata.models[0]!.source, "observed");
  assert.equal(first.metadata.checks.matched, 1); assert.equal(first.metadata.dispositions.accepted, 1);
  assert.match(first.entry.details, /fresh workflow/); assert.match(first.entry.details, /optional historical hints/);
  assert.ok(!JSON.stringify(first).includes("PRIVATE_"), "No task, goal, prompt, command, result, artifact or source text is copied");
  await assert.rejects(access(path.join(project, ".workflow/memory")));
  const abort = new AbortController(); abort.abort(new Error("Preview closed"));
  await assert.rejects(previewStrategy(store, run, [], undefined, abort.signal), /Preview closed/);
  await assert.rejects(access(path.join(project, ".workflow/memory")));
});

test("metadata retains bounded roles and model hints with explicit omitted and configured counts", async t => {
  const { run } = await sample(t);
  const base = run.plan.nodes[0]!;
  run.plan.nodes = Array.from({ length: 16 }, (_, index) => ({ ...structuredClone(base), id: "step-" + index, label: "Role " + index }));
  run.attempts = run.plan.nodes.map(node => ({ ...structuredClone(run.attempts[0]!), nodeId: node.id }));
  const sessions = Array.from({ length: 17 }, (_, index) => ({ ...modelSession(run, index === 16 ? "x".repeat(257) : "model-" + index), nodeId: "step-0" }));
  const metadata = strategyMetadata(run, sessions);
  assert.equal(metadata.roles.length, 12); assert.equal(metadata.omittedRoles, 4);
  assert.equal(metadata.models.length, 12); assert.equal(metadata.omittedModels, 6);
  assert.ok(metadata.models.every(model => model.source === "observed"), "Observed use has priority over configured hints");
  assert.equal(metadata.roles[0]!.modelHints.length, 4); assert.equal(metadata.roles[0]!.omittedModelHints, 13);
  assert.equal(metadata.roles[1]!.modelHints[0]!.source, "configured");
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 64 * 1024);
  run.plan.nodes = [];
  const missing = strategyMetadata(run, sessions);
  assert.equal(missing.roles.length, 0); assert.equal(missing.omittedRoles, 16);
});

test("legacy run totals and unidentified model sessions are reconciled without double counting", async t => {
  const { run } = await sample(t);
  run.executionProtocol = undefined;
  run.usage = { ...emptyUsage(), costUsd: 9, requests: 3, inputTokens: 90 };
  const old = strategyMetadata(run, []);
  assert.equal(old.usage.costUsd, 9); assert.equal(old.usage.requests, 3); assert.equal(old.usageIncomplete, true);
  run.attempts[0]!.usage = { ...emptyUsage(), costUsd: 5, requests: 2, inputTokens: 50 };
  const unassociated = { ...modelSession(run), nodeId: undefined, visit: undefined, usage: { ...emptyUsage(), costUsd: 5, requests: 2, inputTokens: 50 } };
  const combined = strategyMetadata(run, [unassociated, unassociated]);
  assert.equal(combined.usage.costUsd, 9); assert.equal(combined.usage.requests, 3); assert.equal(combined.usage.inputTokens, 90);
  assert.equal(combined.usageIncomplete, true);
  run.usage = undefined; run.attempts[0]!.usage = undefined;
  assert.equal(strategyMetadata(run, []).usageIncomplete, true);
});

test("only completed available sources qualify and demo provenance remains explicit", async t => {
  const { store, run } = await sample(t);
  for (const status of ["draft", "running", "failed", "cancelled", "interrupted"] as const) assert.throws(() => assertStrategyRun({ ...run, status }), /completed/);
  assert.throws(() => assertStrategyRun({ ...run, deletedAt: "now" }), /available/);
  assert.throws(() => assertStrategyRun(run, run.revision + 1), /changed/);
  const demo = await previewStrategy(store, { ...run, mode: "demo" }, []);
  assert.equal(demo.metadata.mode, "demo"); assert.equal(demo.metadata.usageIncomplete, true);
  assert.match(demo.entry.details, /demo simulation/);
});

test("explicit save preserves memory-off and concurrent duplicate clicks share one strategy", async t => {
  const { project, store, run } = await sample(t);
  const { preview, body } = await request(store, run);
  const saved = await Promise.all([store.rememberStrategy(body, preview.metadata, () => assertStrategyRun(run, body.sourceRunRevision)),
    new MemoryStore(project).rememberStrategy(body, preview.metadata, () => assertStrategyRun(run, body.sourceRunRevision))]);
  assert.equal(saved[0]!.entry.id, saved[1]!.entry.id);
  assert.equal(saved.filter(result => result.reused).length, 1);
  assert.equal(saved[0]!.state.enabled, false); assert.equal(saved[0]!.entry.kind, "strategy");
  assert.deepEqual((await store.descriptions()).entries, []);
  const initialText = await readFile(path.join(project, ".workflow/memory/state.json"), "utf8");
  const repeated = await store.rememberStrategy(body, preview.metadata, () => {});
  assert.equal(repeated.reused, true);
  assert.equal(await readFile(path.join(project, ".workflow/memory/state.json"), "utf8"), initialText);
  await store.setEnabled({ enabled: true, revision: (await store.state()).revision });
  const catalog = await store.descriptions();
  assert.equal(catalog.entries[0]!.kind, "strategy"); assert.ok(!JSON.stringify(catalog).includes("Compose a fresh workflow"));
  assert.equal((await store.detail(saved[0]!.entry.id))!.strategy!.sourceRunId, run.id);
});

test("existing user edits and deleted strategies survive conflicting or stale repeated saves", async t => {
  const { store, run } = await sample(t);
  const { preview, body } = await request(store, run);
  const saved = await store.rememberStrategy(body, preview.metadata, () => {});
  const updated = await store.update(saved.entry.id, { revision: saved.state.revision, title: "User title", description: "User description", details: "User-authored strategy" });
  assert.deepEqual(updated.entry.strategy, JSON.parse(JSON.stringify(saved.entry.strategy)), "Provenance stays immutable");
  await assert.rejects(store.rememberStrategy(body, preview.metadata, () => {}), /different content/);
  const refreshed = await previewStrategy(store, run, []);
  assert.equal(refreshed.existingEntry!.id, saved.entry.id); assert.equal(refreshed.entry.details, "User-authored strategy");
  assert.deepEqual(refreshed.metadata, JSON.parse(JSON.stringify(saved.entry.strategy)));
  await store.remove(saved.entry.id, { revision: updated.state.revision });
  await assert.rejects(store.rememberStrategy(body, preview.metadata, () => {}), /changed in another session/);
  assert.deepEqual((await store.state()).entries, []);
});

test("revision, strict payload and cancellation checks prevent unintended saves", async t => {
  const { project, store, run } = await sample(t);
  const { preview, body } = await request(store, run);
  assert.throws(() => rememberStrategySchema.parse({ ...body, graph: run.plan }), /Unrecognized/);
  await assert.rejects(store.rememberStrategy({ ...body, sourceRunRevision: 99 }, preview.metadata, () => {}), /Source workflow changed/);
  const early = new AbortController(); early.abort(new Error("Cancelled before save"));
  await assert.rejects(store.rememberStrategy(body, preview.metadata, () => {}, early.signal), /Cancelled/);
  await assert.rejects(access(path.join(project, ".workflow/memory")));
  const during = new AbortController();
  let checks = 0;
  await assert.rejects(store.rememberStrategy(body, preview.metadata, () => { if (++checks === 2) { during.abort(new Error("Cancelled before publication")); during.signal.throwIfAborted(); } }, during.signal), /Cancelled before publication/);
  assert.deepEqual((await store.state()).entries, []);
  await assert.rejects(store.rememberStrategy(body, preview.metadata, () => { throw new Error("Source deleted"); }), /Source deleted/);
  assert.deepEqual((await store.state()).entries, []);
  const note = await store.create({ revision: (await store.state()).revision, kind: "note", title: "Other client", description: "Concurrent edit", details: "" });
  await assert.rejects(store.rememberStrategy(body, preview.metadata, () => {}), /changed in another session/);
  assert.equal((await store.state()).entries[0]!.id, note.entry.id);
});

test("automatic capacity never evicts a user-endorsed strategy", async t => {
  const { store, run } = await sample(t);
  const { preview, body } = await request(store, run);
  const saved = await store.rememberStrategy(body, preview.metadata, () => {});
  let state = await store.setEnabled({ enabled: true, revision: saved.state.revision });
  for (let index = 0; index < 99; index++) state = (await store.create({ revision: state.revision, kind: "note", title: "Note " + index, description: "Keep this", details: "" })).state;
  await store.enroll(run);
  const observed = await store.observe(run, [modelSession(run)]);
  assert.equal(observed.changed, false); assert.equal(observed.skipped, 1); assert.equal(observed.evicted, 0);
  assert.equal((await store.get(saved.entry.id)).kind, "strategy");
});
