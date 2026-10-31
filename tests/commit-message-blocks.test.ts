import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { fixture } from "./helpers.js";
import { WorkflowEngine } from "../src/core/engine.js";
import { runProcess } from "../src/infrastructure/process.js";

const names = ["collect-commit-diff", "draft-commit-message", "validate-commit-message"];
async function modules(project: string) {
  await mkdir(path.join(project, "blocks"));
  for (const name of names)
    await copyFile(
      path.resolve("examples/blocks", name + ".ts"),
      path.join(project, "blocks", name + ".ts"),
    );
}
async function git(project: string, ...args: string[]) {
  const result = await runProcess(project, ["git", ...args], AbortSignal.timeout(10000), 10000);
  assert.equal(result.exitCode, 0, result.output);
  return result.stdout;
}

test("three focused blocks collect only staged changes, draft with Luna without tools, and validate without committing", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await modules(project);
  await git(project, "init");
  await writeFile(path.join(project, "README.md"), "# Setup\nRun the development server.\n");
  await git(project, "add", "README.md");
  await writeFile(path.join(project, "README.md"), "# Setup\nUNSTAGED_SENTINEL\n");
  const before = await git(project, "diff", "--cached");
  let calls = 0;
  const engine = new WorkflowEngine(project, "live", async (execution) => {
    calls++;
    assert.equal(execution.settings.model, "gpt-6-luna");
    assert.equal(execution.tools, "none");
    assert.deepEqual(Object.keys(execution.inputs), ["call-prompt"]);
    const input = JSON.parse(execution.inputs["call-prompt"]!);
    assert.match(input.diff, /Run the development server/);
    assert.doesNotMatch(input.diff, /UNSTAGED_SENTINEL/);
    return {
      outcome: "pass",
      summary: "Drafted",
      artifacts: { data: JSON.stringify({ message: "docs: explain development startup" }) },
    };
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const source = await readFile("examples/commit-message.ts", "utf8");
  const draft = await engine.createProgram(
    "Commit message",
    "Suggest a message",
    { source },
    library,
  );
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.equal(calls, 1);
  assert.deepEqual(
    run.attempts.map((a) => a.nodeId),
    ["collect-diff", "draft-message", "validate-message"],
  );
  assert.equal(
    run.artifacts["validate-message"]?.["commit-message"],
    "docs: explain development startup",
  );
  assert.equal(await git(project, "diff", "--cached"), before);
  assert.match(await readFile(path.join(project, "README.md"), "utf8"), /UNSTAGED_SENTINEL/);
  const head = await runProcess(
    project,
    ["git", "rev-parse", "--verify", "HEAD"],
    AbortSignal.timeout(10000),
    10000,
  );
  assert.notEqual(head.exitCode, 0);
});

test("message validation rejects malformed subjects and accepts breaking-change footers without model calls", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await modules(project);
  const engine = new WorkflowEngine(project, "live", async () => {
    throw new Error("No model expected");
  });
  cleanup(() => engine.shutdown());
  await engine.initialize();
  for (const [message, valid] of [
    ["Updated stuff", false],
    ["fix: correct parsing\nmissing blank separator", false],
    ["feat(api)!: remove legacy endpoint\n\nBREAKING CHANGE: use /v2 instead.", true],
  ] as const) {
    const source = `import {workflow,step} from "workflow"; import validate from "./blocks/validate-commit-message"; export default workflow({name:"Validate",flow:step("validate",validate,{inputs:{message:${JSON.stringify(message)}}})});`;
    const draft = await engine.createProgram("Validate", "Validate message", { source }, library);
    await engine.approve(draft.id);
    await engine.waitForIdle();
    assert.equal(
      engine.get(draft.id).status,
      valid ? "completed" : "failed",
      engine.get(draft.id).error ?? "",
    );
  }
});
