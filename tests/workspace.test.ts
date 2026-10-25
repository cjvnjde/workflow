import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { initializeProject, loadLibrary } from "../src/library.js";
import { Workspace } from "../src/workspace.js";
import { fixture } from "./helpers.js";

test("file tools can update source, tests, manifests and project configuration", async (t) => {
  const { project } = await fixture(t);
  const workspace = await Workspace.create(project);
  await workspace.write("src/math.ts", "export const add = (a, b) => a - b");
  await workspace.write("src/math.test.ts", "assert.equal(add(1, 2), 3)");
  await workspace.write("package.json", '{"scripts":{"test":"bun test"}}');
  await workspace.write(".workflow/local-notes.md", "Project setup");
  await workspace.edit("src/math.ts", "a - b", "a + b");
  assert.match(await workspace.read("src/math.ts"), /a \+ b/);
  assert.match(await workspace.read("src/math.test.ts"), /assert.equal/);
  assert.deepEqual(await workspace.list("**/*.test.ts"), ["src/math.test.ts"]);
  assert.match(await workspace.read("package.json"), /bun test/);
  assert.equal(await workspace.read(".workflow/local-notes.md"), "Project setup");
  assert.ok(!(await workspace.list()).some((file) => file.startsWith(".workflow/")));
  assert.ok((await workspace.list(".workflow/**/*.md")).includes(".workflow/local-notes.md"));
});

test("file tools accept absolute paths and links without a project-root allowlist", async (t) => {
  const { project } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "workflow-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const workspace = await Workspace.create(project);
  const target = path.join(outside, "file.txt");
  await workspace.write(target, "original");
  await symlink(outside, path.join(project, "linked"));
  assert.equal(await workspace.read("linked/file.txt"), "original");
  await workspace.edit("linked/file.txt", "original", "updated");
  assert.equal(await readFile(target, "utf8"), "updated");
  await workspace.write(path.relative(project, target), "relative outside");
  assert.equal(await workspace.read(target), "relative outside");
  await link(target, path.join(project, "hard-linked.txt"));
  assert.equal(await workspace.read("hard-linked.txt"), "relative outside");
  await symlink(path.join(outside, "new.txt"), path.join(project, "dangling"));
  await workspace.write("dangling", "new target");
  assert.equal(await readFile(path.join(outside, "new.txt"), "utf8"), "new target");
});

test("exact edits require one nonempty match and preserve the file on error", async (t) => {
  const { project, library } = await fixture(t);
  const fix = library.blocks.fix;
  assert.ok(fix);
  const workspace = await Workspace.create(project);
  await workspace.write("source.ts", "same same");
  await assert.rejects(
    workspace.edit("source.ts", "same", "different"),
    /exactly once/,
  );
  await assert.rejects(
    workspace.edit("source.ts", "", "different"),
    /must not be empty/,
  );
  assert.equal(await workspace.read("source.ts"), "same same");
});

test("init never overwrites an existing policy and skills cannot escape their block", async (t) => {
  const { project, library } = await fixture(t);
  await assert.rejects(initializeProject(project), { code: "EEXIST" });
  const review = library.blocks.review;
  assert.ok(review);
  review.definition.skills = ["../../config.json"];
  await writeFile(
    path.join(project, ".workflow/blocks/review/block.json"),
    JSON.stringify(review.definition),
  );
  await assert.rejects(loadLibrary(project), /must stay inside/);
});

test("special files are rejected before opening can block", { skip: process.platform === "win32" }, async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { project } = await fixture(t);
  execFileSync("mkfifo", [path.join(project, "pipe")]);
  // Use an isolated process: a regression would otherwise leave an open() blocked in this test runner.
  const source = new URL("../src/workspace.ts", import.meta.url).pathname;
  execFileSync(process.execPath, ["-e", `
    import assert from 'node:assert/strict';
    import { Workspace } from ${JSON.stringify(source)};
    const workspace = await Workspace.create(${JSON.stringify(project)});
    await assert.rejects(workspace.read('pipe'), /regular file/);
    await assert.rejects(workspace.write('pipe', 'content'), /regular file/);
  `], { timeout: 2000 });
});

test("Git metadata and dotfiles are accessible with explicit paths", async (t) => {
  const { project } = await fixture(t);
  const workspace = await Workspace.create(project);
  await workspace.write(".git/HEAD", "ref: refs/heads/main\n");
  await workspace.write(".env.fixture", "EXAMPLE=not-a-secret");
  await workspace.write(".npmrc", "registry=https://registry.npmjs.org/");
  assert.equal(await workspace.read(".git/HEAD"), "ref: refs/heads/main\n");
  assert.match(await workspace.read(".env.fixture"), /EXAMPLE/);
  assert.ok((await workspace.list()).includes(".npmrc"));
  assert.deepEqual(await workspace.list(".git/**"), [".git/HEAD"]);
  assert.ok(!(await workspace.list()).includes(".git/HEAD"));
});

test('isolated managed writes cannot escape through absolute paths or links', async t => {
 const {project}=await fixture(t);
 const isolated=path.join(project,'isolated');await mkdir(isolated);
 const workspace=await Workspace.create(isolated,{writeRootOnly:true,absoluteJournalPaths:true});
 await writeFile(path.join(project,'outside.txt'),'keep');
 await assert.rejects(workspace.write(path.join(project,'outside.txt'),'changed'),/stay inside/);
 await symlink(path.join(project,'outside.txt'),path.join(isolated,'alias'));
 await assert.rejects(workspace.write('alias','changed'),/stay inside/);
 assert.equal(await readFile(path.join(project,'outside.txt'),'utf8'),'keep');
});
