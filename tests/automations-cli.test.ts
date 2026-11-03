import assert from "node:assert/strict";
import { test } from "vitest";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createApplication } from "../src/core/application.js";
import { createHttpServer } from "../src/http/http-server.js";
import { WorkflowClient } from "../src/client/client.js";
import { TerminalController } from "../src/terminal/controller.js";
import { fixture } from "./helpers.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
test("automation CLI and terminal share definitions, revisions, jobs and linked runs offline", async (t) => {
  const { project, cleanup } = await fixture(t);
  const app = await createApplication({
    project,
    mode: "demo",
    startTriggers: false,
    startAutomations: false,
    providers: async () => [],
    catalog: async () => ({ models: [], warnings: [] }),
  });
  cleanup(() => app.close());
  const http = await createHttpServer(app, 0);
  cleanup(() => http.close());
  const address = await http.listen({ host: "127.0.0.1", port: 0 });
  const client = new WorkflowClient({ baseUrl: address });
  const command = async (args: string[], expectedCode = 0) => {
    const child = Bun.spawn(
      [process.execPath, cli, "automation", ...args, "--server", address, "--json"],
      { cwd: project, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, expectedCode, stderr);
    return expectedCode === 0 ? JSON.parse(stdout) : stderr;
  };
  assert.deepEqual(await command(["list"]), []);
  const draft = await client.createProgram({
    title: "Offline",
    task: "Capture",
    source: `import { workflow, block, step, z } from "workflow";
const capture = block({ input: z.object({}), run() { return { ok: true }; } });
export default workflow({ name: "Offline capture", input: z.object({}), flow: step("capture", capture) });`,
  });
  await writeFile(
    path.join(project, "automation.json"),
    JSON.stringify({
      name: "CLI automation",
      schedule: { kind: "manual" },
      target: { kind: "workflow", runId: draft.id },
      execution: { workspace: "project" },
      policy: { approval: "required" },
    }),
  );
  const saved = await command(["save", "automation.json"]);
  assert.equal((await command(["show", saved.id])).config.name, "CLI automation");
  assert.equal((await command(["config", saved.id])).schedule.kind, "manual");
  const enabled = await command(["enable", saved.id, String(saved.revision)]);
  await command(["save", "automation.json", saved.id, String(saved.revision)], 1);
  assert.equal(enabled.state, "enabled");
  const job = await command(["test", saved.id, String(enabled.revision)]);
  assert.equal(job.test, true);
  assert.equal((await command(["job", job.id])).id, job.id);
  assert.ok(
    (await command(["jobs", saved.id])).some((entry: { id: string }) => entry.id === job.id),
  );
  assert.ok(await command(["settings"]));
  assert.ok(await command(["version", saved.versionId]));
  const controller = new TerminalController(client);
  cleanup(() => controller.close());
  await controller.initialize();
  await controller.submit("/automations");
  assert.equal(controller.state.error, "");
  assert.ok(controller.state.choices.some((choice) => choice.id === saved.id));
  await controller.choose(saved.id);
  assert.ok(controller.state.choices.some((choice) => choice.id === job.id));
  await controller.choose(job.id);
  assert.ok(controller.state.choices.some((choice) => choice.id === "run"));
  await controller.choose("details");
  assert.match(controller.state.detail, new RegExp(job.runId));
});
