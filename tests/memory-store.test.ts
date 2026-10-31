import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "vitest";
import { MemoryStore, observeContributions } from "../src/core/memory/memory-store.js";
import { MEMORY_PAGE_BYTES } from "../src/contracts/memory-schema.js";
import { runSchema, type WorkflowRun } from "../src/contracts/domain.js";
import { usageSessionSchema, type UsageSession } from "../src/contracts/usage-schema.js";
import { emptyUsage } from "../src/core/execution/budget.js";
import { createTemplate } from "../src/core/library/templates.js";
import { createHttpServer } from "../src/http/http-server.js";
import type { WorkflowApplication } from "../src/core/application.js";
import { WorkflowClient } from "../src/client/client.js";
import { fixture } from "./helpers.js";

async function sample(t: TestContext) {
  const { project, library } = await fixture(t);
  const run = runSchema.parse({
    id: randomUUID(),
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:02:00.000Z",
    approvedAt: "2026-10-30T10:01:00.000Z",
    mode: "live",
    status: "completed",
    plan: createTemplate("PRIVATE_TASK_CONTEXT", "bug", library),
    config: library.config,
    blocks: library.blocks,
    cursor: "$complete",
    visits: { prepare: 1 },
    artifacts: {},
    attempts: [
      {
        nodeId: "prepare",
        visit: 1,
        startedAt: "2026-10-30T10:01:00.000Z",
        finishedAt: "2026-10-30T10:02:00.000Z",
        result: {
          outcome: "pass",
          disposition: "accepted",
          summary: "PRIVATE_OUTPUT",
          artifacts: { data: '"PRIVATE_ARTIFACT"' },
        },
        checks: [
          {
            command: "test",
            expected: "failure",
            exitCode: 1,
            matched: true,
            output: "PRIVATE_CHECK_OUTPUT",
          },
        ],
      },
    ],
  });
  return { project, run, store: new MemoryStore(project) };
}
async function enable(store: MemoryStore) {
  return store.setEnabled({ enabled: true, revision: (await store.state()).revision });
}
async function collect(store: MemoryStore, run: WorkflowRun, sessions: UsageSession[] = []) {
  await store.enroll(run);
  return store.observe(run, sessions);
}
function session(run: WorkflowRun, model = "small", visit = 1) {
  return usageSessionSchema.parse({
    id: randomUUID(),
    scopeId: randomUUID(),
    operationId: run.id + "/" + randomUUID(),
    phase: "execution",
    runId: run.id,
    nodeId: "prepare",
    visit,
    provider: "test",
    model,
    thinking: "low",
    pricing: { source: "catalog", rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 2, requests: 1, costUsd: 0.001 },
    status: "completed",
    startedAt: run.approvedAt!,
    updatedAt: run.updatedAt,
    endedAt: run.updatedAt,
  });
}

test("memory defaults off without writes; explicit management still works while off", async (t) => {
  const { project, store, run } = await sample(t);
  const initial = await store.state();
  assert.equal(initial.enabled, false);
  assert.deepEqual(initial.entries, []);
  await store.enroll(run);
  assert.equal(await store.needsObservation(run), false);
  assert.equal((await store.observe(run, [])).changed, false);
  assert.deepEqual((await store.descriptions()).entries, []);
  assert.equal(await store.detail(randomUUID()), null);
  await assert.rejects(access(path.join(project, ".workflow/memory")));
  await assert.rejects(access(path.join(project, ".workflow/runs", run.id, "memory-ticket.json")));
  const created = await store.create({
    revision: initial.revision,
    kind: "preference",
    title: "Review preference",
    description: "Explicit user preference",
    details: "Prefer a separate reviewer.",
    tags: ["review"],
  });
  assert.equal(created.state.enabled, false);
  assert.equal((await store.get(created.entry.id)).details, created.entry.details);
  assert.equal(await store.detail(created.entry.id), null);
  await assert.rejects(
    store.create({
      revision: created.state.revision,
      kind: "observation",
      title: "Invented",
      description: "No",
      details: "No",
    }),
  );
  assert.equal((await stat(path.join(project, ".workflow/memory/state.json"))).mode & 0o777, 0o600);
});

test("revision checks serialize competing clients and preserve edited entries", async (t) => {
  const { project, store } = await sample(t);
  const body = {
    revision: (await store.state()).revision,
    kind: "note" as const,
    title: "Project constraint",
    description: "Explicit context",
    details: "Keep this note",
  };
  const results = await Promise.allSettled([
    store.create(body),
    new MemoryStore(project).create(body),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const state = await store.state(),
    id = state.entries[0]!.id;
  const edited = await store.update(id, {
    revision: state.revision,
    title: "Edited title",
    description: "Edited description",
    details: "Exact user detail",
  });
  assert.equal(edited.entry.id, id);
  assert.equal(edited.entry.edited, true);
  await assert.rejects(
    store.remove(id, { revision: state.revision }),
    /changed in another session/,
  );
  assert.equal((await store.get(id)).details, "Exact user detail");
  await assert.rejects(
    store.update(id, {
      revision: edited.state.revision,
      title: "x",
      description: "y",
      details: "x".repeat(4001),
    }),
  );
});

test("description search is paginated and byte bounded without disclosing details", async (t) => {
  const { store } = await sample(t);
  let state = await enable(store);
  for (let index = 0; index < 40; index++)
    state = (
      await store.create({
        revision: state.revision,
        kind: "note",
        title: "Note " + index,
        description: "Description " + index + " " + "界".repeat(280),
        details: "PRIVATE_DETAIL_" + index,
        tags: [index % 2 ? "odd" : "even"],
      })
    ).state;
  const seen = new Set<string>();
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = await store.descriptions({ offset, limit: 32 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MEMORY_PAGE_BYTES);
    assert.ok(page.entries.length <= 32);
    assert.ok(!JSON.stringify(page).includes("PRIVATE_DETAIL"));
    for (const entry of page.entries) {
      assert.ok(!seen.has(entry.id));
      seen.add(entry.id);
    }
    offset = page.nextOffset ?? undefined;
  }
  assert.equal(seen.size, 40);
  assert.equal((await store.descriptions({ query: "odd", limit: 32 })).total, 20);
  await store.setEnabled({ enabled: false, revision: state.revision });
  assert.equal((await store.descriptions({ offset: 12 })).total, 0);
  assert.equal(await store.detail([...seen][0]!), null);
});

test("ordinary-run model facts count unique sessions and visits without copying task content", async (t) => {
  const { run } = await sample(t);
  const a = session(run),
    b = session(run),
    reviewer = session(run, "reviewer"),
    a2 = session(run, "small", 2);
  const second = {
    ...structuredClone(run.attempts[0]!),
    visit: 2,
    result: { outcome: "retry" as const, summary: "PRIVATE_RETRY", artifacts: {} },
  };
  run.attempts.push(second, structuredClone(second));
  run.visits.prepare = 2;
  reviewer.pricing = { source: "unknown", rates: null };
  const facts = observeContributions(run, [a, b, reviewer, a2, a], {
    id: randomUUID(),
    caseId: "bugfix",
    caseName: "Bug fix",
  });
  assert.equal(facts.length, 2);
  const coding = facts.find((item) => item.model?.model === "small")!,
    review = facts.find((item) => item.model?.model === "reviewer")!;
  assert.equal(coding.runs, 1);
  assert.equal(coding.visits, 2);
  assert.equal(coding.sessions, 3);
  assert.equal(coding.usage.requests, 3);
  assert.equal(coding.usage.inputTokens, 30);
  assert.deepEqual(coding.outcomes, { pass: 1, retry: 1, fail: 0, interrupted: 0 });
  assert.equal(review.visits, 1);
  assert.equal(review.sessions, 1);
  assert.equal(review.usage.requests, 1);
  assert.equal(review.usageIncomplete, true);
  assert.equal(coding.checks.matched, 2);
  assert.equal(coding.dispositions.accepted, 1);
  assert.ok(!JSON.stringify(facts).includes("PRIVATE_"));
});

for (const point of ["prepared", "committed", "receipt"] as const)
  test("observation recovery after " + point + " is exactly once", async (t) => {
    const { project, run } = await sample(t);
    let crashed = false;
    const store = new MemoryStore(project, {
      checkpoint: (stage) => {
        if (stage === point && !crashed) {
          crashed = true;
          throw new Error("Crash at " + point);
        }
      },
    });
    await enable(store);
    await store.enroll(run);
    const recorded = session(run);
    await assert.rejects(store.observe(run, [recorded]), /Crash/);
    const restarted = new MemoryStore(project);
    await Promise.all([
      restarted.observe(run, [recorded]),
      new MemoryStore(project).observe(run, [recorded]),
    ]);
    const state = await restarted.state();
    assert.equal(state.entries.length, 1);
    const entry = await restarted.get(state.entries[0]!.id);
    assert.equal(entry.observation!.runs, 1);
    assert.equal(entry.observation!.visits, 1);
    assert.equal(entry.observation!.sessions, 1);
    assert.equal(entry.observation!.usage.requests, 1);
    assert.equal(await restarted.needsObservation(run), false);
    assert.equal(
      JSON.parse(
        await readFile(path.join(project, ".workflow/runs", run.id, "memory-ticket.json"), "utf8"),
      ).state,
      "applied",
    );
  });

test("a successor write finalizes crashed receipts and deletion never reimports their counts", async (t) => {
  const { project, run } = await sample(t);
  const crashing = new MemoryStore(project, {
    checkpoint: (point) => {
      if (point === "committed") throw new Error("after commit");
    },
  });
  await enable(crashing);
  await crashing.enroll(run);
  await assert.rejects(crashing.observe(run, []), /after commit/);
  const store = new MemoryStore(project),
    first = await store.state(),
    id = first.entries[0]!.id;
  await store.remove(id, { revision: first.revision });
  assert.equal((await store.observe({ ...run, deletedAt: "later" }, [])).changed, false);
  assert.deepEqual((await store.state()).entries, []);
  const nextRun = {
    ...run,
    id: randomUUID(),
    approvedAt: new Date(Date.now() + 1000).toISOString(),
    updatedAt: new Date(Date.now() + 2000).toISOString(),
  };
  await collect(store, nextRun);
  const next = await store.state();
  assert.equal(next.entries.length, 1);
  assert.notEqual(next.entries[0]!.id, id);
  assert.equal((await store.get(next.entries[0]!.id)).observation!.runs, 1);
  const note = await store.create({
    revision: next.revision,
    kind: "note",
    title: "After hidden run",
    description: "Management still works",
    details: "Retain",
  });
  assert.equal(note.state.entries.length, 2);
  assert.equal((await new MemoryStore(project).observe(run, [])).changed, false);
});

test("deleting A excludes prepared B's older facts while unrelated and future work remain eligible", async (t) => {
  const { project, run, store } = await sample(t);
  await enable(store);
  await collect(store, run, [session(run, "small")]);
  const oldId = (await store.state()).entries[0]!.id;
  const pendingRun = { ...run, id: randomUUID() };
  const preparing = new MemoryStore(project, {
    checkpoint: (point) => {
      if (point === "prepared") throw new Error("prepared before deletion");
    },
  });
  await preparing.enroll(pendingRun);
  await assert.rejects(
    preparing.observe(pendingRun, [session(pendingRun, "small"), session(pendingRun, "unrelated")]),
    /prepared before deletion/,
  );
  await store.remove(oldId, { revision: (await store.state()).revision });
  const restarted = new MemoryStore(project);
  await restarted.observe(pendingRun, []);
  const remaining = await restarted.state();
  assert.equal(remaining.entries.length, 1);
  assert.equal(
    (await restarted.get(remaining.entries[0]!.id)).observation!.model!.model,
    "unrelated",
  );
  await assert.rejects(restarted.get(oldId), /not found/);
  const future = {
    ...run,
    id: randomUUID(),
    approvedAt: new Date(Date.now() + 1000).toISOString(),
  };
  await collect(restarted, future, [session(future, "small")]);
  const fresh = (
    await Promise.all((await restarted.state()).entries.map((entry) => restarted.get(entry.id)))
  ).find((entry) => entry.observation?.model?.model === "small")!;
  assert.notEqual(fresh.id, oldId);
  assert.equal(fresh.observation!.runs, 1);
  assert.equal(fresh.observation!.sources[0]!.runId, future.id);
});

test("deletion cutoff survives crash at removal and a successor deletion replacing its marker", async (t) => {
  const { project, run, store } = await sample(t);
  await enable(store);
  await collect(store, run, [session(run, "small"), session(run, "other")]);
  const initial = await store.state();
  const entries = await Promise.all(initial.entries.map((entry) => store.get(entry.id)));
  const small = entries.find((entry) => entry.observation!.model!.model === "small")!,
    other = entries.find((entry) => entry.observation!.model!.model === "other")!;
  const pending = { ...run, id: randomUUID() };
  const preparing = new MemoryStore(project, {
    checkpoint: (point) => {
      if (point === "prepared") throw new Error("prepared");
    },
  });
  await preparing.enroll(pending);
  await assert.rejects(preparing.observe(pending, [session(pending, "small")]), /prepared/);
  const deleting = new MemoryStore(project, {
    checkpoint: (point) => {
      if (point === "deleted") throw new Error("deleted before receipt");
    },
  });
  await assert.rejects(
    deleting.remove(small.id, { revision: initial.revision }),
    /deleted before receipt/,
  );
  const next = new MemoryStore(project);
  await next.remove(other.id, { revision: (await next.state()).revision });
  await new MemoryStore(project).observe(pending, []);
  assert.deepEqual((await next.state()).entries, []);
});

test("disable and re-enable do not collect off-period or previously enrolled work", async (t) => {
  const { store, run } = await sample(t);
  await enable(store);
  await store.enroll(run);
  await store.setEnabled({ enabled: false, revision: (await store.state()).revision });
  assert.equal(await store.needsObservation(run), false);
  assert.equal((await store.observe(run, [])).changed, false);
  const offRun = { ...run, id: randomUUID() };
  await store.enroll(offRun);
  await enable(store);
  assert.equal((await store.observe(run, [])).changed, false);
  assert.equal((await store.observe(offRun, [])).changed, false);
  assert.deepEqual((await store.state()).entries, []);
  const current = { ...run, id: randomUUID() };
  await collect(store, current);
  const state = await store.state();
  assert.equal(state.entries.length, 1);
  const entry = await store.get(state.entries[0]!.id);
  assert.match(entry.details, /zero reported cost does not establish zero cost/);
  assert.match(entry.details, /not verified quality/);
});

test("aggregate IDs and edited text persist while repeated runs add bounded factual sources", async (t) => {
  const { store, run } = await sample(t);
  await enable(store);
  await collect(store, run);
  const state = await store.state(),
    id = state.entries[0]!.id;
  const edited = await store.update(id, {
    revision: state.revision,
    title: "My label",
    description: "My project observation",
    details: "A user-written caveat.",
  });
  for (let index = 1; index <= 7; index++)
    await collect(store, {
      ...run,
      id: randomUUID(),
      updatedAt: "2026-10-30T12:0" + index + ":00Z",
    });
  const entry = await store.get(id);
  assert.equal((await store.state()).entries.length, 1);
  assert.equal(entry.observation!.runs, 8);
  assert.equal(entry.observation!.sources.length, 5);
  assert.equal(entry.title, "My label");
  assert.equal(entry.details, "A user-written caveat.");
  assert.ok(
    entry.updatedAt >= edited.entry.updatedAt,
    "Backdated reconciliation cannot move the user's edit timestamp backwards",
  );
  await assert.rejects(
    store.update(id, {
      revision: edited.state.revision,
      title: "stale",
      description: "stale",
      details: "stale",
    }),
    /changed in another session/,
  );
});

test("capacity reports omitted groups and preserves every explicit entry", async (t) => {
  const { store, run } = await sample(t);
  let state = await enable(store);
  for (let index = 0; index < 100; index++)
    state = (
      await store.create({
        revision: state.revision,
        kind: index % 2 ? "note" : "preference",
        title: "Explicit " + index,
        description: "Keep this",
        details: "User-authored",
      })
    ).state;
  await store.enroll(run);
  const result = await store.observe(
    run,
    Array.from({ length: 103 }, (_, index) =>
      session(run, "model-" + String(index).padStart(3, "0")),
    ),
  );
  assert.equal(result.changed, false);
  assert.equal(result.evicted, 0);
  assert.equal(result.skipped, 103);
  const after = await store.state();
  assert.equal(after.entries.length, 100);
  assert.ok(after.entries.every((entry) => entry.kind !== "observation"));
  assert.equal((await store.observe(run, [])).skipped, 0, "Applied ticket is not counted again");
});

test("bounded automatic capacity evicts only unedited observations", async (t) => {
  const { store, run } = await sample(t);
  let state = await enable(store);
  for (let index = 0; index < 99; index++)
    state = (
      await store.create({
        revision: state.revision,
        kind: "note",
        title: "Note " + index,
        description: "Keep",
        details: "Explicit",
      })
    ).state;
  await collect(store, run, [session(run, "old")]);
  const oldId = (await store.state()).entries.find((entry) => entry.kind === "observation")!.id;
  const next = { ...run, id: randomUUID(), updatedAt: "later" };
  const result = await collect(store, next, [session(next, "new")]);
  assert.equal(result.evicted, 1);
  assert.equal(result.changed, true);
  await assert.rejects(store.get(oldId), /not found/);
  assert.equal((await store.state()).entries.filter((entry) => entry.kind === "note").length, 99);
  const observation = (await store.state()).entries.find((entry) => entry.kind === "observation")!;
  await store.update(observation.id, {
    revision: (await store.state()).revision,
    title: observation.title,
    description: observation.description,
    details: "Explicitly edited",
  });
  const third = { ...run, id: randomUUID(), updatedAt: "still later" };
  const skipped = await collect(store, third, [session(third, "third")]);
  assert.equal(skipped.evicted, 0);
  assert.equal(skipped.skipped, 1);
  assert.equal((await store.get(observation.id)).details, "Explicitly edited");
});

test("memory API and shared client validate IDs, explicit authorship and optimistic revisions", async (t) => {
  const { store } = await sample(t);
  const app = {
    memory: () => store.state(),
    memoryEntry: (id: string) => store.get(id),
    setMemoryEnabled: (body: unknown) => store.setEnabled(body),
    createMemoryEntry: (body: unknown) => store.create(body),
    updateMemoryEntry: (id: string, body: unknown) => store.update(id, body),
    deleteMemoryEntry: (id: string, body: unknown) => store.remove(id, body),
  } as unknown as WorkflowApplication;
  const server = await createHttpServer(app);
  t.onTestFinished(() => server.close());
  const client = new WorkflowClient({
    baseUrl: "http://127.0.0.1:4310",
    fetch: Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const response = await server.inject({
          method: (init?.method ?? "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
          url: new URL(String(url)).pathname,
          headers: { host: "127.0.0.1:4310", ...Object.fromEntries(new Headers(init?.headers)) },
          payload: init?.body as string | undefined,
        });
        return new Response(response.body, { status: response.statusCode });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const initial = await client.memory();
  assert.equal(initial.enabled, false);
  const created = await client.createMemoryEntry({
    revision: initial.revision,
    kind: "preference",
    title: "Explicit",
    description: "User-authored preference",
    details: "Use short notes",
  });
  assert.equal((await client.memoryEntry(created.entry.id)).kind, "preference");
  const enabled = await client.setMemoryEnabled(true, created.state.revision);
  await assert.rejects(
    client.updateMemoryEntry(created.entry.id, {
      revision: created.state.revision,
      title: "stale",
      description: "stale",
      details: "stale",
    }),
    /changed in another session/,
  );
  const edited = await client.updateMemoryEntry(created.entry.id, {
    revision: enabled.revision,
    title: "Updated",
    description: "Updated description",
    details: "Updated details",
  });
  await client.deleteMemoryEntry(created.entry.id, edited.state.revision);
  await assert.rejects(client.memoryEntry(created.entry.id), /not found/);
  const invalid = await server.inject({
    url: "/api/memory/entries/invalid",
    headers: { host: "127.0.0.1:4310" },
  });
  assert.equal(invalid.statusCode, 400);
  const forged = await server.inject({
    method: "POST",
    url: "/api/memory/entries",
    headers: { host: "127.0.0.1:4310", "x-workflow-client": "1" },
    payload: {
      revision: (await client.memory()).revision,
      kind: "observation",
      title: "No",
      description: "No",
      details: "No",
    },
  });
  assert.equal(forged.statusCode, 400);
});
