import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fixture, passingRunner, passingResult } from "./helpers.js";
import { WorkflowEngine } from "../src/engine.js";
import { Tasks } from "../src/tasks.js";
import { createTemplate } from "../src/templates.js";
import { loadOrchestration, saveOrchestration } from "../src/orchestration-settings.js";
import { bundleSchema, validatePlan, type Library } from "../src/domain.js";
import { Attachments } from "../src/attachments.js";
import { createServer } from "../src/server.js";
import { taskSchema } from "../src/task-schema.js";
import { executionSettingsSchema } from "../src/setup-schema.js";

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await check()) { return; } await delay(30); }
  throw new Error("State transition timed out");
}
function commandLibrary(library: Library) {
  const bundle = bundleSchema.parse({ definition: { id: "verify", name: "Verify", description: "Run tests without changing code", executor: { kind: "command", command: "verify", expect: "success" }, permissions: { read: [], write: [] }, outputs: ["diagnostics"] }, prompt: "Run the configured tests.", skills: [] });
  return { ...library, blocks: { ...library.blocks, verify: bundle } };
}

test("task questions, answers and attachments persist; stale duplicate answers cannot replan", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  let plans = 0;
  const tasks = new Tasks(engine, async () => ({ models: [], warnings: [] }), async (options) => {
    plans++;
    if (!options.task.answers.length) { return { kind: "question", question: { question: "Which integration?", options: ["Internal", "External"] } }; }
    assert.deepEqual(options.task.answers, [{ question: "Which integration?", answer: "Internal" }]);
    assert.equal(options.task.attachments[0]?.name, "request.txt");
    return { kind: "plan", plan: createTemplate(options.task.prompt, "feature", library), library: options.library, rationale: "Use the internal service", suggestedBlocks: [] };
  });
  await tasks.initialize(); cleanup(() => tasks.close());
  const attached = await new Attachments(project).add({ name: "request.txt", mimeType: "text/plain", data: Buffer.from("Internal service specification").toString("base64") });
  const created = await tasks.create({ prompt: "Integrate the service", attachments: [attached.id] });
  await until(() => tasks.get(created.id).status === "needs_input");
  const question = tasks.get(created.id);
  await tasks.answer(created.id, { revision: question.revision, answer: "Internal" });
  await assert.rejects(tasks.answer(created.id, { revision: question.revision, answer: "External" }), /already changed/);
  await until(() => tasks.get(created.id).status === "ready");
  assert.equal(plans, 2);
  assert.equal(engine.get(tasks.get(created.id).runId!).status, "draft");
  await tasks.close();
  const restored = new Tasks(engine);
  await restored.initialize(); cleanup(() => restored.close());
  assert.deepEqual(restored.get(created.id).answers, tasks.get(created.id).answers);
  assert.equal(restored.list()[0]!.runId, tasks.get(created.id).runId);
  assert.ok(!("events" in restored.list()[0]!));
});

test("cancelled planning creates no run and server restart exposes interrupted planning for retry", async (t) => {
  const { project, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner); cleanup(() => engine.shutdown());
  const tasks = new Tasks(engine, async () => ({ models: [], warnings: [] }), async (options) => {
    await delay(10000, undefined, { signal: options.signal });
    throw new Error("Should be cancelled");
  });
  await tasks.initialize(); cleanup(() => tasks.close());
  const task = await tasks.create({ prompt: "Long planning" });
  await until(() => tasks.get(task.id).status === "planning");
  await tasks.cancel(task.id);
  await until(() => tasks.get(task.id).status === "cancelled");
  assert.equal(tasks.get(task.id).runId, undefined);
  await tasks.close();
  const filename = path.join(project, ".workflow", "tasks", `${task.id}.json`);
  const interrupted = taskSchema.parse(JSON.parse(await readFile(filename, "utf8")));
  interrupted.status = "planning";
  await writeFile(filename, JSON.stringify(interrupted));
  const restored = new Tasks(engine); await restored.initialize(); cleanup(() => restored.close());
  assert.equal(restored.get(task.id).status, "failed");
  assert.match(restored.get(task.id).error!, /interrupted/);
});

test("cancellation during draft creation discards the late draft and never automatically approves it", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner); cleanup(() => engine.shutdown());
  const settings = await loadOrchestration(project); settings.settings.approval = "automatic";
  await saveOrchestration(project, settings, []);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  let approvals = 0;
  const create = engine.create.bind(engine);
  engine.create = async (...args) => { entered = true; await gate; return await create(...args); };
  engine.approve = async () => { approvals++; throw new Error("Cancelled draft must not start"); };
  const tasks = new Tasks(engine, async () => ({ models: [], warnings: [] }), async options => ({
    kind: "plan", plan: createTemplate(options.task.prompt, "bug", library), library,
    rationale: "Review", suggestedBlocks: [],
  }));
  await tasks.initialize(); cleanup(() => tasks.close());
  cleanup(async () => { release(); });
  const task = await tasks.create({ prompt: "Cancel while persisting the graph" });
  await until(() => entered);
  assert.equal((await tasks.cancel(task.id)).status, "cancelled");
  await assert.rejects(tasks.retry(task.id), /still stopping/);
  release();
  await tasks.close();
  assert.equal(tasks.get(task.id).status, "cancelled");
  assert.equal(tasks.get(task.id).runId, undefined);
  assert.equal(engine.list().length, 0);
  assert.equal(engine.list(true).length, 1, "The discarded draft keeps its recovery record");
  assert.equal(approvals, 0);
  const restored = new Tasks(engine); await restored.initialize(); cleanup(() => restored.close());
  assert.equal(restored.get(task.id).status, "cancelled");
  assert.equal(restored.get(task.id).runId, undefined);
});

test("cancellation while publishing a question persists cancellation and removes the question", async (t) => {
  const { project, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner); cleanup(() => engine.shutdown());
  const tasks = new Tasks(engine, async () => ({ models: [], warnings: [] }), async () => ({
    kind: "question", question: { question: "Which service?", options: [] },
  }));
  await tasks.initialize(); cleanup(() => tasks.close());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let publishing = false;
  const save = tasks["save"].bind(tasks);
  tasks["save"] = async (task) => {
    await save(task);
    if (task.status === "needs_input") { publishing = true; await gate; }
  };
  cleanup(async () => { release(); });
  const task = await tasks.create({ prompt: "Connect the unspecified service" });
  await until(() => publishing);
  assert.equal((await tasks.cancel(task.id)).status, "cancelled");
  release();
  await tasks.close();
  assert.equal(tasks.get(task.id).question, undefined);
  const restored = new Tasks(engine); await restored.initialize(); cleanup(() => restored.close());
  assert.equal(restored.get(task.id).status, "cancelled");
  assert.equal(restored.get(task.id).question, undefined);
});

test("automatic tasks execute command verification and route failure diagnostics back to implementation", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const modelCalls: string[] = [];
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    modelCalls.push(execution.node.id);
    assert.equal(execution.node.id, "implement");
    assert.match(execution.inputs.diagnostics!, /EXPECTED FIX/);
    await writeFile(path.join(project, "fixed.txt"), "fixed");
    return passingResult(execution);
  });
  cleanup(() => engine.shutdown()); await engine.initialize();
  const settings = await loadOrchestration(project); settings.settings.approval = "automatic";
  await saveOrchestration(project, settings, []);
  const taskLibrary = commandLibrary(library);
  taskLibrary.config.commands.verify = { argv: [process.execPath, "-e", "const fs=require('node:fs'); if(!fs.existsSync('fixed.txt')) { console.error('EXPECTED FIX'); process.exit(1); } console.log('Checks passed')"], timeoutMs: 5000 };
  const tasks = new Tasks(engine, async () => ({ models: [], warnings: [] }), async (options) => ({
    kind: "plan", library: taskLibrary, rationale: "Verify, implement only if failing, then verify again", suggestedBlocks: [],
    plan: validatePlan({ title: "Verified implementation", task: options.task.prompt, entry: "verify", nodes: [
      { id: "verify", block: "verify", label: "Test", goal: "Verify without fixing", maxVisits: 2, on: { pass: "$complete", retry: "implement", fail: "$failed" } },
      { id: "implement", block: "implement", label: "Implement", goal: "Address test diagnostics", maxVisits: 1, inputs: [{ node: "verify", artifact: "diagnostics", required: true }], on: { pass: "verify", retry: "$failed", fail: "$failed" } },
    ] }, taskLibrary),
  }));
  await tasks.initialize(); cleanup(() => tasks.close());
  const created = await tasks.create({ prompt: "Fix the failing check" });
  await until(() => !!tasks.get(created.id).runId);
  const runId = tasks.get(created.id).runId!;
  await until(() => engine.get(runId).status === "completed");
  const run = engine.get(runId);
  assert.deepEqual(modelCalls, ["implement"]);
  assert.equal(run.visits.verify, 2);
  assert.match(run.artifacts.verify!.diagnostics!, /Checks passed/);
  assert.equal(run.attempts[0]!.result!.outcome, "retry");
});

test("task API enforces local mutation guard, serves attachments safely and supports block deletion snapshots", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "demo", passingRunner);
  const server = await createServer(engine, 4310, { catalog: async () => ({ models: [], warnings: [] }) }); cleanup(() => server.close());
  const headers = { host: "127.0.0.1:4310", "x-workflow-client": "1" };
  assert.equal((await server.inject({ method: "POST", url: "/api/tasks", headers: { host: headers.host }, payload: { prompt: "Blocked" } })).statusCode, 403);
  const execution = await server.inject({ url: "/api/settings/execution", headers });
  assert.equal(execution.statusCode, 200, execution.body);
  assert.deepEqual(Object.keys(execution.json()).sort(), ["commands", "configRevision", "instructions", "maxSteps"]);
  const updatedExecution = await server.inject({ method: "PUT", url: "/api/settings/execution", headers, payload: { ...executionSettingsSchema.parse(execution.json()), maxSteps: 45 } });
  assert.equal(updatedExecution.statusCode, 200, updatedExecution.body);
  assert.equal(updatedExecution.json().maxSteps, 45);
  const upload = await server.inject({ method: "POST", url: "/api/attachments", headers, payload: { name: "context.html", mimeType: "text/html", data: Buffer.from("<script>alert(1)</script>").toString("base64") } });
  assert.equal(upload.statusCode, 200, upload.body);
  const response = await server.inject({ url: `/api/attachments/${upload.json().id}`, headers });
  assert.match(response.headers["content-type"] as string, /text\/plain/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  const created = await server.inject({ method: "POST", url: "/api/tasks", headers, payload: { prompt: "Inspect the request", attachments: [upload.json().id] } });
  assert.equal(created.statusCode, 202, created.body);
  await until(async () => (await server.inject({ url: `/api/tasks/${created.json().id}`, headers })).json().status === "ready");
  const current = (await server.inject({ url: `/api/tasks/${created.json().id}`, headers })).json();
  const before = engine.get(current.runId);
  const state = (await server.inject({ url: "/api/library", headers })).json();
  const removed = await server.inject({ method: "DELETE", url: "/api/library/blocks/review", headers, payload: { revision: state.revision } });
  assert.equal(removed.statusCode, 200, removed.body);
  const staleEdit = await server.inject({ method: "POST", url: "/api/library/proposals", headers, payload: { kind: "manual", baseHash: state.revision, changes: { summary: "Stale edit", blocks: [{ bundle: library.blocks.review, rationale: "Editing an old version" }] } } });
  assert.equal(staleEdit.statusCode, 409);
  assert.match(staleEdit.json().error, /changed in another session/);
  assert.equal(engine.get(before.id).blocks.review!.prompt, library.blocks.review!.prompt);
  assert.equal((await server.inject({ url: "/api/library", headers })).json().blocks.review, undefined);
});

test("recovery planning retains prior evidence and original scope without automatically rerunning effects", async t => {
 const {project,library,cleanup}=await fixture(t);
 const engine=new WorkflowEngine(project,'live',passingRunner);
 cleanup(()=>engine.shutdown());await engine.initialize();
 const draft=await engine.createProgram('Failed task','Fix the reported bug',{source:`import {workflow,block} from "workflow";
 const first=block({async run(ctx){await ctx.writeFile("retained.txt","completed work");ctx.artifact("evidence","Keep this result");return {done:true};}});
 const broken=block({async run(){throw new Error("acceptance infrastructure unavailable");}});
 export default workflow({name:"Failure",async run(ctx){await ctx.step("first",first);return await ctx.step("broken",broken);}});`},library);
 await engine.approve(draft.id);await engine.waitForIdle();
 assert.equal(engine.get(draft.id).status,'failed');
 const sourceTaskId=crypto.randomUUID();
 const sourceTask=taskSchema.parse({id:sourceTaskId,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),revision:1,status:'ready',prompt:'Fix the reported bug',attachments:[],answers:[{question:'Which platform?',answer:'Desktop only'}],runId:draft.id,approval:'review'});
 await mkdir(path.join(project,'.workflow/tasks'),{recursive:true});
 await writeFile(path.join(project,'.workflow/tasks',sourceTaskId+'.json'),JSON.stringify(sourceTask));
 const state=await loadOrchestration(project);state.settings.approval='automatic';await saveOrchestration(project,state,[]);
 let observed=false;
 const tasks=new Tasks(engine,async()=>({models:[],warnings:[]}),async options=>{
  observed=true;assert.equal(options.task.prompt,'Fix the reported bug');assert.equal(options.recovery?.id,draft.id);
  assert.equal(options.recovery?.artifacts.first?.evidence,'Keep this result');
  assert.deepEqual(options.task.answers,[{question:'Which platform?',answer:'Desktop only'}]);
  return {kind:'question',question:{question:'Which unavailable dependency is ready?',options:[]}};
 });
 cleanup(()=>tasks.close());await tasks.initialize();
 const task=await tasks.create({prompt:'Continue',sourceRunId:draft.id});
 await until(()=>tasks.get(task.id).status==='needs_input');
 assert.ok(observed);assert.equal(tasks.get(task.id).approval,'review');
 assert.equal(await readFile(path.join(project,'retained.txt'),'utf8'),'completed work');
 assert.equal(engine.get(draft.id).status,'failed');
 await assert.rejects(tasks.create({prompt:'Invalid',sourceRunId:'00000000-0000-0000-0000-000000000000'}));
});
