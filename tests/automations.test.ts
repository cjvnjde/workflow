import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "vitest";
import { runSchema, type WorkflowRun } from "../src/contracts/domain.js";
import {
  automationConfigSchema,
  workSignalSchema,
  type AutomationConfig,
  type AutomationExecution,
  type AutomationJob,
  type AutomationJson,
  type AutomationRunOwnership,
  type AutomationTarget,
  type WorkSignal,
} from "../src/contracts/automation-schema.js";
import { Automations } from "../src/core/automations/automations.js";
import type { AutomationAccountingEngine } from "../src/core/automations/accounting.js";
import { usageReportSchema, usageSessionSchema } from "../src/contracts/usage-schema.js";
import { createTemplate } from "../src/core/library/templates.js";
import { emptyUsage } from "../src/core/execution/budget.js";
import { fixture } from "./helpers.js";

const epoch = Date.parse("2026-11-03T12:00:00.000Z");
const target = { kind: "block", blockId: "main" } as const;
const reaction = { kind: "block", blockId: "reaction" } as const;
const advanceRoute = {
  id: "advance",
  signalKind: "changed",
  revisionPolicy: "advance",
  target: reaction,
} as const;

function signal(resource = "item-1", values: Partial<WorkSignal> = {}) {
  return workSignalSchema.parse({
    sourceId: "local-inbox",
    resourceKey: resource,
    signalKind: "changed",
    revision: "r1",
    fingerprint: "content-1",
    observedAt: new Date(epoch).toISOString(),
    payload: { accepted: true },
    references: { item: `https://example.invalid/${resource}` },
    ...values,
  });
}

function config(values: Record<string, unknown> = {}): AutomationConfig {
  return automationConfigSchema.parse({
    name: "Durable work",
    enabled: true,
    schedule: { kind: "manual" },
    target,
    policy: { overlap: "queue" },
    ...values,
  });
}

/** Only the executor is fake: queue, observations, snapshots and transactions use real SQLite. */
async function setup(t: TestContext) {
  const { project, library, cleanup } = await fixture(t);
  let time = epoch;
  const template = runSchema.parse({
    id: randomUUID(),
    createdAt: new Date(epoch).toISOString(),
    updatedAt: new Date(epoch).toISOString(),
    mode: "demo",
    status: "completed",
    plan: createTemplate("Frozen target", "bug", library),
    config: library.config,
    blocks: library.blocks,
    executionProtocol: 2,
    executionVersion: "a".repeat(64),
    cursor: "prepare",
    visits: {},
    attempts: [],
    artifacts: {},
    program: {
      source: "frozen-v1",
      input: { retained: true },
      catalog: library.blocks,
      models: {},
      composition: "graph",
    },
  });
  const runs = new Map<string, WorkflowRun>();
  const reservations = new Map<string, string>();
  const ownerships = new Map<string, AutomationRunOwnership>();
  const cleaned: string[] = [];
  const dirty = new Set<string>();
  const starts = new Map<string, number>();
  const effects = new Map<string, number>();
  const handlers = new Map<string, (run: WorkflowRun) => void>();
  const publications = new Map<string, string>();
  let creations = 0,
    approvals = 0,
    snapshots = 0,
    modelCalls = 0,
    plannerCalls = 0;
  const engine = {
    project,
    mode: "demo" as const,
    usage: undefined as AutomationAccountingEngine["usage"],
    list: (includeDeleted = false) =>
      [...runs.values()]
        .filter((run) => includeDeleted || !run.deletedAt)
        .map((run) => ({ ...structuredClone(run), title: run.plan.title, task: run.plan.task })),
    get: (id: string) => {
      const run = runs.get(id);
      if (!run) throw new Error("Workflow not found");
      return structuredClone(run);
    },
    snapshotForAutomation: async (selected: AutomationTarget, execution: AutomationExecution) => {
      snapshots++;
      const frozen = structuredClone(template);
      frozen.plan.title = selected.kind === "block" ? selected.blockId : selected.runId;
      if (execution.maxCostUsd !== undefined)
        frozen.config.budget = { ...frozen.config.budget!, maxCostUsd: execution.maxCostUsd };
      return frozen;
    },
    createAutomatedRun: async (
      frozen: WorkflowRun,
      id: string,
      input: Record<string, AutomationJson>,
      ownership: AutomationRunOwnership,
    ) => {
      if (ownership.previousRunId) {
        assert.ok(!dirty.has(ownership.previousRunId), "a dirty workspace cannot be continued");
        assert.ok(
          ["completed", "failed", "cancelled"].includes(runs.get(ownership.previousRunId)!.status),
          "a continuation requires a terminal parent",
        );
      }
      const reservation = createHash("sha256")
        .update(JSON.stringify({ frozen, input, ownership }))
        .digest("hex");
      if (runs.has(id)) {
        assert.equal(
          reservations.get(id),
          reservation,
          "a stable run must retain its frozen input and execution policy",
        );
        return engine.get(id);
      }
      creations++;
      reservations.set(id, reservation);
      ownerships.set(id, structuredClone(ownership));
      const run = structuredClone(frozen);
      run.id = id;
      run.status = "draft";
      run.revision = 0;
      run.attempts = [];
      run.artifacts = {};
      run.usage = emptyUsage();
      delete run.outputValue;
      run.program!.input = { ...run.program!.input, ...structuredClone(input) };
      run.automation = {
        automationId: ownership.automationId,
        jobId: ownership.jobId,
        workspace: ownership.workspace,
        root: ownership.workspace === "project" ? project : `${project}/owned/${id}`,
        reservation,
        execution: structuredClone(ownership.execution),
      };
      runs.set(id, run);
      return engine.get(id);
    },
    approve: async (id: string, revision?: number) => {
      const run = runs.get(id)!;
      assert.equal(run.status, "draft", "an effectful run must never be approved twice");
      if (revision !== undefined) assert.equal(run.revision, revision);
      approvals++;
      starts.set(id, (starts.get(id) ?? 0) + 1);
      run.status = "running";
      run.revision++;
      const input = run.program!.input;
      const effectKey = typeof input.effectKey === "string" ? input.effectKey : run.plan.title;
      effects.set(
        effectKey,
        (effects.get(effectKey) ?? 0) + (typeof input.amount === "number" ? input.amount : 1),
      );
      handlers.get(run.plan.title)?.(run);
      return engine.get(id);
    },
    pause: async (id: string) => {
      runs.get(id)!.status = "paused";
      return engine.get(id);
    },
    resume: async (id: string) => {
      runs.get(id)!.status = "running";
      return engine.get(id);
    },
    cancel: async (id: string) => {
      runs.get(id)!.status = "cancelled";
      return engine.get(id);
    },
    reject: async (id: string) => {
      runs.get(id)!.status = "rejected";
      return engine.get(id);
    },
    cleanupAutomationWorkspace: async (id: string) => {
      assert.ok(["completed", "failed", "cancelled"].includes(runs.get(id)!.status));
      cleaned.push(id);
    },
    plan: async () => {
      plannerCalls++;
      throw new Error("Scheduler must not plan work");
    },
    model: async () => {
      modelCalls++;
      throw new Error("Scheduler must not call models");
    },
  };
  const open = async () => {
    const service = await Automations.open(engine, { now: () => time });
    cleanup(() => service.close());
    return service;
  };
  const service = await open();
  return {
    service,
    open,
    engine,
    runs,
    starts,
    effects,
    handlers,
    publications,
    template,
    ownerships,
    cleaned,
    dirty,
    approveLinked: async (value: AutomationJob) => {
      // The real engine invokes this guard before approval; the fake executor deliberately does not.
      await service.assertRunAdmission(value.runId);
      return engine.approve(value.runId);
    },
    now: () => time,
    at: (value: number) => {
      time = value;
    },
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    counts: () => ({ creations, approvals, snapshots, modelCalls, plannerCalls }),
    complete: (job: AutomationJob, output: AutomationJson = { done: true }, costUsd = 0) => {
      const run = runs.get(job.runId)!;
      run.status = "completed";
      run.outputValue = structuredClone(output);
      run.usage = { ...emptyUsage(), costUsd };
    },
    fail: (job: AutomationJob, error = "Execution failed", costUsd = 0) => {
      const run = runs.get(job.runId)!;
      run.status = "failed";
      run.error = error;
      run.usage = { ...emptyUsage(), costUsd };
    },
  };
}

function job(service: Automations, id: string) {
  const found = service.state().jobs.find((candidate) => candidate.id === id);
  assert.ok(found, `Missing durable job ${id}`);
  return found;
}

async function runNow(service: Automations, id: string) {
  const value = await service.action(id, "run-now");
  assert.ok("runId" in value);
  return value;
}

test("direct scheduling executes the frozen target without discovery, planning or model overhead", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({ inputs: { effectKey: "counter", amount: 7 } }),
  });
  const direct = await runNow(ctx.service, automation.id);
  assert.equal(direct.phase, "direct");
  assert.equal(direct.status, "running");
  assert.equal(ctx.effects.get("counter"), 7);
  assert.equal(ctx.engine.get(direct.runId).program!.input.retained, true);
  ctx.complete(direct, { count: 7 });
  await ctx.service.tick();
  assert.deepEqual(job(ctx.service, direct.id).result, { count: 7 });
  assert.equal(job(ctx.service, direct.id).status, "completed");
  assert.equal(ctx.service.state().observations.length, 0);
  assert.deepEqual(ctx.counts(), {
    creations: 1,
    approvals: 1,
    snapshots: 1,
    modelCalls: 0,
    plannerCalls: 0,
  });
});

for (const missedRuns of ["skip", "latest", "catch-up"] as const) {
  test(`durable interval ${missedRuns} checkpoints survive downtime, duplicate ticks and a backwards clock`, async (t) => {
    const ctx = await setup(t);
    const automation = await ctx.service.save({
      config: config({
        schedule: { kind: "interval", seconds: 60 },
        policy: { missedRuns, maxCatchUp: 3, overlap: "queue", approval: "required" },
      }),
    });
    await ctx.service.close();
    ctx.advance(10 * 60_000 + 1000);
    const reopened = await ctx.open();
    await reopened.tick();
    const expected = missedRuns === "skip" ? [] : missedRuns === "latest" ? [10] : [8, 9, 10];
    assert.deepEqual(
      reopened
        .state()
        .jobs.map((value) => value.key)
        .sort(),
      expected.map((minute) => `tick:${epoch + minute * 60_000}`).sort(),
    );
    assert.equal(reopened.state().automations[0]!.nextFireAt, epoch + 11 * 60_000);
    const identities = reopened.state().jobs.map((value) => [value.id, value.runId]);
    await reopened.tick();
    ctx.at(epoch - 60_000);
    await reopened.tick();
    assert.deepEqual(
      reopened.state().jobs.map((value) => [value.id, value.runId]),
      identities,
    );
    assert.equal(ctx.counts().approvals, 0);
    assert.equal(reopened.state().automations[0]!.id, automation.id);
  });
}

test("a past once schedule is durably consumed exactly once across restart", async (t) => {
  const ctx = await setup(t);
  await ctx.service.save({
    config: config({ schedule: { kind: "once", at: new Date(epoch - 60_000).toISOString() } }),
  });
  await ctx.service.tick();
  const first = ctx.service.state().jobs[0]!;
  assert.equal(ctx.effects.get("main"), 1);
  ctx.complete(first);
  await ctx.service.tick();
  await ctx.service.close();
  const reopened = await ctx.open();
  ctx.advance(86_400_000);
  await reopened.tick();
  assert.equal(reopened.state().jobs.length, 1);
  assert.equal(reopened.state().automations[0]!.nextFireAt, null);
  assert.equal(ctx.effects.get("main"), 1);
});

test("discovery accepts zero then many signals and passes only the committed checkpoint to the next scan", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({ mode: "discovery", routes: [advanceRoute] }),
  });
  const empty = await runNow(ctx.service, automation.id);
  ctx.complete(empty, { signals: [], checkpoint: { page: 1 } });
  await ctx.service.tick();
  assert.equal(job(ctx.service, empty.id).status, "completed");
  assert.deepEqual(ctx.service.state().automations[0]!.checkpoint, { page: 1 });
  assert.equal(ctx.service.state().cases.length, 0);
  assert.equal(ctx.effects.get("reaction"), undefined);
  const scan = await runNow(ctx.service, automation.id);
  assert.deepEqual(scan.input.automation, {
    id: automation.id,
    jobId: scan.id,
    phase: "discovery",
    checkpoint: { page: 1 },
  });
  ctx.complete(scan, {
    signals: [signal("one"), signal("two"), signal("three")],
    checkpoint: { page: 2 },
  });
  await ctx.service.tick();
  assert.deepEqual(ctx.service.state().automations[0]!.checkpoint, { page: 2 });
  assert.equal(ctx.service.state().observations.length, 3);
  assert.equal(ctx.service.state().cases.length, 3);
  assert.equal(ctx.service.state().jobs.filter((value) => value.phase === "reaction").length, 3);
  assert.equal(ctx.effects.get("reaction"), 2);
  assert.equal(ctx.counts().modelCalls, 0);
});

test("invalid machine results never publish a truncated preview or retry completed effects after restart", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({ output: { target: reaction, approval: "automatic" } }),
  });
  const original = await runNow(ctx.service, automation.id);
  ctx.complete(original);
  const run = ctx.runs.get(original.runId)!;
  delete run.outputValue;
  run.outputValueError = "too_large";
  run.output = "x".repeat(64_000);
  await ctx.service.tick();
  assert.equal(job(ctx.service, original.id).status, "needs_attention");
  assert.equal(ctx.service.state().jobs.length, 1);
  assert.equal(ctx.effects.get("reaction"), undefined);
  await ctx.service.close();
  const reopened = await ctx.open();
  await reopened.tick();
  await reopened.jobAction(original.id, "reconcile");
  assert.equal(job(reopened, original.id).status, "needs_attention");
  assert.equal(reopened.state().jobs.length, 1);
  assert.equal(ctx.starts.get(original.runId), 1);
  assert.equal(ctx.engine.get(original.runId).output, run.output);
});

test("discovery queue overflow rolls back all observations, cases, jobs and checkpoint; reconciliation does not rerun the scan", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({
      mode: "discovery",
      routes: [advanceRoute],
      policy: { maxQueued: 1, overlap: "queue" },
    }),
  });
  await ctx.service.ingest(automation.id, { signals: [], checkpoint: { page: 0 } });
  const scan = await runNow(ctx.service, automation.id);
  ctx.complete(scan, { signals: [signal("one"), signal("two")], checkpoint: { page: 1 } });
  await ctx.service.tick();
  assert.equal(job(ctx.service, scan.id).status, "needs_attention");
  assert.deepEqual(ctx.service.state().automations[0]!.checkpoint, { page: 0 });
  assert.equal(ctx.service.state().observations.length, 0);
  assert.equal(ctx.service.state().cases.length, 0);
  assert.equal(ctx.service.state().jobs.length, 1);
  assert.equal(ctx.effects.get("main"), 1);
  await ctx.service.save({
    id: automation.id,
    revision: automation.revision,
    config: {
      ...automation.config,
      policy: { ...automation.config.policy, maxQueued: 3 },
    },
  });
  await ctx.service.jobAction(scan.id, "reconcile");
  assert.equal(job(ctx.service, scan.id).status, "completed");
  assert.deepEqual(ctx.service.state().automations[0]!.checkpoint, { page: 1 });
  assert.equal(ctx.service.state().observations.length, 2);
  assert.equal(ctx.service.state().jobs.length, 3);
  assert.equal(ctx.effects.get("main"), 1);
});

test("external intake is atomic and rejected batches are retryable after queue capacity changes", async (t) => {
  const ctx = await setup(t);
  let automation = await ctx.service.save({
    config: config({ routes: [advanceRoute], policy: { maxQueued: 1 } }),
  });
  const batch = { signals: [signal("one"), signal("two")], checkpoint: "after-batch" };
  await assert.rejects(ctx.service.ingest(automation.id, batch), /queue is full/);
  assert.equal(ctx.service.state().jobs.length, 0);
  assert.equal(ctx.service.state().observations.length, 0);
  assert.equal(ctx.service.state().cases.length, 0);
  assert.equal(ctx.service.state().automations[0]!.checkpoint, undefined);
  automation = await ctx.service.save({
    id: automation.id,
    revision: automation.revision,
    config: {
      ...automation.config,
      policy: { ...automation.config.policy, maxQueued: 2 },
    },
  });
  await ctx.service.ingest(automation.id, batch);
  assert.equal(ctx.service.state().jobs.length, 2);
  assert.equal(ctx.service.state().observations.length, 2);
  assert.equal(ctx.service.state().automations[0]!.checkpoint, "after-batch");
});

test("explicit delivery and semantic signal identities deduplicate across durable restart", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({ config: config({ routes: [advanceRoute] }) });
  const identified = signal("identified", { id: "delivery-1" });
  const semantic = signal("semantic");
  await ctx.service.ingest(automation.id, { signals: [identified, semantic] });
  await ctx.service.tick();
  const identities = ctx.service.state().jobs.map((value) => [value.id, value.runId]);
  for (const value of ctx.service.state().jobs) ctx.complete(value);
  await ctx.service.tick();
  await ctx.service.close();
  const reopened = await ctx.open();
  await reopened.ingest(automation.id, {
    signals: [
      { ...identified, payload: { redelivered: true }, revision: "transport-changed" },
      {
        ...semantic,
        payload: { transportTimestamp: 1 },
        observedAt: new Date(epoch + 1000).toISOString(),
      },
    ],
  });
  await reopened.tick();
  assert.deepEqual(
    reopened.state().jobs.map((value) => [value.id, value.runId]),
    identities,
  );
  assert.equal(reopened.state().observations.length, 2);
  assert.equal(ctx.effects.get("reaction"), 2);
  await reopened.ingest(automation.id, { signals: [{ ...identified, sourceId: "other-inbox" }] });
  await reopened.tick();
  assert.equal(reopened.state().jobs.length, 3);
  assert.equal(ctx.effects.get("reaction"), 3);
});

test("routes are first-match with exact primitive payload and source filters, not model classification", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({
      routes: [
        {
          ...advanceRoute,
          id: "foreign",
          sourceId: "another-source",
          target: { kind: "block", blockId: "wrong-source" },
        },
        {
          ...advanceRoute,
          id: "string",
          match: { accepted: "true" },
          target: { kind: "block", blockId: "wrong-type" },
        },
        { ...advanceRoute, id: "first", match: { accepted: true }, inputs: { selected: "first" } },
        { ...advanceRoute, id: "fallback", inputs: { selected: "last" } },
      ],
    }),
  });
  await ctx.service.ingest(automation.id, {
    signals: [signal(), signal("ignored", { signalKind: "unhandled" })],
  });
  await ctx.service.tick();
  const selected = ctx.service.state().jobs[0]!;
  assert.equal(ctx.service.state().jobs.length, 1);
  assert.equal(selected.targetKey, "route:first");
  assert.equal(selected.input.selected, "first");
  assert.equal(ctx.effects.get("reaction"), 1);
  assert.equal(
    ctx.service.state().observations.find((value) => value.signal.resourceKey === "ignored")!
      .disposition,
    "unmatched",
  );
  assert.equal(ctx.counts().modelCalls, 0);
});

test("advance retires old revisions, supersedes unstarted work and rejects late stale deliveries", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({ config: config({ routes: [advanceRoute] }) });
  await ctx.service.ingest(automation.id, {
    signals: [signal("resource", { correlationKey: "case-1" })],
  });
  const old = ctx.service.state().jobs[0]!;
  await ctx.service.ingest(automation.id, {
    signals: [
      signal("different-resource", {
        correlationKey: "case-1",
        revision: "r2",
        fingerprint: "content-2",
        observedAt: new Date(epoch + 1000).toISOString(),
        references: { review: "https://example.invalid/review/1" },
      }),
    ],
  });
  assert.equal(job(ctx.service, old.id).status, "cancelled");
  assert.match(job(ctx.service, old.id).reason!, /Superseded/);
  assert.equal(ctx.service.state().cases.length, 1);
  assert.equal(ctx.service.state().cases[0]!.currentRevision, "r2");
  assert.deepEqual(ctx.service.state().cases[0]!.references, {
    item: "https://example.invalid/resource",
    review: "https://example.invalid/review/1",
  });
  await ctx.service.ingest(automation.id, {
    signals: [
      signal("resource", {
        id: "late-old-delivery",
        correlationKey: "case-1",
        observedAt: new Date(epoch + 2000).toISOString(),
      }),
    ],
  });
  assert.equal(ctx.service.state().observations[0]!.disposition, "stale");
  await ctx.service.tick();
  assert.equal(ctx.effects.get("reaction"), 1);
  assert.equal(ctx.runs.has(old.runId), false);
});

test("out-of-order current signals wait durably for advance and receive persisted case references and prior results", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({
      routes: [
        advanceRoute,
        {
          id: "review",
          signalKind: "reviewed",
          revisionPolicy: "current",
          target: { kind: "block", blockId: "review" },
        },
      ],
    }),
  });
  const current = signal("review-1", {
    signalKind: "reviewed",
    correlationKey: "case",
    observedAt: new Date(epoch + 2000).toISOString(),
  });
  await ctx.service.ingest(automation.id, { signals: [current] });
  assert.equal(ctx.service.state().observations[0]!.disposition, "awaiting-revision");
  assert.equal(ctx.service.state().jobs.length, 0);
  await ctx.service.close();
  const reopened = await ctx.open();
  await reopened.ingest(automation.id, {
    signals: [signal("resource", { correlationKey: "case" })],
  });
  assert.equal(reopened.state().jobs.length, 2);
  assert.equal(
    reopened.state().observations.find((value) => value.signal.signalKind === "reviewed")!
      .disposition,
    "queued",
  );
  await reopened.tick();
  const first = reopened.state().jobs.find((value) => value.targetKey === "route:advance")!;
  const review = reopened.state().jobs.find((value) => value.targetKey === "route:review")!;
  assert.equal(job(reopened, first.id).status, "running");
  assert.equal(job(reopened, review.id).status, "queued");
  ctx.complete(first, { artifact: "https://example.invalid/report/1" });
  await reopened.tick();
  const input = ctx.engine.get(review.runId).program!.input;
  assert.deepEqual(input.prior, [
    {
      jobId: first.id,
      runId: first.runId,
      status: "completed",
      result: { artifact: "https://example.invalid/report/1" },
    },
  ]);
  assert.equal((input.case as Record<string, AutomationJson>).lastRunId, first.runId);
  assert.equal((input.case as Record<string, AutomationJson>).currentRevision, "r1");
  assert.equal(JSON.stringify(input).includes("conversation"), false);
  assert.equal(ctx.effects.get("review"), 1);
});

test("queued jobs retain immutable target, input and cost policy through edit, disable and restart", async (t) => {
  const ctx = await setup(t);
  await ctx.service.settings({ ...ctx.service.state().settings, concurrency: 1 });
  let automation = await ctx.service.save({
    config: config({ inputs: { amount: 2 }, execution: { maxCostUsd: 1 } }),
  });
  const active = await runNow(ctx.service, automation.id);
  const queued = await runNow(ctx.service, automation.id);
  assert.equal(queued.status, "queued");
  ctx.template.program!.source = "edited-v2";
  ctx.template.executionVersion = "b".repeat(64);
  automation = await ctx.service.save({
    id: automation.id,
    revision: automation.revision,
    config: {
      ...automation.config,
      enabled: false,
      inputs: { amount: 20 },
      execution: { ...automation.config.execution, maxCostUsd: 5 },
    },
  });
  ctx.complete(active);
  await ctx.service.tick();
  assert.equal(job(ctx.service, queued.id).status, "queued");
  await ctx.service.close();
  const reopened = await ctx.open();
  await reopened.action(automation.id, "enable", automation.revision);
  await reopened.tick();
  const run = ctx.engine.get(queued.runId);
  assert.equal(run.program!.source, "frozen-v1");
  assert.equal(run.executionVersion, "a".repeat(64));
  assert.equal(run.program!.input.amount, 2);
  assert.equal(run.automation!.execution.maxCostUsd, 1);
  assert.equal(job(reopened, queued.id).versionId, queued.versionId);
  assert.equal(ctx.effects.get("main"), 4);
  const newest = await runNow(reopened, automation.id);
  ctx.complete(job(reopened, queued.id));
  await reopened.tick();
  assert.equal(ctx.engine.get(newest.runId).program!.source, "edited-v2");
  assert.equal(ctx.engine.get(newest.runId).automation!.execution.maxCostUsd, 5);
  assert.equal(ctx.effects.get("main"), 24);
});

test("global concurrency admits two isolated runs and queues the third until a slot is released", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({ config: config({ policy: { concurrency: 3 } }) });
  const first = await runNow(ctx.service, automation.id);
  const second = await runNow(ctx.service, automation.id);
  const third = await runNow(ctx.service, automation.id);
  assert.equal(first.status, "running");
  assert.equal(second.status, "running");
  assert.equal(third.status, "queued");
  assert.match(third.reason!, /Global concurrency/);
  assert.equal(ctx.effects.get("main"), 2);
  assert.notEqual(
    ctx.engine.get(first.runId).automation!.root,
    ctx.engine.get(second.runId).automation!.root,
  );
  ctx.complete(first);
  await ctx.service.tick();
  assert.equal(job(ctx.service, third.id).status, "running");
  assert.equal(ctx.effects.get("main"), 3);
  assert.deepEqual([...ctx.starts.values()], [1, 1, 1]);
});

test("an approval-blocked case does not starve unrelated queued work", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({
      routes: [
        { ...advanceRoute, approval: "required" },
        { id: "current", signalKind: "reviewed", revisionPolicy: "current", target: reaction },
        {
          id: "independent",
          signalKind: "independent",
          revisionPolicy: "advance",
          target: reaction,
        },
      ],
    }),
  });
  await ctx.service.ingest(automation.id, { signals: [signal()] });
  await ctx.service.tick();
  const approval = ctx.service.state().jobs[0]!;
  assert.equal(approval.status, "waiting");
  await ctx.service.ingest(automation.id, {
    signals: [
      signal("item-1", { signalKind: "reviewed", id: "review" }),
      signal("unrelated", { signalKind: "independent" }),
    ],
  });
  await ctx.service.tick();
  const blocked = ctx.service.state().jobs.find((value) => value.targetKey === "route:current")!;
  const independent = ctx.service
    .state()
    .jobs.find((value) => value.targetKey === "route:independent")!;
  assert.equal(blocked.status, "queued");
  assert.match(blocked.reason!, /owns this case/);
  assert.equal(independent.status, "running");
  assert.equal(ctx.effects.get("reaction"), 1);
  assert.equal(ctx.starts.has(approval.runId), false);
});

test("a crash after the engine side effect but before SQLite acknowledgement reuses the reserved run", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({ inputs: { effectKey: "external-counter", amount: 11 } }),
  });
  const store = ctx.service["store"];
  const update = store.update.bind(store);
  store.update = (value) => {
    if (ctx.starts.has(value.runId)) throw new Error("Simulated database acknowledgement loss");
    return update(value);
  };
  await assert.rejects(runNow(ctx.service, automation.id), /acknowledgement loss/);
  const reserved = ctx.service.state().jobs[0]!;
  assert.equal(reserved.status, "admitted");
  assert.equal(ctx.engine.get(reserved.runId).status, "running");
  assert.equal(ctx.effects.get("external-counter"), 11);
  store.update = update;
  await ctx.service.close();
  const reopened = await ctx.open();
  await reopened.tick();
  assert.equal(job(reopened, reserved.id).status, "running");
  assert.equal(job(reopened, reserved.id).runId, reserved.runId);
  ctx.complete(reserved, { count: 11 });
  await reopened.tick();
  assert.equal(job(reopened, reserved.id).status, "completed");
  assert.equal(ctx.effects.get("external-counter"), 11);
  assert.equal(ctx.counts().creations, 1);
  assert.equal(ctx.counts().approvals, 1);
});

test("read-only failures use persisted exponential backoff, retain usage and stop at the attempt ceiling", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({
      policy: { retry: { safe: "read-only", maxAttempts: 3, backoffSeconds: 10 } },
    }),
  });
  let current = await runNow(ctx.service, automation.id);
  const runIds = [current.runId];
  for (let attempt = 1; attempt <= 3; attempt++) {
    ctx.fail(current, "Read-only source unavailable", 0.1);
    const failedAt = ctx.now();
    await ctx.service.tick();
    current = job(ctx.service, current.id);
    if (attempt === 3) break;
    assert.equal(current.status, "queued");
    assert.equal(current.attempt, attempt + 1);
    assert.deepEqual(current.priorRunIds, runIds);
    assert.ok(current.availableAt >= failedAt + 10_000 * 2 ** (attempt - 1) * 0.8);
    assert.ok(current.availableAt <= failedAt + 10_000 * 2 ** (attempt - 1) * 1.2);
    const due = current.availableAt;
    await ctx.service.close();
    const reopened = await ctx.open();
    ctx.service = reopened;
    ctx.at(due - 1);
    await reopened.tick();
    assert.equal(ctx.counts().approvals, attempt);
    ctx.at(Math.ceil(due));
    await reopened.tick();
    current = job(reopened, current.id);
    assert.equal(current.status, "running");
    runIds.push(current.runId);
  }
  assert.equal(current.status, "failed");
  assert.equal(current.attempt, 3);
  assert.equal(new Set(runIds).size, 3);
  assert.ok(Math.abs(current.usage!.costUsd - 0.3) < 1e-9);
  ctx.advance(86_400_000);
  await ctx.service.tick();
  assert.equal(ctx.counts().approvals, 3);
});

test("read-only retry delay is capped at one hour and an uncertain mutation never retries", async (t) => {
  const ctx = await setup(t);
  const reader = await ctx.service.save({
    config: config({
      policy: { retry: { safe: "read-only", maxAttempts: 4, backoffSeconds: 3600 } },
    }),
  });
  let read = await runNow(ctx.service, reader.id);
  ctx.fail(read);
  await ctx.service.tick();
  read = job(ctx.service, read.id);
  assert.ok(read.availableAt - ctx.now() <= 3_600_000);
  ctx.at(Math.ceil(read.availableAt));
  await ctx.service.tick();
  read = job(ctx.service, read.id);
  ctx.fail(read);
  await ctx.service.tick();
  read = job(ctx.service, read.id);
  assert.equal(read.availableAt - ctx.now(), 3_600_000);
  await ctx.service.action(reader.id, "disable");
  const writer = await ctx.service.save({
    config: config({ name: "Mutating target", inputs: { effectKey: "writes" } }),
  });
  const write = await runNow(ctx.service, writer.id);
  ctx.fail(write, "Remote write succeeded but result was lost");
  await ctx.service.tick();
  ctx.advance(86_400_000);
  await ctx.service.tick();
  assert.equal(job(ctx.service, write.id).status, "needs_attention");
  assert.equal(job(ctx.service, write.id).effects, "possible");
  assert.equal(job(ctx.service, write.id).attempt, 1);
  assert.equal(ctx.effects.get("writes"), 1);
  await assert.rejects(ctx.service.jobAction(write.id, "retry"), /Never blindly retry/);
});

test("per-automation concurrency does not consume another automation's available global slot", async (t) => {
  const ctx = await setup(t);
  const limited = await ctx.service.save({ config: config({ policy: { concurrency: 1 } }) });
  const other = await ctx.service.save({ config: config({ name: "Unrelated" }) });
  await runNow(ctx.service, limited.id);
  const blocked = await runNow(ctx.service, limited.id);
  assert.match(blocked.reason!, /Automation concurrency/);
  const admitted = await runNow(ctx.service, other.id);
  assert.equal(admitted.status, "running");
  assert.equal(ctx.counts().approvals, 2);
});

test("per-automation and global queue limits reject intake without advancing its checkpoint", async (t) => {
  const ctx = await setup(t);
  await ctx.service.settings({ ...ctx.service.state().settings, maxQueued: 2 });
  const first = await ctx.service.save({
    config: config({ routes: [advanceRoute], policy: { maxQueued: 1 } }),
  });
  const second = await ctx.service.save({
    config: config({ name: "Other", routes: [advanceRoute] }),
  });
  await ctx.service.ingest(first.id, { signals: [signal("one")], checkpoint: "accepted-first" });
  await assert.rejects(
    ctx.service.ingest(first.id, { signals: [signal("two")], checkpoint: "rejected-first" }),
    /queue is full/,
  );
  await ctx.service.ingest(second.id, {
    signals: [signal("three")],
    checkpoint: "accepted-second",
  });
  await assert.rejects(
    ctx.service.ingest(second.id, { signals: [signal("four")], checkpoint: "rejected-second" }),
    /queue is full/,
  );
  assert.equal(ctx.service.state().jobs.length, 2);
  assert.equal(ctx.service.state().observations.length, 2);
  assert.equal(
    ctx.service.state().automations.find((value) => value.id === first.id)!.checkpoint,
    "accepted-first",
  );
  assert.equal(
    ctx.service.state().automations.find((value) => value.id === second.id)!.checkpoint,
    "accepted-second",
  );
});

test("admission cooldown is persisted across restart and clock rollback", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({ policy: { cooldownSeconds: 60 } }),
  });
  const first = await runNow(ctx.service, automation.id);
  const second = await runNow(ctx.service, automation.id);
  assert.equal(second.status, "queued");
  assert.match(second.reason!, /cooldown/);
  ctx.complete(first);
  await ctx.service.tick();
  await ctx.service.close();
  const reopened = await ctx.open();
  ctx.at(epoch - 1000);
  await reopened.tick();
  ctx.at(epoch + 59_999);
  await reopened.tick();
  assert.equal(ctx.effects.get("main"), 1);
  ctx.at(epoch + 60_000);
  await reopened.tick();
  assert.equal(job(reopened, second.id).status, "running");
  assert.equal(ctx.effects.get("main"), 2);
});

for (const scope of ["automation", "global"] as const) {
  test(`${scope} spending limits reserve active costs, release unused reservation and include completed usage`, async (t) => {
    const ctx = await setup(t);
    await ctx.service.settings({
      ...ctx.service.state().settings,
      concurrency: 3,
      ...(scope === "global" ? { maxCostUsd: 1 } : {}),
    });
    const automation = await ctx.service.save({
      config: config({
        execution: { maxCostUsd: 0.6 },
        policy: { concurrency: 3, ...(scope === "automation" ? { maxCostUsd: 1 } : {}) },
      }),
    });
    const first = await runNow(ctx.service, automation.id);
    const second = await runNow(ctx.service, automation.id);
    assert.equal(second.status, "queued");
    assert.match(second.reason!, /spending limit exhausted or reserved/);
    assert.equal(ctx.counts().approvals, 1);
    ctx.complete(first, { done: true }, 0.3);
    await ctx.service.tick();
    assert.equal(job(ctx.service, second.id).status, "running");
    ctx.complete(job(ctx.service, second.id), { done: true }, 0.5);
    await ctx.service.tick();
    const exhausted = await runNow(ctx.service, automation.id);
    assert.equal(exhausted.status, "queued");
    assert.match(exhausted.reason!, /spending limit exhausted/);
    assert.equal(ctx.service.state().usage[automation.id]!.costUsd, 0.8);
    assert.equal(ctx.counts().approvals, 2);
  });
}

test("a global cap rejects unreserved jobs and unpriced usage prevents further admission", async (t) => {
  const ctx = await setup(t);
  await ctx.service.settings({ ...ctx.service.state().settings, maxCostUsd: 2 });
  const unreserved = await ctx.service.save({ config: config() });
  const blocked = await runNow(ctx.service, unreserved.id);
  assert.match(blocked.reason!, /per-job cost reservation/);
  const reserved = await ctx.service.save({
    config: config({ name: "Reserved", execution: { maxCostUsd: 0.5 } }),
  });
  const first = await runNow(ctx.service, reserved.id);
  ctx.complete(first);
  ctx.runs.get(first.runId)!.usage = { ...emptyUsage(), requests: 1, unpricedRequests: 1 };
  await ctx.service.tick();
  const second = await runNow(ctx.service, reserved.id);
  assert.equal(second.status, "queued");
  assert.match(second.reason!, /unpriced/);
  assert.equal(ctx.counts().approvals, 1);
});

test("named resources stay reserved by paused effectful work while unrelated resources can proceed", async (t) => {
  const ctx = await setup(t);
  const owner = await ctx.service.save({
    config: config({ execution: { resources: ["deploy:staging"] } }),
  });
  const contender = await ctx.service.save({
    config: config({ name: "Same resource", execution: { resources: ["deploy:staging"] } }),
  });
  const unrelated = await ctx.service.save({
    config: config({ name: "Other resource", execution: { resources: ["deploy:preview"] } }),
  });
  const first = await runNow(ctx.service, owner.id);
  await ctx.service.jobAction(first.id, "pause");
  await ctx.service.tick();
  const blocked = await runNow(ctx.service, contender.id);
  assert.equal(blocked.status, "queued");
  assert.match(blocked.reason!, /resource is reserved/);
  assert.equal((await runNow(ctx.service, unrelated.id)).status, "running");
  assert.equal(ctx.counts().approvals, 2);
});

test("output defaults to approval; a lost publication result is reconciled by stable remote key without replay", async (t) => {
  const ctx = await setup(t);
  await ctx.service.settings({ ...ctx.service.state().settings, maxCostUsd: 1 });
  const automation = await ctx.service.save({
    config: config({
      execution: { maxCostUsd: 0.2 },
      output: {
        target: { kind: "block", blockId: "publish" },
        reconcile: { kind: "block", blockId: "find-publication" },
        execution: { resources: ["remote:publication"], maxCostUsd: 0.6 },
      },
    }),
  });
  let writes = 0,
    lookups = 0;
  ctx.handlers.set("publish", (run) => {
    const context = run.program!.input.automation as Record<string, AutomationJson>;
    const key = context.publicationKey as string;
    writes++;
    ctx.publications.set(key, `https://example.invalid/published/${writes}`);
    run.status = "failed";
    run.error = "Publication committed remotely; response lost";
    run.usage = { ...emptyUsage(), costUsd: 0.2 };
  });
  ctx.handlers.set("find-publication", (run) => {
    const context = run.program!.input.automation as Record<string, AutomationJson>;
    lookups++;
    const reference = ctx.publications.get(context.publicationKey as string);
    run.status = "completed";
    run.outputValue = reference ? { published: true, reference } : { published: false };
  });
  const parent = await runNow(ctx.service, automation.id);
  ctx.complete(parent, { report: "ready" }, 0.1);
  await ctx.service.tick();
  const output = ctx.service.state().jobs.find((value) => value.phase === "output")!;
  assert.equal(output.approval, "required");
  assert.equal(output.status, "waiting");
  assert.equal(output.publicationKey, `workflow-automation:${parent.id}`);
  assert.equal(writes, 0);
  assert.deepEqual(output.input.result, { report: "ready" });
  await ctx.service.jobAction(output.id, "approve");
  await ctx.service.tick();
  assert.equal(job(ctx.service, output.id).status, "needs_attention");
  assert.equal(writes, 1);
  await assert.rejects(ctx.service.jobAction(output.id, "retry"), /Never blindly retry/);
  await ctx.service.close();
  const reopened = await ctx.open();
  ctx.advance(86_400_000);
  await reopened.tick();
  assert.equal(job(reopened, output.id).status, "needs_attention");
  assert.equal(writes, 1);
  await reopened.jobAction(output.id, "reconcile");
  await assert.rejects(reopened.jobAction(output.id, "reconcile"), /already pending/);
  await reopened.tick();
  await reopened.tick();
  const reconciliation = reopened.state().jobs.find((value) => value.phase === "reconcile")!;
  assert.equal(reconciliation.status, "completed");
  assert.equal(reconciliation.publicationKey, output.publicationKey);
  assert.equal(job(reopened, output.id).status, "completed");
  assert.equal(job(reopened, output.id).effects, "reconciled");
  assert.deepEqual(job(reopened, output.id).result, {
    published: true,
    reference: "https://example.invalid/published/1",
  });
  assert.equal(writes, 1);
  assert.equal(lookups, 1);
});

test("negative reconciliation remains human-gated and test jobs never route or publish", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({
      routes: [advanceRoute],
      output: {
        target: { kind: "block", blockId: "publish" },
        reconcile: { kind: "block", blockId: "lookup" },
      },
    }),
  });
  const parent = await runNow(ctx.service, automation.id);
  ctx.complete(parent);
  await ctx.service.tick();
  const output = ctx.service.state().jobs.find((value) => value.phase === "output")!;
  await ctx.service.jobAction(output.id, "approve");
  ctx.fail(output, "No reliable publication receipt");
  await ctx.service.tick();
  await ctx.service.jobAction(output.id, "reconcile");
  await ctx.service.tick();
  const reconciliation = ctx.service.state().jobs.find((value) => value.phase === "reconcile")!;
  ctx.complete(reconciliation, { published: false });
  await ctx.service.tick();
  assert.equal(job(ctx.service, output.id).status, "needs_attention");
  assert.match(job(ctx.service, output.id).reason!, /Human confirmation/);
  assert.equal(ctx.effects.get("publish"), 1);
  await ctx.service.action(automation.id, "disable");
  const testJob = await ctx.service.action(automation.id, "test");
  assert.ok("runId" in testJob);
  assert.equal(testJob.status, "waiting");
  assert.equal(ctx.starts.has(testJob.runId), false);
  await ctx.service.jobAction(testJob.id, "approve");
  ctx.complete(testJob, { signals: [signal("never-route-test-output")] });
  await ctx.service.tick();
  assert.equal(job(ctx.service, testJob.id).status, "completed");
  assert.equal(ctx.service.state().observations.length, 0);
  assert.equal(ctx.service.state().jobs.filter((value) => value.phase === "output").length, 1);
});

test("cron checkpoints persist bounded DST catch-up and do not duplicate work after a clock rollback", async (t) => {
  const ctx = await setup(t);
  ctx.at(Date.parse("2026-03-06T12:00:00.000Z"));
  await ctx.service.save({
    config: config({
      schedule: { kind: "cron", expression: "0 9 * * *", timezone: "America/New_York" },
      policy: { overlap: "queue", missedRuns: "catch-up", maxCatchUp: 3, approval: "required" },
    }),
  });
  await ctx.service.close();
  const reopened = await ctx.open();
  ctx.at(Date.parse("2026-03-09T13:00:00.000Z"));
  await reopened.tick();
  assert.deepEqual(
    reopened
      .state()
      .jobs.map((value) => value.key)
      .sort(),
    ["2026-03-07T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z"]
      .map((value) => `tick:${Date.parse(value)}`)
      .sort(),
  );
  assert.equal(reopened.state().automations[0]!.nextFireAt, Date.parse("2026-03-10T13:00:00.000Z"));
  const identities = reopened.state().jobs.map((value) => value.id);
  ctx.at(Date.parse("2026-03-07T12:00:00.000Z"));
  await reopened.tick();
  ctx.at(Date.parse("2026-03-09T13:00:00.000Z"));
  await reopened.tick();
  assert.deepEqual(
    reopened.state().jobs.map((value) => value.id),
    identities,
  );
  assert.equal(ctx.counts().approvals, 0);
});

test("a full scheduled catch-up batch rolls back its timer checkpoint before any partial admission", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({
      schedule: { kind: "interval", seconds: 60 },
      policy: { overlap: "queue", missedRuns: "catch-up", maxCatchUp: 3, maxQueued: 1 },
    }),
  });
  ctx.advance(10 * 60_000);
  await ctx.service.tick();
  assert.equal(ctx.service.state().jobs.length, 0);
  assert.equal(ctx.service.state().automations[0]!.nextFireAt, epoch + 60_000);
  assert.match(ctx.service.state().automations[0]!.error!, /queue is full/);
  assert.equal(ctx.counts().approvals, 0);
  await ctx.service.save({
    id: automation.id,
    revision: automation.revision,
    config: {
      ...automation.config,
      policy: { ...automation.config.policy, maxQueued: 3 },
    },
  });
  await ctx.service.tick();
  assert.equal(ctx.service.state().jobs.length, 3);
  assert.equal(ctx.service.state().automations[0]!.nextFireAt, epoch + 11 * 60_000);
  assert.equal(ctx.service.state().automations[0]!.error, undefined);
  assert.equal(ctx.counts().approvals, 2);
});

test("deferred current observations retain their original routing snapshot when the definition is edited", async (t) => {
  const ctx = await setup(t);
  let automation = await ctx.service.save({
    config: config({
      routes: [
        advanceRoute,
        {
          id: "review",
          signalKind: "reviewed",
          revisionPolicy: "current",
          target: { kind: "block", blockId: "original-review" },
          inputs: { frozen: "original" },
        },
      ],
    }),
  });
  const versionId = automation.versionId;
  await ctx.service.ingest(automation.id, {
    signals: [
      signal("review", {
        signalKind: "reviewed",
        correlationKey: "case",
        observedAt: new Date(epoch + 1000).toISOString(),
      }),
    ],
  });
  automation = await ctx.service.save({
    id: automation.id,
    revision: automation.revision,
    config: {
      ...automation.config,
      routes: [
        automation.config.routes[0]!,
        {
          ...automation.config.routes[1]!,
          target: { kind: "block", blockId: "edited-review" },
          inputs: { frozen: "edited" },
        },
      ],
    },
  });
  await ctx.service.close();
  const reopened = await ctx.open();
  await reopened.ingest(automation.id, {
    signals: [signal("resource", { correlationKey: "case" })],
  });
  await reopened.tick();
  const first = reopened.state().jobs.find((value) => value.targetKey === "route:advance")!;
  ctx.complete(first);
  await reopened.tick();
  const review = reopened.state().jobs.find((value) => value.targetKey === "route:review")!;
  assert.equal(review.versionId, versionId);
  assert.equal(review.input.frozen, "original");
  assert.equal(ctx.engine.get(review.runId).plan.title, "original-review");
  assert.equal(ctx.effects.get("original-review"), 1);
  assert.equal(ctx.effects.has("edited-review"), false);
});

for (const scope of ["automation", "global"] as const) {
  test(`${scope} cap retains live spending and remaining reservation between scheduler ticks`, async (t) => {
    const ctx = await setup(t);
    await ctx.service.settings({
      ...ctx.service.state().settings,
      concurrency: 3,
      ...(scope === "global" ? { maxCostUsd: 1 } : {}),
    });
    const automation = await ctx.service.save({
      config: config({
        execution: { maxCostUsd: 0.6 },
        policy: { concurrency: 3, ...(scope === "automation" ? { maxCostUsd: 1 } : {}) },
      }),
    });
    const first = await runNow(ctx.service, automation.id);
    ctx.runs.get(first.runId)!.usage = { ...emptyUsage(), costUsd: 0.5 };
    assert.equal(
      job(ctx.service, first.id).usage?.costUsd ?? 0,
      0,
      "SQLite has not reconciled the live cost yet",
    );
    const second = await runNow(ctx.service, automation.id);
    assert.equal(second.status, "queued");
    assert.match(second.reason!, /spending limit/);
    assert.equal(ctx.counts().approvals, 1);
    ctx.complete(first, { done: true }, 0.5);
    await ctx.service.tick();
    assert.equal(
      job(ctx.service, second.id).status,
      "queued",
      "terminal live spending is not released as unused reservation",
    );
    assert.equal(ctx.counts().approvals, 1);
  });
}

for (const constraint of [
  "concurrency",
  "resource",
  "automation budget",
  "global budget",
] as const) {
  test(`linked workflow approval atomically acquires the ${constraint} reservation before another approval`, async (t) => {
    const ctx = await setup(t);
    await ctx.service.settings({
      ...ctx.service.state().settings,
      concurrency: 4,
      ...(constraint === "global budget" ? { maxCostUsd: 1 } : {}),
    });
    const automation = await ctx.service.save({
      config: config({
        policy: {
          approval: "required",
          concurrency: constraint === "concurrency" ? 1 : 4,
          ...(constraint === "automation budget" ? { maxCostUsd: 1 } : {}),
        },
        execution: {
          maxCostUsd: 0.6,
          resources: constraint === "resource" ? ["shared:publisher"] : [],
        },
      }),
    });
    const first = await runNow(ctx.service, automation.id);
    const second = await runNow(ctx.service, automation.id);
    assert.equal(first.status, "waiting");
    assert.equal(second.status, "waiting");
    const outcomes = await Promise.allSettled([
      ctx.approveLinked(first),
      ctx.approveLinked(second),
    ]);
    assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
    const denied = outcomes.find((value) => value.status === "rejected");
    assert.ok(denied?.status === "rejected");
    assert.match(
      String(denied.reason),
      constraint === "concurrency"
        ? /Automation concurrency/
        : constraint === "resource"
          ? /resource is reserved/
          : /spending limit/,
    );
    assert.equal(ctx.counts().approvals, 1);
    const winner = ctx.starts.has(first.runId) ? first : second;
    const loser = winner.id === first.id ? second : first;
    assert.equal(ctx.engine.get(winner.runId).status, "running");
    assert.equal(ctx.engine.get(loser.runId).status, "draft");
    assert.equal(job(ctx.service, loser.id).approval, "required");
    if (constraint.includes("budget")) {
      ctx.runs.get(winner.runId)!.usage = { ...emptyUsage(), costUsd: 0.5 };
      await assert.rejects(ctx.approveLinked(loser), /spending limit/);
      assert.equal(
        ctx.counts().approvals,
        1,
        "linked admission also retains spending incurred between ticks",
      );
    }
  });
}

test("linked workflow approval cannot start a draft after its automation is disabled", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({ policy: { approval: "required" } }),
  });
  const draft = await runNow(ctx.service, automation.id);
  await ctx.service.action(automation.id, "disable");
  await assert.rejects(ctx.approveLinked(draft), /Enable|disabled/);
  assert.equal(ctx.engine.get(draft.runId).status, "draft");
  assert.equal(job(ctx.service, draft.id).approval, "required");
  assert.equal(ctx.counts().approvals, 0);
});

test("a completed discovery hidden from run history still delivers its signals and checkpoint exactly once", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({ mode: "discovery", routes: [advanceRoute] }),
  });
  const scan = await runNow(ctx.service, automation.id);
  ctx.complete(scan, { signals: [signal("retained")], checkpoint: "delivered" });
  ctx.runs.get(scan.runId)!.deletedAt = new Date(epoch).toISOString();
  assert.equal(
    ctx.engine.list().some((value) => value.id === scan.runId),
    false,
  );
  await ctx.service.close();
  const reopened = await ctx.open();
  await reopened.tick();
  await reopened.tick();
  assert.equal(job(reopened, scan.id).status, "completed");
  assert.equal(reopened.state().automations[0]!.checkpoint, "delivered");
  assert.equal(reopened.state().observations.length, 1);
  assert.equal(reopened.state().jobs.filter((value) => value.phase === "reaction").length, 1);
  assert.equal(ctx.effects.get("reaction"), 1);
  assert.equal(ctx.starts.get(scan.runId), 1);
});

test("current feedback older than the advancing observation routes both on deferred replay and later delivery", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({
      routes: [
        advanceRoute,
        { id: "feedback", signalKind: "reviewed", revisionPolicy: "current", target: reaction },
      ],
    }),
  });
  await ctx.service.ingest(automation.id, {
    signals: [
      signal("item", {
        id: "early-feedback",
        signalKind: "reviewed",
        revision: "r2",
      }),
    ],
  });
  assert.equal(ctx.service.state().observations[0]!.disposition, "awaiting-revision");
  await ctx.service.ingest(automation.id, {
    signals: [
      signal("item", {
        revision: "r2",
        fingerprint: "r2",
        observedAt: new Date(epoch + 60_000).toISOString(),
      }),
    ],
  });
  await ctx.service.ingest(automation.id, {
    signals: [
      signal("item", {
        id: "delayed-feedback",
        signalKind: "reviewed",
        revision: "r2",
        observedAt: new Date(epoch + 1000).toISOString(),
      }),
    ],
  });
  const feedback = ctx.service
    .state()
    .observations.filter((value) => value.signal.signalKind === "reviewed");
  assert.equal(feedback.length, 2);
  assert.ok(feedback.every((value) => value.disposition === "queued"));
  assert.equal(
    ctx.service.state().jobs.filter((value) => value.targetKey === "route:feedback").length,
    2,
  );
  await ctx.service.tick();
  for (let i = 0; i < 3; i++) {
    const active = ctx.service.state().jobs.find((value) => value.status === "running");
    assert.ok(active);
    ctx.complete(active);
    await ctx.service.tick();
  }
  assert.equal(ctx.effects.get("reaction"), 3);
  assert.ok(ctx.service.state().jobs.every((value) => value.status === "completed"));
});

test("any-revision routes retain their frozen policy through supersession and linked approval", async (t) => {
  const ctx = await setup(t);
  let automation = await ctx.service.save({
    config: config({
      routes: [
        advanceRoute,
        {
          id: "history",
          signalKind: "history",
          revisionPolicy: "any",
          approval: "required",
          target: reaction,
        },
      ],
      policy: { supersede: true },
    }),
  });
  await ctx.service.ingest(automation.id, {
    signals: [signal(), signal("item-1", { id: "historical", signalKind: "history" })],
  });
  await ctx.service.ingest(automation.id, {
    signals: [
      signal("item-1", {
        revision: "r2",
        fingerprint: "r2",
        observedAt: new Date(epoch + 1000).toISOString(),
      }),
    ],
  });
  const historical = ctx.service.state().jobs.find((value) => value.targetKey === "route:history")!;
  assert.equal(historical.status, "queued", "superseding r1 does not cancel an any-revision route");
  assert.equal(historical.revisionPolicy, "any");
  automation = await ctx.service.save({
    id: automation.id,
    revision: automation.revision,
    config: {
      ...automation.config,
      routes: [
        automation.config.routes[0]!,
        { ...automation.config.routes[1]!, revisionPolicy: "current" },
      ],
    },
  });
  await ctx.service.tick();
  const advancing = ctx.service
    .state()
    .jobs.find((value) => value.targetKey === "route:advance" && value.signal?.revision === "r2")!;
  if (job(ctx.service, advancing.id).status === "running") {
    ctx.complete(advancing);
    await ctx.service.tick();
  }
  assert.equal(job(ctx.service, historical.id).status, "waiting");
  await ctx.approveLinked(historical);
  assert.equal(ctx.starts.get(historical.runId), 1);
  ctx.complete(historical);
  await ctx.service.tick();
  await ctx.service.ingest(automation.id, {
    signals: [signal("item-1", { id: "current-policy", signalKind: "history" })],
  });
  assert.equal(
    ctx.service.state().observations.find((value) => value.signal.id === "current-policy")!
      .disposition,
    "stale",
  );
});

test("superseding an unexecuted approval draft rejects it and releases the case for the newer revision", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({ routes: [{ ...advanceRoute, approval: "required" }] }),
  });
  await ctx.service.ingest(automation.id, { signals: [signal()] });
  await ctx.service.tick();
  const old = ctx.service.state().jobs[0]!;
  assert.equal(old.status, "waiting");
  assert.equal(ctx.engine.get(old.runId).status, "draft");
  await ctx.service.ingest(automation.id, {
    signals: [
      signal("item-1", {
        revision: "r2",
        fingerprint: "r2",
        observedAt: new Date(epoch + 1000).toISOString(),
      }),
    ],
  });
  await ctx.service.tick();
  assert.equal(job(ctx.service, old.id).status, "cancelled");
  assert.equal(ctx.engine.get(old.runId).status, "rejected");
  assert.equal(ctx.starts.has(old.runId), false);
  const latest = ctx.service.state().jobs.find((value) => value.signal?.revision === "r2")!;
  assert.equal(latest.status, "waiting");
  await ctx.service.jobAction(latest.id, "approve");
  assert.equal(job(ctx.service, latest.id).status, "running");
  assert.equal(ctx.effects.get("reaction"), 1);
});

for (const stopped of ["failed", "interrupted"] as const) {
  test(`internal output and ${stopped} publication reconciliation bypass a full successor queue without replay`, async (t) => {
    const ctx = await setup(t);
    await ctx.service.settings({ ...ctx.service.state().settings, maxQueued: 1 });
    const automation = await ctx.service.save({
      config: config({
        routes: [
          advanceRoute,
          { id: "feedback", signalKind: "reviewed", revisionPolicy: "current", target: reaction },
        ],
        policy: { maxQueued: 1 },
        output: {
          target: { kind: "block", blockId: "publish" },
          approval: "automatic",
          reconcile: { kind: "block", blockId: "find-publication" },
        },
      }),
    });
    ctx.handlers.set("publish", (run) => {
      const input = run.program!.input.automation as Record<string, AutomationJson>;
      ctx.publications.set(
        input.publicationKey as string,
        "https://example.invalid/retained-publication",
      );
      ctx.dirty.add(run.id);
      run.status = stopped;
      run.error = "Remote publication succeeded before local acknowledgement";
    });
    ctx.handlers.set("find-publication", (run) => {
      const input = run.program!.input.automation as Record<string, AutomationJson>;
      const reference = ctx.publications.get(input.publicationKey as string);
      assert.ok(reference);
      run.status = "completed";
      run.outputValue = { published: true, reference };
    });
    await ctx.service.ingest(automation.id, { signals: [signal()] });
    await ctx.service.tick();
    const parent = ctx.service.state().jobs[0]!;
    assert.equal(parent.status, "running");
    await ctx.service.ingest(automation.id, {
      signals: [signal("item-1", { id: "successor", signalKind: "reviewed" })],
    });
    const successor = ctx.service
      .state()
      .jobs.find((value) => value.targetKey === "route:feedback")!;
    assert.equal(successor.status, "queued");
    ctx.complete(parent, { report: "ready" });
    await ctx.service.tick();
    assert.equal(
      job(ctx.service, parent.id).status,
      "completed",
      "required output must not deadlock behind its same-case successor",
    );
    const output = ctx.service.state().jobs.find((value) => value.phase === "output")!;
    assert.ok(output);
    await ctx.service.tick();
    assert.equal(job(ctx.service, output.id).status, "needs_attention");
    assert.equal(job(ctx.service, successor.id).status, "queued");
    assert.equal(ctx.effects.get("publish"), 1);
    await ctx.service.jobAction(output.id, "reconcile");
    const reconciliation = ctx.service.state().jobs.find((value) => value.phase === "reconcile")!;
    assert.ok(reconciliation, "recovery has capacity even when blocked successors fill maxQueued");
    await ctx.service.tick();
    await ctx.service.tick();
    assert.equal(job(ctx.service, reconciliation.id).status, "completed");
    assert.equal(job(ctx.service, reconciliation.id).previousRunId, undefined);
    assert.equal(ctx.ownerships.get(reconciliation.runId)!.previousRunId, undefined);
    assert.equal(reconciliation.parentJobId, output.id);
    assert.equal(reconciliation.publicationKey, output.publicationKey);
    assert.deepEqual(job(ctx.service, output.id).result, {
      published: true,
      reference: "https://example.invalid/retained-publication",
    });
    assert.equal(job(ctx.service, output.id).status, "completed");
    assert.equal(job(ctx.service, output.id).effects, "reconciled");
    assert.equal(ctx.effects.get("publish"), 1);
    assert.equal(ctx.effects.get("find-publication"), 1);
    assert.equal(ctx.starts.get(output.runId), 1);
    await ctx.service.close();
    const reopened = await ctx.open();
    await reopened.tick();
    assert.equal(
      ctx.effects.get("publish"),
      1,
      "remote-found publication is not replayed after restart",
    );
    assert.equal(ctx.effects.get("find-publication"), 1);
  });
}

for (const retireBeforeOutput of [true, false]) {
  test(`output freezes the parent revision and cannot publish r1 retired ${retireBeforeOutput ? "before creation" : "while awaiting approval"}`, async (t) => {
    const ctx = await setup(t);
    const automation = await ctx.service.save({
      config: config({
        routes: [advanceRoute],
        policy: { supersede: true },
        output: { target: { kind: "block", blockId: "publish" } },
      }),
    });
    await ctx.service.ingest(automation.id, { signals: [signal()] });
    await ctx.service.tick();
    const parent = ctx.service.state().jobs[0]!;
    const newer = {
      signals: [
        signal("item-1", {
          revision: "r2",
          fingerprint: "r2",
          observedAt: new Date(epoch + 1000).toISOString(),
        }),
      ],
    };
    if (retireBeforeOutput) await ctx.service.ingest(automation.id, newer);
    ctx.complete(parent, { report: "r1-only" });
    await ctx.service.tick();
    const output = ctx.service
      .state()
      .jobs.find((value) => value.phase === "output" && value.parentJobId === parent.id)!;
    assert.ok(output);
    assert.deepEqual(output.signal, parent.signal);
    assert.equal(output.revisionPolicy, parent.revisionPolicy);
    assert.equal(output.signal!.revision, "r1");
    assert.equal((output.input.signal as Record<string, AutomationJson>).revision, "r1");
    if (!retireBeforeOutput) {
      assert.equal(output.status, "waiting");
      await ctx.service.ingest(automation.id, newer);
    }
    await ctx.service.tick();
    assert.equal(job(ctx.service, output.id).status, "cancelled");
    await assert.rejects(
      ctx.service.jobAction(output.id, "approve"),
      /not awaiting approval|superseded|stale/i,
    );
    if (ctx.runs.has(output.runId))
      await assert.rejects(ctx.approveLinked(output), /missing|terminal|superseded|stale/i);
    assert.equal(ctx.starts.has(output.runId), false);
    assert.equal(ctx.effects.has("publish"), false);
  });
}

test("cleanup rejects the last case workspace required by future continuation", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({
      routes: [
        advanceRoute,
        { id: "feedback", signalKind: "reviewed", revisionPolicy: "current", target: reaction },
      ],
    }),
  });
  await ctx.service.ingest(automation.id, { signals: [signal()] });
  await ctx.service.tick();
  const parent = ctx.service.state().jobs[0]!;
  ctx.complete(parent);
  await ctx.service.tick();
  assert.equal(ctx.service.state().cases[0]!.lastRunId, parent.runId);
  await assert.rejects(
    ctx.service.jobAction(parent.id, "cleanup"),
    /case|continuation|depend|workspace.*required/i,
  );
  assert.deepEqual(ctx.cleaned, []);
  await ctx.service.ingest(automation.id, {
    signals: [signal("item-1", { id: "follow-up", signalKind: "reviewed" })],
  });
  await ctx.service.tick();
  const next = ctx.service.state().jobs.find((value) => value.targetKey === "route:feedback")!;
  assert.equal(next.status, "running");
  assert.equal(ctx.ownerships.get(next.runId)!.previousRunId, parent.runId);
});

test("cleanup rejects a terminal parent while an unprepared output still needs its workspace", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({
      output: { target: { kind: "block", blockId: "publish" } },
    }),
  });
  const parent = await runNow(ctx.service, automation.id);
  await ctx.service.action(automation.id, "disable");
  ctx.complete(parent);
  await ctx.service.tick();
  const output = ctx.service.state().jobs.find((value) => value.phase === "output")!;
  assert.equal(job(ctx.service, parent.id).status, "completed");
  assert.equal(output.status, "queued");
  assert.equal(output.prepared, false);
  await assert.rejects(
    ctx.service.jobAction(parent.id, "cleanup"),
    /continuation|depend|workspace.*required/i,
  );
  assert.deepEqual(ctx.cleaned, []);
  await ctx.service.action(automation.id, "enable");
  await ctx.service.tick();
  assert.equal(job(ctx.service, output.id).status, "waiting");
  assert.equal(ctx.ownerships.get(output.runId)!.previousRunId, parent.runId);
});

test("terminal job cleanup visits every retained read-only retry workspace", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({
      policy: { retry: { safe: "read-only", maxAttempts: 3, backoffSeconds: 1 } },
    }),
  });
  let current = await runNow(ctx.service, automation.id);
  const retained = [current.runId];
  for (let attempt = 1; attempt < 3; attempt++) {
    ctx.fail(current);
    await ctx.service.tick();
    current = job(ctx.service, current.id);
    ctx.at(Math.ceil(current.availableAt));
    await ctx.service.tick();
    current = job(ctx.service, current.id);
    retained.push(current.runId);
  }
  ctx.complete(current);
  await ctx.service.tick();
  assert.deepEqual(job(ctx.service, current.id).priorRunIds, retained.slice(0, -1));
  await ctx.service.jobAction(current.id, "cleanup");
  assert.deepEqual([...ctx.cleaned].sort(), [...retained].sort());
  assert.equal(new Set(ctx.cleaned).size, 3);
  assert.equal(job(ctx.service, current.id).status, "completed");
});

test("an any-revision route admits a historical observation first delivered after retirement", async (t) => {
  const ctx = await setup(t);
  const automation = await ctx.service.save({
    config: config({
      routes: [
        advanceRoute,
        { id: "history", signalKind: "history", revisionPolicy: "any", target: reaction },
      ],
      policy: { supersede: true },
    }),
  });
  await ctx.service.ingest(automation.id, { signals: [signal()] });
  await ctx.service.tick();
  ctx.complete(ctx.service.state().jobs[0]!);
  await ctx.service.tick();
  await ctx.service.ingest(automation.id, {
    signals: [
      signal("item-1", {
        revision: "r2",
        fingerprint: "r2",
        observedAt: new Date(epoch + 1000).toISOString(),
      }),
    ],
  });
  await ctx.service.tick();
  const advancing = ctx.service.state().jobs.find((value) => value.signal?.revision === "r2")!;
  ctx.complete(advancing);
  await ctx.service.tick();
  await ctx.service.ingest(automation.id, {
    signals: [signal("item-1", { id: "late-history", signalKind: "history" })],
  });
  await ctx.service.tick();
  const historical = ctx.service.state().jobs.find((value) => value.targetKey === "route:history")!;
  assert.equal(historical.status, "running");
  assert.equal(historical.revisionPolicy, "any");
  assert.equal(historical.signal!.revision, "r1");
  assert.equal(ctx.service.state().cases[0]!.currentRevision, "r2");
  assert.equal(ctx.effects.get("reaction"), 3);
});

for (const exit of ["cancel", "read-only retry"] as const) {
  test(`incomplete zero-cost accounting remains budget-blocking after ${exit}`, async (t) => {
    const ctx = await setup(t);
    await ctx.service.settings({ ...ctx.service.state().settings, maxCostUsd: 1 });
    const automation = await ctx.service.save({
      config: config({
        execution: { maxCostUsd: 0.4 },
        policy: { retry: { safe: "read-only", maxAttempts: 2, backoffSeconds: 1 } },
      }),
    });
    const first = await runNow(ctx.service, automation.id);
    const interrupted = usageSessionSchema.parse({
      id: randomUUID(),
      scopeId: first.runId,
      runId: first.runId,
      phase: "execution",
      operationId: "execution:call",
      provider: "fixture",
      model: "small",
      thinking: "off",
      pricing: { source: "catalog", rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      usage: emptyUsage(),
      status: "interrupted",
      startedAt: new Date(epoch).toISOString(),
      updatedAt: new Date(epoch).toISOString(),
    });
    ctx.engine.usage = {
      sessions: async () => [interrupted],
      report: async ({ runId } = {}) =>
        usageReportSchema.parse({
          scope: { kind: "project" },
          total: emptyUsage(),
          phases: [],
          models: [],
          sessions: runId === first.runId ? [interrupted] : [],
          sessionCount: runId === first.runId ? 1 : 0,
          sessionsTruncated: false,
          legacyExecution: emptyUsage(),
          limits: { remainingCostUsd: null },
          incomplete: runId === first.runId,
          warnings: runId === first.runId ? ["Interrupted usage may be missing"] : [],
        }),
    };
    if (exit === "cancel") await ctx.service.jobAction(first.id, "cancel");
    else ctx.fail(first, "Read-only request interrupted before usage acknowledgement");
    await ctx.service.tick();
    const retained = job(ctx.service, first.id);
    assert.equal(retained.usageIncomplete, true);
    assert.equal(retained.usage!.costUsd, 0);
    assert.equal(retained.usage!.unpricedRequests, 0);
    if (exit === "read-only retry") {
      assert.deepEqual(retained.priorRunIds, [first.runId]);
      ctx.at(Math.ceil(retained.availableAt));
      await ctx.service.tick();
      assert.equal(job(ctx.service, first.id).status, "queued");
      assert.match(job(ctx.service, first.id).reason!, /incomplete|uncertain/i);
    } else assert.equal(retained.status, "cancelled");
    const next = await runNow(ctx.service, automation.id);
    assert.equal(next.status, "queued");
    assert.match(next.reason!, /incomplete|uncertain/i);
    assert.equal(ctx.counts().approvals, 1, "unknown provider charges must not become free budget");
  });
}
