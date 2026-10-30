import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { type runSchema } from "../src/contracts/domain.js";
import { createTemplate } from "../src/core/library/templates.js";
import { mergeEvents, mergeRuns, newerRun } from "../web/features/execution/run-state.js";
import { readPlanDraft } from "../web/features/tasks/plan-draft.js";
import { request } from "../web/shared/api.js";
import { fixture } from "./helpers.js";

test("delayed lists preserve newer revisions and newly created runs", () => {
  const item = {
    id: "first",
    status: "draft" as const,
    title: "Original",
    task: "Task",
    mode: "demo" as const,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    cursor: "work",
    revision: 1,
  };
  const completed = { ...item, status: "completed" as const, title: "Reviewed", revision: 8 };
  const added = { ...item, id: "second", createdAt: "2026-01-02" };
  assert.deepEqual(mergeRuns([completed, added], [item]), [added, completed]);
});

test("run detail updates preserve live usage and the selected run", () => {
  // Detail merging only reads identity, revision and usage.
  const current = { id: "first", revision: 5, usage: { requests: 3 } } as z.infer<typeof runSchema>;
  assert.equal(newerRun(current, { ...current, revision: 4 }, "first"), current);
  assert.equal(
    newerRun(current, { ...current, usage: { ...current.usage!, requests: 2 } }, "first"),
    current,
  );
  assert.equal(newerRun(current, { ...current, id: "second", revision: 10 }, "first"), current);
  assert.equal(newerRun(current, { ...current, revision: 6 }, "first")?.revision, 6);
});

test("event history merges deduplicate out-of-order delivery and retain the latest 500", () => {
  const events = Array.from({ length: 501 }, (_, i) => ({
    id: String(i),
    time: String(i).padStart(4, "0"),
    runId: "one",
    kind: "check",
    message: "checked",
  }));
  const merged = mergeEvents(events.slice(200), events.slice(0, 300).reverse());
  assert.equal(merged.length, 500);
  assert.equal(merged[0]?.id, "1");
  assert.equal(merged.at(-1)?.id, "500");
});

test("editing incomplete fields preserves step controls while domain validation blocks saving", async (t) => {
  const { library } = await fixture(t);
  const plan = createTemplate("Feature task", "feature", library);
  plan.title = "";
  plan.nodes[0]!.goal = "";
  plan.nodes[0]!.maxVisits = 0;
  const result = readPlanDraft(JSON.stringify(plan), library);
  assert.equal(result.plan?.title, "");
  assert.equal(result.plan?.nodes[0]?.maxVisits, 0);
  assert.equal(result.validPlan, undefined);
  assert.match(result.error!, /title/);
  assert.match(readPlanDraft("{", library).error!, /JSON/);
  plan.title = "Fixed";
  plan.nodes[0]!.goal = "Do work";
  plan.nodes[0]!.maxVisits = 2;
  plan.nodes[0]!.on.pass = "missing-step";
  assert.match(readPlanDraft(JSON.stringify(plan), library).error!, /Unknown transition/);
});

test("non-JSON server failures show a useful HTTP error instead of a parsing exception", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => new Response("<html>Unavailable</html>", { status: 503 }),
    { preconnect: original.preconnect },
  );
  try {
    await assert.rejects(
      request("/api/runs", z.unknown()),
      /Request failed \(503\).*Workflow is running/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("deletion markers win over delayed lists and remain available across refreshes", () => {
  const item = {
    id: "deleted",
    status: "completed" as const,
    title: "Finished",
    task: "Task",
    mode: "demo" as const,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    cursor: "$complete",
    revision: 5,
  };
  const removed = { ...item, revision: 6, deletedAt: "2026-01-02" };
  assert.deepEqual(mergeRuns([removed], [item]), [removed]);
  assert.deepEqual(mergeRuns([item], [removed]), [removed]);
  assert.deepEqual(mergeRuns([removed], []), [removed]);
});

test("bodyless deletion requests do not advertise an empty JSON document", async () => {
  const original = globalThis.fetch;
  let observed: RequestInit | undefined;
  globalThis.fetch = Object.assign(
    async (_url: unknown, options?: RequestInit) => {
      observed = options;
      return Response.json({ removed: true });
    },
    { preconnect: original.preconnect },
  );
  try {
    await request("/api/runs/example", z.object({ removed: z.boolean() }), { method: "DELETE" });
    assert.equal(new Headers(observed?.headers).get("content-type"), null);
    assert.equal(new Headers(observed?.headers).get("x-workflow-client"), "1");
  } finally {
    globalThis.fetch = original;
  }
});
