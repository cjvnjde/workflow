import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { loadLibrary } from "../src/library.js";
import { eventSchema, runSchema } from "../src/domain.js";

const execute = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("../", import.meta.url));

async function commandFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const project = path.join(directory, "consumer project");
  const bin = path.join(directory, "bin");
  await mkdir(project);
  await mkdir(bin);
  await symlink(
    path.join(packageDirectory, "dist/cli.js"),
    path.join(bin, "workflow"),
  );
  const runtime = Bun.which("bun");
  assert.ok(runtime);
  await symlink(runtime, path.join(bin, "bun"));
  const env = {
    ...process.env,
    // Deliberately exclude Node and other global tooling from the executable's PATH.
    PATH: bin,
  };
  const run = async (args: string[]) =>
    await execute("workflow", args[0] === "init" ? [...args, "--no-ai"] : args, { cwd: project, env, timeout: 15_000 });

  return { project, env, run };
}

test("the executable on PATH documents current-directory usage without a project argument", async (t) => {
  const { run, project } = await commandFixture(t);
  const result = await run(["--help"]);
  assert.match(result.stdout, /workflow init/);
  assert.match(result.stdout, /current directory/);
  assert.ok(!result.stdout.includes("--project"));
  await assert.rejects(access(path.join(project, ".workflow")), {
    code: "ENOENT",
  });
});

test("workflow init creates policy in the caller's project without installing anything there", async (t) => {
  const { run, project } = await commandFixture(t);
  const manifest = JSON.stringify({
    name: "consumer-project",
    scripts: { test: "bun test" },
  });
  await writeFile(path.join(project, "package.json"), manifest);
  const result = await run([
    "init",
    "--instructions",
    "Preserve the project's public API.",
  ]);
  assert.match(result.stdout, /with 7 blocks/);
  const library = await loadLibrary(project);
  assert.equal(
    library.config.instructions,
    "Preserve the project's public API.",
  );
  assert.deepEqual(library.config.commands.test?.argv, ["bun", "run", "test"]);
  assert.equal(
    await readFile(path.join(project, "package.json"), "utf8"),
    manifest,
  );
  await assert.rejects(access(path.join(project, "node_modules")), {
    code: "ENOENT",
  });
});

test("workflow does not fall back to its installation's configuration", async (t) => {
  const { run } = await commandFixture(t);
  await assert.rejects(run(["serve", "--demo"]), (error: unknown) => {
    const failure = z
      .object({ code: z.literal(1), stderr: z.string() })
      .parse(error);
    assert.match(failure.stderr, /Run workflow init in this folder first/);

    return true;
  });
  await assert.rejects(
    run(["init", "--project", "/tmp/unused"]),
    (error: unknown) => {
      const failure = z
        .object({ code: z.literal(1), stderr: z.string() })
        .parse(error);
      assert.match(failure.stderr, /Unknown option '--project'/);

      return true;
    },
  );
});

test("the package ships a Bun executable and UI, not project state or a development runner", async (t) => {
  const manifest = z
    .object({ bin: z.object({ workflow: z.string() }) })
    .parse(
      JSON.parse(
        await readFile(path.join(packageDirectory, "package.json"), "utf8"),
      ),
    );
  assert.equal(manifest.bin.workflow, "dist/cli.js");
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-pack-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const archive = path.join(directory, "workflow.tgz");
  await execute(
    "bun",
    ["pm", "pack", "--filename", archive, "--ignore-scripts", "--quiet"],
    { cwd: packageDirectory, timeout: 15_000 },
  );
  const result = await execute("tar", ["-tzf", archive], { timeout: 15_000 });
  const files = result.stdout
    .trim()
    .split("\n")
    .map((file) => file.replace(/^package\//, ""));
  assert.match(
    await readFile(path.join(packageDirectory, "dist/cli.js"), "utf8"),
    /^#!\/usr\/bin\/env bun\n/,
  );
  assert.ok(files.includes("dist/cli.js"));
  assert.ok(files.includes("dist/workflow-bundle.js"));
  assert.ok(files.includes("dist/program-runtime.js"));
  assert.ok(files.includes("dist/workflow-sdk.d.ts"));
  assert.ok(files.includes("dist/composition-sdk.d.ts"));
  assert.ok(files.includes("examples/implement-reviewed.ts"));
  assert.ok(files.includes("dist/web/index.html"));
  assert.ok(files.some((file) => file.startsWith("dist/web/assets/")));
  assert.ok(
    !files.some((file) => /^(src|tests|node_modules|\.workflow)\//.test(file)),
  );
  assert.ok(!files.some((file) => file.endsWith(".ts") && !["dist/workflow-sdk.d.ts", "dist/composition-sdk.d.ts"].includes(file) && !file.startsWith("examples/")));
});

test("workflow serves the bundled UI from the install location while using the caller's project", async (t) => {
  const { run, project, env } = await commandFixture(t);
  await run(["init"]);
  const child = spawn("workflow", ["--demo", "--port", "0"], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let diagnostics = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  void closed.catch(() => {});
  const ready = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`CLI did not become ready: ${output}\n${diagnostics}`));
    }, 15_000);
    const finish = (error?: Error, address?: string) => {
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else if (address) {
        resolve(address);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const address = output.match(
        /Workflow DEMO · (http:\/\/127\.0\.0\.1:\d+)/,
      )?.[1];
      if (address) {
        finish(undefined, address);
      }
    });
    child.once("error", (error) => {
      finish(error);
    });
    child.once("close", (code) => {
      finish(new Error(`CLI exited (${code}): ${diagnostics}`));
    });
  });
  try {
    const address = await ready;
    const response = await fetch(`${address}/api/project`, {
      headers: { origin: address },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const data: unknown = await response.json();
    const loaded = z
      .object({ project: z.string(), mode: z.literal("demo") })
      .parse(data);
    assert.equal(await realpath(loaded.project), await realpath(project));
    const html = await (
      await fetch(address, { signal: AbortSignal.timeout(5000) })
    ).text();
    assert.match(html, /<title>Workflow/);
    const script = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(script);
    const asset = await fetch(new URL(script, address), {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    await access(path.join(project, ".workflow/lock"));
  } finally {
    child.kill("SIGTERM");
    assert.equal(await closed, 0);
  }
  await assert.rejects(access(path.join(project, ".workflow/lock")), {
    code: "ENOENT",
  });
  await assert.rejects(access(path.join(project, "dist")), { code: "ENOENT" });
});

test("a killed CLI recovers its lease and Temporal server, then resumes without replaying a completed step", async (t) => {
  const context = await commandFixture(t);
  await context.run(["init"]);
  const launch = () => {
    const child = spawn("workflow", ["--demo", "--port", "0"], {
      cwd: context.project,
      env: { ...context.env, WORKFLOW_DEMO_DELAY_MS: "1000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stderr.on("data", (data: Buffer) => { errors += data.toString(); });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`Server not ready: ${output}\n${errors}`)); }, 20_000);
      child.stdout.on("data", (data: Buffer) => {
        output += data.toString();
        const address = output.match(/Workflow DEMO · (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        if (address) { clearTimeout(timer); resolve(address); }
      });
      child.once("close", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${errors}`)); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    void ready.catch(() => {});
    void exited.catch(() => {});

    return { child, ready, exited };
  };
  const first = launch();
  let second: ReturnType<typeof launch> | undefined;
  const streamController = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const address = await first.ready;
    const response = await fetch(`${address}/api/stream`, { signal: AbortSignal.any([streamController.signal, AbortSignal.timeout(15_000)]) });
    assert.ok(response.body);
    reader = response.body.getReader();
    await reader.read();
    const readEvent = async (kind: string) => {
      let buffer = "";
      while (reader) {
        const chunk = await reader.read();
        if (chunk.done) { throw new Error("Event stream closed before the checkpoint"); }
        buffer += new TextDecoder().decode(chunk.value);
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data && eventSchema.parse(JSON.parse(data.slice(6))).kind === kind) { return; }
        }
      }
    };
    const mutate = async (base: string, route: string, body: unknown) => {
      const result = await fetch(`${base}${route}`, { method: "POST", headers: { "x-workflow-client": "1", "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      assert.equal(result.status, 200, await result.clone().text());

      return runSchema.parse(await result.json());
    };
    const run = await mutate(address, "/api/runs", { task: "Crash-recoverable bug", strategy: "bug" });
    const started = readEvent("node_start");
    await mutate(address, `/api/runs/${run.id}/approve`, {});
    await started;
    const paused = readEvent("paused");
    await mutate(address, `/api/runs/${run.id}/pause`, {});
    await paused;
    streamController.abort();
    await reader.cancel().catch(() => {});
    const before = runSchema.parse(await (await fetch(`${address}/api/runs/${run.id}`)).json());
    assert.equal(before.status, "paused");
    assert.equal(before.cursor, "work");
    assert.equal(before.attempts.length, 1);
    first.child.kill("SIGKILL");
    await first.exited;
    second = launch();
    const restoredAddress = await second.ready;
    const restored = runSchema.parse(await (await fetch(`${restoredAddress}/api/runs/${run.id}`)).json());
    assert.equal(restored.status, "paused");
    assert.deepEqual(restored.artifacts, before.artifacts);
    const port = new URL(restoredAddress).port;
    const resumed = await context.run(["resume", run.id, "--port", port]);
    assert.match(resumed.stdout, new RegExp(run.id));
    const completedController = new AbortController();
    const completionStream = await fetch(`${restoredAddress}/api/stream`, { signal: AbortSignal.any([completedController.signal, AbortSignal.timeout(15_000)]) });
    assert.ok(completionStream.body);
    reader = completionStream.body.getReader();
    try {
      await readEvent("run_end");
    } finally {
      completedController.abort();
      await reader.cancel().catch(() => {});
    }
    const completed = runSchema.parse(await (await fetch(`${restoredAddress}/api/runs/${run.id}`)).json());
    assert.equal(completed.status, "completed");
    assert.equal(completed.attempts.filter((attempt) => attempt.nodeId === "prepare").length, 1);
  } finally {
    streamController.abort();
    await reader?.cancel().catch(() => {});
    for (const process of [second, first]) {
      if (process && process.child.exitCode === null && process.child.signalCode === null) { process.child.kill("SIGTERM"); }
      await process?.exited;
    }
  }
});
