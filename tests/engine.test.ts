import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Client, Connection, WorkflowFailedError } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/activity";
import { z } from "zod";
import type { BlockExecution } from "../src/block-runner.js";
import { runDemoBlock } from "../src/block-runner.js";
import { WorkflowEngine } from "../src/engine.js";
import { createTemplate } from "../src/templates.js";
import { fixture, passingResult, passingRunner } from "./helpers.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((accept) => { resolve = accept; });

  return { promise, resolve };
}

async function setup(t: TestContext, runner = passingRunner, mode: "live" | "demo" = "live") {
  const context = await fixture(t);
  const engine = new WorkflowEngine(context.project, mode, runner);
  context.cleanup(() => engine.shutdown());
  await engine.initialize();

  return { ...context, engine };
}

function eventBarrier(engine: WorkflowEngine, kind: string) {
  const barrier = deferred<void>();
  const unsubscribe = engine.subscribe((event) => {
    if (event.kind === kind) { unsubscribe(); barrier.resolve(); }
  });

  return barrier.promise;
}

test("Temporal does not execute drafts; approval runs only the selected graph", async (t) => {
  const executions: BlockExecution[] = [];
  const { engine, library } = await setup(t, async (execution) => {
    executions.push(execution);
    return passingResult(execution);
  });
  const run = await engine.create(createTemplate("Fix bug", "bug", library), library);
  assert.equal(run.status, "draft");
  assert.equal(executions.length, 0);
  await engine.approve(run.id);
  await engine.waitForIdle();
  assert.deepEqual(executions.map((execution) => execution.node.id), ["prepare", "work", "review"]);
  assert.equal(engine.get(run.id).status, "completed");
  await assert.rejects(engine.approve(run.id), /Only draft/);
  await assert.rejects(engine.update(run.id, run.plan), /Only draft/);
});

test("a failed Temporal start restores a draft with a newer revision and permits retry", async (t) => {
  const { engine, library, project } = await setup(t);
  const draft = await engine.create(createTemplate("Retry failed start", "bug", library), library);
  const workflow = engine["environment"]!.client.workflow;
  const originalStart = workflow.start;
  let observedRevision = draft.revision;
  workflow.start = async () => {
    const inFlight = engine.get(draft.id);
    assert.equal(inFlight.status, "running");
    observedRevision = inFlight.revision;
    throw new Error("Simulated Temporal start failure");
  };
  try { await assert.rejects(engine.approve(draft.id), /Simulated Temporal start failure/); }
  finally { workflow.start = originalStart; }
  const restored = engine.get(draft.id);
  assert.equal(restored.status, "draft");
  assert.ok(restored.revision > observedRevision, "The browser must accept the restored draft after observing approval");
  assert.equal(restored.approvedAt, undefined);
  const persisted = JSON.parse(await readFile(path.join(project, ".workflow", "runs", draft.id, "run.json"), "utf8"));
  assert.equal(persisted.revision, restored.revision);
  assert.equal((await engine.events(draft.id)).at(-1)?.kind, "draft");
  await assert.rejects(engine.approve(draft.id, draft.revision), /Draft changed/);
  await engine.approve(draft.id, restored.revision);
  await engine.waitForIdle();
  assert.equal(engine.get(draft.id).status, "completed");
});

test("a crash after saving approval but before sending the start RPC recovers a draft and fences the old approval", async (t) => {
  const executions: string[] = [];
  const runner = async (execution: BlockExecution) => { executions.push(execution.node.id); return passingResult(execution); };
  const { engine, library, project, cleanup } = await setup(t, runner);
  const draft = await engine.create(createTemplate("Recover interrupted approval", "bug", library), library);
  const store = engine["store"];
  const save = store.save.bind(store);
  let crashedSnapshot = draft;
  store.save = async (run) => {
    await save(run);
    if (run.temporalStart === "pending") {
      crashedSnapshot = structuredClone(run);
      throw new Error("Crash after durable approval, before start");
    }
  };
  await assert.rejects(engine.approve(draft.id), /Crash after durable approval/);
  store.save = save;
  assert.equal(executions.length, 0);
  await engine.shutdown();
  const restored = new WorkflowEngine(project, "live", runner);
  cleanup(() => restored.shutdown());
  await restored.initialize();
  const recovered = restored.get(draft.id);
  assert.equal(recovered.status, "draft");
  assert.equal(recovered.approvedAt, undefined);
  assert.match(recovered.error!, /approve again/);
  assert.ok(recovered.revision > crashedSnapshot.revision);
  assert.notEqual(recovered.temporalWorkflowId, crashedSnapshot.temporalWorkflowId);
  assert.equal(executions.length, 0, "Restart must not execute an unstarted draft");
  assert.throws(() => restored["assertSnapshot"](crashedSnapshot), /locally approved/);
  await restored.approve(draft.id, recovered.revision);
  assert.throws(() => restored["assertSnapshot"](crashedSnapshot), /locally approved/);
  await restored.waitForIdle();
  assert.deepEqual(executions, ["prepare", "work", "review"]);
  assert.equal(restored.get(draft.id).temporalStart, "confirmed");
});

test("a missing history receipt never turns a confirmed or legacy execution back into a draft", async (t) => {
  for (const receipt of ["confirmed", undefined] as const) {
    const { engine, library, project, cleanup } = await setup(t);
    const draft = await engine.create(createTemplate("Missing execution history", "bug", library), library);
    await engine["store"].save({
      ...draft, status: "running", approvedAt: new Date().toISOString(), temporalStart: receipt,
    });
    await engine.shutdown();
    const restored = new WorkflowEngine(project, "live", passingRunner);
    cleanup(() => restored.shutdown());
    await assert.rejects(restored.initialize(), /Temporal history .* is missing/);
    assert.equal(restored.get(draft.id).status, "running");
  }
});

test("startup reconciles an accepted start with an unconfirmed receipt without duplicating execution", async (t) => {
  const executions: string[] = [];
  const runner = async (execution: BlockExecution) => { executions.push(execution.node.id); return passingResult(execution); };
  const { engine, library, project, cleanup } = await setup(t, runner);
  const draft = await engine.create(createTemplate("Accepted start, lost acknowledgement", "bug", library), library);
  // Stop workers to model the process disappearing before any activity starts.
  for (const { worker, done } of engine["workers"].values()) { worker.shutdown(); await done; }
  engine["workers"].clear();
  const approved = { ...draft, status: "running" as const, temporalStart: "pending" as const, approvedAt: new Date().toISOString(), revision: draft.revision + 1 };
  await engine["store"].save(approved);
  const { temporalStart: _receipt, ...input } = approved;
  await engine["environment"]!.client.workflow.start("executeWorkflow", {
    workflowId: approved.temporalWorkflowId!, taskQueue: engine["queueFor"](approved.executionVersion), args: [input],
  });
  await engine.shutdown();
  const restored = new WorkflowEngine(project, "live", runner);
  cleanup(() => restored.shutdown());
  await restored.initialize();
  await restored.waitForIdle();
  assert.equal(restored.get(draft.id).status, "completed");
  assert.equal(restored.get(draft.id).temporalStart, "confirmed");
  assert.deepEqual(executions, ["prepare", "work", "review"]);
});

test("Temporal review retries route only explicitly selected feedback", async (t) => {
  const executions: BlockExecution[] = [];
  const { engine, library } = await setup(t, async (execution) => {
    executions.push(execution);
    const result = passingResult(execution);
    if (execution.node.id === "review" && execution.visit === 1) {
      return { ...result, outcome: "retry", artifacts: { feedback: "Handle empty input" } };
    }

    return result;
  });
  const draft = await engine.create(createTemplate("Feature", "feature", library), library);
  await engine.approve(draft.id);
  await engine.waitForIdle();
  assert.deepEqual(executions.map((execution) => execution.node.id), ["prepare", "work", "verify", "review", "work", "verify", "review"]);
  const work = executions.filter((execution) => execution.node.id === "work");
  assert.equal(work[0]?.inputs["review-feedback"], undefined);
  assert.equal(work[1]?.inputs["review-feedback"], "Handle empty input");
  assert.equal(work[1]?.inputs.requirements, "prepare:requirements");
  assert.equal(executions[0]?.inputs.implementation, undefined);
  assert.equal(engine.get(draft.id).status, "completed");
});

test("host checks override a passing agent and bounded Temporal loops terminate", async (t) => {
  const { engine, library } = await setup(t);
  const fix = library.blocks.fix;
  assert.ok(fix);
  library.config.commands.test = { argv: [process.execPath, "-e", "console.error('still broken'); process.exit(1)"], timeoutMs: 2000 };
  fix.definition.checks = [{ command: "test", expect: "success" }];
  const plan = createTemplate("Bug", "bug", library);
  const work = plan.nodes.find((node) => node.id === "work");
  assert.ok(work);
  work.maxVisits = 2;
  const draft = await engine.create(plan, library);
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /iteration budget/);
  assert.equal(run.visits.work, 2);
  assert.equal(run.visits.review, undefined);
  assert.equal(run.attempts.find((attempt) => attempt.nodeId === "work")?.result?.outcome, "retry");
  assert.match(run.artifacts.work?.summary ?? "", /still broken/);
});

test("Temporal input freezes block policies, prompts and commands at proposal time", async (t) => {
  const prompts: string[] = [];
  const { engine, library } = await setup(t, async (execution) => {
    assert.equal(execution.workflow?.task, execution.task);
    assert.ok(execution.workflow?.nodes.some((node) => node.id === execution.node.id));
    prompts.push(execution.bundle.prompt);
    return passingResult(execution);
  });
  const fix = library.blocks.fix;
  assert.ok(fix);
  const original = fix.prompt;
  const draft = await engine.create(createTemplate("Bug", "bug", library), library);
  fix.prompt = "Changed after proposal";
  fix.definition.description = "Changed after proposal";
  library.config.maxSteps = 1;
  await engine.approve(draft.id);
  await engine.waitForIdle();
  assert.ok(prompts.includes(original));
  assert.equal(engine.get(draft.id).status, "completed");
});

test("only one workflow owns the project and cancellation stops its active activity", async (t) => {
  const started = deferred<void>();
  const { engine, library } = await setup(t, async (execution) => {
    started.resolve();
    await new Promise<void>((_resolve, reject) => {
      execution.signal.addEventListener("abort", () => { reject(execution.signal.reason); }, { once: true });
    });

    return passingResult(execution);
  });
  const first = await engine.create(createTemplate("First", "bug", library), library);
  const second = await engine.create(createTemplate("Second", "bug", library), library);
  await engine.approve(first.id);
  await started.promise;
  await assert.rejects(engine.approve(second.id), /Another workflow/);
  await engine.cancel(first.id);
  await engine.waitForIdle();
  assert.equal(engine.get(first.id).status, "cancelled");
  assert.equal(engine.get(first.id).attempts.length, 1);
  assert.equal(engine.get(second.id).status, "draft");
});

test("missing required artifacts stop the workflow before an activity executes", async (t) => {
  let executions = 0;
  const { engine, library } = await setup(t, async (execution) => {
    executions += 1;
    return passingResult(execution);
  });
  const plan = createTemplate("Bug", "bug", library);
  const first = plan.nodes[0];
  assert.ok(first);
  first.inputs = [{ node: "work", artifact: "implementation", required: true }];
  const draft = await engine.create(plan, library);
  await engine.approve(draft.id);
  await engine.waitForIdle();
  assert.equal(executions, 0);
  assert.match(engine.get(draft.id).error ?? "", /Missing required artifact/);
});

test("pause finishes the active step; resume survives server restart without repeating completed edits", async (t) => {
  const started = deferred<void>();
  const release = deferred<void>();
  const executions: string[] = [];
  const { engine, project, library, cleanup } = await setup(t, async (execution) => {
    executions.push(execution.node.id);
    if (execution.node.id === "prepare") {
      await writeFile(path.join(project, "completed-edit.txt"), "written once");
      started.resolve();
      await release.promise;
    }

    return passingResult(execution);
  });
  const draft = await engine.create(createTemplate("Bug", "bug", library), library);
  await engine.approve(draft.id);
  await started.promise;
  const paused = eventBarrier(engine, "paused");
  assert.equal((await engine.pause(draft.id)).status, "pausing");
  release.resolve();
  await paused;
  assert.equal(engine.get(draft.id).status, "paused");
  assert.equal(engine.get(draft.id).cursor, "work");
  await engine.shutdown();
  const restarted = new WorkflowEngine(project, "live", async (execution) => {
    assert.notEqual(execution.node.id, "prepare", "a completed file-mutating activity must not be replayed");
    executions.push(execution.node.id);
    return passingResult(execution);
  });
  cleanup(() => restarted.shutdown());
  await restarted.initialize();
  assert.equal(restarted.get(draft.id).status, "paused");
  await restarted.resume(draft.id);
  await restarted.waitForIdle();
  assert.equal(restarted.get(draft.id).status, "completed");
  assert.deepEqual(executions, ["prepare", "work", "review"]);
  assert.equal(await readFile(path.join(project, "completed-edit.txt"), "utf8"), "written once");
  assert.ok((await restarted.events(draft.id)).some((event) => event.kind === "resumed"));
});

test("an activity failure waits for explicit resume, which retries only that step within visit budgets", async (t) => {
  const executions: string[] = [];
  const { engine, library } = await setup(t, async (execution) => {
    executions.push(`${execution.node.id}:${execution.visit}`);
    if (execution.node.id === "work" && execution.visit === 1) { throw new Error("Simulated provider disconnect after partial edits"); }

    return passingResult(execution);
  });
  const draft = await engine.create(createTemplate("Bug", "bug", library), library);
  const interrupted = eventBarrier(engine, "interrupted");
  await engine.approve(draft.id);
  await interrupted;
  assert.equal(engine.get(draft.id).status, "interrupted");
  assert.deepEqual(executions, ["prepare:1", "work:1"]);
  assert.match(engine.get(draft.id).error ?? "", /Simulated provider disconnect after partial edits/);
  assert.match(engine.get(draft.id).error ?? "", /Inspect shell, Git and check-command effects/);
  await engine.resume(draft.id);
  await engine.waitForIdle();
  assert.deepEqual(executions, ["prepare:1", "work:1", "work:2", "review:1"]);
  assert.equal(engine.get(draft.id).status, "completed");
  assert.equal(engine.get(draft.id).visits.work, 2);
});

test("worker loss recovers managed changes after restart without automatically rerunning the step", async (t) => {
  const started = deferred<void>();
  const executions: string[] = [];
  const { engine, project, library, cleanup } = await setup(t, async (execution) => {
    executions.push(`${execution.node.id}:${execution.visit}`);
    if (execution.node.id === "work") {
      const { Workspace } = await import("../src/workspace.js");
      const workspace = await Workspace.create(project, { journal: execution.journal, signal: execution.signal });
      await workspace.write("partial-edit.txt", "inspect before retry");
      started.resolve();
      await new Promise<never>((_resolve, reject) => {
        execution.signal.addEventListener("abort", () => { reject(execution.signal.reason); }, { once: true });
      });
    }

    return passingResult(execution);
  });
  const draft = await engine.create(createTemplate("Bug", "bug", library), library);
  await engine.approve(draft.id);
  await started.promise;
  await engine.shutdown();
  const restarted = new WorkflowEngine(project, "live", async (execution) => {
    executions.push(`${execution.node.id}:${execution.visit}`);
    return passingResult(execution);
  });
  cleanup(() => restarted.shutdown());
  const interrupted = eventBarrier(restarted, "interrupted");
  await restarted.initialize();
  await interrupted;
  assert.equal(restarted.get(draft.id).status, "interrupted");
  assert.deepEqual(executions, ["prepare:1", "work:1"]);
  await assert.rejects(readFile(path.join(project, "partial-edit.txt")), { code: "ENOENT" });
  assert.equal(restarted.get(draft.id).attempts.at(-1)?.recovery?.status, "restored");
  await restarted.resume(draft.id);
  await restarted.waitForIdle();
  assert.equal(restarted.get(draft.id).status, "completed");
  assert.deepEqual(executions, ["prepare:1", "work:1", "work:2", "review:1"]);
});

test("rejecting a draft never executes it and the execution mode cannot silently change", async (t) => {
  const { engine, project, library, cleanup } = await setup(t, async () => { throw new Error("Must not run"); }, "demo");
  const rejected = await engine.create(createTemplate("Bug", "bug", library), library);
  await engine.reject(rejected.id);
  assert.equal(engine.get(rejected.id).status, "rejected");
  const pending = await engine.create(createTemplate("Feature", "feature", library), library);
  await engine.shutdown();
  const live = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => live.shutdown());
  await live.initialize();
  await assert.rejects(live.approve(pending.id), /different execution mode/);
});

test("starting a Temporal workflow directly cannot bypass local approval", async (t) => {
  let executions = 0;
  const { engine, project, library, cleanup } = await setup(t, async (execution) => {
    executions += 1;
    return passingResult(execution);
  });
  const legitimate = await engine.create(createTemplate("Approved", "bug", library), library);
  await engine.approve(legitimate.id);
  await engine.waitForIdle();
  const receipt = z.object({ port: z.number() }).parse(JSON.parse(await readFile(path.join(project, ".workflow/temporal/server.json"), "utf8")));
  const connection = await Connection.connect({ address: `127.0.0.1:${receipt.port}` });
  cleanup(() => connection.close());
  const client = new Client({ connection });
  assert.ok(legitimate.temporalWorkflowId);
  const description = await client.workflow.getHandle(legitimate.temporalWorkflowId).describe();
  const draft = await engine.create(createTemplate("Not approved", "bug", library), library);
  assert.ok(draft.temporalWorkflowId);
  executions = 0;
  const unauthorized = await client.workflow.start("executeWorkflow", {
    workflowId: draft.temporalWorkflowId,
    taskQueue: description.taskQueue,
    args: [{ ...draft, status: "running", approvedAt: new Date().toISOString() }],
  });
  await assert.rejects(unauthorized.result(), (error: unknown) => error instanceof WorkflowFailedError && error.cause instanceof Error && error.cause.cause instanceof ApplicationFailure && error.cause.cause.type === "UnapprovedExecution");
  assert.equal(executions, 0);
  assert.equal(engine.get(draft.id).status, "draft");
});

test("demo still uses Temporal but never executes configured check commands", async (t) => {
  const { engine, library } = await setup(t, runDemoBlock, "demo");
  const fix = library.blocks.fix;
  assert.ok(fix);
  library.config.commands.test = { argv: ["this-executable-must-not-run"], timeoutMs: 1000 };
  fix.definition.checks = [{ command: "test", expect: "success" }];
  const draft = await engine.create(createTemplate("Bug", "bug", library), library);
  await engine.approve(draft.id);
  await engine.waitForIdle();
  assert.equal(engine.get(draft.id).status, "completed");
  assert.match(engine.get(draft.id).attempts.find((attempt) => attempt.nodeId === "work")?.checks[0]?.output ?? "", /DEMO/);
});

test("cancellation restores only the current step and retains completed-step changes", async (t) => {
  const { Workspace } = await import("../src/workspace.js");
  const started = deferred<void>();
  const { engine, project, library } = await setup(t, async (execution) => {
    const workspace = await Workspace.create(execution.project, { journal: execution.journal, signal: execution.signal });
    if (execution.node.id === "prepare") { await workspace.write("completed.ts", "keep this"); }
    if (execution.node.id === "work") {
      await workspace.write("partial.ts", "unfinished change");
      started.resolve();
      await new Promise<never>((_resolve, reject) => execution.signal.addEventListener("abort", () => reject(execution.signal.reason), { once: true }));
    }
    return passingResult(execution);
  });
  // Let preparation make a completed file-tool change to distinguish it from the interrupted step.
  await writeFile(path.join(project, "partial.ts"), "original");
  const draft = await engine.create(createTemplate("Cancel safely", "bug", library), library);
  await engine.approve(draft.id); await started.promise;
  await engine.cancel(draft.id); await engine.waitForIdle();
  const finished = engine.get(draft.id);
  assert.equal(finished.status, "cancelled");
  assert.equal(finished.attempts.at(-1)?.recovery?.status, "restored");
  assert.equal(await readFile(path.join(project, "partial.ts"), "utf8"), "original");
  assert.equal(await readFile(path.join(project, "completed.ts"), "utf8"), "keep this");
});

test("failed checks restore file-tool changes before the approved retry route", async (t) => {
  const { Workspace } = await import("../src/workspace.js");
  const { engine, project, library } = await setup(t, async (execution) => {
    if (execution.node.id === "work") {
      assert.equal(await readFile(path.join(execution.project, "source.ts"), "utf8"), "original");
      const workspace = await Workspace.create(execution.project, { journal: execution.journal, signal: execution.signal });
      await workspace.write("source.ts", "broken implementation");
    }
    return passingResult(execution);
  });
  library.config.commands.test = { argv: [process.execPath, "-e", "process.exit(1)"], timeoutMs: 2000 };
  library.blocks.fix!.definition.checks = [{ command: "test", expect: "success" }];
  await writeFile(path.join(project, "source.ts"), "original");
  const plan = createTemplate("Fail verification", "bug", library);
  plan.nodes.find((node) => node.id === "work")!.maxVisits = 2;
  const draft = await engine.create(plan, library); await engine.approve(draft.id); await engine.waitForIdle();
  assert.equal(engine.get(draft.id).status, "failed");
  assert.equal(await readFile(path.join(project, "source.ts"), "utf8"), "original");
  assert.equal(engine.get(draft.id).attempts.filter((attempt) => attempt.nodeId === "work").length, 2);
});

test("manual recovery conflicts block resume and preserve external edits", async (t) => {
  const { Workspace } = await import("../src/workspace.js");
  const { engine, project, library } = await setup(t, async (execution) => {
    if (execution.node.id === "work" && execution.visit === 1) {
      const workspace = await Workspace.create(execution.project, { journal: execution.journal });
      await workspace.write("source.ts", "agent change");
      await writeFile(path.join(execution.project, "source.ts"), "manual change");
      throw new Error("Provider disconnected");
    }
    return passingResult(execution);
  });
  await writeFile(path.join(project, "source.ts"), "original");
  const draft = await engine.create(createTemplate("Recovery conflict", "bug", library), library);
  const interrupted = eventBarrier(engine, "interrupted");
  await engine.approve(draft.id); await interrupted;
  await assert.rejects(engine.resume(draft.id), /Resolve recovery conflicts/);
  assert.equal(await readFile(path.join(project, "source.ts"), "utf8"), "manual change");
  await writeFile(path.join(project, "source.ts"), "original");
  assert.equal((await engine.recover(draft.id)).recovery.status, "restored");
  await engine.resume(draft.id); await engine.waitForIdle();
  assert.equal(engine.get(draft.id).status, "completed");
});

test("keeping recovery files requires a stopped run, preserves current bytes and releases claims", async t => {
  const { Workspace } = await import("../src/workspace.js");
  const { engine, project, library } = await setup(t, async execution => {
    if (execution.node.id === "work") {
      const workspace = await Workspace.create(execution.project, {journal:execution.journal});
      await workspace.write("source.ts", "managed edit");
      await writeFile(path.join(execution.project,"source.ts"), "formatted or external edit");
      throw new Error("Session timed out");
    }
    return passingResult(execution);
  });
  await writeFile(path.join(project,"source.ts"),"original");
  const draft=await engine.create(createTemplate("Conflict","bug",library),library);
  const interrupted=eventBarrier(engine,"interrupted");
  await engine.approve(draft.id);await interrupted;
  await assert.rejects(engine.keepRecoveryFiles(draft.id),/Stop execution/);
  await engine.cancel(draft.id);await engine.waitForIdle();
  const kept=await engine.keepRecoveryFiles(draft.id);
  assert.equal(kept.status,"cancelled");
  assert.equal(kept.attempts.at(-1)?.recovery?.status,"committed");
  assert.equal(await readFile(path.join(project,"source.ts"),"utf8"),"formatted or external edit");
  const next=await engine.createProgram("Continue","Finish remaining work",{source:`import {workflow,block} from "workflow";
    const work=block({async run(ctx){await ctx.writeFile("source.ts","reviewed continuation");}});
    export default workflow({name:"Continue",async run(ctx){await ctx.step("next",work);}});`},library);
  await engine.approve(next.id);await engine.waitForIdle();
  assert.equal(engine.get(next.id).status,"completed");
  assert.equal(await readFile(path.join(project,"source.ts"),"utf8"),"reviewed continuation");
});

test("spending totals survive interrupted attempts and stop further model steps", async (t) => {
  const { budgetSchema } = await import("../src/domain.js");
  const { emptyUsage } = await import("../src/budget.js");
  let executions = 0;
  const { engine, library } = await setup(t, async (execution) => {
    executions += 1;
    await execution.onUsage?.({ ...emptyUsage(), requests: 1, inputTokens: 100, costUsd: 0.2 });
    throw new Error("Request failed after billable usage");
  });
  library.config.agent.provider = "priced"; library.config.agent.model = "model";
  library.config.budget = budgetSchema.parse({ maxCostUsd: 0.1, prices: { "priced/model": { input: 1, output: 2 } } });
  const draft = await engine.create(createTemplate("Cost limit", "bug", library), library);
  const interrupted = eventBarrier(engine, "interrupted");
  await engine.approve(draft.id); await interrupted;
  assert.equal(engine.get(draft.id).usage?.costUsd, 0.2);
  await engine.resume(draft.id); await engine.waitForIdle();
  assert.equal(executions, 1);
  assert.equal(engine.get(draft.id).status, "failed");
  assert.match(engine.get(draft.id).error ?? "", /spending limit/);
});

test("upgraded workers resume paused runs with their archived workflow version", async (t) => {
  const { engine, project, library, cleanup } = await setup(t, async (execution) => {
    if (execution.node.id === "prepare") { await release.promise; }
    return passingResult(execution);
  });
  const release = deferred<void>();
  const draft = await engine.create(createTemplate("Versioned restart", "bug", library), library);
  const started = eventBarrier(engine, "node_start");
  await engine.approve(draft.id); await started;
  const paused = eventBarrier(engine, "paused");
  await engine.pause(draft.id); release.resolve(); await paused;
  assert.ok(draft.executionVersion);
  await engine.shutdown();
  const bundle = path.join(project, "upgraded-bundle.js");
  const original = await readFile(new URL("../dist/workflow-bundle.js", import.meta.url), "utf8");
  assert.ok(original.includes("Workflow resumed."));
  await writeFile(bundle, original.replaceAll("Workflow resumed.", "UPGRADED workflow resumed."));
  const restarted = new WorkflowEngine(project, "live", passingRunner, { workflowBundlePath: bundle });
  cleanup(() => restarted.shutdown()); await restarted.initialize();
  const newDraft = await restarted.create(createTemplate("New version", "bug", library), library);
  assert.notEqual(newDraft.executionVersion, draft.executionVersion);
  await restarted.resume(draft.id); await restarted.waitForIdle();
  assert.equal(restarted.get(draft.id).status, "completed");
  const resumed = (await restarted.events(draft.id)).find((event) => event.kind === "resumed");
  assert.equal(resumed?.message, "Workflow resumed.");
});

test("failed draft persistence does not publish edits or rejection in memory", async (t) => {
  const { mkdir, rename, rm } = await import("node:fs/promises");
  const { engine, project, library } = await setup(t);
  const draft = await engine.create(createTemplate("Keep persisted draft", "bug", library), library);
  const filename = path.join(project, ".workflow/runs", draft.id, "run.json");
  await rename(filename, filename + ".backup");
  await mkdir(filename);
  try {
    await assert.rejects(engine.update(draft.id, { ...draft.plan, title: "Unsaved title" }));
    assert.deepEqual(engine.get(draft.id), draft);
    await assert.rejects(engine.reject(draft.id));
    assert.deepEqual(engine.get(draft.id), draft);
  } finally { await rm(filename, { recursive: true }); await rename(filename + ".backup", filename); }
});

test("pre-versioning Temporal runs resume on the frozen legacy worker without replaying completed steps", async (t) => {
  const { createHash, randomUUID } = await import("node:crypto");
  const { Worker } = await import("@temporalio/worker");
  const { connectTemporal } = await import("../src/temporal-runtime.js");
  const { RunStore } = await import("../src/run-store.js");
  const { runSchema } = await import("../src/domain.js");
  const { project, library, cleanup } = await fixture(t);
  const store = new RunStore(path.join(project, ".workflow/runs"));
  const environment = await connectTemporal(project);
  cleanup(() => environment.teardown());
  // Frozen v1 histories predate optional permission metadata. Reconstruct the
  // actual old input shape instead of sending new block definitions to v1.
  delete library.blocks.push;
  delete library.config.capabilities;
  for (const bundle of Object.values(library.blocks)) {
    bundle.definition.permissions = { read: ["**/*"], write: [], deny: [], writeDeny: [] };
  }
  const id = randomUUID(); const now = new Date().toISOString();
  const legacyRun = runSchema.parse({ id, temporalWorkflowId: `workflow-${id}`, approvedAt: now, createdAt: now, updatedAt: now, revision: 0, mode: "live", status: "running", plan: createTemplate("Legacy upgrade", "bug", library), config: library.config, blocks: library.blocks, cursor: "prepare", visits: {}, artifacts: {}, attempts: [] });
  // Fail promptly if newer defaults leak into this historical input fixture.
  const { runSchema: legacySchema } = await import("../src/legacy/domain-v1.js");
  legacySchema.parse(legacyRun);
  await store.save(legacyRun);
  const queue = `workflow-${createHash("sha256").update(project).digest("hex").slice(0, 32)}`;
  const started = deferred<void>(); const release = deferred<void>(); const paused = deferred<void>();
  const executions: string[] = [];
  const worker = await Worker.create({
    connection: environment.nativeConnection, taskQueue: queue,
    workflowBundle: { codePath: new URL("../dist/workflow-v1-bundle.js", import.meta.url).pathname },
    activities: {
      saveProjection: async (run: import("../src/domain.js").WorkflowRun) => { await store.save(run); if (run.status === "paused") { paused.resolve(); } },
      executeBlock: async (run: import("../src/domain.js").WorkflowRun) => {
        executions.push(run.cursor); started.resolve(); await release.promise;
        const node = run.plan.nodes.find((item) => item.id === run.cursor)!;
        return { result: { outcome: "pass", summary: "Legacy step completed", artifacts: Object.fromEntries(run.blocks[node.block]!.definition.outputs.map((name) => [name, "Legacy artifact"])) }, checks: [] };
      },
    },
  });
  const done = worker.run(); void done.catch(() => {});
  cleanup(async () => { if (worker.getState() === "RUNNING") { worker.shutdown(); } await done; });
  const handle = await environment.client.workflow.start("executeWorkflow", { workflowId: legacyRun.temporalWorkflowId!, taskQueue: queue, args: [legacyRun] });
  await started.promise; await handle.signal("pause"); release.resolve(); await paused.promise;
  worker.shutdown(); await done; await environment.teardown();
  const restarted = new WorkflowEngine(project, "live", async (execution) => { executions.push(execution.node.id); return passingResult(execution); });
  cleanup(() => restarted.shutdown()); await restarted.initialize();
  assert.equal(restarted.get(id).status, "paused");
  await restarted.resume(id); await restarted.waitForIdle();
  assert.equal(restarted.get(id).status, "completed");
  assert.deepEqual(executions, ["prepare", "work", "review"]);
});

test("approval snapshots compare serialized policy values, including optional catalog fields", async (t) => {
  const { budgetSchema } = await import("../src/domain.js");
  const { engine, library } = await setup(t);
  library.config.agent.provider = "catalog"; library.config.agent.model = "model";
  library.config.budget = budgetSchema.parse({ prices: { "catalog/model": { input: 1, output: 2 } } });
  library.config.budget.prices["catalog/model"]!.tiers = undefined;
  const draft = await engine.create(createTemplate("Optional price fields", "bug", library), library);
  await engine.approve(draft.id); await engine.waitForIdle();
  assert.equal(engine.get(draft.id).status, "completed");
});

test("deleted completed workflows stay removed after stale projections and restart while retaining recovery history", async t => {
  const { engine, library, project, cleanup } = await setup(t);
  const draft = await engine.create(createTemplate("Completed history", "bug", library), library);
  await engine.approve(draft.id); await engine.waitForIdle();
  const completed = engine.get(draft.id);
  const removed = await engine.remove(draft.id);
  assert.ok(removed.deletedAt); assert.ok(removed.revision > completed.revision);
  await engine["saveProjection"](completed, { kind: "run_end", message: "COMPLETED" });
  assert.equal(engine.list().length, 0);
  assert.ok(engine.list(true)[0]?.deletedAt);
  assert.deepEqual(engine.get(draft.id).attempts, completed.attempts);
  await assert.rejects(engine.approve(draft.id), /not found/);
  await engine.shutdown();
  const restarted = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => restarted.shutdown()); await restarted.initialize();
  assert.equal(restarted.list().length, 0);
  assert.equal((await restarted.remove(draft.id)).revision, removed.revision);
  const record = JSON.parse(await readFile(path.join(project, ".workflow", "runs", draft.id, "run.json"), "utf8"));
  assert.ok(record.deletedAt); assert.ok(record.attempts.length);
});

test("deletion refuses running and paused workflows until execution is stopped", async t => {
  const release = deferred<void>();
  const { engine, library } = await setup(t, async execution => { await release.promise; return passingResult(execution); });
  const draft = await engine.create(createTemplate("Stop before deletion", "bug", library), library);
  const started = eventBarrier(engine, "node_start");
  try {
    await engine.approve(draft.id); await started;
    await assert.rejects(engine.remove(draft.id), /Stop execution/);
    const paused = eventBarrier(engine, "paused");
    await engine.pause(draft.id);
    release.resolve(); await paused;
    assert.equal(engine.get(draft.id).status, "paused");
    await assert.rejects(engine.remove(draft.id), /Stop execution/);
    await engine.cancel(draft.id);
    await engine.waitForIdle();
    assert.ok((await engine.remove(draft.id)).deletedAt);
  } finally { release.resolve(); }
});
