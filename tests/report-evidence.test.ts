import { test } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { RunStore } from "../src/core/storage/run-store.js";
import { reportEvidenceSchema } from "../src/contracts/index.js";
import { runReport } from "../web/features/execution/run-report.js";
import type { WorkflowRun } from "../src/contracts/domain.js";
import { fixture } from "./helpers.js";

test("Results retain early model, file, ownership and decision evidence beyond the live window and after restart", async (t) => {
  const { project } = await fixture(t);
  const directory = path.join(project, ".workflow/runs"),
    id = randomUUID();
  const store = new RunStore(directory);
  const emit = (kind: string, message: unknown) =>
    store.record({
      id: randomUUID(),
      runId: id,
      nodeId: "work",
      time: "2026-10-30T12:00:00Z",
      kind,
      message: typeof message === "string" ? message : JSON.stringify(message),
    });
  await emit("execution_workspace", "/saved/worktree");
  await emit("model_session", {
    provider: "fake",
    model: "early-model",
    thinking: "off",
    tools: ["read"],
  });
  await emit("model_session_end", { durationMs: 42 });
  await emit("file_evidence", {
    workspace: "/saved/worktree",
    changedFileCount: 1,
    changes: [{ path: "early.ts", before: null, after: "hash" }],
  });
  await emit("ownership_evidence", { checkedFileCount: 1, protectedPaths: ["tests/**"] });
  await emit("flow_decision", { groupId: "review", result: true, route: "exit" });
  await emit("capability_warning", "Recorded warning");
  for (let i = 0; i < 600; i++) await emit("tool_end", "Routine tool payload");
  assert.equal(
    (await store.events(id)).some((event) => event.kind === "model_session"),
    false,
  );
  const evidence = reportEvidenceSchema.parse(await new RunStore(directory).reportEvidence(id));
  assert.equal(evidence.total, 607);
  assert.equal(evidence.asOf, 606);
  assert.equal(evidence.available, true);
  assert.equal(evidence.events.length, 7);
  const report = runReport(
    { status: "completed", attempts: [] } as unknown as WorkflowRun,
    evidence.events,
  );
  assert.equal(report.calls[0]?.durationMs, 42);
  assert.equal(report.calls[0]?.workspace, "/saved/worktree");
  assert.equal(report.decisions[0]?.route, "exit");
  assert.ok(
    evidence.events.some(
      (event) => event.kind === "file_evidence" && event.message.includes("early.ts"),
    ),
  );
  assert.ok(evidence.events.some((event) => event.kind === "ownership_evidence"));
});

test("report evidence shares the execution cache, folds appends, and rejects external corruption", async (t) => {
  const { project } = await fixture(t);
  const directory = path.join(project, ".workflow/runs"),
    id = randomUUID();
  const store = new RunStore(directory);
  const event = {
    id: randomUUID(),
    runId: id,
    time: "now",
    kind: "file_evidence_unavailable",
    message: "Original",
  };
  await store.record(event);
  await store.execution(id);
  const scan = store["scan"];
  let scans = 0;
  store["scan"] = function (runId: string) {
    scans++;
    return scan.call(this, runId);
  };
  const first = await store.reportEvidence(id);
  first.events[0]!.message = "Caller mutation";
  await store.record({ ...event, id: randomUUID(), kind: "ownership_violation", message: "Later" });
  const next = await store.reportEvidence(id);
  assert.equal(scans, 0);
  assert.equal(first.total, 1);
  assert.equal(next.total, 2);
  assert.deepEqual(
    next.events.map((event) => event.message),
    ["Original", "Later"],
  );
  const filename = path.join(directory, id, "events.jsonl");
  await writeFile(filename, JSON.stringify({ ...event, message: "Replacement" }) + "\n");
  assert.equal((await store.reportEvidence(id)).events[0]?.message, "Replacement");
  await writeFile(filename, "corrupt\n");
  await assert.rejects(store.reportEvidence(id));
});

test("an unavailable event log is distinguishable from a complete log without evidence records", async (t) => {
  const { project } = await fixture(t);
  const store = new RunStore(path.join(project, ".workflow/runs")),
    id = randomUUID();
  assert.equal((await store.reportEvidence(id)).available, false);
  await store.record({
    id: randomUUID(),
    runId: id,
    time: "now",
    kind: "node_start",
    message: "No model session",
  });
  const evidence = await store.reportEvidence(id);
  assert.equal(evidence.available, true);
  assert.equal(evidence.total, 1);
  assert.deepEqual(evidence.events, []);
});
