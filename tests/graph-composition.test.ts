import assert from "node:assert/strict";
import { test } from "vitest";
import { bundleSchema, validatePlan } from "../src/contracts/domain.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowEngine } from "../src/core/engine.js";
import { fixture } from "./helpers.js";
import { validatePlanModels } from "../src/core/library/library-proposals.js";
import type { AvailableModel } from "../src/contracts/library-editor-schema.js";
const models: AvailableModel[] = ["careful", "quick"].map((id) => ({
  provider: "test",
  id,
  name: id,
  reasoning: true,
  thinkingLevels: ["off", "high"],
  contextWindow: 100000,
  maxTokens: 8000,
  cost: null,
}));

const code = (id: string, source: string) =>
  bundleSchema.parse({
    definition: {
      id,
      name: id,
      description: `Reusable ${id} block`,
      executor: {
        kind: "code",
        source: `import {block,z} from "workflow";export default ${source};`,
      },
    },
    prompt: "Behavior is defined by source",
    skills: [],
  });

test("generated code graphs preview all routes, preserve edited model defaults and execute typed retry handoffs", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  library.config.agent = {
    ...library.config.agent,
    provider: "test",
    model: "careful",
    thinking: "off",
  };
  library.blocks.produce = code(
    "produce",
    `block({async run(ctx){
    if(ctx.visit===2 && (ctx.input.feedback as {approved:boolean}).approved!==false)throw new Error("Missing typed feedback");
    await ctx.ai({prompt:ctx.prompt});
    await ctx.ai({prompt:"Explicit call",model:{provider:"test",model:"careful",thinking:"high"}});
    ctx.summary("Implementation "+ctx.visit);
    return {value:ctx.visit};
  }})`,
  );
  library.blocks.inspect = code(
    "inspect",
    `block({input:z.object({implementation:z.object({value:z.number()})}),async run(ctx){
    const approved=ctx.input.implementation.value===2;
    ctx.outcome(approved ? "pass" : "retry");ctx.summary(approved ? "Reviewed and passed" : "Try again");return {approved};
  }})`,
  );
  await writeFile(path.join(project, "helper.ts"), 'export const marker = "frozen";');
  const produce = library.blocks.produce.definition.executor;
  if (produce?.kind === "code")
    produce.source =
      'import {marker} from "../../../helper.ts";' +
      produce.source.replace("prompt:ctx.prompt", 'prompt:ctx.prompt+" "+marker');
  const plan = validatePlan(
    {
      title: "Graph",
      task: "Implement and review",
      entry: "implement",
      nodes: [
        {
          id: "implement",
          block: "produce",
          label: "Implement",
          goal: "Implement task",
          maxVisits: 2,
          agent: { provider: "test", model: "careful", thinking: "off" },
          inputs: [
            {
              node: "review",
              artifact: "data",
              as: "feedback",
              required: false,
            },
          ],
          on: { pass: "review", retry: "review", fail: "$failed" },
        },
        {
          id: "review",
          block: "inspect",
          label: "Review",
          goal: "Check result",
          maxVisits: 2,
          inputs: [
            {
              node: "implement",
              artifact: "data",
              as: "implementation",
              required: true,
            },
          ],
          on: { pass: "$complete", retry: "implement", fail: "$failed" },
        },
      ],
    },
    library,
  );
  const calls: { model?: string; thinking: string; prompt: string }[] = [];
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    calls.push({
      model: execution.settings.model,
      thinking: execution.settings.thinking,
      prompt: execution.node.goal,
    });
    return { outcome: "pass", summary: "Model result", artifacts: {} };
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const draft = await engine.create(plan, library);
  assert.equal(draft.program?.composition, "graph");
  assert.deepEqual(draft.plan, plan);
  assert.ok(draft.blocks.produce && draft.blocks.inspect);
  assert.equal(draft.cursor, "implement");
  assert.equal(calls.length, 0);
  await writeFile(path.join(project, "helper.ts"), 'export const marker = "changed";');
  const edited = structuredClone(plan);
  edited.nodes[0]!.agent = {
    provider: "test",
    model: "quick",
    thinking: "off",
  };
  edited.nodes[0]!.goal = "Updated step instructions";
  validatePlanModels(edited, library, models);
  const invalid = structuredClone(edited);
  invalid.nodes[0]!.agent!.model = "invented";
  assert.throws(() => validatePlanModels(invalid, library, models), /not available/);
  const saved = await engine.update(draft.id, edited, draft.revision);
  assert.equal(
    saved.executionVersion,
    draft.executionVersion,
    "Graph edits keep frozen block imports",
  );
  assert.deepEqual(saved.program!.input.plan, edited);
  await assert.rejects(engine.update(draft.id, plan, draft.revision), /changed/);
  await assert.rejects(
    engine.updateProgram(draft.id, { source: draft.program!.source }, saved.revision),
    /Edit the workflow graph/,
  );
  await engine.approve(draft.id, saved.revision);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.deepEqual(run.plan, edited, "Execution must preserve all reviewed connections and goals");
  assert.equal(run.output, "Reviewed and passed");
  assert.deepEqual(
    run.attempts.map((a) => [a.nodeId, a.result?.outcome]),
    [
      ["implement", "pass"],
      ["review", "retry"],
      ["implement", "pass"],
      ["review", "pass"],
    ],
  );
  assert.deepEqual(
    calls.map((c) => [c.model, c.thinking]),
    [
      ["quick", "off"],
      ["careful", "high"],
      ["quick", "off"],
      ["careful", "high"],
    ],
  );
  assert.equal(calls[0]!.prompt, "Updated step instructions frozen");
});

test("a code graph follows its fail route after a block throws instead of discarding the recovery branch", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  library.blocks.broken = code("broken", 'block({async run(){throw new Error("Invalid input");}})');
  library.blocks.recover = code(
    "recover",
    'block({async run(ctx){return "Handled: "+ctx.input.error;}})',
  );
  const plan = validatePlan(
    {
      title: "Recovery",
      task: "Handle error",
      entry: "first",
      nodes: [
        {
          id: "first",
          block: "broken",
          label: "Fail",
          goal: "Check",
          maxVisits: 1,
          inputs: [],
          on: { pass: "$complete", retry: "$failed", fail: "fallback" },
        },
        {
          id: "fallback",
          block: "recover",
          label: "Recover",
          goal: "Report",
          maxVisits: 1,
          inputs: [{ node: "first", artifact: "summary", as: "error", required: true }],
          on: { pass: "$complete", retry: "$failed", fail: "$failed" },
        },
      ],
    },
    library,
  );
  const engine = new WorkflowEngine(project, "live", async () => {
    throw new Error("No AI expected");
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const draft = await engine.create(plan, library);
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.equal(run.output, "Handled: Invalid input");
  assert.deepEqual(run.plan, plan);
});
