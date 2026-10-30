import test from "node:test";
import assert from "node:assert/strict";
import { executionEvidence } from "../web/features/execution/execution-evidence.js";

test("execution evidence measures actual attempt overlap and does not count the join as concurrent", () => {
  const run: Parameters<typeof executionEvidence>[0] = {
    status: "completed",
    updatedAt: "2026-10-25T10:00:20Z",
    plan: {
      nodes: [
        { id: "a", label: "Inspect" },
        { id: "b", label: "Inspect" },
      ],
    },
    attempts: [
      {
        nodeId: "a",
        visit: 1,
        startedAt: "2026-10-25T10:00:00Z",
        finishedAt: "2026-10-25T10:00:10Z",
        result: { outcome: "pass" },
      },
      {
        nodeId: "b",
        visit: 1,
        startedAt: "2026-10-25T10:00:02Z",
        finishedAt: "2026-10-25T10:00:12Z",
        result: { outcome: "retry" },
      },
      {
        nodeId: "join",
        visit: 1,
        startedAt: "2026-10-25T10:00:12Z",
        finishedAt: "2026-10-25T10:00:20Z",
        result: { outcome: "fail" },
      },
    ],
  };
  const result = executionEvidence(run, Date.parse("2026-10-26T10:00:00Z"));
  assert.equal(result.overlaps.length, 1);
  assert.equal(result.overlaps[0]?.seconds, 8);
  assert.match(result.overlaps[0]!.first, /Inspect · a/);
  assert.match(result.overlaps[0]!.second, /Inspect · b/);
  assert.deepEqual(
    result.intervals.map((item) => item.outcome),
    ["Step passed", "Changes requested", "Not accepted"],
  );
});
