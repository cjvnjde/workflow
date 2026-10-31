import assert from "node:assert/strict";
import { test } from "vitest";
import { writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { attachApplication } from "../src/core/application.js";
import { WorkflowEngine } from "../src/core/engine.js";
import { createHttpServer } from "../src/http/http-server.js";
import { WorkflowClient } from "../src/client/client.js";
import { TerminalController } from "../src/terminal/controller.js";
import { fixture } from "./helpers.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("CLI and TUI share opt-in memory, retain entries while off, and reject stale edits without model work", async (t) => {
  const { project, cleanup } = await fixture(t);
  let modelCalls = 0;
  const app = await attachApplication(
    new WorkflowEngine(project, "live", async () => {
      modelCalls++;
      throw new Error("No model call expected");
    }),
    {
      startTriggers: false,
      providers: async () => [],
      catalog: async () => ({ models: [], warnings: [] }),
    },
  );
  cleanup(() => app.close());
  const server = await createHttpServer(app, 0);
  cleanup(() => server.close());
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const client = new WorkflowClient({ baseUrl: address });
  const command = async (args: string[], expectedCode = 0) => {
    const child = Bun.spawn(
      [process.execPath, cli, "memory", ...args, "--server", address, "--json"],
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
  const initial = await command([]);
  assert.equal(initial.enabled, false);
  assert.deepEqual(initial.entries, []);
  await assert.rejects(access(path.join(project, ".workflow", "memory", "state.json")));
  const note = {
    kind: "preference",
    title: "Review expectations",
    description: "Review API compatibility separately",
    details: "Keep public API review independent from implementation.",
    tags: ["review"],
  };
  await writeFile(path.join(project, "note.json"), JSON.stringify(note));
  const added = await command(["add", "note.json"]);
  assert.equal(
    added.state.enabled,
    false,
    "Authoring a preference must not enable collection or planner access",
  );
  assert.equal(added.entry.kind, "preference");
  const controller = new TerminalController(client);
  cleanup(() => controller.close());
  await controller.initialize();
  await controller.submit("/memory");
  assert.equal(controller.state.error, "");
  assert.match(controller.state.panelDescription, /Disabled/);
  assert.ok(controller.state.choices.some((choice) => choice.id === added.entry.id));
  await controller.submit(`/memory ${added.entry.id}`);
  assert.match(controller.state.detail, /Keep public API review independent/);
  await controller.submit("/memory on");
  assert.equal((await command([])).enabled, true);
  const read = await command(["show", added.entry.id]);
  await writeFile(
    path.join(project, "changes.json"),
    JSON.stringify({
      revision: read.revision,
      title: note.title,
      description: note.description,
      details: "A stale change",
      tags: note.tags,
    }),
  );
  const changed = await client.updateMemoryEntry(added.entry.id, {
    revision: read.revision,
    title: note.title,
    description: note.description,
    details: "Saved in another client",
    tags: note.tags,
  });
  await command(["update", added.entry.id, "changes.json"], 1);
  assert.equal((await client.memoryEntry(added.entry.id)).details, "Saved in another client");
  await writeFile(
    path.join(project, "changes.json"),
    JSON.stringify({
      revision: changed.state.revision,
      title: note.title,
      description: note.description,
      details: "Reviewed CLI change",
      tags: note.tags,
    }),
  );
  assert.equal(
    (await command(["update", added.entry.id, "changes.json"])).entry.details,
    "Reviewed CLI change",
  );
  assert.equal((await command(["off"])).enabled, false);
  assert.equal((await command(["show", added.entry.id])).entry.details, "Reviewed CLI change");
  assert.equal((await command(["remove", added.entry.id])).entries.length, 0);
  assert.equal(modelCalls, 0);
});
