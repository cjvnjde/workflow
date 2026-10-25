import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowEngine } from "../src/engine.js";
import { checkProgram, checkCodeBlocks, validateProgram } from "../src/program-compiler.js";
import { budgetSchema, bundleSchema } from "../src/domain.js";
import { fixture, passingRunner } from "./helpers.js";
import { emptyUsage } from "../src/budget.js";

const wrap = (code: string, task = 'return await ctx.step("work", work);') => `import { workflow, block, z } from "workflow";\n${code}\nexport default workflow({name:"Code test", async run(ctx){ ${task} }});`;

test("one TypeScript block combines typed AI calls, file effects and commands with cumulative model usage", async t => {
  const { project, library, cleanup } = await fixture(t);
  library.config.agent = { ...library.config.agent, provider: "test", model: "first" };
  library.config.budget = budgetSchema.parse({ maxCostUsd: 2, prices: { "test/first": { input: 1, output: 1 }, "test/second": { input: 1, output: 1 } } });
  const calls: { model: string | undefined; remaining: number | undefined; inputs: Record<string, string> }[] = [];
  const engine = new WorkflowEngine(project, "live", async execution => {
    assert.equal(execution.resultMode, "value");
    calls.push({ model: execution.settings.model, remaining: execution.maxCostUsd, inputs: execution.inputs });
    await execution.onUsage?.({ ...emptyUsage(), costUsd: 0.1, requests: 1, inputTokens: 10 });
    await execution.onUsage?.({ ...emptyUsage(), costUsd: 0.2, requests: 2, inputTokens: 20 });
    return { outcome: "pass", summary: "AI result", artifacts: { data: JSON.stringify({ answer: calls.length }) } };
  });
  cleanup(() => engine.shutdown()); await engine.initialize();
  const source = wrap(`const work = block({
    input: z.object({ request: z.string() }), output: z.object({ answer: z.number(), text: z.string() }),
    async run(ctx) {
      const shape = z.object({ answer: z.number() });
      const first = await ctx.ai({prompt:ctx.input.request,output:shape,model:{provider:"test",model:"first"}});
      await ctx.writeFile("answer.txt", String(first.answer));
      const command = await ctx.exec("printf 'command-output'");
      const second = await ctx.ai({prompt:command.stdout,output:shape,model:{provider:"test",model:"second"}});
      ctx.artifact("evidence.md",command.stdout);
      await ctx.log("Combining model results");
      ctx.summary("Combined two model calls with file and command results.");
      return { answer: second.answer, text: await ctx.readFile("answer.txt") };
    }
  });`, 'return await ctx.step("work",work,{inputs:{request:"Compute"}});');
  const draft = await engine.createProgram("Mixed code", "Compute", { source }, library);
  await engine.approve(draft.id); await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.attempts.length, 1);
  assert.deepEqual(JSON.parse(run.artifacts.work!.data!), { answer: 2, text: "1" });
  assert.equal(run.artifacts.work!["evidence.md"], "command-output");
  assert.equal(run.usage?.requests, 4);
  assert.equal(run.usage?.costUsd, 0.4);
  assert.deepEqual(calls.map(call => call.model), ["first", "second"]);
  assert.equal(calls[1]?.remaining, 1.8);
  assert.match(run.artifacts.work!.summary!, /Combined two model calls/);
});

test("code input/output validation and thrown errors fail visibly and recover managed writes", async t => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown()); await engine.initialize();
  await writeFile(path.join(project, "original.txt"), "original");
  const variants = [
    'const work=block({input:z.object({required:z.string()}),async run(ctx){await ctx.writeFile("original.txt","bad");}});',
    'const work=block({output:z.string().min(3),async run(ctx){await ctx.writeFile("original.txt","changed");return "x";}});',
    'const work=block({async run(ctx){await ctx.writeFile("original.txt","changed");throw new Error("Requested failure");}});',
  ];
  for (const definition of variants) {
    const draft = await engine.createProgram("Failed code", "Check", { source: wrap(definition) }, library);
    await engine.approve(draft.id); await engine.waitForIdle();
    const run = engine.get(draft.id);
    assert.equal(run.status, "failed");
    assert.equal(run.attempts[0]?.result?.outcome, "fail");
    assert.ok(run.artifacts.work?.summary);
    assert.equal(await readFile(path.join(project, "original.txt"), "utf8"), "original");
  }
  assert.throws(() => checkProgram(project, { source: wrap('const work=block({input:z.object({name:z.string()}),async run(ctx){return ctx.input.missing;}});') }), /missing/);
});

test("saved TypeScript blocks are typechecked, frozen with helpers and return typed data", async t => {
  const { project, library, cleanup } = await fixture(t);
  await writeFile(path.join(project, "helper.ts"), 'export const answer = "frozen";');
  library.blocks.custom = bundleSchema.parse({ definition: { id: "custom", name: "Custom code", description: "Typed library block",
    executor: { kind: "code", source: 'import {block,z} from "workflow"; import {answer} from "../../../helper.ts"; export default block({input:z.object({value:z.number()}),async run(ctx){return {answer,value:ctx.input.value};}});' },
  }, prompt: "Code owns the behavior", skills: [] });
  checkCodeBlocks(project, library.blocks);
  const invalid = structuredClone(library.blocks);
  invalid.custom!.definition.executor = { kind: "code", source: 'export default 42;', timeoutMs: 1000, maxOperations: 10 };
  assert.throws(() => checkCodeBlocks(project, invalid), /CodeBlock/);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown()); await engine.initialize();
  const draft = await engine.createProgram("Saved code", "Run", { source: wrap('', 'return await ctx.step<{answer:string,value:number}>("custom","custom",{inputs:{value:7}});') }, library);
  await writeFile(path.join(project, "helper.ts"), 'export const answer = "modified";');
  await engine.approve(draft.id); await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error);
  assert.deepEqual(JSON.parse(run.artifacts.custom!.data!), { answer: "frozen", value: 7 });
});

test("code operation limits and unawaited commands cannot leave background work running", async t => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown()); await engine.initialize();
  for (const definition of [
    'const work=block({maxOperations:2,async run(ctx){for(let i=0;i<3;i++)await ctx.log("bounded");}});',
    'const work=block({async run(ctx){void ctx.exec("sleep 1; printf leaked > leaked.txt");return "too soon";}});',
  ]) {
    const draft = await engine.createProgram("Bounded", "Check", { source: wrap(definition) }, library);
    await engine.approve(draft.id); await engine.waitForIdle();
    const run = engine.get(draft.id);
    assert.equal(run.status, "failed", run.error);
    assert.match(run.error!, /operation limit|Await every/);
  }
  await new Promise(resolve => setTimeout(resolve, 1100));
  await assert.rejects(readFile(path.join(project, "leaked.txt")), /ENOENT/);
});

test("code test results can route a bounded loop without making an AI call", async t => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", async () => { throw new Error("No model call expected"); });
  cleanup(() => engine.shutdown()); await engine.initialize();
  const source = wrap(`const work = block({async run(ctx){
    const result=await ctx.exec(ctx.visit===1 ? "printf 'not ready'; exit 1" : "printf 'passed'");
    ctx.outcome(result.exitCode===0 ? "pass" : "retry");
    ctx.summary(result.output);
    return {passed:result.exitCode===0, feedback:result.output};
  }});`, 'for(let i=0;i<2;i++){const result=await ctx.step("work",work,{maxVisits:2});if(result.passed)return result.feedback;}throw new Error("Check failed");');
  const draft = await engine.createProgram("Code loop", "Check", { source }, library);
  await engine.approve(draft.id); await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.output, "passed");
  assert.deepEqual(run.attempts.map(attempt => attempt.result?.outcome), ["retry", "pass"]);
});

test("initialization writes editable TypeScript modules and conversions preserve script contracts and limits", async t => {
  const { project, library, cleanup } = await fixture(t);
  const { initializeProject, loadLibrary } = await import("../src/library.js");
  const { codeBundle } = await import("../src/code-migration.js");
  const child = path.join(project, "new-project");
  const initialized = await initializeProject(child);
  assert.ok(Object.values(initialized.blocks).every(bundle => bundle.definition.executor?.kind === "code"));
  checkCodeBlocks(child, initialized.blocks);
  const file = path.join(child, ".workflow/blocks/review/block.ts");
  await writeFile(file, 'import {block} from "workflow";export default block({async run(){return "customized";}});');
  const updated = (await loadLibrary(child)).blocks.review!.definition.executor;
  assert.equal(updated?.kind, "code");
  if (updated?.kind === "code") assert.match(updated.source, /customized/);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown()); await engine.initialize();
  const legacy = bundleSchema.parse({ definition: {id:"converted",name:"Converted",description:"Legacy TypeScript compatibility",outputs:["evidence"],
    executor:{kind:"script",language:"typescript",runtime:"node",code:`import {writeFileSync,readFileSync} from "node:fs";
const input: {inputs:{message:string}} = JSON.parse(readFileSync(process.env.WORKFLOW_INPUT!,"utf8"));
writeFileSync(process.env.WORKFLOW_RESULT!,JSON.stringify({outcome:"pass",summary:input.inputs.message,artifacts:{evidence:"preserved"}}));`,timeoutMs:5000,expect:"success"},
  },prompt:"Legacy",skills:[]});
  library.blocks.converted = codeBundle(legacy, library.config.commands);
  checkCodeBlocks(project, library.blocks);
  const draft = await engine.createProgram("Converted", "Read", { source: wrap('', 'const result=await ctx.step("converted","converted",{inputs:{message:"hello"}});return result.summary;') }, library);
  await engine.approve(draft.id); await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.output, "hello");
  assert.equal(run.artifacts.converted?.evidence, "preserved");
});

test("pure code output transforms retain their types and invalid non-JSON outputs fail", async t => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown()); await engine.initialize();
  for (const [definition, status] of [
    ['const work=block({output:z.string().transform(value=>value.length),async run(){return "typed";}});', "completed"],
    ['const work=block({async run(){return new Date();}});', "failed"],
  ]) {
    const draft=await engine.createProgram("Pure code","Check",{source:wrap(definition!)},library);
    await engine.approve(draft.id);await engine.waitForIdle();
    const run=engine.get(draft.id);
    assert.equal(run.status,status,run.error);
    if(status==="completed")assert.equal(JSON.parse(run.artifacts.work!.data!),5);
    else assert.match(run.error!,/JSON values/);
  }
});

test("a code block awaiting an unresolved promise still honors its timeout and can be cancelled", async t => {
  const {project,library,cleanup}=await fixture(t);
  const engine=new WorkflowEngine(project,"live",passingRunner);
  cleanup(()=>engine.shutdown());await engine.initialize();
  const draft=await engine.createProgram("Timed wait","Check",{source:wrap('const work=block({timeoutMs:1000,async run(){await new Promise<void>(()=>{});return "unreachable";}});')},library);
  await engine.approve(draft.id);
  for(let i=0;i<100 && engine.get(draft.id).status!=="interrupted";i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(engine.get(draft.id).status,"interrupted");
  await engine.cancel(draft.id);await engine.waitForIdle();
  assert.equal(engine.get(draft.id).status,"cancelled");
});


test("unsupported module execution is rejected before the planner accepts a workflow", async t => {
  const {project}=await fixture(t);
  assert.throws(()=>checkProgram(project,{source:wrap('const zod = await import("workflow"); const work=block({async run(){return zod.z.string().parse("x");}});')}),/Top-level await|static imports/);
  assert.throws(()=>checkProgram(project,{source:wrap('await Promise.resolve(); const work=block({async run(){return "x";}});')}),/Top-level await/);
  assert.throws(()=>checkProgram(project,{source:wrap('const work=block({async run(){return (await import("workflow")).z.string().parse("x");}});')}),/static imports/);
});


test("submission bundling resolves SDK dependencies and rejects missing runtime modules without evaluating code", async t => {
  const {project}=await fixture(t);
  const source='import {workflow,block} from "workflow";import {z} from "zod";const work=block({output:z.string(),async run(){return "ok";}});export default workflow({name:"Dependency",async run(ctx){return ctx.step("work",work);}});';
  await validateProgram(project,{source});
  await validateProgram(project,{source:'throw new Error("Never evaluated");'+source});
  await writeFile(path.join(project,"phantom.d.ts"),'declare module "missing-runtime-module" {export const value:string;}');
  await assert.rejects(validateProgram(project,{source:'/// <reference path="./phantom.d.ts" />\nimport {value} from "missing-runtime-module";'+source.replace('return "ok"','return value')}),/could not be bundled|missing-runtime-module/);
});

test("protected regression changes cannot be accepted even when an AI runner reports success", async t => {
  const { project, library, cleanup } = await fixture(t);
  await writeFile(path.join(project, "regression.test.ts"), "original assertions");
  const engine = new WorkflowEngine(project, "live", async execution => {
    assert.deepEqual(execution.protectedPaths, ["**/*.test.ts"]);
    // Simulate a shell/MCP write bypassing managed file tools.
    await writeFile(path.join(project, "regression.test.ts"), "weakened assertions");
    return {outcome:"pass", summary:"claimed success", artifacts:{}};
  });
  cleanup(()=>engine.shutdown()); await engine.initialize();
  const source = wrap('const work=block({async run(ctx){return await ctx.ai({prompt:"Fix production",protectedPaths:["**/*.test.ts"]});}});');
  const draft = await engine.createProgram("Ownership", "Fix", {source}, library);
  await engine.approve(draft.id); await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "failed");
  assert.match(JSON.stringify(run.attempts), /Protected files changed/);
  // Unmanaged edits are reported, never silently overwritten by recovery.
  assert.equal(await readFile(path.join(project,"regression.test.ts"),"utf8"), "weakened assertions");
});

test("default test authoring preserves a valid failing regression while acceptance remains blocked", async t => {
  const { project, cleanup } = await fixture(t);
  const { initializeProject } = await import("../src/library.js");
  const { mkdir } = await import("node:fs/promises");
  const { Workspace } = await import("../src/workspace.js");
  const child = path.join(project,"authoring-project");
  await mkdir(child);
  await writeFile(path.join(child,"package.json"),JSON.stringify({scripts:{test:"bun regression.test.ts"}}));
  await writeFile(path.join(child,"production.ts"),"export const actual = 1;\n");
  const library = await initializeProject(child);
  const engine = new WorkflowEngine(child,"live",async execution=>{
    if(execution.bundle.definition.name === "Write independent tests") {
      const workspace=await Workspace.create(child,{journal:execution.journal});
      await workspace.write("regression.test.ts",'import assert from "node:assert/strict"; import { actual } from "./production.ts"; assert.equal(actual, 2);\n' );
    }
    return {outcome:"pass",summary:"Authoring completed; product check fails",artifacts:{data:JSON.stringify({outcome:"pass",summary:"Role complete",artifacts:{feedback:"Valid assertion exposes product defect"}})}};
  });
  cleanup(()=>engine.shutdown()); await engine.initialize();
  const source='import {workflow,step,sequence} from "workflow";export default workflow({name:"Independent tests",flow:sequence(step("author","verify"),step("gate","checks"))});';
  const draft=await engine.createProgram("Authoring","Check behavior",{source},library);
  await engine.approve(draft.id); await engine.waitForIdle();
  const run=engine.get(draft.id);
  assert.equal(run.status,"failed");
  assert.deepEqual(run.attempts.map(a=>a.result?.outcome),["pass","retry"]);
  assert.match(await readFile(path.join(child,"regression.test.ts"),"utf8"),/assert.equal\(actual, 2\)/);
});

test("a read-only preparatory AI call cannot modify production or admit the later repair call", async t => {
  const {project, library, cleanup}=await fixture(t);
  await writeFile(path.join(project,"production.ts"),"original production");
  let calls=0;
  const engine=new WorkflowEngine(project,"live",async execution=>{
    calls++;
    assert.deepEqual(execution.protectedPaths,["**/*"]);
    // Inventory mistakenly performs the surrounding block's repair via shell.
    await writeFile(path.join(project,"production.ts"),"premature repair");
    return {outcome:"pass",summary:"Inventory complete",artifacts:{data:'{"paths":["regression.test.ts"]}'}};
  });
  cleanup(()=>engine.shutdown()); await engine.initialize();
  const source=wrap('const work=block({async run(ctx){const inventory=await ctx.ai({prompt:"Read-only: identify regression files",protectedPaths:["**/*"],output:z.object({paths:z.array(z.string())})});return await ctx.ai({prompt:"Repair production",protectedPaths:inventory.paths});}});');
  const draft=await engine.createProgram("Call ownership","Fix the bug",{source},library);
  await engine.approve(draft.id);await engine.waitForIdle();
  assert.equal(engine.get(draft.id).status,"failed");
  assert.equal(calls,1);
  assert.match(JSON.stringify(engine.get(draft.id).attempts),/Protected files changed: production.ts/);
});
