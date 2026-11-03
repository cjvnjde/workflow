import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import {
  automationExecutionSchema,
  type AutomationRunOwnership,
} from "../src/contracts/automation-schema.js";
import { bundleSchema, commandSchema } from "../src/contracts/domain.js";
import { ManagedWorkspaces } from "../src/core/execution/managed-workspaces.js";
import { automationBoundary } from "../src/infrastructure/automation-boundary.js";
import {
  localExecutionEnvironment,
  createExecutionEnvironment,
} from "../src/core/execution/execution-environment.js";
import { WorkflowEngine } from "../src/core/engine.js";
import { waitForRun } from "../src/client/client.js";
import { fixture, passingRunner } from "./helpers.js";

const execute = promisify(execFile);
async function repository(project: string) {
  await execute("git", ["init", "-b", "main"], { cwd: project });
  await execute("git", ["config", "user.email", "automation@example.invalid"], { cwd: project });
  await execute("git", ["config", "user.name", "Automation tests"], { cwd: project });
  await writeFile(path.join(project, ".gitignore"), ".workflow/\n");
  await writeFile(path.join(project, "baseline.txt"), "baseline");
  await execute("git", ["add", ".gitignore", "baseline.txt"], { cwd: project });
  await execute("git", ["commit", "-m", "Baseline"], { cwd: project });
}
function ownership(overrides = {}): AutomationRunOwnership {
  const execution = automationExecutionSchema.parse(overrides);
  return {
    automationId: randomUUID(),
    jobId: randomUUID(),
    workspace: execution.workspace,
    baseRef: execution.baseRef,
    execution,
  };
}

test("explicit project ownership works without Git but never removes the project", async (t) => {
  const { project } = await fixture(t);
  const owner = ownership({ workspace: "project" }),
    id = randomUUID();
  const manager = new ManagedWorkspaces(project);
  const metadata = await manager.reserve(id, owner, { frozen: true });
  assert.equal(metadata.root, project);
  assert.equal(await manager.assert(id, metadata, { frozen: true }), project);
  await assert.rejects(() => manager.assert(id, metadata, { frozen: false }), /frozen reservation/);
  await assert.rejects(() => manager.cleanup(id, metadata), /never removed/);
});

test("worktree reservations survive restart, pin baseline and reject policy/path replacement", async (t) => {
  const { project } = await fixture(t);
  await repository(project);
  const id = randomUUID(),
    owner = ownership(),
    snapshot = { input: { value: "original" } };
  const manager = new ManagedWorkspaces(project);
  const first = await manager.reserve(id, owner, snapshot);
  await writeFile(path.join(project, "baseline.txt"), "later");
  await execute("git", ["commit", "-am", "Later baseline"], { cwd: project });
  const restarted = new ManagedWorkspaces(project);
  assert.deepEqual(await restarted.reserve(id, owner, snapshot), first);
  assert.equal(await readFile(path.join(first.root, "baseline.txt"), "utf8"), "baseline");
  await assert.rejects(
    () => restarted.reserve(id, owner, { input: { value: "tampered" } }),
    /reservation/,
  );
  await assert.rejects(() => restarted.assert(id, { ...first, root: project }), /ownership/);
  const env = await localExecutionEnvironment({
    project: first.root,
    isolated: true,
    signal: AbortSignal.timeout(10_000),
  });
  await assert.rejects(() => env.writeText("../escape", "bad"), /inside/);
  await symlink(project, path.join(first.root, "escape"));
  await assert.rejects(() => env.writeText("escape/baseline.txt", "bad"), /inside/);
  await assert.rejects(() => restarted.cleanup(id, first), /dirty/);
});

test("durable command/tool/model counters and filtered environments cover injected effects", async (t) => {
  const { project } = await fixture(t);
  await repository(project);
  const id = randomUUID(),
    owner = ownership({
      maxCommands: 1,
      maxModelCalls: 1,
      maxToolCalls: 1,
      environment: ["WORKFLOW_TEST_ALLOWED"],
    });
  const manager = new ManagedWorkspaces(project),
    metadata = await manager.reserve(id, owner, {});
  const oldAllowed = process.env.WORKFLOW_TEST_ALLOWED,
    oldDenied = process.env.WORKFLOW_TEST_DENIED;
  process.env.WORKFLOW_TEST_ALLOWED = "visible";
  process.env.WORKFLOW_TEST_DENIED = "secret";
  try {
    await automationBoundary.run(
      {
        environment: owner.execution.environment,
        consume: (kind) => manager.consume(id, metadata, kind),
      },
      async () => {
        const env = await createExecutionEnvironment(
          async (options) => {
            assert.equal(options.environment?.WORKFLOW_TEST_ALLOWED, "visible");
            assert.equal(options.environment?.WORKFLOW_TEST_DENIED, undefined);
            return localExecutionEnvironment(options);
          },
          { project: metadata.root, isolated: true, signal: AbortSignal.timeout(10_000) },
        );
        const result = await env.exec(
          'printf "%s:%s" "$WORKFLOW_TEST_ALLOWED" "${WORKFLOW_TEST_DENIED-unset}"',
        );
        assert.equal(result.output, "visible:unset");
        await assert.rejects(() => env.exec("true"), /commands limit/);
        await assert.rejects(() => env.readText(path.join(project, "baseline.txt")), /inside/);
      },
    );
    await manager.consume(id, metadata, "models");
    await manager.consume(id, metadata, "tools");
    const restarted = new ManagedWorkspaces(project);
    await assert.rejects(() => restarted.consume(id, metadata, "models"), /models limit/);
    await assert.rejects(() => restarted.consume(id, metadata, "tools"), /tools limit/);
  } finally {
    if (oldAllowed === undefined) delete process.env.WORKFLOW_TEST_ALLOWED;
    else process.env.WORKFLOW_TEST_ALLOWED = oldAllowed;
    if (oldDenied === undefined) delete process.env.WORKFLOW_TEST_DENIED;
    else process.env.WORKFLOW_TEST_DENIED = oldDenied;
  }
});

test("cleanup retains clean unpublished commits and only removes published clean worktrees", async (t) => {
  const { project } = await fixture(t);
  await repository(project);
  const manager = new ManagedWorkspaces(project),
    id = randomUUID();
  const metadata = await manager.reserve(id, ownership(), {});
  await assert.rejects(() => manager.cleanup(id, metadata), /unpublished/);
  await execute("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: project });
  await manager.cleanup(id, metadata);
  await manager.cleanup(id, metadata);
  await assert.rejects(() => manager.assert(id, metadata), /ownership/);
});

test("two owned full workflows isolate exec, tool, file and AI paths while manual runs stay exclusive", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await repository(project);
  const roots: string[] = [];
  let engine = new WorkflowEngine(project, "live", async (execution) => {
    roots.push(execution.project);
    assert.equal(execution.attachmentProject, project);
    const env = await createExecutionEnvironment(
      execution.environmentFactory ?? localExecutionEnvironment,
      {
        project: execution.project,
        isolated: execution.absoluteJournalPaths,
        signal: execution.signal,
        journal: execution.journal,
      },
    );
    await env.writeText("ai.txt", "owned");
    return { outcome: "pass", summary: "owned", artifacts: {} };
  });
  cleanup(() => engine.shutdown());
  engine.setAutomationAdmissionGuard(() => {});
  await engine.initialize();
  const blockId = Object.keys(library.blocks)[0]!;
  const standalone = await engine.snapshotForAutomation(
    { kind: "block", blockId },
    automationExecutionSchema.parse({}),
  );
  assert.ok(standalone.program?.catalog[blockId]);
  assert.equal(roots.length, 0, "snapshotting never executes a block or model");
  const source = `import {workflow,block,step,defineTool,z} from "workflow";
    const writer=defineTool({name:"writer",description:"Write owned tool file",input:z.object({value:z.string()}),output:z.string(),async execute(input,ctx){await ctx.env.writeText("tool.txt",input.value);await ctx.env.exec("printf tool > tool-command.txt");return input.value;}});
    export default workflow({name:"Owned",flow:step("work",block({async run(ctx){
      const value=String(ctx.input.value); await ctx.exec("sleep 1; printf command > command.txt");
      await ctx.writeFile("file.txt",value); const read=await ctx.readFile("file.txt");
      await ctx.call(writer,{value:read}); await ctx.ai({prompt:"Write owned evidence",tools:"none"}); return {value:read};
    }}),{inputs:ctx=>ctx.input,maxVisits:1})});`;
  const draft = await engine.createProgram("Owned", "Owned operations", { source }, library);
  const policy = automationExecutionSchema.parse({ maxCommands: 10 });
  const template = await engine.snapshotForAutomation(
    { kind: "workflow", runId: draft.id },
    policy,
  );
  const ownerA = ownership(policy),
    ownerB = ownership(policy),
    idA = randomUUID(),
    idB = randomUUID();
  const [a, b] = await Promise.all([
    engine.createAutomatedRun(template, idA, { value: "A" }, ownerA),
    engine.createAutomatedRun(template, idB, { value: "B" }, ownerB),
  ]);
  assert.notEqual(a.automation!.root, b.automation!.root);
  await assert.rejects(() => engine.updateProgram(a.id, { source }), /frozen/);
  engine.setAutomationAdmissionGuard(() => {
    throw new Error("scheduler capacity reached");
  });
  await assert.rejects(() => engine.approve(a.id), /scheduler capacity/);
  engine.setAutomationAdmissionGuard(() => {});
  await engine.approve(a.id);
  await engine.approve(b.id);
  await assert.rejects(() => engine.approve(draft.id), /owns this execution workspace/);
  await Promise.all(
    [a, b].map((run) =>
      waitForRun(() => engine.get(run.id), { signal: AbortSignal.timeout(30_000) }),
    ),
  );
  for (const [run, value] of [
    [a, "A"],
    [b, "B"],
  ] as const) {
    assert.equal(engine.get(run.id).status, "completed", engine.get(run.id).error ?? "");
    for (const filename of ["file.txt", "tool.txt"])
      assert.equal(await readFile(path.join(run.automation!.root, filename), "utf8"), value);
    assert.equal(await readFile(path.join(run.automation!.root, "command.txt"), "utf8"), "command");
    assert.equal(
      await readFile(path.join(run.automation!.root, "tool-command.txt"), "utf8"),
      "tool",
    );
    assert.equal(await readFile(path.join(run.automation!.root, "ai.txt"), "utf8"), "owned");
    await assert.rejects(() => engine.cleanupAutomationWorkspace(run.id), /dirty/);
  }
  assert.deepEqual(new Set(roots), new Set([a.automation!.root, b.automation!.root]));
  await assert.rejects(() => readFile(path.join(project, "file.txt")), /ENOENT/);
  await engine.shutdown();
  engine = new WorkflowEngine(project, "live", passingRunner);
  engine.setAutomationAdmissionGuard(() => {});
  await engine.initialize();
  assert.equal(
    (await engine.createAutomatedRun(template, idA, { value: "A" }, ownerA)).automation!.root,
    a.automation!.root,
  );
  await assert.rejects(
    () => engine.createAutomatedRun(template, idA, { value: "tampered" }, ownerA),
    /reservation/,
  );
  assert.deepEqual(engine.get(idA).outputValue, { value: "A" });
  const successorOwner = { ...ownerA, jobId: randomUUID(), previousRunId: a.id };
  await assert.rejects(
    () => engine.createAutomatedRun(template, randomUUID(), { value: "next" }, successorOwner),
    /Commit prior automation work/,
  );
  await execute("git", ["add", "."], { cwd: a.automation!.root });
  await execute("git", ["commit", "-m", "Owned work"], { cwd: a.automation!.root });
  const successor = await engine.createAutomatedRun(
    template,
    randomUUID(),
    { value: "next" },
    successorOwner,
  );
  assert.notEqual(successor.automation!.root, a.automation!.root);
  assert.equal(await readFile(path.join(successor.automation!.root, "file.txt"), "utf8"), "A");
  assert.notEqual(successor.automation!.branch, a.automation!.branch);
});

test("owned legacy commands, host checks and failure recovery use the same execution root", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await repository(project);
  library.config.commands["owned-command"] = commandSchema.parse({
    argv: ["bash", "-c", "printf command > command.txt"],
  });
  library.config.commands["owned-check"] = commandSchema.parse({
    argv: ["bash", "-c", "test -f command.txt && printf checked > check.txt"],
  });
  library.blocks["owned-command"] = bundleSchema.parse({
    definition: {
      id: "owned-command",
      name: "Owned command",
      description: "Exercise owned command and checks",
      executor: { kind: "command", command: "owned-command" },
      skills: [],
      outputs: [],
      checks: [{ command: "owned-check", expect: "success" }],
    },
    prompt: "Execute the frozen command",
    skills: [],
  });
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  engine.setAutomationAdmissionGuard(() => {});
  await engine.initialize();
  const source = `import {workflow,step,sequence,block} from "workflow";
    export default workflow({name:"Owned recovery",flow:sequence(
      step("command","owned-command",{maxVisits:1}),
      step("rollback",block({async run(ctx){await ctx.writeFile("baseline.txt","changed");throw new Error("intentional failure");}}),{maxVisits:1})
    )});`;
  const draft = await engine.createProgram(
    "Owned recovery",
    "Exercise every owned host path",
    { source },
    library,
  );
  const owner = ownership({ maxCommands: 2 });
  const template = await engine.snapshotForAutomation(
    { kind: "workflow", runId: draft.id },
    owner.execution,
  );
  const run = await engine.createAutomatedRun(template, randomUUID(), {}, owner);
  await engine.approve(run.id);
  await waitForRun(() => engine.get(run.id), { signal: AbortSignal.timeout(30_000) });
  assert.equal(engine.get(run.id).status, "failed");
  assert.equal(await readFile(path.join(run.automation!.root, "command.txt"), "utf8"), "command");
  assert.equal(await readFile(path.join(run.automation!.root, "check.txt"), "utf8"), "checked");
  assert.equal(await readFile(path.join(run.automation!.root, "baseline.txt"), "utf8"), "baseline");
  assert.equal(await readFile(path.join(project, "baseline.txt"), "utf8"), "baseline");
  await assert.rejects(() => readFile(path.join(project, "command.txt")), /ENOENT/);
  const events = await engine.events(run.id);
  assert.ok(
    events.some(
      (event) => event.operation?.name === "owned-check" && event.operation.state === "completed",
    ),
  );
});
