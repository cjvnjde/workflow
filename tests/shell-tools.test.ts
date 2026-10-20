import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { workspaceTools } from "../src/block-runner.js";
import { Workspace } from "../src/workspace.js";
import { fixture } from "./helpers.js";

const execute = promisify(execFile);
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

async function shell(project: string) {
  const tool = workspaceTools(await Workspace.create(project)).find((item) => item.name === "bash")!;
  return (command: string, signal = AbortSignal.timeout(10_000), timeout?: number) =>
    tool.execute("call", { command, timeout }, signal, undefined, {} as never);
}
function text(result: Awaited<ReturnType<Awaited<ReturnType<typeof shell>>>>) {
  return result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
}

test("agent bash can inspect identity, stage, commit and push to a configured local remote", async (t) => {
  const { project } = await fixture(t);
  // Both repositories are disposable; nothing is published over the network.
  const remote = path.join(project, "remote.git");
  const repository = path.join(project, "repository");
  await mkdir(repository);
  await execute("git", ["init", "--bare", remote]);
  const git = (...args: string[]) => execute("git", args, { cwd: repository });
  await git("init", "-b", "main");
  await git("config", "user.name", "Workflow Regression");
  await git("config", "user.email", "regression@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.hooksPath", "/dev/null");
  await git("remote", "add", "origin", remote);
  await writeFile(path.join(repository, ".gitignore"), ".env\n");
  await writeFile(path.join(repository, ".env"), "FAKE_FIXTURE_VALUE=private\n");
  await writeFile(path.join(repository, "example.ts"), "export const ready = true;\n");
  const run = await shell(repository);
  const inspection = await run("git status --short && git var GIT_AUTHOR_IDENT && git remote -v");
  assert.match(text(inspection), /Workflow Regression/);
  assert.match(text(inspection), /remote\.git/);
  const publication = await run("git add -- .gitignore example.ts && git commit -m 'Add example' && git push -u origin HEAD:main");
  assert.notEqual(publication.isError, true);
  assert.match(text(publication), /new branch|branch.*main/);
  const localHead = (await git("rev-parse", "HEAD")).stdout.trim();
  assert.equal((await execute("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim(), localHead);
  assert.equal((await git("status", "--porcelain")).stdout, "");
  assert.deepEqual((await git("ls-files")).stdout.trim().split("\n"), [".gitignore", "example.ts"]);
  assert.match(await (await Workspace.create(repository)).read(".git/HEAD"), /refs\/heads\/main/);
});

test("bash inherits the server environment and returns command failures and output", async (t) => {
  const { project } = await fixture(t);
  const previous = process.env.WORKFLOW_SHELL_TEST_VALUE;
  process.env.WORKFLOW_SHELL_TEST_VALUE = "inherited-test-value";
  t.after(() => {
    if (previous === undefined) delete process.env.WORKFLOW_SHELL_TEST_VALUE;
    else process.env.WORKFLOW_SHELL_TEST_VALUE = previous;
  });
  const run = await shell(project);
  const result = await run("pwd; printf '%s\\n' \"$WORKFLOW_SHELL_TEST_VALUE\"; printf 'failure evidence\\n' >&2; exit 7");
  assert.equal(result.isError, true);
  assert.match(text(result), /inherited-test-value/);
  assert.match(text(result), /failure evidence/);
  assert.ok(text(result).includes(await realpath(project)));
});

test("cancellation and command timeouts stop bash subprocesses before late effects", async (t) => {
  const { project } = await fixture(t);
  const run = await shell(project);
  const marker = path.join(project, "late-write");
  const started = path.join(project, "started");
  const controller = new AbortController();
  const command = run(`touch ${quote(started)}; sleep 1; touch ${quote(marker)}`, controller.signal);
  const rejected = assert.rejects(command, /abort/i);
  for (let tries = 0; tries < 200; tries++) {
    if (await stat(started).then(() => true, () => false)) break;
    await Bun.sleep(10);
  }
  assert.ok(await readFile(started).then(() => true, () => false));
  controller.abort();
  await rejected;
  await assert.rejects(run(`sleep 1; touch ${quote(marker)}`, AbortSignal.timeout(5000), 0.05), /timed out/i);
  await Bun.sleep(1100);
  await assert.rejects(stat(marker), { code: "ENOENT" });
});
