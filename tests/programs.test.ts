import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { WorkflowEngine } from "../src/core/engine.js";
import { checkProgram } from "../src/core/planning/program-compiler.js";
import { validateBlockResult, type BlockExecution } from "../src/core/execution/block-runner.js";
import { budgetSchema, bundleSchema } from "../src/contracts/domain.js";
import { fixture, passingResult, passingRunner } from "./helpers.js";
import { createServer } from "../src/http/server.js";
import { refineProgram } from "../src/core/planning/program-refiner.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  loadOrchestration,
  saveOrchestration,
} from "../src/core/settings/orchestration-settings.js";

const scripted = `import { workflow, script, z } from "workflow";
export default workflow({name:"Check",input:z.object({request:z.string()}),async run(ctx){
  const result = await ctx.step("check",script({language:"bash",code:"printf 'ran\\\\n' >> effect.txt"}),{prompt:ctx.input.request});
  if(result.outcome !== "pass") throw new Error(result.summary);
  return "Finished";
}});`;
const input = { request: "Check working files" };
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Expected state did not arrive");
}

test("TypeScript compiler catches type errors, missing exports and invalid inputs without evaluating source", async (t) => {
  const { project } = await fixture(t);
  assert.equal(
    (await checkProgram(project, { source: scripted, input })).input.request,
    input.request,
  );
  await assert.rejects(
    () =>
      checkProgram(project, {
        source: scripted.replace("ctx.input.request", "ctx.input.absent"),
        input,
      }),
    /absent/,
  );
  await assert.rejects(
    () => checkProgram(project, { source: "export const x = 1", input }),
    /default export/,
  );
  await assert.rejects(
    () => checkProgram(project, { source: scripted, filename: "../escape.ts", input }),
    /project-relative/,
  );
  await assert.rejects(() => checkProgram(project, { source: scripted, input: [] }));
  // Compilation must never evaluate even top-level orchestration statements.
  await checkProgram(project, {
    source: `throw new Error("Must not evaluate");\n${scripted}`,
    input,
  });
});

test("shipped TypeScript examples typecheck with the installed SDK", async (t) => {
  const { project } = await fixture(t);
  for (const name of ["implement-reviewed", "scripts-only", "composed", "shared-tools"]) {
    const source = await readFile(new URL(`../examples/${name}.ts`, import.meta.url), "utf8");
    await checkProgram(project, { source, input: {} });
  }
});

test("TypeScript script workflows execute only after approval and freeze imported helpers", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await writeFile(path.join(project, "helper.ts"), 'export const message = "frozen helper";');
  const engine = new WorkflowEngine(project, "live", async () => {
    throw new Error("No AI for scripts");
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source =
    `import { message } from "./helper.ts";\n` +
    scripted.replace('return "Finished"', "return message");
  const draft = await engine.createProgram(
    "Script workflow",
    input.request,
    { source, input },
    library,
  );
  assert.equal(draft.plan.nodes.length, 0);
  await assert.rejects(readFile(path.join(project, "effect.txt")), /ENOENT/);
  await writeFile(
    path.join(project, "helper.ts"),
    'export const message = "changed after approval snapshot";',
  );
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.equal(run.output, "frozen helper");
  assert.equal(await readFile(path.join(project, "effect.txt"), "utf8"), "ran\n");
  assert.equal(run.attempts.length, 1);
  assert.equal(run.blocks.check?.definition.executor?.kind, "script");
});

test("cancelling source compilation or draft publication leaves no visible workflow", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  for (const boundary of ["compile", "publish"] as const) {
    let arrived!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalPrepare = engine["prepareProgram"].bind(engine);
    const originalSave = engine["store"].save.bind(engine["store"]);
    if (boundary === "compile")
      engine["prepareProgram"] = async (...args) => {
        const result = await originalPrepare(...args);
        arrived();
        await gate;
        return result;
      };
    else
      engine["store"].save = async (run) => {
        await originalSave(run);
        if (!run.deletedAt) {
          arrived();
          await gate;
        }
      };
    const controller = new AbortController();
    const created = engine.createProgram(
      "Cancelled",
      input.request,
      { source: scripted, input },
      library,
      controller.signal,
    );
    const rejected = assert.rejects(created, /Cancelled compilation/);
    await reached;
    controller.abort(new Error("Cancelled compilation"));
    release();
    await rejected;
    engine["prepareProgram"] = originalPrepare;
    engine["store"].save = originalSave;
    assert.equal(engine.list().length, 0);
  }
});

test("native loops use typed review data, selected context, reusable blocks and model overrides", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const calls: BlockExecution[] = [];
  const engine = new WorkflowEngine(project, "live", async (step) => {
    calls.push(step);
    if (step.node.id === "review")
      return {
        outcome: "pass",
        summary: "Review completed",
        artifacts: {
          data: JSON.stringify({
            approved: step.visit === 2,
            feedback: step.visit === 1 ? "Handle empty values" : "Approved",
          }),
        },
      };
    return passingResult(step);
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source = `import { workflow, agent, z } from "workflow";
const reviewer = agent({instructions:"Review only",outputs:["summary"],model:{provider:"test",model:"reviewer",thinking:"high"},output:z.object({approved:z.boolean(),feedback:z.string()})});
export default workflow({name:"Reviewed implementation",input:z.object({request:z.string(),model:z.string()}),async run(ctx){
  let feedback = "";
  for(let attempt=0;attempt<3;attempt++){
    await ctx.step("implement","implement",{prompt:ctx.input.request,inputs:{feedback},model:ctx.input.model,maxVisits:3});
    const result = await ctx.step("review",reviewer,{prompt:ctx.input.request,maxVisits:3});
    if(result.artifacts.summary !== result.summary) throw new Error("Missing implicit summary");
    if(result.data?.approved) return result.data.feedback;
    feedback = result.data?.feedback ?? result.summary;
  }
  throw new Error("Review did not pass");
}});`;
  const draft = await engine.createProgram(
    "Implement with review",
    input.request,
    { source, input: { ...input, model: "coder" } },
    library,
  );
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.equal(run.output, "Approved");
  assert.deepEqual(
    calls.map((step) => step.node.id),
    ["implement", "review", "implement", "review"],
  );
  assert.equal(calls[2]!.inputs.feedback, "Handle empty values");
  assert.equal(calls[0]!.settings.model, "coder");
  assert.equal(calls[1]!.settings.model, "reviewer");
  assert.equal(calls[1]!.settings.thinking, "high");
  assert.equal(run.visits.review, 2);
  assert.ok(run.transitions?.some((edge) => edge.from === "review" && edge.to === "implement"));
  assert.ok(run.transitions?.some((edge) => edge.from === "review" && edge.to === "$complete"));
});

test("typed artifacts are validated before accepting a passing agent result", () => {
  const bundle = bundleSchema.parse({
    definition: {
      id: "review",
      name: "Review",
      description: "Review",
      outputs: ["data"],
      outputSchema: z.toJSONSchema(z.object({ approved: z.boolean() })),
    },
    prompt: "Review",
    skills: [],
  });
  assert.throws(
    () =>
      validateBlockResult(
        { outcome: "pass", summary: "review", artifacts: { data: '{"approved":"yes"}' } },
        bundle,
      ),
    /boolean/,
  );
  assert.throws(() =>
    validateBlockResult(
      { outcome: "pass", summary: "review", artifacts: { data: "not json" } },
      bundle,
    ),
  );
  assert.equal(
    validateBlockResult(
      { outcome: "pass", summary: "review", artifacts: { data: '{"approved":false}' } },
      bundle,
    ).outcome,
    "pass",
  );
});

test("profile models retain pricing and frozen settings when workflow code customizes context", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const directory = path.join(project, "pricing-models");
  await mkdir(directory);
  await writeFile(
    path.join(directory, "models.json"),
    JSON.stringify({
      providers: {
        "pricing-test": {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "fixture-only",
          models: [
            {
              id: "reviewer",
              contextWindow: 32_000,
              maxTokens: 1000,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const settings = await loadOrchestration(project);
  await saveOrchestration(
    project,
    {
      ...settings,
      settings: {
        ...settings.settings,
        profiles: [
          {
            id: "shared",
            name: "Shared reviewer",
            description: "Review code",
            enabled: true,
            agent: { provider: "pricing-test", model: "reviewer", thinking: "off" },
          },
        ],
      },
    },
    [
      {
        provider: "pricing-test",
        id: "reviewer",
        name: "Reviewer",
        reasoning: false,
        thinkingLevels: ["off"],
        contextWindow: 32_000,
        maxTokens: 1000,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  );
  library.blocks.shared = bundleSchema.parse({
    definition: {
      id: "shared",
      name: "Shared script",
      description: "A script with the same ID as a model profile",
      executor: { kind: "script", language: "bash", runtime: "bash", code: "true" },
    },
    prompt: "Execute",
    skills: [],
  });
  library.config.budget = budgetSchema.parse({ maxCostUsd: 1 });
  const previousDirectory = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = directory;
  try {
    const draft = await engine.createProgram(
      "Profile pricing",
      "Review",
      {
        source: `
      import { workflow, agent } from "workflow";
      export default workflow({name:"Profile pricing",async run(ctx){
        ctx.input.localNote = "Working state";
        ctx.models.shared!.timeoutMs = 10000;
        const result = await ctx.step("review",agent({instructions:"Review",model:ctx.models.shared}));
        return result.summary;
      }});
    `,
      },
      library,
    );
    assert.equal(draft.config.budget?.prices["pricing-test/reviewer"]?.input, 1);
    await engine.approve(draft.id);
    await engine.waitForIdle();
    const completed = engine.get(draft.id);
    assert.equal(completed.status, "completed", completed.error ?? "");
    assert.deepEqual(completed.program?.input, {});
    assert.equal(completed.program?.models.shared?.timeoutMs, undefined);
    assert.equal(completed.blocks.review?.definition.agent?.timeoutMs, 10000);
  } finally {
    if (previousDirectory === undefined) delete process.env.WORKFLOW_HOME;
    else process.env.WORKFLOW_HOME = previousDirectory;
  }
});

test("TypeScript workflow pauses and resumes on its archived version without repeating a completed script", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source = scripted
    .replace(
      'return "Finished";',
      `await ctx.step("second",script({language:"bash",code:"printf second > second.txt"})); return "Done";`,
    )
    .replace(">> effect.txt", ">> effect.txt; sleep 0.3");
  const draft = await engine.createProgram(
    "Durable scripts",
    input.request,
    { source, input },
    library,
  );
  await engine.approve(draft.id);
  await until(() => engine.get(draft.id).attempts.length === 1);
  await engine.pause(draft.id);
  await until(() => engine.get(draft.id).status === "paused");
  await engine.shutdown();
  const resumed = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => resumed.shutdown());
  await resumed.initialize();
  assert.equal(resumed.get(draft.id).status, "paused");
  await resumed.resume(draft.id);
  await resumed.waitForIdle();
  const run = resumed.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.equal(await readFile(path.join(project, "effect.txt"), "utf8"), "ran\n");
  assert.equal(await readFile(path.join(project, "second.txt"), "utf8"), "second");
  assert.equal(run.attempts.length, 2);
});

test("TypeScript input validation and total step budgets stop invalid or unbounded execution", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const invalid = await engine.createProgram(
    "Invalid input",
    "test",
    { source: scripted, input: { request: 42 } },
    library,
  );
  await engine.approve(invalid.id);
  await engine.waitForIdle();
  assert.equal(engine.get(invalid.id).status, "failed");
  assert.equal(engine.get(invalid.id).attempts.length, 0);
  const initialization = await engine.createProgram(
    "Initialization failure",
    "test",
    {
      source: `throw new Error("Invalid helper initialization");\n${scripted}`,
      input,
    },
    library,
  );
  await engine.approve(initialization.id);
  await engine.waitForIdle();
  assert.equal(engine.get(initialization.id).status, "failed");
  assert.match(engine.get(initialization.id).error ?? "", /Invalid helper initialization/);
  const abandoned = await engine.createProgram(
    "Unawaited step",
    "test",
    {
      source: scripted
        .replace("const result = await ctx.step", "const result = ctx.step")
        .replace('if(result.outcome !== "pass") throw new Error(result.summary);', "void result;"),
      input,
    },
    library,
  );
  await engine.approve(abandoned.id);
  await engine.waitForIdle();
  assert.equal(engine.get(abandoned.id).status, "failed");
  assert.match(engine.get(abandoned.id).error ?? "", /Await every/);
  await assert.rejects(readFile(path.join(project, "effect.txt")), /ENOENT/);
  library.config.maxSteps = 2;
  const source = `import { workflow } from "workflow";export default workflow({name:"Bounded",async run(ctx){
    while(true) await ctx.step("repeat","review");
  }});`;
  const draft = await engine.createProgram("Budget", "test", { source }, library);
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /iteration budget/);
  assert.equal(run.attempts.length, 2);
});

test("program API typechecks drafts, rejects stale edits and preserves approved source", async (t) => {
  const { project, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const server = await createServer(engine, 0, {
    catalog: async () => ({ models: [], warnings: [] }),
  });
  cleanup(() => server.close());
  const headers = { "x-workflow-client": "1" };
  const body = { title: "Code API", task: input.request, source: scripted, input };
  assert.equal(
    (await server.inject({ method: "POST", url: "/api/programs", payload: body })).statusCode,
    403,
  );
  const created = await server.inject({
    method: "POST",
    url: "/api/programs",
    headers,
    payload: body,
  });
  assert.equal(created.statusCode, 200, created.body);
  const draft = created.json();
  const refined = await refineProgram(
    {
      project,
      run: draft,
      instructions: "Return Updated",
      models: [],
      signal: new AbortController().signal,
      emit: () => {},
    },
    async (options) => {
      const submit = options.tools.find((tool) => tool.name === "submit_workflow")!;
      await submit.execute(
        "test",
        { source: scripted.replace('"Finished"', '"Updated"'), input: JSON.stringify(input) },
        options.signal,
        undefined,
        {} as never,
      );
    },
  );
  const changed = await server.inject({
    method: "PUT",
    url: `/api/runs/${draft.id}/program`,
    headers: { ...headers, "if-match": `"${draft.revision}"` },
    payload: refined,
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const stale = await server.inject({
    method: "PUT",
    url: `/api/runs/${draft.id}/program`,
    headers: { ...headers, "if-match": `"${draft.revision}"` },
    payload: { source: scripted, input },
  });
  assert.equal(stale.statusCode, 409);
  await engine.approve(draft.id, changed.json().revision);
  await engine.waitForIdle();
  assert.equal(engine.get(draft.id).output, "Updated");
  await assert.rejects(engine.updateProgram(draft.id, { source: scripted, input }), /Only a draft/);
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  await writeFile(path.join(project, "workflow.ts"), scripted);
  const cli = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      "run",
      "workflow.ts",
      "--port",
      new URL(address).port,
      "--input",
      JSON.stringify(input),
      "--approve",
    ],
    { cwd: project, timeout: 15_000 },
  );
  assert.match(cli.stdout, /running|completed/);
  await engine.waitForIdle();
  assert.equal(engine.list().length, 2);
  assert.ok(engine.list().every((run) => run.status === "completed"));
});
