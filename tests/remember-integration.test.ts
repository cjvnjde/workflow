import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApplication } from "../src/application.js";
import { createHttpServer } from "../src/http-server.js";
import { WorkflowClient } from "../src/client.js";
import { TerminalController } from "../src/tui/controller.js";
import { planningMemory } from "../src/planning-memory.js";
import { fixture } from "./helpers.js";

test("remember previews and explicit terminal/CLI saves share compact guidance without enabling memory or starting AI jobs", async t => {
  const { project, cleanup } = await fixture(t);
  let modelCalls = 0;
  const app = await createApplication({ project, mode: "live", startTriggers: false,
    runner: async () => { modelCalls++; throw new Error("No model request expected"); },
    providers: async () => [], catalog: async () => ({ models: [], warnings: [] }),
  });
  cleanup(() => app.close());
  const server = await createHttpServer(app, 0); cleanup(() => server.close());
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const client = new WorkflowClient({ baseUrl: address });
  const source = `import {workflow,step,block} from "workflow";
    // SOURCE_SENTINEL should never be copied into remembered metadata.
    export default workflow({name:"A small report",flow:step("report",block({async run(ctx){await ctx.artifact("private","ARTIFACT_SENTINEL");return {done:true};}}),{prompt:"PROMPT_SENTINEL"})});`;
  const draft = await app.createProgram({ source, title: "A small report", task: "REQUEST_SENTINEL" });
  await app.approve(draft.id, draft.revision);
  for (let i = 0; i < 750 && !["completed", "failed", "interrupted", "cancelled"].includes(app.getRun(draft.id).status); i++) await Bun.sleep(20);
  assert.equal(app.getRun(draft.id).status, "completed", app.getRun(draft.id).error);
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const command = async (args: string[], expectedCode = 0) => {
    const child = Bun.spawn([process.execPath, cli, "remember", draft.id, ...args, "--server", address, "--json"], { cwd: project, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, expectedCode, stderr);
    return expectedCode === 0 ? JSON.parse(stdout) : stderr;
  };
  const preview = await command([]);
  assert.equal(preview.memoryEnabled, false); assert.equal(preview.existingEntry, null);
  assert.equal(preview.metadata.sourceRunId, draft.id);
  assert.equal(preview.metadata.mode, "live");
  assert.ok(!/SOURCE_SENTINEL|ARTIFACT_SENTINEL|PROMPT_SENTINEL|REQUEST_SENTINEL/.test(JSON.stringify(preview)));
  assert.deepEqual((await client.memory()).entries, []);
  await assert.rejects(access(path.join(project, ".workflow", "memory", "state.json")));
  const terminal = new TerminalController(client); cleanup(() => terminal.close());
  await terminal.initialize(); await terminal.openSession({ id: draft.id, kind: "run" });
  await terminal.submit("/remember save");
  assert.match(terminal.state.error, /review the approach/);
  assert.deepEqual((await client.memory()).entries, []);
  await terminal.submit("/remember");
  assert.equal(terminal.state.error, ""); assert.match(terminal.state.detail, /Preview only/);
  assert.deepEqual((await client.memory()).entries, []);
  await terminal.submit("/remember save");
  assert.equal(terminal.state.error, "");
  const saved = await client.memory();
  assert.equal(saved.enabled, false); assert.equal(saved.entries.length, 1); assert.equal(saved.entries[0]!.kind, "strategy");
  const duplicate = await command(["--save"]);
  assert.equal(duplicate.reused, true); assert.equal(duplicate.entry.id, saved.entries[0]!.id);
  await command(["--save", "--input", JSON.stringify({ details: "Conflicting replacement" })], 1);
  const current = await client.memoryEntry(duplicate.entry.id);
  assert.notEqual(current.details, "Conflicting replacement");
  const edited = await client.updateMemoryEntry(current.id, { revision: (await client.memory()).revision, title: current.title, description: "A reusable reporting approach", details: "GUIDANCE_SENTINEL: keep the report small and review its inputs", tags: ["reports"] });
  const existing = await command([]);
  assert.equal(existing.entry.details, edited.entry.details);
  await client.setMemoryEnabled(true, edited.state.revision);
  const controller = new AbortController();
  const context = await planningMemory(project, controller.signal);
  assert.match(context.prompt!, /A reusable reporting approach/);
  assert.ok(!context.prompt!.includes("GUIDANCE_SENTINEL"));
  const tool = context.tools.find(tool => tool.name === "load_memory")!;
  const loaded = await tool.execute("selected-strategy", { id: current.id }, controller.signal, undefined, {} as never);
  assert.match(JSON.stringify(loaded), /GUIDANCE_SENTINEL/);
  assert.equal(modelCalls, 0);
  await app.engine.remove(draft.id);
  await command([], 1);
  assert.equal((await client.memoryEntry(current.id)).strategy!.sourceRunId, draft.id, "Hiding source history does not delete explicitly saved guidance");
});
