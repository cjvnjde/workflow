import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import {
  createApplication,
  localExecutionEnvironment,
  type ApplicationOptions,
} from "../src/core/application.js";
import { automationConfigSchema } from "../src/contracts/automation-schema.js";
import { waitForRun } from "../src/client/client.js";
import { fixture } from "./helpers.js";

const source = `import { workflow, block, z } from "workflow";
const increment = block({
  input: z.object({ amount: z.number() }),
  async run(ctx) {
    const previous = Number(await ctx.readFile("counter.txt"));
    const count = previous + ctx.input.amount;
    await ctx.writeFile("counter.txt", String(count));
    ctx.summary("Incremented durable counter to " + count);
    return { count };
  },
});
export default workflow({
  name: "Scheduled counter", input: z.object({ amount: z.number() }),
  async run(ctx) { return ctx.step("increment", increment, { inputs: { amount: ctx.input.amount } }); },
});`;

test("Temporal executes a frozen scheduled project job once and reopening the application does not replay its real file effect", async (t) => {
  const { project, cleanup } = await fixture(t);
  const counter = path.join(project, "counter.txt");
  await writeFile(counter, "0");
  let time = Date.parse("2026-11-03T12:00:00.000Z");
  let writes = 0,
    modelCalls = 0,
    plannerCalls = 0;
  const roots: string[] = [];
  const options: ApplicationOptions = {
    project,
    mode: "live",
    startTriggers: false,
    startAutomations: false,
    automationClock: () => time,
    runner: async () => {
      modelCalls++;
      throw new Error("A deterministic scheduled target must not invoke a model");
    },
    plan: async () => {
      plannerCalls++;
      throw new Error("A scheduled target must not invoke the planner");
    },
    catalog: async () => ({ models: [], warnings: [] }),
    providers: async () => [],
    environment: async (settings) => {
      roots.push(settings.project);
      const local = await localExecutionEnvironment(settings);
      return {
        ...local,
        writeText: async (filename, content) => {
          if (filename === "counter.txt") writes++;
          await local.writeText(filename, content);
        },
        exec: async () => {
          throw new Error("The counter must not execute host commands");
        },
      };
    },
  };
  const app = await createApplication(options);
  cleanup(() => app.close());
  const draft = await app.createProgram({
    title: "Scheduled counter",
    task: "Increment a local counter",
    source,
    input: { amount: 1 },
  });
  const automation = await app.automations.save({
    config: automationConfigSchema.parse({
      name: "Once-only counter",
      enabled: true,
      target: { kind: "workflow", runId: draft.id },
      schedule: { kind: "once", at: new Date(time + 60_000).toISOString() },
      inputs: { amount: 3 },
      execution: { workspace: "project", maxCommands: 0, maxModelCalls: 0 },
    }),
  });
  const frozen = app.automations.version(automation.versionId);
  await app.updateProgram(
    draft.id,
    { source: source.replace("previous + ctx.input.amount", "previous + 100") },
    draft.revision,
  );
  await app.automations.tick();
  assert.equal(app.automations.state().jobs.length, 0);
  assert.equal(writes, 0);
  time += 60_000;
  await app.automations.tick();
  const queued = app.automations.state().jobs[0]!;
  assert.equal(queued.phase, "direct");
  assert.equal(queued.status, "running", queued.reason ?? "Job did not start");
  const completed = await waitForRun(() => app.getRun(queued.runId), {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(completed.status, "completed", completed.error ?? "Workflow did not complete");
  assert.ok(completed.temporalWorkflowId, "the job must execute through the real Temporal engine");
  assert.equal(completed.automation!.workspace, "project");
  assert.equal(completed.automation!.root, project);
  assert.equal(completed.executionVersion, frozen.targets.main!.executionVersion);
  assert.deepEqual(completed.outputValue, { count: 3 });
  assert.equal(await readFile(counter, "utf8"), "3");
  assert.equal(writes, 1);
  assert.ok(roots.length > 0);
  assert.ok(roots.every((root) => root === project));
  await app.automations.tick();
  assert.equal(app.automations.state().jobs[0]!.status, "completed");
  await app.close();
  const reopened = await createApplication(options);
  cleanup(() => reopened.close());
  time += 86_400_000;
  await reopened.automations.tick();
  await reopened.automations.ingest(automation.id, { signals: [], checkpoint: { verified: true } });
  await reopened.automations.tick();
  assert.equal(reopened.automations.state().jobs.length, 1);
  assert.equal(reopened.automations.state().jobs[0]!.runId, queued.runId);
  assert.equal(reopened.getRun(queued.runId).status, "completed");
  assert.equal(reopened.automations.state().automations[0]!.nextFireAt, null);
  assert.equal(await readFile(counter, "utf8"), "3");
  assert.equal(writes, 1);
  assert.equal(modelCalls, 0);
  assert.equal(plannerCalls, 0);
});
