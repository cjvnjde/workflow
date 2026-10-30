import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createApplication } from "../src/core/application.js";
import { createHttpServer } from "../src/http/http-server.js";
import { WorkflowClient } from "../src/client/client.js";
import { TerminalController } from "../src/terminal/controller.js";
import { bundleSchema, type WorkflowRun } from "../src/contracts/domain.js";
import type { StoredEvidenceValue } from "../src/contracts/evidence-schema.js";
import { exportAttemptEvidence } from "../src/core/storage/evidence-export.js";
import { fixture } from "./helpers.js";

async function settled(get: () => WorkflowRun) {
  for (let i = 0; i < 1000; i++) {
    const run = get();
    if (["completed", "failed", "interrupted", "cancelled"].includes(run.status)) return run;
    await Bun.sleep(20);
  }
  throw new Error(`Execution did not settle: ${get().status}: ${get().error ?? ""}`);
}

test("parallel named handoffs retain exact raw/effective values through API, terminal and CLI export", async (t) => {
  const { project, cleanup } = await fixture(t);
  const app = await createApplication({
    project,
    mode: "live",
    startTriggers: false,
    runner: async () => {
      throw new Error("The handoff example must not use an AI model");
    },
    catalog: async () => ({ models: [], warnings: [] }),
    providers: async () => [],
  });
  cleanup(() => app.close());
  const server = await createHttpServer(app, 0);
  cleanup(() => server.close());
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const client = new WorkflowClient({ baseUrl: address });
  const source = await readFile(
    new URL("../examples/parallel-handoffs.ts", import.meta.url),
    "utf8",
  );
  const draft = await app.createProgram({
    source,
    title: "Parallel handoffs",
    task: "Combine selected reports",
  });
  await app.approve(draft.id, draft.revision);
  const run = await settled(() => app.getRun(draft.id));
  assert.equal(run.status, "completed", run.error);
  const evidence = await client.attemptEvidence(run.id, "combine", 1);
  assert.equal(evidence.inputs.state, "available");
  assert.equal(evidence.output.state, "available");
  if (evidence.inputs.state !== "available" || evidence.output.state !== "available")
    throw new Error("Missing evidence");
  const json = async (value: StoredEvidenceValue) => {
    assert.equal(value.state, "captured");
    if (value.state !== "captured") throw new Error("Missing captured value");
    return JSON.parse(await client.evidenceContent(run.id, "combine", 1, value.ref.id));
  };
  const raw = await json(evidence.inputs.value.raw),
    effective = await json(evidence.inputs.value.effective);
  assert.deepEqual(raw, {
    frontend: { files: ["ui.ts"], tests: 2 },
    backend: { files: ["api.ts"], tests: 3 },
    title: "  Combined report  ",
  });
  assert.deepEqual(effective, { ...raw, title: "Combined report" });
  assert.deepEqual(
    evidence.inputs.value.dependencies
      .map((value) => [value.producerNodeId, value.producerVisit, value.usedBy])
      .sort(),
    [
      ["backend", 1, "inputs"],
      ["frontend", 1, "inputs"],
    ],
  );
  assert.deepEqual(await json(evidence.output.value.data), {
    title: "Combined report",
    files: ["ui.ts", "api.ts"],
    totalTests: 5,
  });
  assert.equal(evidence.sessions.length, 0);
  const controller = new TerminalController(client);
  cleanup(() => controller.close());
  await controller.initialize();
  await controller.openSession({ id: run.id, kind: "run" });
  await controller.submit("/data combine 1");
  assert.equal(controller.state.error, "");
  assert.match(controller.state.detail, /INPUTS BEFORE SCHEMA/);
  assert.match(controller.state.detail, /"title": " {2}Combined report {2}"/);
  assert.match(controller.state.detail, /INPUTS RECEIVED BY THE BLOCK/);
  assert.match(controller.state.detail, /frontend · visit 1/);
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const child = Bun.spawn(
    [process.execPath, cli, "data", run.id, "combine", "1", "--json", "--server", address],
    { cwd: project, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, stderr);
  const exported = JSON.parse(stdout);
  assert.equal(exported.evidence.nodeId, "combine");
  assert.equal(exported.evidence.visit, 1);
  const ref = evidence.inputs.value.raw;
  if (ref.state !== "captured") throw new Error("Missing raw ref");
  assert.deepEqual(JSON.parse(exported.contents[ref.ref.id].text), raw);
  const bounded = await exportAttemptEvidence(client, run.id, "combine", 1, undefined, 1);
  assert.ok(Object.values(bounded.contents).every((content) => content.state === "omitted"));
  assert.ok(
    Object.values(bounded.contents).every(
      (content) => "url" in content && content.url.includes("/content/"),
    ),
  );
});

test("input failures, unsupported transforms and repeated visits preserve execution behavior and operation limits", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  library.blocks["inspect-transform"] = bundleSchema.parse({
    definition: {
      id: "inspect-transform",
      name: "Transform a date",
      description: "Exercise an unsupported inspector value",
      executor: {
        kind: "code",
        source: `import {block,z} from "workflow";
      export default block({input:z.object({stamp:z.string().transform(value=>new Date(value))}),maxOperations:1,
        async run(ctx){await ctx.log("Only one real operation");return ctx.input.stamp.toISOString();}});`,
      },
    },
    skills: [],
  });
  library.blocks["inspect-number"] = bundleSchema.parse({
    definition: {
      id: "inspect-number",
      name: "Read a number",
      description: "Reject an invalid raw value before executing code",
      executor: {
        kind: "code",
        source:
          'import {block,z} from "workflow";export default block({input:z.object({amount:z.number()}),run(){throw new Error("Code ran despite invalid input");}});',
      },
    },
    skills: [],
  });
  const app = await createApplication({
    project,
    mode: "live",
    startTriggers: false,
    runner: async () => {
      throw new Error("No model request expected");
    },
    providers: async () => [],
  });
  cleanup(() => app.close());
  const server = await createHttpServer(app, 0);
  cleanup(() => server.close());
  const client = new WorkflowClient({
    baseUrl: await server.listen({ host: "127.0.0.1", port: 0 }),
  });
  const transformed = await app.engine.createProgram(
    "Date transform",
    "Keep normal execution",
    {
      source: `import {workflow,step} from "workflow";
    export default workflow({name:"Date transform",flow:step("date","inspect-transform",{inputs:()=>({stamp:"2026-10-30T00:00:00.000Z"})})});`,
    },
    library,
  );
  await app.approve(transformed.id, transformed.revision);
  const dateRun = await settled(() => app.getRun(transformed.id));
  assert.equal(dateRun.status, "completed", dateRun.error);
  const date = await client.attemptEvidence(transformed.id, "date", 1);
  if (date.inputs.state !== "available" || date.output.state !== "available")
    throw new Error("Missing date evidence");
  assert.equal(date.inputs.value.raw.state, "captured");
  assert.equal(date.inputs.value.effective.state, "unavailable");
  if (date.inputs.value.effective.state === "unavailable")
    assert.equal(date.inputs.value.effective.reasonCode, "unsupported");
  assert.equal(date.output.value.data.state, "captured");
  if (date.output.value.data.state === "captured")
    assert.equal(
      JSON.parse(
        await client.evidenceContent(transformed.id, "date", 1, date.output.value.data.ref.id),
      ),
      "2026-10-30T00:00:00.000Z",
    );

  const invalid = await app.engine.createProgram(
    "Invalid input",
    "Validate before code",
    {
      source: `import {workflow,step} from "workflow";
    export default workflow({name:"Invalid input",flow:step("invalid","inspect-number",{inputs:()=>({amount:"not a number"})})});`,
    },
    library,
  );
  await app.approve(invalid.id, invalid.revision);
  assert.equal((await settled(() => app.getRun(invalid.id))).status, "failed");
  const rejected = await client.attemptEvidence(invalid.id, "invalid", 1);
  if (rejected.inputs.state !== "available") throw new Error("Missing rejected input evidence");
  assert.equal(rejected.inputs.value.raw.state, "captured");
  assert.equal(rejected.inputs.value.effective.state, "unavailable");
  if (rejected.inputs.value.effective.state === "unavailable")
    assert.equal(rejected.inputs.value.effective.reasonCode, "validation-failed");
  assert.doesNotMatch(rejected.inputs.value.inputError ?? "", /Code ran despite/);

  const repeated = await app.engine.createProgram(
    "Repeated visits",
    "Retain each visit",
    {
      source: `import {workflow,block} from "workflow";
    const echo=block({run(ctx){return ctx.input.round;}});
    export default workflow({name:"Repeated visits",async run(ctx){
      for(let round=1;round<=2;round++) await ctx.step("echo",echo,{inputs:{round},maxVisits:2});
      return "Done";
    }});`,
    },
    library,
  );
  await app.approve(repeated.id, repeated.revision);
  assert.equal((await settled(() => app.getRun(repeated.id))).status, "completed");
  for (const visit of [1, 2]) {
    const evidence = await client.attemptEvidence(repeated.id, "echo", visit);
    if (evidence.inputs.state !== "available" || evidence.output.state !== "available")
      throw new Error("Missing visit evidence");
    assert.equal(evidence.output.value.data.state, "captured");
    if (evidence.output.value.data.state === "captured")
      assert.equal(
        JSON.parse(
          await client.evidenceContent(
            repeated.id,
            "echo",
            visit,
            evidence.output.value.data.ref.id,
          ),
        ),
        visit,
      );
  }
});
