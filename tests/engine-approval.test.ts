import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ApplicationFailure, asyncLocalStorage, type Context } from "@temporalio/activity";
import { WorkflowEngine } from "../src/core/engine.js";
import { emptyUsage } from "../src/core/execution/budget.js";
import { bundleSchema, runSchema, type WorkflowRun } from "../src/contracts/domain.js";
import { fixture, passingResult } from "./helpers.js";

async function setup(t: TestContext, program = false) {
  const { project, library, cleanup } = await fixture(t);
  let executions = 0;
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    executions++;
    return passingResult(execution);
  });
  cleanup(() => engine.shutdown());
  const id = randomUUID();
  const now = new Date().toISOString();
  const block = bundleSchema.parse({
    definition: {
      id: "work",
      name: "Work",
      description: "Approval boundary",
      ...(program ? { executor: { kind: "code", source: "frozen source" } } : {}),
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
    executionVersion: "a".repeat(64),
    plan: {
      title: "Approval boundary",
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
    ...(program ? { program: { source: "frozen source", catalog: {}, models: {} } } : {}),
    config: library.config,
    blocks: { work: block },
    cursor: "work",
    visits: { work: 1 },
    artifacts: {},
    usage: emptyUsage(),
    attempts: [{ nodeId: "work", visit: 1, startedAt: now }],
  });
  engine["runs"].set(id, structuredClone(run));
  const activity = {
    info: {
      workflowExecution: { workflowId: run.temporalWorkflowId },
      activityId: "approval-test",
      attempt: 1,
    },
    cancellationSignal: new AbortController().signal,
    heartbeat: () => {},
  } as unknown as Context;
  return { project, engine, run, activity, executions: () => executions };
}

function unapproved(error: unknown) {
  assert.ok(error instanceof ApplicationFailure);
  assert.equal(error.type, "UnapprovedExecution");
  assert.equal(error.nonRetryable, true, "Rejected effects must never be retried");
  assert.match(
    error.message,
    /^(Temporal execution does not match a locally approved snapshot|Activity belongs to another Temporal workflow)$/,
  );
  return true;
}

const policyChanges: [string, (run: WorkflowRun) => void][] = [
  [
    "approval timestamp",
    (run) => {
      run.approvedAt = "2000-01-01T00:00:00.000Z";
    },
  ],
  [
    "missing approval timestamp",
    (run) => {
      delete run.approvedAt;
    },
  ],
  [
    "execution mode",
    (run) => {
      run.mode = "demo";
    },
  ],
  [
    "Temporal identity",
    (run) => {
      run.temporalWorkflowId = "forged-workflow";
    },
  ],
  [
    "missing Temporal identity",
    (run) => {
      delete run.temporalWorkflowId;
    },
  ],
  [
    "archived execution version",
    (run) => {
      run.executionVersion = "b".repeat(64);
    },
  ],
  [
    "execution protocol",
    (run) => {
      delete run.executionProtocol;
    },
  ],
  [
    "task",
    (run) => {
      run.plan.task = "Different task";
    },
  ],
  [
    "graph instructions",
    (run) => {
      run.plan.nodes[0]!.goal = "Different instructions";
    },
  ],
  [
    "block instructions",
    (run) => {
      run.blocks.work!.prompt = "Different instructions";
    },
  ],
  [
    "command configuration",
    (run) => {
      run.config.commands.injected = { argv: ["touch", "unauthorized"], timeoutMs: 1000 };
    },
  ],
  [
    "budget estimate",
    (run) => {
      run.estimate = {
        expectedCostUsd: 0,
        worstCaseCostUsd: 0,
        expectedVisits: 1,
        maxVisits: 1,
        unpricedNodes: [],
        assumptions: "Forged budget",
      };
    },
  ],
];

for (const [name, change] of policyChanges) {
  test(`graph activities reject changes to the approved ${name} before running a block`, async (t) => {
    const { engine, run, activity, executions } = await setup(t);
    const approved = structuredClone(run);
    change(run);
    await asyncLocalStorage.run(activity, () =>
      assert.rejects(engine["executeBlockNow"](run), unapproved),
    );
    assert.equal(executions(), 0);
    assert.deepEqual(engine.get(run.id), approved);
    assert.deepEqual(await engine.events(run.id), []);
  });
}

test("a forged approval cannot authorize a draft or an unknown run", async (t) => {
  const { engine, run, activity, executions } = await setup(t);
  const draft = { ...structuredClone(run), status: "draft" as const, approvedAt: undefined };
  engine["runs"].set(run.id, draft);
  await asyncLocalStorage.run(activity, async () => {
    await assert.rejects(engine["executeBlockNow"](run), unapproved);
    assert.deepEqual(engine.get(run.id), draft);
    engine["runs"].delete(run.id);
    await assert.rejects(engine["executeBlockNow"](run), unapproved);
  });
  assert.equal(executions(), 0);
  engine["runs"].set(run.id, draft);
  assert.deepEqual(await engine.events(run.id), []);
});

test("an approved snapshot cannot be replayed by a different Temporal workflow", async (t) => {
  const { engine, run, activity, executions } = await setup(t);
  const replay = {
    ...activity,
    info: {
      ...activity.info,
      workflowExecution: { workflowId: "another-workflow", runId: "another-run" },
    },
  } as unknown as Context;
  await asyncLocalStorage.run(replay, () =>
    assert.rejects(engine["executeBlockNow"](run), unapproved),
  );
  assert.equal(executions(), 0);
  assert.deepEqual(engine.get(run.id), run);
  assert.deepEqual(await engine.events(run.id), []);
});

test("serialized approved snapshots allow execution progress and optional undefined fields", async (t) => {
  const { engine, run, activity, executions } = await setup(t);
  const transported = JSON.parse(JSON.stringify(run)) as WorkflowRun;
  transported.revision += 1;
  transported.updatedAt = "2000-01-01T00:00:00.000Z";
  transported.blocks.work!.definition.agent = undefined;
  const result = await asyncLocalStorage.run(activity, () =>
    engine["executeBlockNow"](transported),
  );
  assert.equal(result.result.outcome, "pass");
  assert.equal(executions(), 1);
});

const programChanges: [string, (run: WorkflowRun) => void][] = [
  [
    "title",
    (run) => {
      run.plan.title = "Different workflow";
    },
  ],
  [
    "task",
    (run) => {
      run.plan.task = "Different task";
    },
  ],
  [
    "source",
    (run) => {
      run.program!.source = "changed source";
    },
  ],
  [
    "inputs",
    (run) => {
      run.program!.input = { request: "Different task" };
    },
  ],
  [
    "catalog",
    (run) => {
      run.program!.catalog.work = run.blocks.work!;
    },
  ],
  [
    "model profiles",
    (run) => {
      run.program!.models.injected = { model: "different-model" };
    },
  ],
];

for (const [name, change] of programChanges) {
  test(`code activities reject changed ${name} before writing a file`, async (t) => {
    const { engine, run, activity, project } = await setup(t, true);
    const approved = structuredClone(run);
    const filename = path.join(project, "approval.txt");
    await writeFile(filename, "original");
    change(run);
    await asyncLocalStorage.run(activity, () =>
      assert.rejects(
        engine["executeOperation"](run, { kind: "write", path: "approval.txt", content: "forged" }),
        unapproved,
      ),
    );
    assert.equal(await readFile(filename, "utf8"), "original");
    assert.deepEqual(engine.get(run.id), approved);
    assert.deepEqual(await engine.events(run.id), []);
  });
}

test("code workflows authorize derived steps through the frozen program", async (t) => {
  const { engine, run, activity, project } = await setup(t, true);
  const approved = structuredClone(run);
  // Program steps and block projections are derived during execution; the
  // frozen source, catalog, inputs and model profiles remain the authority.
  run.plan.nodes[0]!.goal = "Derived step instructions";
  run.blocks.work!.prompt = "Derived block instructions";
  const filename = path.join(project, "approval.txt");
  await writeFile(filename, "original");
  await asyncLocalStorage.run(activity, () =>
    engine["executeOperation"](JSON.parse(JSON.stringify(run)), {
      kind: "write",
      path: "approval.txt",
      content: "approved",
    }),
  );
  assert.equal(await readFile(filename, "utf8"), "approved");
  assert.deepEqual(engine.get(run.id), approved);
});

test("activities without a Temporal identity cannot execute even an approved snapshot", async (t) => {
  const { engine, run, activity, executions } = await setup(t);
  const unbound = {
    ...activity,
    info: { ...activity.info, workflowExecution: undefined },
  } as unknown as Context;
  await asyncLocalStorage.run(unbound, async () => {
    await assert.rejects(engine["executeBlockNow"](run), unapproved);
    delete run.temporalWorkflowId;
    engine["runs"].set(run.id, structuredClone(run));
    await assert.rejects(engine["executeBlockNow"](run), unapproved);
  });
  assert.equal(executions(), 0);
  assert.deepEqual(engine.get(run.id), run);
  assert.deepEqual(await engine.events(run.id), []);
});
