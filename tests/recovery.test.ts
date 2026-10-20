import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Workspace } from "../src/workspace.js";
import { FileJournal } from "../src/recovery.js";
import { atomicWrite } from "../src/atomic-file.js";
import { fixture } from "./helpers.js";

async function recoveryFixture(t: import("node:test").TestContext) {
  const { project } = await fixture(t);
  const journal = await FileJournal.open(path.join(project, ".workflow", "recovery-test"));
  const workspace = await Workspace.create(project, { journal });
  const recovery = await Workspace.create(project);
  return { project, journal, workspace, recovery };
}

test("failed-step recovery restores original bytes and permissions and removes newly created files", async (t) => {
  const { project, journal, workspace, recovery } = await recoveryFixture(t);
  const original = Buffer.from([0, 255, 123, 13, 10]);
  await writeFile(path.join(project, "original.bin"), original);
  await chmod(path.join(project, "original.bin"), 0o755);
  await workspace.write("original.bin", "changed");
  await workspace.write("new/file.ts", "created");
  assert.equal((await stat(path.join(project, "original.bin"))).mode & 0o777, 0o755);
  const settled = await journal.settle(recovery, false);
  assert.equal(settled.status, "restored");
  assert.deepEqual(await readFile(path.join(project, "original.bin")), original);
  assert.equal((await stat(path.join(project, "original.bin"))).mode & 0o777, 0o755);
  await assert.rejects(stat(path.join(project, "new/file.ts")), { code: "ENOENT" });
  assert.deepEqual(await journal.settle(recovery, false), settled);
});

test("recovery survives restart after a later write intent was saved but never published", async (t) => {
  const { project, journal, workspace, recovery } = await recoveryFixture(t);
  await writeFile(path.join(project, "source.ts"), "original");
  await workspace.write("source.ts", "first change");
  await journal.prepare("source.ts", await recovery.snapshot("source.ts"), Buffer.from("second change"));
  const restarted = await FileJournal.open(path.join(project, ".workflow", "recovery-test"));
  assert.equal((await restarted.settle(recovery, false)).status, "restored");
  assert.equal(await readFile(path.join(project, "source.ts"), "utf8"), "original");
});

test("recovery preserves manual changes and can be retried once a conflict is resolved", async (t) => {
  const { project, journal, workspace, recovery } = await recoveryFixture(t);
  await writeFile(path.join(project, "source.ts"), "original");
  await workspace.write("source.ts", "agent change");
  await writeFile(path.join(project, "source.ts"), "manual change");
  const conflict = await journal.settle(recovery, false);
  assert.equal(conflict.status, "conflict");
  assert.deepEqual(conflict.conflicts, ["source.ts"]);
  assert.equal(await readFile(path.join(project, "source.ts"), "utf8"), "manual change");
  await writeFile(path.join(project, "source.ts"), "original");
  assert.equal((await journal.settle(recovery, false)).status, "restored");
});

test("completed steps commit their changes and are not undone by a later recovery request", async (t) => {
  const { project, journal, workspace, recovery } = await recoveryFixture(t);
  await workspace.write("completed.ts", "completed step");
  assert.equal((await journal.settle(recovery, true)).status, "committed");
  assert.equal((await journal.settle(recovery, false)).status, "committed");
  assert.equal(await readFile(path.join(project, "completed.ts"), "utf8"), "completed step");
  await assert.rejects(workspace.write("completed.ts", "late write"), /already settled/);
});

test("atomic writes preserve the original when publication fails", async (t) => {
  const { project } = await fixture(t);
  const filename = path.join(project, "atomic.ts");
  await writeFile(filename, "original");
  await assert.rejects(atomicWrite(filename, "replacement", 0o644, () => { throw new Error("Cancelled before publish"); }), /Cancelled/);
  assert.equal(await readFile(filename, "utf8"), "original");
  await assert.rejects(atomicWrite(filename, "replacement", 0o644, async () => {
    await Promise.resolve();
    throw new Error("Async validation failed");
  }), /Async validation/);
  assert.equal(await readFile(filename, "utf8"), "original");
});

test("cancelled file tools cannot publish writes", async (t) => {
  const { project } = await fixture(t);
  const workspace = await Workspace.create(project, { signal: AbortSignal.abort(new Error("Cancelled")) });
  await assert.rejects(workspace.write("cancelled.ts", "content"), /Cancelled/);
  await assert.rejects(stat(path.join(project, "cancelled.ts")), { code: "ENOENT" });
});

test("recovery cannot follow a directory replaced with a link", async (t) => {
  const { project, journal, workspace, recovery } = await recoveryFixture(t);
  await workspace.write("source/file.ts", "change");
  const { rename } = await import("node:fs/promises");
  await mkdir(path.join(project, "external"));
  await writeFile(path.join(project, "external/file.ts"), "external content");
  await rename(path.join(project, "source"), path.join(project, "saved-source"));
  await symlink(path.join(project, "external"), path.join(project, "source"));
  assert.equal((await journal.settle(recovery, false)).status, "conflict");
  assert.equal(await readFile(path.join(project, "external/file.ts"), "utf8"), "external content");
});

test("file journals track physical paths across aliases and recover outside-project edits", async (t) => {
  const { project, journal, workspace, recovery } = await recoveryFixture(t);
  const { mkdtemp, rm } = await import("node:fs/promises");
  const outside = await mkdtemp(path.join(path.dirname(project), "workflow-recovery-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = path.join(outside, "file.ts");
  await writeFile(target, "original");
  await symlink(outside, path.join(project, "linked"));
  await workspace.write("linked/file.ts", "first");
  await workspace.write(target, "second");
  assert.equal((await journal.settle(recovery, false)).status, "restored");
  assert.equal(await readFile(target, "utf8"), "original");
});
