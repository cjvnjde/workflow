import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { writeFile, readFile, rm } from "node:fs/promises";
import { fixture } from "./helpers.js";
import { runProcess } from "../src/process.js";
import { executionWorkspace } from "../src/execution-workspace.js";
import { WorkflowEngine } from "../src/engine.js";
import { Workspace } from "../src/workspace.js";

const git = async (cwd: string, ...args: string[]) => {
  const r = await runProcess(
    cwd,
    ["git", ...args],
    AbortSignal.timeout(10000),
    10000,
  );
  assert.equal(r.exitCode, 0, r.output);
  return r.stdout.trim();
};

test("independent writers overlap in real worktrees, join, and integrate with combined verification", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await git(project, "init");
  await git(project, "config", "user.email", "test@example.com");
  await git(project, "config", "user.name", "Workflow Test");
  await writeFile(path.join(project, "base.txt"), "unchanged baseline");
  await git(project, "add", "base.txt");
  await git(project, "commit", "-m", "baseline");
  const paths = [`${project}-writer-a`, `${project}-writer-b`];
  for (const dir of paths)
    await git(project, "worktree", "add", "--detach", dir, "HEAD");
  t.after(async () => {
    for (const dir of paths) await rm(dir, { recursive: true, force: true });
  });
  assert.equal(
    await executionWorkspace(project, paths[0], AbortSignal.timeout(10000)),
    paths[0],
  );
  await assert.rejects(
    executionWorkspace(project, "/tmp", AbortSignal.timeout(10000)),
    /Git worktree/,
  );
  let active = 0,
    peak = 0,
    arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    active++;
    peak = Math.max(peak, active);
    if (++arrived === 2) release();
    await barrier;
    try {
      const name = execution.node.id;
      const workspace = await Workspace.create(execution.project, {
        journal: execution.journal,
        absoluteJournalPaths: execution.absoluteJournalPaths,
      });
      await workspace.write(`${name}.txt`, `${name} result`);
      assert.equal(
        await readFile(path.join(project, "base.txt"), "utf8"),
        "unchanged baseline",
      );
      await git(execution.project, "add", `${name}.txt`);
      await git(execution.project, "commit", "-m", `Add ${name}`);
      const commit = await git(execution.project, "rev-parse", "HEAD");
      return {
        outcome: "pass",
        summary: "Isolated implementation",
        artifacts: { data: JSON.stringify({ commit }) },
      };
    } finally {
      active--;
    }
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source = `import {workflow,block,step,sequence,parallel,z} from "workflow";
 const writer=block({input:z.object({path:z.string()}),async run(ctx){return await ctx.ai({prompt:"Implement assigned change",workspace:ctx.input.path,output:z.object({commit:z.string()})});}});
 const a=step("a",writer,{inputs:{path:${JSON.stringify(paths[0])}}});
 const b=step("b",writer,{inputs:{path:${JSON.stringify(paths[1])}}});
 const integrate=step("integrate",block({input:z.object({a:z.object({commit:z.string()}),b:z.object({commit:z.string()})}),async run(ctx){
 const r=await ctx.exec("git cherry-pick "+ctx.input.a.commit+" "+ctx.input.b.commit);
 if(r.exitCode!==0)throw new Error(r.output);
 const check=await ctx.exec("test -f a.txt && test -f b.txt && test \\\"$(cat base.txt)\\\" = \\\"unchanged baseline\\\"");
 if(check.exitCode!==0)throw new Error(check.output);ctx.summary("Combined checks passed");return {passed:true};
 }}),{inputs:ctx=>({a:ctx.output(a),b:ctx.output(b)})});
 export default workflow({name:"Parallel isolated implementation",flow:sequence(parallel([a,b],{label:"Independent writers"}),integrate)});`;
  const draft = await engine.createProgram(
    "Isolated writers",
    "Implement independent changes",
    { source },
    library,
  );
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(peak, 2);
  assert.equal(await readFile(path.join(project, "a.txt"), "utf8"), "a result");
  assert.equal(await readFile(path.join(project, "b.txt"), "utf8"), "b result");
});

test("integration conflicts stop combined acceptance and preserve both worktrees", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await git(project, "init");
  await git(project, "config", "user.email", "test@example.com");
  await git(project, "config", "user.name", "Workflow Test");
  await writeFile(path.join(project, "shared.txt"), "original\n");
  await git(project, "add", "shared.txt");
  await git(project, "commit", "-m", "baseline");
  const paths = [`${project}-conflict-a`, `${project}-conflict-b`];
  const commits: string[] = [];
  t.after(async () => {
    for (const dir of paths) await rm(dir, { recursive: true, force: true });
  });
  for (const [index, dir] of paths.entries()) {
    await git(project, "worktree", "add", "--detach", dir, "HEAD");
    await writeFile(path.join(dir, "shared.txt"), `writer ${index}\n`);
    await git(dir, "add", "shared.txt");
    await git(dir, "commit", "-m", `Writer ${index}`);
    commits.push(await git(dir, "rev-parse", "HEAD"));
  }
  const engine = new WorkflowEngine(project, "live", async () => {
    throw new Error("No AI expected");
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source = `import {workflow,block,step,sequence} from "workflow";
 const integration=step("integrate",block({async run(ctx){const r=await ctx.exec(${JSON.stringify("git cherry-pick " + commits.join(" "))});ctx.artifact("integration",r.output);ctx.summary(r.output||"Integrated");if(r.exitCode!==0)ctx.disposition("changes-requested");return {passed:r.exitCode===0};}}));
 const check=step("acceptance",block({async run(ctx){await ctx.writeFile("accepted.txt","must not happen");return true;}}));
 export default workflow({name:"Conflicting writers",flow:sequence(integration,check)});`;
  const draft = await engine.createProgram(
    "Conflict",
    "Integrate changes",
    { source },
    library,
  );
  await engine.approve(draft.id);
  await engine.waitForIdle();
  assert.equal(engine.get(draft.id).status, "failed");
  assert.equal(engine.get(draft.id).attempts.length, 1);
  await assert.rejects(readFile(path.join(project, "accepted.txt")), /ENOENT/);
  for (const [index, dir] of paths.entries())
    assert.equal(
      await readFile(path.join(dir, "shared.txt"), "utf8"),
      `writer ${index}\n`,
    );
  assert.match(
    engine.get(draft.id).artifacts.integrate!.integration!,
    /CONFLICT/,
  );
});

test("failed isolated edits restore their own worktree without touching the project", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await git(project, "init");
  await git(project, "config", "user.email", "test@example.com");
  await git(project, "config", "user.name", "Workflow Test");
  await writeFile(path.join(project, "owned.txt"), "baseline");
  await git(project, "add", "owned.txt");
  await git(project, "commit", "-m", "baseline");
  const isolated = `${project}-rollback`;
  await git(project, "worktree", "add", "--detach", isolated, "HEAD");
  t.after(() => rm(isolated, { recursive: true, force: true }));
  await writeFile(path.join(project, "owned.txt"), "unrelated main edits");
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    const workspace = await Workspace.create(execution.project, {
      journal: execution.journal,
      absoluteJournalPaths: execution.absoluteJournalPaths,
      writeRootOnly: true,
    });
    await workspace.write("owned.txt", "partial isolated edit");
    return {
      outcome: "fail",
      summary: "Required acceptance failed",
      artifacts: {},
    };
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source = `import {workflow,block} from "workflow";
    const work=block({async run(ctx){await ctx.ai({prompt:"Change owned file",workspace:${JSON.stringify(isolated)}});}});
    export default workflow({name:"Isolated rollback",async run(ctx){await ctx.step("work",work);}});`;
  const draft = await engine.createProgram(
    "Rollback",
    "Check rollback",
    { source },
    library,
  );
  await engine.approve(draft.id);
  await engine.waitForIdle();
  assert.equal(engine.get(draft.id).status, "failed");
  assert.equal(
    await readFile(path.join(isolated, "owned.txt"), "utf8"),
    "baseline",
  );
  assert.equal(
    await readFile(path.join(project, "owned.txt"), "utf8"),
    "unrelated main edits",
  );
});

test("concurrent calls cannot claim the same isolated worktree", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await git(project, "init");
  await git(project, "config", "user.email", "test@example.com");
  await git(project, "config", "user.name", "Workflow Test");
  await writeFile(path.join(project, "base.txt"), "baseline");
  await git(project, "add", "base.txt");
  await git(project, "commit", "-m", "baseline");
  const isolated = `${project}-shared`;
  await git(project, "worktree", "add", "--detach", isolated, "HEAD");
  t.after(() => rm(isolated, { recursive: true, force: true }));
  let release!: () => void;
  const rejected = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const engine = new WorkflowEngine(project, "live", async () => {
    calls++;
    await rejected;
    return { outcome: "pass", summary: "Only owner ran", artifacts: {} };
  });
  const events: string[] = [];
  const unsubscribe = engine.subscribe((event) => {
    if (
      event.kind === "operation_error" &&
      event.message.includes("Another AI call owns")
    ) {
      events.push(event.message);
      release();
    }
  });
  cleanup(async () => {
    release();
    unsubscribe();
    await engine.shutdown();
  });
  await engine.initialize();
  const source = `import {workflow,block,step,parallel} from "workflow";
    const work=block({async run(ctx){return await ctx.ai({prompt:"Assigned work",workspace:${JSON.stringify(isolated)}});}});
    export default workflow({name:"Exclusive workspace",flow:parallel([step("a",work),step("b",work)],{concurrency:2})});`;
  const draft = await engine.createProgram(
    "Exclusive workspace",
    "Independent edits",
    { source },
    library,
  );
  await engine.approve(draft.id);
  await engine.waitForIdle();
  assert.equal(engine.get(draft.id).status, "failed");
  assert.equal(calls, 1);
  assert.equal(events.length, 1);
});
