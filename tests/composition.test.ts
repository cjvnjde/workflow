import assert from "node:assert/strict";
import test from "node:test";
import { readFile, realpath, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { WorkflowEngine } from "../src/core/engine.js";
import { fixture } from "./helpers.js";
import {
  block,
  step,
  sequence,
  parallel,
  when,
  repeatUntil,
  describeFlow,
} from "../src/sdk/workflow-sdk.js";
import { executeFlow } from "../src/core/execution/composition-runtime.js";
import { FileClaims, FileJournal } from "../src/core/storage/recovery.js";
import { Workspace } from "../src/core/storage/workspace.js";
import { budgetSchema } from "../src/contracts/domain.js";
import { compositionLayout } from "../web/features/graph/graph-layout.js";

const header = 'import {workflow,block,step,sequence,parallel,when,repeatUntil,z} from "workflow";';
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("Expected state did not arrive");
}

test("composition validates structure, typed predicates, explicit outcomes and bounded nested loops", async () => {
  const producer = block({ run: () => ({ approved: true }) });
  const review = step("review", producer, {
    maxVisits: 3,
    on: { retry: "continue" },
  });
  const flow = repeatUntil("revisions", {
    body: sequence(
      review,
      when("approved", (c) => c.output(review)?.approved === true, step("publish", producer)),
    ),
    until: (c) => c.output(review)?.approved === true,
    maxIterations: 3,
  });
  const calls: string[] = [];
  const structure = describeFlow(flow);
  await executeFlow({
    flow,
    structure,
    input: {},
    request: "test",
    models: {},
    group: async () => {},
    step: async (node) => {
      calls.push(node.id);
      return {
        outcome: "pass",
        summary: node.id,
        artifacts: {},
        data: { approved: calls.filter((id) => id === "review").length === 2 },
      };
    },
  });
  assert.deepEqual(calls, ["review", "review", "publish"]);
  assert.throws(() => describeFlow(sequence(review, review)), /unique/);
  assert.throws(() => describeFlow(parallel([review], { concurrency: 0 })), /concurrency/);
  const impossible = repeatUntil("exhausted", {
    body: review,
    until: () => false,
    maxIterations: 2,
  });
  await assert.rejects(
    executeFlow({
      flow: impossible,
      structure: describeFlow(impossible),
      input: {},
      request: "test",
      models: {},
      group: async () => {},
      step: async () => ({ outcome: "retry", summary: "No", artifacts: {} }),
    }),
    /did not satisfy/,
  );
  const layout = compositionLayout(structure);
  assert.ok(layout.nodes.some((node) => node.id === "revisions" && node.kind === "group"));
  assert.ok(layout.edges.some((edge) => edge.repeat));
});

test("structured workflows preview before approval, execute typed feedback loops and select branches", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", async () => {
    throw new Error("No AI expected");
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source =
    header +
    `
    const implement=step("implement",block({async run(ctx){
      if(ctx.visit===2 && (ctx.input.feedback as {approved:boolean}).approved!==false)throw new Error("Feedback missing");
      await ctx.writeFile("implemented.txt",String(ctx.visit));return {round:ctx.visit};
    }}),{maxVisits:3,inputs:ctx=>({feedback:ctx.output("review")??null})});
    const review=step("review",block({input:z.object({round:z.number()}),run(ctx){const approved=ctx.input.round===2;ctx.outcome(approved?"pass":"retry");return{approved};}}),{maxVisits:3,on:{retry:"continue"},inputs:ctx=>({round:ctx.output(implement)?.round??0})});
    const publish=step("publish",block({async run(ctx){await ctx.writeFile("published.txt","yes");return "Published";}}));
    const unused=step("unused",block({run(){throw new Error("Wrong branch");}}));
    export default workflow({name:"Reviewed",flow:sequence(repeatUntil("revision",{body:sequence(implement,review),until:ctx=>ctx.output(review)?.approved===true,maxIterations:3}),when("publish-check",ctx=>ctx.output(review)?.approved===true,publish,unused))});`;
  const draft = await engine.createProgram("Reviewed", "Implement", { source }, library);
  assert.equal(draft.program?.composition, "structured");
  assert.deepEqual(
    draft.plan.nodes.map((n) => n.id),
    ["implement", "review", "publish", "unused"],
  );
  await assert.rejects(readFile(path.join(project, "implemented.txt")), /ENOENT/);
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.deepEqual(run.visits, { implement: 2, review: 2, publish: 1 });
  assert.equal(run.groups?.revision?.iteration, 2);
  assert.equal(await readFile(path.join(project, "published.txt"), "utf8"), "yes");
  assert.equal(run.output, "Published");
});

test("parallel calls overlap, retain identities and merge outputs only after the join", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const gates = { a: deferred(), b: deferred() };
  const calls: { id: string; model?: string; input?: string }[] = [];
  const engine = new WorkflowEngine(project, "live", async (call) => {
    calls.push({
      id: call.node.id,
      model: call.settings.model,
      input: call.inputs.tag,
    });
    await gates[call.node.id as "a" | "b"].promise;
    await call.onUsage?.({
      inputTokens: call.node.id === "a" ? 10 : 20,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      requests: 1,
      unpricedRequests: 1,
    });
    return { outcome: "pass", summary: call.node.id, artifacts: {} };
  });
  cleanup(() => engine.shutdown());
  cleanup(async () => {
    gates.a.release();
    gates.b.release();
  });
  await engine.initialize();
  const source =
    header +
    `
    const job=block({async run(ctx){await ctx.writeFile(String(ctx.input.tag)+".txt",String(ctx.input.tag));return await ctx.ai({prompt:ctx.prompt});}});
    const a=step("a",job,{inputs:{tag:"a"},model:"model-a"});const b=step("b",job,{inputs:{tag:"b"},model:"model-b"});
    const report=step("report",block({input:z.object({a:z.string(),b:z.string()}),run(ctx){return ctx.input.a+ctx.input.b;}}),{inputs:ctx=>({a:ctx.output(a)!,b:ctx.output(b)!})});
    export default workflow({name:"Parallel",flow:sequence(parallel([a,b],{concurrency:2}),report)});`;
  const draft = await engine.createProgram("Parallel", "Independent work", { source }, library);
  await engine.approve(draft.id);
  await until(() => calls.length === 2);
  assert.deepEqual(new Set(engine.get(draft.id).activeNodes), new Set(["a", "b"]));
  assert.deepEqual(calls.map((c) => [c.id, c.model, c.input]).sort(), [
    ["a", "model-a", "a"],
    ["b", "model-b", "b"],
  ]);
  gates.b.release();
  await until(() => engine.get(draft.id).attempts.some((a) => a.nodeId === "b" && a.finishedAt));
  assert.ok(!engine.get(draft.id).visits.report);
  gates.a.release();
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.equal(run.output, "ab");
  assert.equal(run.usage?.inputTokens, 30);
  assert.deepEqual(run.activeNodes, []);
  assert.equal(await readFile(path.join(project, "a.txt"), "utf8"), "a");
  assert.equal(await readFile(path.join(project, "b.txt"), "utf8"), "b");
});

test("pause drains active parallel steps and keeps queued branches waiting until resume", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const gates = { a: deferred(), b: deferred() };
  const calls: string[] = [];
  const engine = new WorkflowEngine(project, "live", async (call) => {
    calls.push(call.node.id);
    if (call.node.id !== "c") await gates[call.node.id as "a" | "b"].promise;
    return { outcome: "pass", summary: call.node.id, artifacts: {} };
  });
  cleanup(() => engine.shutdown());
  cleanup(async () => {
    gates.a.release();
    gates.b.release();
  });
  await engine.initialize();
  const source =
    header +
    `const job=block({run:ctx=>ctx.ai({prompt:ctx.prompt})});export default workflow({name:"Pause",flow:parallel([step("a",job),step("b",job),step("c",job)],{concurrency:2})});`;
  const draft = await engine.createProgram("Pause", "Task", { source }, library);
  await engine.approve(draft.id);
  await until(() => calls.length === 2);
  await engine.pause(draft.id);
  gates.a.release();
  await until(() => engine.get(draft.id).attempts.some((a) => a.nodeId === "a" && a.finishedAt));
  assert.equal((await engine.refresh(draft.id)).status, "pausing");
  assert.deepEqual([...calls].sort(), ["a", "b"]);
  gates.b.release();
  await until(() => engine.get(draft.id).status === "paused");
  assert.deepEqual([...calls].sort(), ["a", "b"]);
  await engine.resume(draft.id);
  await engine.waitForIdle();
  assert.equal(engine.get(draft.id).status, "completed");
  assert.deepEqual(calls.slice(0, 2).sort(), ["a", "b"]);
  assert.equal(calls[2], "c");
});

test("managed parallel writes reject overlapping physical paths and retain claims after restart", async (t) => {
  const { project } = await fixture(t);
  const physicalProject = await realpath(project);
  const aliasedProject = path.join(physicalProject, "project-alias");
  await symlink(".", aliasedProject, "dir");
  await writeFile(path.join(project, "shared.txt"), "original");
  await symlink("shared.txt", path.join(project, "alias.txt"));
  const first = path.join(project, "journal-a"),
    second = path.join(project, "journal-b");
  let claims = new FileClaims(aliasedProject);
  const a = await FileJournal.open(first, claims),
    b = await FileJournal.open(second, claims);
  const wa = await Workspace.create(aliasedProject, { journal: a }),
    wb = await Workspace.create(physicalProject, { journal: b });
  await wa.write("shared.txt", "identical");
  await assert.rejects(wb.write("alias.txt", "identical"), /Parallel file conflict/);
  await assert.rejects(wb.edit("shared.txt", "identical", "other"), /Parallel file conflict/);
  claims = new FileClaims(aliasedProject);
  const recovered = await FileJournal.open(first, claims);
  const later = await FileJournal.open(second, claims);
  const resumed = await Workspace.create(physicalProject, { journal: later });
  await assert.rejects(resumed.write("shared.txt", "identical"), /Parallel file conflict/);
  await assert.rejects(resumed.write("alias.txt", "identical"), /Parallel file conflict/);
  await assert.rejects(resumed.edit("shared.txt", "identical", "other"), /Parallel file conflict/);
  assert.equal(
    (await recovered.settle(await Workspace.create(aliasedProject), true)).status,
    "committed",
  );
  await resumed.edit("shared.txt", "identical", "next");
  assert.equal((await later.settle(resumed, false)).status, "restored");
  const next = await FileJournal.open(path.join(project, "journal-c"), claims);
  const following = await Workspace.create(aliasedProject, { journal: next });
  await following.write("alias.txt", "after rollback");
  assert.equal((await next.settle(following, false)).status, "restored");
  assert.equal(await readFile(path.join(project, "shared.txt"), "utf8"), "identical");
});

test("parallel AI sessions share the dollar budget without double-counting failed or completed calls", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  library.config.agent.provider = "test";
  library.config.agent.model = "budget";
  library.config.budget = budgetSchema.parse({
    maxCostUsd: 1,
    prices: {
      "test/budget": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  });
  const gate = deferred();
  const amounts: number[] = [];
  const engine = new WorkflowEngine(project, "live", async (call) => {
    amounts.push(call.maxCostUsd!);
    if (amounts.length === 1) await gate.promise;
    await call.onUsage?.({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.2,
      requests: 1,
      unpricedRequests: 0,
    });
    return { outcome: "pass", summary: call.node.id, artifacts: {} };
  });
  cleanup(() => engine.shutdown());
  cleanup(async () => gate.release());
  await engine.initialize();
  const source =
    header +
    `const job=block({run:ctx=>ctx.ai({prompt:ctx.prompt})});export default workflow({name:"Budget",flow:parallel([step("a",job),step("b",job)])});`;
  const draft = await engine.createProgram("Budget", "Task", { source }, library);
  await engine.approve(draft.id);
  await until(() => amounts.length === 1);
  assert.equal(amounts.length, 1);
  gate.release();
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.deepEqual(amounts, [1, 0.8]);
  assert.equal(run.usage?.costUsd, 0.4);
  const waits = (await engine.execution(draft.id)).operations.filter(
    (operation) => operation.name === "Budget queue",
  );
  assert.equal(waits.length, 2);
  assert.ok(
    waits.every(
      (operation) =>
        operation.state === "completed" &&
        operation.startedAt &&
        operation.finishedAt &&
        operation.durationMs !== undefined &&
        operation.parentKey,
    ),
  );
});

test("loop summaries follow the final visit, explicit repeat skips the rest of a body, and sibling output stays private", async () => {
  const a = step("a", block({ run: () => "a" }));
  const b = step("b", block({ run: () => "b" }));
  const flow = repeatUntil("loop", {
    body: when("branch", (c) => c.iteration("loop") !== 2, a, b),
    until: (c) => c.iteration("loop") === 3,
    maxIterations: 3,
  });
  const calls: string[] = [];
  const summary = await executeFlow({
    flow,
    structure: describeFlow(flow),
    input: {},
    request: "",
    models: {},
    group: async () => {},
    step: async (node) => {
      calls.push(node.id);
      return {
        outcome: "pass",
        summary: node.id + calls.length,
        artifacts: {},
      };
    },
  });
  assert.deepEqual(calls, ["a", "b", "a"]);
  assert.equal(summary, "a3");
  calls.length = 0;
  const retry = step("retry", block({ run: () => "retry" }), {
    on: { retry: "repeat" },
  });
  const loop = repeatUntil("retry-loop", {
    body: sequence(retry, a),
    until: () => true,
    maxIterations: 2,
  });
  await executeFlow({
    flow: loop,
    structure: describeFlow(loop),
    input: {},
    request: "",
    models: {},
    group: async () => {},
    step: async (node) => {
      calls.push(node.id);
      return {
        outcome: calls.length === 1 ? "retry" : "pass",
        summary: "",
        artifacts: {},
      };
    },
  });
  assert.deepEqual(calls, ["retry", "retry", "a"]);
  const sibling = step("sibling", block({ run: () => null }), {
    inputs: (c) => ({ other: c.output(a) ?? null }),
  });
  const independent = parallel([a, sibling], { concurrency: 1 });
  await executeFlow({
    flow: independent,
    structure: describeFlow(independent),
    input: {},
    request: "",
    models: {},
    group: async () => {},
    step: async (node, options) => {
      if (node.id === "sibling") assert.deepEqual(options.inputs, { other: null });
      return {
        outcome: "pass",
        summary: node.id,
        artifacts: {},
        data: "private",
      };
    },
  });
});

test("nested parallel failure stops outer dispatch immediately and drains started siblings", async () => {
  const gate = deferred(),
    failed = deferred();
  const job = block({ run: () => "ok" });
  const flow = parallel(
    [parallel([step("fail", job), step("drain", job)]), step("outer", job), step("queued", job)],
    { concurrency: 2 },
  );
  const calls: string[] = [];
  const pending = executeFlow({
    flow,
    structure: describeFlow(flow),
    input: {},
    request: "",
    models: {},
    group: async () => {},
    step: async (node) => {
      calls.push(node.id);
      if (node.id === "drain") await gate.promise;
      if (node.id === "fail") {
        failed.release();
        return { outcome: "fail", summary: "No", artifacts: {} };
      }
      if (node.id === "outer") {
        await failed.promise;
        await new Promise((r) => setTimeout(r, 20));
      }
      return { outcome: "pass", summary: "Yes", artifacts: {} };
    },
  });
  await failed.promise;
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(!calls.includes("queued"));
  gate.release();
  await assert.rejects(pending, /No/);
  assert.ok(calls.includes("drain"));
});

test("historical overlapping claims load but cannot commit or overwrite another attempt's bytes", async (t) => {
  const { project } = await fixture(t);
  const wa = await Workspace.create(project);
  await writeFile(path.join(project, "shared.txt"), "original");
  const old = await FileJournal.open(path.join(project, "old"));
  const older = await Workspace.create(project, { journal: old });
  await older.write("shared.txt", "same");
  await writeFile(path.join(project, "shared.txt"), "manual");
  assert.equal((await old.settle(wa, false)).status, "conflict");
  const newer = await FileJournal.open(path.join(project, "new"));
  await (await Workspace.create(project, { journal: newer })).write("shared.txt", "same");
  const claims = new FileClaims(project);
  const a = await FileJournal.open(path.join(project, "old"), claims),
    b = await FileJournal.open(path.join(project, "new"), claims);
  assert.equal((await a.settle(wa, false)).status, "conflict");
  assert.equal((await b.settle(wa, true)).status, "conflict");
  assert.equal((await a.settle(wa, false)).status, "conflict");
  assert.equal(await readFile(path.join(project, "shared.txt"), "utf8"), "same");
  await writeFile(path.join(project, "shared.txt"), "original");
  assert.equal((await a.settle(wa, false)).status, "restored");
});

test("deferred invalid inputs fail cleanly without poisoning the saved graph, and visit limits remain independent of loops", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", async () => {
    throw new Error("No AI expected");
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const bad = await engine.createProgram(
    "Bad prompt",
    "Task",
    {
      source:
        header +
        `export default workflow({name:"Bad prompt",flow:step("bad",block({run:()=>"unused"}),{prompt:()=>"x".repeat(9000)})});`,
    },
    library,
  );
  await engine.approve(bad.id);
  await engine.waitForIdle();
  const failed = await engine.refresh(bad.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /8000|too_big|Too big/);
  assert.equal(failed.attempts.length, 0);
  assert.equal(failed.plan.nodes[0]!.goal, "Task");
  const limited = await engine.createProgram(
    "Visit cap",
    "Task",
    {
      source:
        header +
        `export default workflow({name:"Visit cap",flow:repeatUntil("loop",{body:step("work",block({run:()=>"done"}),{maxVisits:1}),until:()=>false,maxIterations:3})});`,
    },
    library,
  );
  await engine.approve(limited.id);
  await engine.waitForIdle();
  assert.equal(engine.get(limited.id).status, "failed");
  assert.match(engine.get(limited.id).error!, /iteration budget exhausted/);
  assert.equal(engine.get(limited.id).visits.work, 1);
});

test("parallel composition treats an undefined thrown value as a failure", async () => {
  const job = block({ run: () => null });
  const flow = parallel(
    [
      when(
        "throws",
        () => {
          throw undefined;
        },
        step("never", job),
      ),
      step("queued", job),
    ],
    { concurrency: 1 },
  );
  const calls: string[] = [];
  let rejected = false;
  try {
    await executeFlow({
      flow,
      structure: describeFlow(flow),
      input: {},
      request: "",
      models: {},
      group: async () => {},
      step: async (node) => {
        calls.push(node.id);
        return { outcome: "pass", summary: "", artifacts: {} };
      },
    });
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
  assert.deepEqual(calls, []);
});

test("failure diagnosis routes test repairs and production repairs to different owners before rechecking", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", async () => {
    throw new Error("This ownership fixture needs no model");
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  for (const broken of ["test", "production"] as const) {
    const testText = broken === "test" ? "export const expected = ;" : "export const expected = 2;";
    await writeFile(path.join(project, "fixture-test.mjs"), testText);
    await writeFile(
      path.join(project, "fixture-production.mjs"),
      `export const actual = ${broken === "production" ? 1 : 2};`,
    );
    const checkCommand =
      'node --input-type=module -e \'try { const t=await import("./fixture-test.mjs"); const p=await import("./fixture-production.mjs"); console.log(t.expected===p.actual?"pass":"production"); } catch(e) { console.log(e instanceof SyntaxError?"test":"blocked"); }\'';
    const source = `${header}
      const gateBlock=block({async run(ctx){
        const checked=await ctx.exec(${JSON.stringify(checkCommand)});
        return {owner:checked.exitCode===0?checked.stdout.trim():"blocked"};
      }});
      const assess=step("assess",gateBlock);
      const tests=step("test-author",block({async run(ctx){await ctx.writeFile("fixture-test.mjs","export const expected = 2;");return "Corrected invalid fixture without weakening the expected value";}}));
      const fix=step("production-owner",block({async run(ctx){await ctx.writeFile("fixture-production.mjs","export const actual = 2;");return "Corrected production";}}));
      const gate=step("final-gate",gateBlock);
      const acceptance=step("acceptance",block({async run(ctx){if(ctx.input.owner!=="pass")throw new Error("Checks still fail");return "Accepted";}}),{inputs:c=>({owner:c.output(gate)?.owner})});
      export default workflow({name:"Repair ownership",flow:sequence(assess,when("invalid-test",c=>c.output(assess)?.owner==="test",tests),when("production-defect",c=>c.output(assess)?.owner==="production",fix),gate,acceptance)});`;
    const draft = await engine.createProgram(
      "Ownership fixture",
      "Repair the failing check",
      { source },
      library,
    );
    await engine.approve(draft.id);
    await engine.waitForIdle();
    const run = engine.get(draft.id);
    assert.equal(run.status, "completed", run.error ?? "");
    assert.deepEqual(
      run.attempts.map((a) => a.nodeId),
      [
        "assess",
        broken === "test" ? "test-author" : "production-owner",
        "final-gate",
        "acceptance",
      ],
    );
    if (broken === "production")
      assert.equal(await readFile(path.join(project, "fixture-test.mjs"), "utf8"), testText);
  }
});
