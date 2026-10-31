import assert from "node:assert/strict";
import { test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowEngine } from "../src/core/engine.js";
import type { UsageTotals } from "../src/contracts/domain.js";
import { FileClaims, FileJournal } from "../src/core/storage/recovery.js";
import { Workspace } from "../src/core/storage/workspace.js";
import { fixture } from "./helpers.js";

const header = 'import { workflow, block, step, sequence, parallel } from "workflow";';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function until(check: () => boolean | Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function usage(costUsd: number): UsageTotals {
  return {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    requests: 1,
    unpricedRequests: 0,
  };
}

test("cancelling parallel attempts restores every active managed edit and preserves completed work", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await writeFile(path.join(project, "a.txt"), "original-a");
  await writeFile(path.join(project, "b.txt"), "original-b");
  const started = new Set<string>();
  const aborted = new Set<string>();
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    started.add(execution.node.id);
    try {
      return await waitForAbort(execution.signal);
    } finally {
      aborted.add(execution.node.id);
    }
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();

  const source =
    header +
    `
    const completed = step("completed", block({async run(ctx) {
      await ctx.writeFile("completed.txt", "keep completed work");
      return "Completed";
    }}));
    const active = block({async run(ctx) {
      await ctx.writeFile(String(ctx.input.file), "partial edit");
      return await ctx.ai({prompt: ctx.prompt});
    }});
    export default workflow({name: "Cancel parallel work", flow: sequence(
      completed,
      parallel([
        step("a", active, {inputs: {file: "a.txt"}}),
        step("b", active, {inputs: {file: "b.txt"}}),
      ], {concurrency: 2}),
    )});`;
  const draft = await engine.createProgram("Cancel parallel work", "Task", { source }, library);
  await engine.approve(draft.id);
  await until(() => started.size === 2, "Both independent attempts should start");
  assert.equal(await readFile(path.join(project, "a.txt"), "utf8"), "partial edit");
  assert.equal(await readFile(path.join(project, "b.txt"), "utf8"), "partial edit");

  await engine.cancel(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "cancelled", run.error ?? "");
  assert.deepEqual(aborted, new Set(["a", "b"]));
  assert.deepEqual(run.activeNodes, []);
  assert.equal(await readFile(path.join(project, "a.txt"), "utf8"), "original-a");
  assert.equal(await readFile(path.join(project, "b.txt"), "utf8"), "original-b");
  assert.equal(await readFile(path.join(project, "completed.txt"), "utf8"), "keep completed work");
  assert.equal(
    run.attempts.find((attempt) => attempt.nodeId === "completed")?.recovery?.status,
    "committed",
  );
  for (const id of ["a", "b"]) {
    assert.equal(
      run.attempts.find((attempt) => attempt.nodeId === id)?.recovery?.status,
      "restored",
    );
  }
});

test("restart resumes only the interrupted parallel sibling and retains every attempt's usage", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await writeFile(path.join(project, "a.txt"), "original-a");
  await writeFile(path.join(project, "b.txt"), "original-b");
  const calls: string[] = [];
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    calls.push(`${execution.node.id}:${execution.visit}`);
    await execution.onUsage?.(usage(execution.node.id === "a" ? 0.1 : 0.2));
    if (execution.node.id === "b") return await waitForAbort(execution.signal);
    return { outcome: "pass", summary: "Completed sibling A", artifacts: {} };
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source =
    header +
    `
    const job = block({async run(ctx) {
      await ctx.writeFile(String(ctx.input.file), "changed-" + ctx.visit);
      return await ctx.ai({prompt: ctx.prompt});
    }});
    export default workflow({name: "Recover siblings", flow: parallel([
      step("a", job, {inputs: {file: "a.txt"}, maxVisits: 3}),
      step("b", job, {inputs: {file: "b.txt"}, maxVisits: 3}),
    ])});`;
  const draft = await engine.createProgram("Recover siblings", "Task", { source }, library);
  await engine.approve(draft.id);
  await until(
    () =>
      calls.includes("b:1") &&
      !!engine.get(draft.id).attempts.find((attempt) => attempt.nodeId === "a")?.finishedAt,
    "Sibling A should finish while sibling B remains active",
  );
  await engine.shutdown();

  const restarted = new WorkflowEngine(project, "live", async (execution) => {
    calls.push(`${execution.node.id}:${execution.visit}`);
    assert.equal(execution.node.id, "b", "Completed sibling A must not run again");
    assert.equal(execution.visit, 2);
    await execution.onUsage?.(usage(0.3));
    return { outcome: "pass", summary: "Recovered sibling B", artifacts: {} };
  });
  cleanup(() => restarted.shutdown());
  await restarted.initialize();
  await until(
    () => restarted.get(draft.id).status === "interrupted",
    "Worker loss should await an explicit retry",
  );
  assert.deepEqual(calls.toSorted(), ["a:1", "b:1"]);
  assert.equal(await readFile(path.join(project, "a.txt"), "utf8"), "changed-1");
  assert.equal(await readFile(path.join(project, "b.txt"), "utf8"), "original-b");
  assert.equal(restarted.get(draft.id).usage?.requests, 2);

  await restarted.resume(draft.id);
  await restarted.waitForIdle();
  const run = restarted.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.deepEqual(calls.toSorted(), ["a:1", "b:1", "b:2"]);
  assert.deepEqual(run.visits, { a: 1, b: 2 });
  assert.equal(run.usage?.requests, 3);
  assert.ok(Math.abs((run.usage?.costUsd ?? 0) - 0.6) < 1e-10);
  assert.equal(
    run.attempts.find((attempt) => attempt.nodeId === "b" && attempt.visit === 1)?.usage?.costUsd,
    0.2,
  );
  assert.equal(await readFile(path.join(project, "a.txt"), "utf8"), "changed-1");
  assert.equal(await readFile(path.join(project, "b.txt"), "utf8"), "changed-2");
});

test("nested parallel groups obey the global limit and stop admitted waiters after failure while paused", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const calls: string[] = [];
  let active = 0;
  let maximum = 0;
  // eslint-disable-next-line prefer-const -- Running callbacks read undefined before the first admitted step is selected below.
  let failureId: string | undefined;
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    calls.push(execution.node.id);
    active++;
    maximum = Math.max(maximum, active);
    const gate = deferred();
    gates.set(execution.node.id, gate);
    try {
      await Promise.race([gate.promise, waitForAbort(execution.signal)]);
      return {
        outcome: "pass",
        summary: execution.node.id === failureId ? "fail" : "pass",
        artifacts: {},
      };
    } finally {
      active--;
    }
  });
  cleanup(() => engine.shutdown());
  cleanup(async () => {
    for (const gate of gates.values()) gate.resolve();
  });
  await engine.initialize();
  const groups = Array.from(
    { length: 3 },
    (_, group) =>
      `parallel([${Array.from({ length: 5 }, (_, member) => `step("work-${group}-${member}", job)`).join(",")}], {concurrency: 5})`,
  );
  const source =
    header +
    `
    const job = block({async run(ctx) {
      const answer = await ctx.ai({prompt: ctx.prompt});
      if (answer === "fail") ctx.outcome("fail");
      return answer;
    }});
    export default workflow({name: "Nested limits", flow: parallel([${groups.join(",")}], {concurrency: 3})});`;
  const draft = await engine.createProgram("Nested limits", "Task", { source }, library);
  await engine.approve(draft.id);
  await until(() => calls.length >= 8, "The first eight independent effects should start");
  assert.equal(calls.length, 8);
  assert.equal(maximum, 8);
  assert.equal((await engine.refresh(draft.id)).activeNodes?.length, 8);
  await engine.pause(draft.id);
  failureId = calls[0]!;
  gates.get(failureId)!.resolve();
  await until(
    () =>
      engine
        .get(draft.id)
        .attempts.some(
          (attempt) => attempt.nodeId === failureId && attempt.result?.outcome === "fail",
        ),
    "The failed active step should publish its outcome while paused",
  );
  for (const gate of gates.values()) gate.resolve();
  await until(
    () => engine.get(draft.id).status === "failed",
    "Failure should drain active work and discard admission waiters without requiring Resume",
  );
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(maximum, 8);
  assert.equal(calls.length, 8, "The seven gate-queued steps must never start");
  assert.equal(run.attempts.length, 8);
  assert.deepEqual(run.activeNodes, []);
  assert.match(run.error ?? "", /fail/);
});

test("Resume received before an interrupted checkpoint returns is not lost", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  let calls = 0;
  const engine = new WorkflowEngine(project, "live", async () => {
    calls++;
    if (calls === 1) throw new Error("Disconnect before result");
    return { outcome: "pass", summary: "Retried once", artifacts: {} };
  });
  cleanup(() => engine.shutdown());
  const checkpointStored = deferred();
  const releaseCheckpoint = deferred();
  const saveProjection = engine["saveProjection"].bind(engine);
  let blocked = false;
  engine["saveProjection"] = async (run, event) => {
    await saveProjection(run, event);
    if (!blocked && event?.kind === "interrupted") {
      blocked = true;
      checkpointStored.resolve();
      await releaseCheckpoint.promise;
    }
  };
  cleanup(async () => {
    releaseCheckpoint.resolve();
    engine["saveProjection"] = saveProjection;
  });
  await engine.initialize();
  const source =
    header +
    `
    const work = step("work", block({run: ctx => ctx.ai({prompt: ctx.prompt})}), {maxVisits: 2});
    export default workflow({name: "Resume checkpoint race", flow: work});`;
  const draft = await engine.createProgram("Resume checkpoint race", "Task", { source }, library);
  await engine.approve(draft.id);
  await checkpointStored.promise;
  assert.equal(engine.get(draft.id).status, "interrupted");
  await engine.resume(draft.id);
  releaseCheckpoint.resolve();
  await until(
    () => engine.get(draft.id).status === "completed",
    "One Resume signal must retry after the pending checkpoint completes",
  );
  await engine.waitForIdle();
  assert.equal(calls, 2);
  assert.equal(engine.get(draft.id).visits.work, 2);
});

test("overlapping historical claims cannot commit away evidence needed to protect sibling changes", async (t) => {
  const { project } = await fixture(t);
  const filename = path.join(project, "shared.txt");
  await writeFile(filename, "original");
  // Old versions allowed another run after cancellation left a conflict.
  const firstDirectory = path.join(project, "first-journal");
  const first = await FileJournal.open(firstDirectory);
  const firstWorkspace = await Workspace.create(project, { journal: first });
  await firstWorkspace.write("shared.txt", "identical changes");
  await writeFile(filename, "manual changes");
  assert.equal((await first.settle(firstWorkspace, false)).status, "conflict");

  const secondDirectory = path.join(project, "second-journal");
  const second = await FileJournal.open(secondDirectory);
  const secondWorkspace = await Workspace.create(project, { journal: second });
  await secondWorkspace.write("shared.txt", "identical changes");

  const claims = new FileClaims(project);
  const recoveredFirst = await FileJournal.open(firstDirectory, claims);
  const recoveredSecond = await FileJournal.open(secondDirectory, claims);
  const workspace = await Workspace.create(project);
  assert.equal((await recoveredFirst.settle(workspace, false)).status, "conflict");
  assert.equal((await recoveredSecond.settle(workspace, true)).status, "conflict");
  assert.equal((await recoveredFirst.settle(workspace, false)).status, "conflict");
  assert.equal(await readFile(filename, "utf8"), "identical changes");
});
