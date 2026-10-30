import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fixture, passingResult } from "./helpers.js";
import { runScriptBlock } from "../src/core/execution/script-runner.js";
import { runFunctionBlock } from "../src/legacy/git-push-v1.js";
import { pushScript } from "../src/core/library/script-examples.js";
import { budgetSchema, bundleSchema, nodeSchema, validatePlan } from "../src/contracts/domain.js";
import { validatePlanModels } from "../src/core/library/library-proposals.js";
import { validateLibraryResources } from "../src/core/library/library.js";
import { emptyUsage, estimateBudget } from "../src/core/execution/budget.js";
import { WorkflowEngine } from "../src/core/engine.js";
import type { BlockExecution } from "../src/core/execution/block-runner.js";

const exec = promisify(execFile);
async function git(project: string, ...args: string[]) {
  return (
    await exec("git", ["-C", project, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
  ).stdout.trim();
}
async function repository(project: string) {
  await git(project, "init", "-b", "feature/publish");
  await git(project, "config", "user.name", "Workflow Test");
  await git(project, "config", "user.email", "workflow@example.invalid");
  await git(project, "config", "commit.gpgsign", "false");
  await git(project, "config", "core.hooksPath", "/dev/null");
  const remote = path.join(project, "remote.git");
  await mkdir(remote);
  await git(remote, "init", "--bare");
  await git(project, "remote", "add", "origin", remote);
  return remote;
}
async function commit(project: string, content = "first") {
  await writeFile(path.join(project, "source.txt"), content);
  await git(project, "add", "--", "source.txt");
  await git(project, "commit", "-m", content);
  return await git(project, "rev-parse", "HEAD");
}
function execution(
  project: string,
  library: Awaited<ReturnType<typeof fixture>>["library"],
): BlockExecution {
  return {
    project,
    config: library.config,
    bundle: library.blocks.push!,
    node: nodeSchema.parse({
      id: "push",
      block: "push",
      label: "Publish commits",
      goal: "Push current branch",
      maxVisits: 1,
      on: { pass: "$complete", retry: "$failed", fail: "$failed" },
    }),
    task: "Push current branch",
    settings: library.config.agent,
    inputs: {},
    visit: 1,
    signal: new AbortController().signal,
    emit: () => {},
  };
}

test("editable push script creates a remote branch/upstream, updates it, and never stages or commits", async (t) => {
  const { project, library } = await fixture(t);
  const remote = await repository(project);
  const first = await commit(project);
  await writeFile(path.join(project, "private-untracked.txt"), "leave alone");
  const step = execution(project, library);
  validateLibraryResources(library.blocks, {});
  const plan = validatePlan(
    { title: "Push", task: step.task, entry: "push", nodes: [step.node] },
    library,
  );
  validatePlanModels(plan, library, []);
  assert.equal(estimateBudget(plan, library, "live").expectedCostUsd, 0);
  const created = await runScriptBlock(step);
  assert.equal(created.outcome, "pass", created.summary);
  assert.equal(await git(remote, "rev-parse", "refs/heads/feature/publish"), first);
  assert.equal(
    await git(project, "rev-parse", "--abbrev-ref", "@{upstream}"),
    "origin/feature/publish",
  );
  const second = await commit(project, "second");
  await git(project, "config", "remote.origin.mirror", "true");
  await git(project, "branch", "unrelated");
  const updated = await runScriptBlock(step);
  assert.equal(updated.outcome, "pass", updated.summary);
  assert.equal(await git(remote, "rev-parse", "refs/heads/feature/publish"), second);
  assert.equal(
    await git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/"),
    "refs/heads/feature/publish",
  );
  assert.equal(await git(project, "diff", "--cached", "--name-only"), "");
  assert.equal(await git(project, "rev-list", "--count", "HEAD"), "2");
  assert.equal(await readFile(path.join(project, "private-untracked.txt"), "utf8"), "leave alone");
  assert.match(updated.artifacts.publication!, /Git activity/);
  assert.equal((await runScriptBlock(step)).outcome, "pass", "Repeating a push is safe");
  const legacy = structuredClone(step.bundle);
  legacy.definition.executor = { kind: "function", function: "git-push" };
  assert.equal(
    (await runFunctionBlock({ ...step, bundle: legacy })).outcome,
    "pass",
    "Already approved function snapshots retain their original executor",
  );
});

test("editable push script publishes by branch name despite a different fetch upstream and rejects divergence", async (t) => {
  const { project, library } = await fixture(t);
  const remote = await repository(project);
  const first = await commit(project);
  await git(project, "push", "--set-upstream", "origin", "HEAD:refs/heads/release");
  const second = await commit(project, "second");
  const step = execution(project, library);
  assert.equal((await runScriptBlock(step)).outcome, "pass");
  assert.equal(await git(remote, "rev-parse", "refs/heads/release"), first);
  assert.equal(await git(remote, "rev-parse", "refs/heads/feature/publish"), second);
  await git(project, "reset", "--hard", "HEAD~1");
  await commit(project, "divergent");
  const result = await runScriptBlock(step);
  assert.equal(result.outcome, "retry");
  assert.match(result.summary, /reject|non-fast-forward/i);
  assert.equal(await git(remote, "rev-parse", "refs/heads/release"), first);
  assert.equal(await git(remote, "rev-parse", "refs/heads/feature/publish"), second);
});

test("a feature branch created from origin/main cannot publish its commits to main", async (t) => {
  const { project, library } = await fixture(t);
  const remote = await repository(project);
  const base = await commit(project);
  await git(project, "push", "origin", "HEAD:refs/heads/main");
  await git(project, "checkout", "-b", "codex/issue-4-practice", "origin/main");
  assert.equal(await git(project, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main");
  const feature = await commit(project, "feature");
  const result = await runScriptBlock(execution(project, library));
  assert.equal(result.outcome, "pass", result.summary);
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), base);
  assert.equal(await git(remote, "rev-parse", "refs/heads/codex/issue-4-practice"), feature);
  assert.equal(
    await git(project, "rev-parse", "--abbrev-ref", "@{upstream}"),
    "origin/codex/issue-4-practice",
  );
});

test("editable push script uses an explicit configured remote and reports missing commits/remotes/detached HEAD", async (t) => {
  const { project, library } = await fixture(t);
  const remote = await repository(project);
  const step = execution(project, library);
  assert.equal((await runScriptBlock(step)).outcome, "retry", "Unborn HEAD cannot be pushed");
  const head = await commit(project);
  step.bundle = bundleSchema.parse({
    ...step.bundle,
    definition: { ...step.bundle.definition, executor: pushScript("absent") },
  });
  assert.match((await runScriptBlock(step)).summary, /not configured/);
  await git(project, "remote", "rename", "origin", "published");
  step.bundle.definition.executor = pushScript("published");
  assert.equal((await runScriptBlock(step)).outcome, "pass");
  assert.equal(await git(remote, "rev-parse", "refs/heads/feature/publish"), head);
  await git(project, "checkout", "--detach");
  assert.match((await runScriptBlock(step)).summary, /detached/);
  await assert.rejects(
    runScriptBlock({ ...step, signal: AbortSignal.abort(new Error("Stop")) }),
    /Stop/,
  );
});

test("cancelling a push terminates the Git process group before its hook can publish late effects", async (t) => {
  const { project, library } = await fixture(t);
  const remote = await repository(project);
  await commit(project);
  await mkdir(path.join(project, ".hooks"));
  await writeFile(
    path.join(project, ".hooks/pre-push"),
    "#!/bin/sh\nprintf ready > hook-ready\nsleep 2\nprintf late > hook-late\n",
    { mode: 0o755 },
  );
  await git(project, "config", "core.hooksPath", ".hooks");
  const controller = new AbortController();
  const operation = runScriptBlock({ ...execution(project, library), signal: controller.signal });
  const stopped = assert.rejects(operation, /Cancelled push/);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await stat(path.join(project, "hook-ready")).then(
      () => true,
      () => false,
    );
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort(new Error("Cancelled push"));
  await stopped;
  assert.equal(ready, true);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await assert.rejects(stat(path.join(project, "hook-late")), /ENOENT/);
  assert.equal(await git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/"), "");
});

test("editable push script follows explicit, branch and project remote preferences without publishing other refs", async (t) => {
  const { project, library } = await fixture(t);
  const origin = await repository(project);
  const remotes: Record<string, string> = { origin };
  for (const name of ["personal", "team"]) {
    const directory = path.join(project, `${name}.git`);
    await mkdir(directory);
    await git(directory, "init", "--bare");
    await git(project, "remote", "add", name, directory);
    remotes[name] = directory;
  }
  await commit(project);
  await git(project, "branch", "unrelated");
  await git(project, "config", "branch.feature/publish.remote", "origin");
  await git(project, "config", "branch.feature/publish.merge", "refs/heads/release");
  await git(project, "config", "branch.feature/publish.pushRemote", "personal");
  await git(project, "config", "remote.pushDefault", "team");
  // A configured push refspec must not broaden the script's explicit branch.
  await git(project, "config", "remote.personal.push", "refs/heads/*:refs/heads/*");
  const step = execution(project, library);
  for (const [index, selected] of ["origin", "personal", "team", "origin"].entries()) {
    const head = await commit(project, `preference-${index}`);
    if (index === 2) await git(project, "config", "--unset", "branch.feature/publish.pushRemote");
    if (index === 3) await git(project, "config", "--unset", "remote.pushDefault");
    // Set-upstream is part of successful publication, so restore the original
    // fetch upstream to exercise each distinct remote selection case.
    await git(project, "config", "branch.feature/publish.remote", "origin");
    await git(project, "config", "branch.feature/publish.merge", "refs/heads/release");
    step.bundle.definition.executor = pushScript(index === 0 ? "origin" : "");
    const result = await runScriptBlock(step);
    assert.equal(result.outcome, "pass", result.summary);
    const destination = "feature/publish";
    assert.equal(await git(remotes[selected]!, "rev-parse", `refs/heads/${destination}`), head);
    assert.equal(
      await git(remotes[selected]!, "for-each-ref", "--format=%(refname)", "refs/heads/"),
      `refs/heads/${destination}`,
    );
  }
  await git(project, "config", "--unset", "branch.feature/publish.remote");
  await git(project, "config", "--unset", "branch.feature/publish.merge");
  await git(project, "remote", "rename", "origin", "archive");
  const ambiguous = await runScriptBlock(step);
  assert.equal(ambiguous.outcome, "retry");
  assert.match(ambiguous.summary, /No unambiguous push remote/);
});

test("an approved script workflow publishes using no AI runner or provider credentials", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const remote = await repository(project);
  const head = await commit(project);
  const engine = new WorkflowEngine(project, "live", async () => {
    throw new Error("A script must never call AI");
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const step = execution(project, library);
  const plan = validatePlan(
    { title: "Publish", task: step.task, entry: "push", nodes: [step.node] },
    library,
  );
  const draft = await engine.create(plan, library);
  assert.equal(await git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/"), "");
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const completed = engine.get(draft.id);
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(completed.usage?.requests ?? 0, 0);
  assert.equal(await git(remote, "rev-parse", "refs/heads/feature/publish"), head);
  assert.match(completed.attempts[0]!.result!.summary, /Pushed/);
});

test("a script can finish publication after the preceding AI step exhausts the model budget", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const remote = await repository(project);
  const head = await commit(project);
  library.config.agent.provider = "publication-fixture";
  library.config.agent.model = "priced";
  library.config.budget = budgetSchema.parse({
    maxCostUsd: 0.1,
    prices: { "publication-fixture/priced": { input: 1, output: 1 } },
  });
  const calls: string[] = [];
  const engine = new WorkflowEngine(project, "live", async (step) => {
    calls.push(step.node.id);
    await step.onUsage?.({ ...emptyUsage(), costUsd: 0.1, requests: 1 });
    return passingResult(step);
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const push = execution(project, library).node;
  const review = nodeSchema.parse({
    id: "review",
    block: "review",
    label: "Review",
    goal: "Review before publishing",
    on: { pass: "push", retry: "$failed", fail: "$failed" },
  });
  const draft = await engine.create(
    validatePlan(
      { title: "Review and push", task: "Review and push", entry: "review", nodes: [review, push] },
      library,
    ),
    library,
  );
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const completed = engine.get(draft.id);
  assert.equal(completed.status, "completed", completed.error);
  assert.deepEqual(calls, ["review"]);
  assert.equal(completed.usage?.costUsd, 0.1);
  assert.equal(await git(remote, "rev-parse", "refs/heads/feature/publish"), head);
});
