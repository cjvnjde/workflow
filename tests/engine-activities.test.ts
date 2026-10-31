import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { setImmediate } from "node:timers/promises";
import { asyncLocalStorage, type Context } from "@temporalio/activity";
import type { Worker } from "@temporalio/worker";
import { WorkflowEngine } from "../src/core/engine.js";
import { bundleSchema, runSchema } from "../src/contracts/domain.js";
import type { CodeOperation } from "../src/contracts/code-schema.js";
import { readCommandOutput } from "../src/infrastructure/command-output.js";
import { attemptDirectory } from "../src/core/storage/attempt-store.js";
import { fixture, passingRunner } from "./helpers.js";

test("host verification records check spans with expectations and retrievable command output", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  const id = randomUUID(),
    now = new Date().toISOString();
  const block = bundleSchema.parse({
    definition: {
      id: "work",
      name: "Work",
      description: "Verification",
      checks: [
        { command: "test", expect: "failure" },
        { command: "test", expect: "success" },
      ],
    },
    prompt: "Work",
    skills: [],
  });
  const run = runSchema.parse({
    id,
    temporalWorkflowId: `workflow-${id}`,
    approvedAt: now,
    createdAt: now,
    updatedAt: now,
    mode: "live",
    status: "running",
    executionProtocol: 2,
    plan: {
      title: "Verification",
      task: "Work",
      entry: "work",
      nodes: [
        {
          id: "work",
          block: "work",
          label: "Work",
          goal: "Work",
          on: { pass: "$complete", retry: "$failed", fail: "$failed" },
        },
      ],
    },
    config: {
      ...library.config,
      commands: {
        test: {
          argv: ["bash", "-c", "printf 'reproduction evidence\\n'; exit 3"],
          timeoutMs: 2000,
        },
      },
    },
    blocks: { work: block },
    cursor: "work",
    visits: { work: 1 },
    artifacts: {},
    attempts: [{ nodeId: "work", visit: 1, startedAt: now }],
  });
  engine["runs"].set(id, run);
  const activity = {
    info: {
      workflowExecution: { workflowId: run.temporalWorkflowId },
      activityId: "verify",
      attempt: 1,
    },
    cancellationSignal: new AbortController().signal,
    heartbeat: () => {},
  } as unknown as Context;
  const result = await asyncLocalStorage.run(activity, () => engine["executeBlockNow"](run));
  assert.equal(result.result.outcome, "retry");
  assert.deepEqual(
    result.checks.map((check) => check.matched),
    [true, false],
  );
  const operations = (await engine.events(id)).flatMap((event) =>
    event.operation ? [event.operation] : [],
  );
  const started = operations.filter((operation) => operation.state === "started");
  const completed = operations.filter((operation) => operation.state === "completed");
  assert.deepEqual(
    started.map((operation) => operation.id),
    [`${id}/verify/check-1`, `${id}/verify/check-2`],
  );
  assert.equal(completed.length, 2);
  for (const [index, operation] of completed.entries()) {
    assert.equal(operation.kind, "exec");
    assert.equal(operation.parentId, `${id}/verify`);
    assert.equal(operation.environmentId, `local:${project}`);
    assert.ok(operation.durationMs! >= 0);
    assert.deepEqual(operation.details, {
      check: true,
      expected: index === 0 ? "failure" : "success",
      matched: index === 0,
      exitCode: 3,
    });
    assert.equal(operation.presentation?.card, "command");
    assert.equal(operation.presentation?.exitCode, 3);
    assert.ok(operation.outputRef);
    assert.deepEqual(operation.outputRef, result.checks[index]!.outputRef);
    assert.equal(
      (await readCommandOutput(attemptDirectory(project, id, "work", 1), operation.outputRef!.id))
        .text,
      "reproduction evidence\n",
    );
  }
});

test("code activities cannot execute or simulate a snapshot approved in another mode", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const filename = path.join(project, "mode.txt");
  await writeFile(filename, "original");
  const block = bundleSchema.parse({
    definition: {
      id: "work",
      name: "Work",
      description: "Mode check",
      executor: { kind: "code", source: "frozen source" },
    },
    prompt: "Work",
    skills: [],
  });
  for (const mode of ["live", "demo"] as const) {
    const engine = new WorkflowEngine(project, mode, passingRunner);
    cleanup(() => engine.shutdown());
    const id = randomUUID(),
      now = new Date().toISOString();
    const run = runSchema.parse({
      id,
      temporalWorkflowId: `workflow-${id}`,
      approvedAt: now,
      createdAt: now,
      updatedAt: now,
      mode: mode === "live" ? "demo" : "live",
      status: "running",
      executionProtocol: 2,
      plan: {
        title: "Mode check",
        task: "Work",
        entry: "work",
        nodes: [
          {
            id: "work",
            block: "work",
            label: "Work",
            goal: "Work",
            on: { pass: "$complete", retry: "$failed", fail: "$failed" },
          },
        ],
      },
      program: { source: "frozen source", catalog: {}, models: {} },
      config: library.config,
      blocks: { work: block },
      cursor: "work",
      visits: { work: 1 },
      artifacts: {},
      attempts: [{ nodeId: "work", visit: 1, startedAt: now }],
    });
    engine["runs"].set(id, run);
    const activity = {
      info: { workflowExecution: { workflowId: run.temporalWorkflowId } },
      cancellationSignal: new AbortController().signal,
      heartbeat: () => {},
    } as unknown as Context;
    const operations: CodeOperation[] = [
      { kind: "write", path: "mode.txt", content: "changed" },
      { kind: "read", path: "mode.txt" },
      { kind: "exec", command: "printf changed > mode.txt", timeoutMs: 1000 },
      { kind: "ai", prompt: "Work" },
    ];
    await asyncLocalStorage.run(activity, async () => {
      for (const operation of operations) {
        await assert.rejects(engine["executeOperation"](run, operation), /Execution mode mismatch/);
      }
    });
    assert.equal(await readFile(filename, "utf8"), "original");
    assert.deepEqual(await engine.events(id), []);
  }
});

test("shutdown retains project ownership until every worker has stopped even when another worker failed", async (t) => {
  const { project } = await fixture(t);
  const engine = new WorkflowEngine(project, "demo", passingRunner);
  const failure = new Error("Worker failed");
  let stopped = false,
    released = false;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  engine["workers"].set("failed", {
    worker: { getState: () => "FAILED" } as unknown as Worker,
    done: Promise.reject(failure),
  });
  engine["workers"].set("active", {
    worker: {
      getState: () => "RUNNING",
      shutdown: () => {
        stopped = true;
      },
    } as unknown as Worker,
    done: pending,
  });
  engine["releaseProject"] = async () => {
    released = true;
  };
  const shutdown = engine.shutdown();
  const rejected = assert.rejects(
    shutdown,
    (error) => error instanceof AggregateError && error.errors.includes(failure),
  );
  try {
    await setImmediate();
    assert.equal(stopped, true);
    assert.equal(
      released,
      false,
      "An active worker must retain the project lease even after its sibling failed",
    );
  } finally {
    finish();
    await rejected;
  }
  assert.equal(released, true);
});
