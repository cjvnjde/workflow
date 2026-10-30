import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { WorkflowClient, waitForRun } from "../src/client/client.js";
import { hostInfoSchema } from "../src/host/host-discovery.js";
import { projectHostStatus, stopProjectHost } from "../src/host/host-lifecycle.js";
import { userPaths } from "../src/infrastructure/user-paths.js";
import { fixture } from "./helpers.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
async function context(t: TestContext, source = false) {
  const { project, cleanup } = await fixture(t);
  const home = path.join(project, "private-user-settings");
  await mkdir(home);
  await cp(
    path.join(userPaths().directory, "cache", "temporal"),
    path.join(home, "cache", "temporal"),
    { recursive: true },
  ).catch(() => {});
  const env = {
    ...process.env,
    WORKFLOW_HOME: home,
    PI_OFFLINE: "1",
    WORKFLOW_DEMO_DELAY_MS: "150",
  };
  const command = (args: string[]) =>
    execute(
      process.execPath,
      [path.join(root, source ? "src/cli/index.ts" : "dist/cli.js"), ...args],
      { cwd: project, env, timeout: 25_000 },
    );
  const json = async (args: string[]) => JSON.parse((await command([...args, "--json"])).stdout);
  cleanup(() => stopProjectHost(project, 0));
  return { project, command, json };
}

test("packaged background start is concurrent/idempotent, survives callers, executes work, and stops/restarts", async (t) => {
  const { project, command, json } = await context(t);
  const replies = await Promise.all(
    Array.from({ length: 3 }, (_, i) => json([...(i ? ["start"] : []), "--demo", "--port", "0"])),
  );
  const host = hostInfoSchema.parse(replies[0]);
  assert.equal(new Set(replies.map((reply) => reply.hostId)).size, 1);
  assert.equal(replies.filter((reply) => reply.started).length, 1);
  assert.equal(host.background, true);
  assert.equal((await json(["status"])).hostId, host.hostId);
  const wrongPort = Number(new URL(host.url).port) === 1 ? "2" : "1";
  await assert.rejects(command(["status", "--port", wrongPort]), /already running/);
  await assert.rejects(command(["stop", "--port", wrongPort]), /already running/);
  assert.equal(
    (await json(["start", "--demo"])).started,
    false,
    "The default command reuses the discovered ephemeral port",
  );
  await assert.rejects(command(["start", "--port", "0"]), /running host is demo; requested live/);
  await assert.rejects(
    command(["start", "--demo", "--no-web"]),
    /Stop it before changing --no-web/,
  );
  const receiptPath = path.join(project, ".workflow/server.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.ok(!JSON.stringify(replies).includes(receipt.token));
  assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(project, ".workflow/host.log"))).mode & 0o777, 0o600);
  const rejected = await fetch(`${host.url}/api/host/stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-workflow-client": "1" },
    body: JSON.stringify({ hostId: host.hostId }),
  });
  assert.equal(rejected.status, 403);

  const client = new WorkflowClient({ baseUrl: host.url });
  const task = await client.createTask("Review this background session");
  let runId: string | undefined;
  for (let i = 0; i < 100 && !runId; i++) {
    runId = (await client.task(task.id)).runId;
    if (!runId) await Bun.sleep(50);
  }
  assert.ok(runId);
  const draft = await client.run(runId);
  await client.action(draft.id, "approve", draft.revision);
  assert.equal(
    (await waitForRun(() => client.run(draft.id), { signal: AbortSignal.timeout(12_000) })).status,
    "completed",
  );

  // Neither a live unrelated PID nor a stale host ID is authority to stop.
  await writeFile(
    receiptPath,
    JSON.stringify({ ...receipt, pid: process.pid, hostId: crypto.randomUUID() }),
  );
  try {
    assert.equal((await json(["status"])).canStop, false);
    await assert.rejects(command(["stop"]), /No shutdown was requested/);
    assert.equal((await client.project()).mode, "demo");
  } finally {
    await writeFile(receiptPath, JSON.stringify(receipt));
  }
  assert.equal((await json(["stop"])).stopped, true);
  assert.equal((await json(["status", "--port", "0"])).status, "stopped");
  assert.equal((await json(["stop", "--port", "0"])).stopped, false);
  const restarted = await json(["start", "--demo", "--port", "0"]);
  assert.notEqual(restarted.hostId, host.hostId);
  assert.equal(
    (await new WorkflowClient({ baseUrl: restarted.url }).run(draft.id)).status,
    "completed",
  );
  await json(["stop"]);
});

test("source CLI starts its own detached host, refuses wrong projects and safely replaces unreachable receipts", async (t) => {
  const first = await context(t, true);
  const second = await context(t, true);
  const host = hostInfoSchema.parse(await first.json(["start", "--demo", "--port", "0"]));
  const receiptPath = path.join(second.project, ".workflow/server.json");
  const firstReceipt = JSON.parse(
    await readFile(path.join(first.project, ".workflow/server.json"), "utf8"),
  );
  await writeFile(receiptPath, JSON.stringify({ ...firstReceipt, project: second.project }));
  try {
    await assert.rejects(second.command(["stop"]), /another project/);
    await assert.rejects(
      second.command(["start", "--demo", "--port", String(new URL(host.url).port)]),
      /another project/,
    );
    assert.equal((await first.json(["status"])).hostId, host.hostId);
  } finally {
    await rm(receiptPath, { force: true });
  }
  await first.json(["stop"]);
  // The now-unreachable URL and a live PID cannot authorize any OS signal.
  await writeFile(
    receiptPath,
    JSON.stringify({ ...firstReceipt, project: second.project, pid: process.pid }),
  );
  assert.equal((await second.json(["stop", "--port", "0"])).stopped, false);
  const replacement = await second.json(["start", "--demo", "--port", "0"]);
  assert.notEqual(replacement.hostId, host.hostId);
  assert.equal((await projectHostStatus(second.project, 0)).status, "running");
  await second.json(["stop"]);
});

test("stopping a host with active work drains it before reporting stopped", async (t) => {
  const { project, json } = await context(t);
  const host = hostInfoSchema.parse(await json(["start", "--port", "0"]));
  const client = new WorkflowClient({ baseUrl: host.url });
  const draft = await client.createProgram({
    title: "Long-running command",
    task: "Stop while a command is active",
    filename: "long.ts",
    input: {},
    source:
      'import {workflow,block,step} from "workflow"; export default workflow({name:"Long work",flow:step("wait",block({async run(ctx){return await ctx.exec("sleep 20");}}))});',
  });
  await client.action(draft.id, "approve", draft.revision);
  let active = false;
  for (let i = 0; i < 100 && !active; i++) {
    active = (await client.events(draft.id)).some((event) => event.kind === "operation_start");
    if (!active) await Bun.sleep(50);
  }
  assert.equal(active, true, "A real command must be active before shutdown");
  await json(["stop"]);
  assert.equal((await projectHostStatus(project, 0)).status, "stopped");
  await assert.rejects(readFile(path.join(project, ".workflow/server.json")), /ENOENT/);
  await assert.rejects(stat(path.join(project, ".workflow/server-lease")), /ENOENT/);
  const restarted = await json(["start", "--port", "0"]);
  const run = await new WorkflowClient({ baseUrl: restarted.url }).run(draft.id);
  assert.equal(
    run.status,
    "interrupted",
    "Shutdown must preserve interrupted work without restarting it automatically",
  );
  await json(["stop"]);
});

test(
  "failed child startup reports its error and releases the project for a subsequent start",
  { timeout: 45_000 },
  async (t) => {
    const { project, command, json } = await context(t, true);
    await assert.rejects(
      command(["start", "--demo", "--port", "0", "--temporal-address", "127.0.0.1:not-a-port"]),
      /Background host could not start: Could not connect to Temporal/,
    );
    assert.equal((await projectHostStatus(project, 0)).status, "stopped");
    await assert.rejects(readFile(path.join(project, ".workflow/server.json")), /ENOENT/);
    await assert.rejects(stat(path.join(project, ".workflow/server-lease")), /ENOENT/);
    await assert.rejects(
      command([
        "start",
        "--demo",
        "--port",
        "0",
        "--temporal-workflow-bundle",
        "missing-custom-bundle.js",
      ]),
      /missing-custom-bundle\.js/,
    );
    const apiOnly = await json(["start", "--demo", "--port", "0", "--no-web"]);
    assert.equal(apiOnly.started, true);
    assert.equal(apiOnly.web, false);
    assert.equal(
      (await json(["start", "--demo"])).hostId,
      apiOnly.hostId,
      "Omitting --no-web should reuse an existing API-only host",
    );
    await json(["stop"]);
  },
);
