import assert from "node:assert/strict";
import test from "node:test";
import { operationBody } from "../web/operation-presentation.js";
import { executionTimeline } from "../web/execution-timeline.js";
import {
  projectOperations,
  type RunEvent,
  type WorkflowRun,
} from "../src/contracts.js";

test("operation cards use captured diffs and preserve nonzero exit as a result", () => {
  const diff = operationBody({
    id: "edit",
    name: "edit_file",
    kind: "tool",
    state: "completed",
    presentation: {
      card: "file-diff",
      path: "old.ts",
      before: "old",
      after: "new",
    },
  });
  assert.equal(diff.oldText, "old");
  assert.equal(diff.newText, "new");
  const command = operationBody({
    id: "exec",
    name: "bash",
    kind: "tool",
    state: "completed",
    output: [{ type: "text", text: "expected regression failure" }],
    details: { exitCode: 1 },
  });
  assert.equal(command.exitCode, 1);
  assert.equal(command.result, "expected regression failure");
  const created = operationBody({
    id: "create",
    name: "write",
    kind: "write",
    state: "completed",
    presentation: { card: "file-diff", before: null, after: "new file" },
  });
  assert.equal(created.oldText, "");
});

test("timeline keeps visits separate and unfinished calls as recorded start markers", () => {
  const events: RunEvent[] = [
    {
      id: "1",
      runId: "run",
      nodeId: "work",
      time: "2026-01-01T00:00:00Z",
      kind: "operation",
      message: "",
      operation: {
        id: "one",
        name: "read",
        kind: "read",
        state: "started",
        visit: 1,
      },
    },
    {
      id: "2",
      runId: "run",
      nodeId: "work",
      time: "2026-01-01T00:00:02Z",
      kind: "operation",
      message: "",
      operation: {
        id: "two",
        name: "read",
        kind: "read",
        state: "started",
        visit: 2,
      },
    },
  ];
  const run = {
    plan: { nodes: [{ id: "work", label: "Work" }] },
    attempts: [
      {
        nodeId: "work",
        visit: 1,
        startedAt: events[0]!.time,
        finishedAt: "2026-01-01T00:00:01Z",
      },
      { nodeId: "work", visit: 2, startedAt: events[1]!.time },
    ],
  } as WorkflowRun;
  const model = executionTimeline(run, projectOperations(events), "time");
  assert.equal(model.rows.filter((row) => !row.operationKey).length, 2);
  const open = model.rows.find((row) => row.operationKey && row.visit === 2)!;
  assert.equal(open.start, open.end);
  assert.equal(open.settled, false);
});
