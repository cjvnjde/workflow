import assert from "node:assert/strict";
import { test } from "vitest";
import { sessionHistory } from "../src/core/tasks/session-history.js";
import { runListSchema, taskSchema } from "../src/contracts/index.js";
import {
  mergeSessionPages,
  reconcileSessionEntry,
  type SessionPages,
} from "../web/features/sessions/session-state.js";

const ids = [1, 2, 3, 4, 5, 6].map(
  (id) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
);
const createdAt = "2026-11-03T12:00:00.000Z";
function task(id: string, prompt: string, runId?: string) {
  return taskSchema.parse({
    id,
    prompt,
    runId,
    createdAt,
    updatedAt: createdAt,
    revision: 1,
    status: runId ? "ready" : "cancelled",
    attachments: [],
    answers: [],
    approval: "review",
  });
}
function run(id: string, title: string, deletedAt?: string) {
  return runListSchema.parse([
    {
      id,
      title,
      task: title,
      deletedAt,
      createdAt,
      updatedAt: createdAt,
      revision: 1,
      status: "completed",
      mode: "demo",
      cursor: "$complete",
    },
  ])[0]!;
}

test("session history merges linked work while retaining revisioned deletion markers", () => {
  const tasks = [task(ids[0]!, "Planning title", ids[3]), task(ids[1]!, "Deleted task")];
  tasks[1]!.deletedAt = createdAt;
  const runs = [
    run(ids[3]!, "Reviewed result"),
    run(ids[4]!, "Standalone"),
    run(ids[5]!, "Deleted", createdAt),
  ];
  const page = sessionHistory(tasks, runs, {});
  assert.deepEqual(
    page.items
      .filter((entry) => !entry.deletedAt)
      .map((entry) => [entry.id, entry.title, entry.status]),
    [
      [`run:${ids[4]}`, "Standalone", "completed"],
      [ids[0], "Reviewed result", "completed"],
    ],
  );
  assert.equal(page.nextCursor, null);
  assert.deepEqual(sessionHistory(tasks, runs, { search: "REVIEWED" }).items, [
    page.items.find((entry) => entry.id === ids[0]),
  ]);
  assert.deepEqual(
    page.items
      .filter((entry) => entry.deletedAt)
      .map((entry) => entry.id)
      .sort(),
    [ids[1], `run:${ids[5]}`].sort(),
  );
});

test("cursor paging is stable for equal timestamps and newly inserted sessions", () => {
  const tasks = ids.slice(0, 4).map((id, index) => task(id, `Task ${index}`));
  const first = sessionHistory(tasks, [], { limit: 2 });
  assert.deepEqual(
    first.items.map((entry) => entry.id),
    [ids[3], ids[2]],
  );
  const newer = { ...task(ids[4]!, "New task"), createdAt: "2026-11-04T12:00:00.000Z" };
  const next = sessionHistory([newer, ...tasks], [], { limit: 2, before: first.nextCursor! });
  assert.deepEqual(
    next.items.map((entry) => entry.id),
    [ids[1], ids[0]],
  );
  assert.equal(next.nextCursor, null);
  assert.deepEqual(
    sessionHistory(tasks, [], { limit: 2, search: "Task 0" }).items.map((entry) => entry.id),
    [ids[0]],
  );
});

test("history rejects unbounded or invalid page sizes", () => {
  for (const limit of [0, -1, 101, 1.5]) {
    assert.throws(() => sessionHistory([], [], { limit }));
  }
});

test("late history pages cannot undo renamed titles, linked transitions or deletion markers", () => {
  const planned = task(ids[0]!, "Original task");
  const original = sessionHistory([planned], [], {}).items[0]!;
  const linked = { ...planned, revision: planned.revision + 1, runId: ids[3] };
  const ready = sessionHistory([linked], [run(ids[3]!, "Saved title")], {}).items[0]!;
  const removed = { ...ready, revision: ready.revision + 1, deletedAt: createdAt };
  const pages = (entry: typeof original): SessionPages => ({
    pages: [{ items: [entry], nextCursor: null }],
    pageParams: [undefined],
  });
  assert.deepEqual(mergeSessionPages(pages(ready), pages(original)).pages[0]!.items, [ready]);
  assert.deepEqual(mergeSessionPages(pages(removed), pages(ready)).pages[0]!.items, [removed]);
});

test("a pre-planning history response cannot hide a saved title after task/run linking", () => {
  const planned = task(ids[0]!, "Original task");
  const stale = sessionHistory([planned], [], {}).items[0]!;
  const linked = { ...planned, revision: 4, runId: ids[3] };
  const saved = {
    id: ids[3]!,
    revision: 2,
    status: "draft" as const,
    plan: { title: "Saved title" },
  };
  const current = reconcileSessionEntry(stale, linked, saved);
  assert.equal(current.title, "Saved title");
  assert.equal(current.runId, saved.id);
  assert.equal(current.revision, linked.revision + saved.revision);
  assert.deepEqual(
    reconcileSessionEntry(current, planned, { ...saved, revision: 1, plan: { title: "Stale" } }),
    current,
  );
});
