import assert from "node:assert/strict";
import { readFile, stat, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createCommandCapture,
  readCommandOutput,
  streamCommandOutput,
} from "../src/infrastructure/command-output.js";
import { runProcess } from "../src/infrastructure/process.js";
import { localExecutionEnvironment } from "../src/core/execution/execution-environment.js";
import { workspaceTools } from "../src/core/execution/block-runner.js";
import { Workspace } from "../src/core/storage/workspace.js";
import { runCheck } from "../src/core/execution/checks.js";
import type { ExecutionEnvironment } from "../src/sdk/tool-sdk.js";
import type { CommandOutputRef } from "../src/contracts/operation-schema.js";
import { fixture } from "./helpers.js";

const emptyResult = { exitCode: 0, stdout: "", stderr: "", output: "", timedOut: false };

test("command capture retains output before bounded previews and supports private scoped reads", async (t) => {
  const { project } = await fixture(t);
  const result = await runProcess(
    project,
    [
      "bash",
      "-c",
      "printf 'begin\\n'; printf '%40000s' '' | tr ' ' x; printf 'end\\n'; printf 'diagnostic\\n' >&2",
    ],
    new AbortController().signal,
    5000,
    undefined,
    { captureDirectory: project },
  );
  assert.ok(!result.stdout.includes("begin"));
  assert.ok(result.outputRef);
  const reference = result.outputRef!;
  assert.equal(reference.truncated, false);
  const captured = await readCommandOutput(project, reference.id, "stdout", { limit: 64000 });
  assert.match(captured.text, /^begin\n/);
  assert.match(captured.text, /end\n$/);
  assert.equal(captured.hasMore, false);
  assert.equal(captured.bytes, Buffer.byteLength(captured.text));
  assert.equal(
    (await stat(path.join(project, "command-output", reference.id, "stdout.txt"))).mode & 0o777,
    0o600,
  );
  const download = await streamCommandOutput(project, reference.id, "stderr");
  let text = "";
  for await (const chunk of download.stream) text += chunk;
  assert.equal(text, "diagnostic\n");
  await assert.rejects(readCommandOutput(project, "../escape", "stdout"));
  await assert.rejects(readCommandOutput(project, reference.id, "stdout", { limit: 256001 }));
});

test("byte paging preserves unicode at small boundaries", async (t) => {
  const { project } = await fixture(t);
  const capture = await createCommandCapture(project);
  const source = "😀é✓a😀tail";
  capture.append("stdout", source);
  const reference = await capture.finish();
  let offset = 0,
    text = "";
  do {
    const page = await readCommandOutput(project, reference.id, "output", { offset, limit: 1 });
    assert.ok(page.nextOffset > offset);
    text += page.text;
    offset = page.nextOffset;
  } while (offset < reference.outputBytes);
  assert.equal(text, source);
});

test("command cancellation retains settled output reference before rejecting", async (t) => {
  const { project } = await fixture(t);
  const controller = new AbortController();
  let reference: CommandOutputRef | undefined;
  const task = runProcess(
    project,
    ["bash", "-c", "printf 'before cancellation\\n'; sleep 5"],
    controller.signal,
    10000,
    undefined,
    {
      captureDirectory: project,
      onOutput: () => controller.abort(new Error("cancel capture test")),
      onCapture: (ref) => {
        reference = ref;
      },
    },
  );
  await assert.rejects(task, /cancel capture test/);
  assert.ok(reference);
  assert.match((await readCommandOutput(project, reference!.id)).text, /before cancellation/);
});

test("output reads reject a symlink substituted for a capture file", async (t) => {
  const { project } = await fixture(t);
  const capture = await createCommandCapture(project);
  capture.append("stdout", "safe");
  const ref = await capture.finish();
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(project, "command-output", ref.id, "output.txt"));
  await symlink("/etc/passwd", path.join(project, "command-output", ref.id, "output.txt"));
  await assert.rejects(readCommandOutput(project, ref.id));
});

test("built-in tools use the injected environment and never silently fall back locally", async (t) => {
  const { project } = await fixture(t);
  const calls: string[] = [];
  let contents = "old";
  const environment: ExecutionEnvironment = {
    id: "test-world",
    readText: async (name) => {
      calls.push(`read:${name}`);
      return contents;
    },
    writeText: async (name, text) => {
      calls.push(`write:${name}`);
      contents = text;
    },
    exec: async (command) => {
      calls.push(`exec:${command}`);
      return { ...emptyResult, output: "remote command" };
    },
  };
  const tools = workspaceTools(await Workspace.create(project), environment);
  const invoke = (name: string, args: unknown) =>
    tools
      .find((tool) => tool.name === name)!
      .execute("call", args as never, new AbortController().signal, undefined, {} as never);
  await invoke("read_file", { path: "virtual.txt" });
  await invoke("edit_file", { path: "virtual.txt", oldText: "old", newText: "new" });
  const result = await invoke("bash", { command: "do remotely" });
  assert.equal(contents, "new");
  assert.ok(calls.includes("exec:do remotely"));
  assert.equal((result.details as { environmentId: string }).environmentId, "test-world");
  await assert.rejects(readFile(path.join(project, "virtual.txt")), { code: "ENOENT" });
  await assert.rejects(invoke("list_files", {}), /does not provide file listing/);
  await assert.rejects(invoke("git_changes", {}), /does not provide Git inspection/);
});

test("check argv remains literal through an injected shell environment", async (t) => {
  const { project, library } = await fixture(t);
  const env = await localExecutionEnvironment({
    project,
    signal: new AbortController().signal,
    outputDirectory: project,
  });
  const command = "strange ' argument $(touch escaped)";
  const result = await runCheck(
    project,
    {
      ...library.config,
      commands: { literal: { argv: ["printf", "%s", command], timeoutMs: 1000 } },
    },
    { command: "literal", expect: "success" },
    new AbortController().signal,
    env,
  );
  assert.equal(result.output, command);
  assert.ok(result.outputRef);
  assert.equal(result.matched, true);
  await assert.rejects(stat(path.join(project, "escaped")), { code: "ENOENT" });
});

test("durable direct file and command effects use the injected environment", async (t) => {
  const { WorkflowEngine } = await import("../src/core/engine.js");
  const { passingRunner } = await import("./helpers.js");
  const { waitForRun } = await import("../src/client/client.js");
  const { project, library, cleanup } = await fixture(t);
  const memory = new Map<string, string>();
  const calls: string[] = [];
  const engine = new WorkflowEngine(project, "live", passingRunner, {}, async (options) => {
    assert.equal(options.project, project);
    assert.ok(options.journal);
    return {
      id: "memory-environment",
      readText: async (filename) => {
        calls.push(`read:${filename}`);
        return memory.get(filename) ?? "missing";
      },
      writeText: async (filename, text) => {
        calls.push(`write:${filename}`);
        memory.set(filename, text);
      },
      exec: async (command) => {
        calls.push(`exec:${command}`);
        return { ...emptyResult, stdout: "virtual output", output: "virtual output" };
      },
    };
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const draft = await engine.createProgram(
    "Environment effects",
    "Use injected effects",
    {
      source: `
    import {workflow,block,step} from "workflow";
    export default workflow({name:"Environment effects",flow:step("work",block({async run(ctx){
      await ctx.writeFile("virtual.txt","retained remotely");
      const text=await ctx.readFile("virtual.txt");
      const result=await ctx.exec("printf 'host mutation' > escaped.txt");
      return {text,output:result.output};
    }}))});
  `,
    },
    library,
  );
  await engine.approve(draft.id);
  await waitForRun(() => engine.get(draft.id), { signal: AbortSignal.timeout(20000) });
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error);
  assert.deepEqual(JSON.parse(run.artifacts.work!.data!), {
    text: "retained remotely",
    output: "virtual output",
  });
  assert.deepEqual(calls, [
    "write:virtual.txt",
    "read:virtual.txt",
    "exec:printf 'host mutation' > escaped.txt",
  ]);
  await assert.rejects(stat(path.join(project, "virtual.txt")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(project, "escaped.txt")), { code: "ENOENT" });
  const events = await engine.events(run.id);
  assert.ok(events.some((event) => event.operation?.environmentId === "memory-environment"));
});
