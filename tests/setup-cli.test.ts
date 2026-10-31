import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { attachApplication } from "../src/core/application.js";
import { WorkflowEngine } from "../src/core/engine.js";
import { createHttpServer } from "../src/http/http-server.js";
import { fixture, passingRunner } from "./helpers.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("built setup CLI waits by default, --no-wait detaches, and Ctrl+C leaves the core job running", async (t) => {
  const { project, cleanup } = await fixture(t);
  let generationSignal: AbortSignal | undefined;
  let calls = 0;
  const app = await attachApplication(new WorkflowEngine(project, "live", passingRunner), {
    startTriggers: false,
    catalog: async () => ({
      models: [
        {
          provider: "test",
          id: "small",
          name: "Small",
          reasoning: false,
          thinkingLevels: ["off"],
          contextWindow: 32000,
          maxTokens: 4000,
          cost: null,
        },
      ],
      warnings: [],
    }),
    providers: async () => [],
    design: async (options) => {
      calls++;
      generationSignal = options.signal;
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(options.signal.reason);
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
      });
    },
  });
  cleanup(() => app.close());
  const server = await createHttpServer(app, 0);
  cleanup(() => server.close());
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  await app.updateProjectModel({
    configRevision: (await app.setup()).configRevision,
    agent: { provider: "test", model: "small", thinking: "off" },
  });
  const spawn = (...args: string[]) =>
    Bun.spawn([process.execPath, cli, ...args, "--server", address, "--json"], {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    });
  const command = async (...args: string[]) => {
    const child = spawn(...args);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  };
  const started = await command("setup", "--no-wait");
  assert.match(started.id, /^[a-f0-9-]{36}$/);
  assert.ok(["queued", "running"].includes(started.status));
  assert.equal((await command("setup-status", started.id)).id, started.id);
  const waiting = spawn("setup");
  cleanup(async () => {
    if (waiting.exitCode === null) waiting.kill();
    await waiting.exited;
  });
  const reader = waiting.stderr.getReader();
  let progress = "";
  const watching = (async () => {
    while (!progress.includes(started.id)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Waiter exited before subscribing: ${progress}`);
      progress += new TextDecoder().decode(chunk.value);
    }
  })();
  await Promise.race([
    watching,
    Bun.sleep(5000).then(() => {
      throw new Error("Setup waiter did not show progress");
    }),
  ]);
  assert.equal(waiting.exitCode, null, "Setup must keep waiting while generation is active");
  waiting.kill("SIGINT");
  assert.equal(await waiting.exited, 0);
  reader.releaseLock();
  const detached = JSON.parse(await new Response(waiting.stdout).text());
  assert.equal(detached.id, started.id);
  assert.equal(app.setupJobs.get(started.id).status, "running");
  assert.equal(generationSignal?.aborted, false);
  assert.equal(calls, 1, "Attaching another CLI must not repeat generation");
  // An explicit --wait remains compatible, and a terminal job failure must
  // become the waiter's exit status instead of an early successful return.
  const finishing = spawn("setup", "--wait");
  cleanup(async () => {
    if (finishing.exitCode === null) finishing.kill();
    await finishing.exited;
  });
  const finishingReader = finishing.stderr.getReader();
  let finishingProgress = "";
  while (!finishingProgress.includes(started.id)) {
    const chunk = await finishingReader.read();
    assert.equal(chunk.done, false, "Waiter exited before attaching to setup");
    finishingProgress += new TextDecoder().decode(chunk.value);
  }
  finishingReader.releaseLock();
  const cancelled = await command("setup-cancel", started.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(generationSignal?.aborted, true);
  assert.equal(await finishing.exited, 1);
  assert.equal(JSON.parse(await new Response(finishing.stdout).text()).status, "cancelled");
});
