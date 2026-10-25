import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProtectedPaths } from "../src/protected-paths.js";
import { Workspace } from "../src/workspace.js";

test("test ownership rejects managed edits and detects unmanaged changes, additions and deletions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-ownership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src/example.test.ts"),
    "original assertions",
  );
  const guard = await ProtectedPaths.capture(root, ["**/*.test.ts"]);
  const workspace = await Workspace.create(root, { protect: guard });
  await workspace.write("src/example.ts", "production fix");
  await assert.rejects(
    workspace.edit("src/example.test.ts", "original", "weakened"),
    /belongs to another step/,
  );
  await symlink(
    path.join(root, "src/example.test.ts"),
    path.join(root, "alias"),
  );
  await assert.rejects(
    workspace.write("alias", "bypass"),
    /belongs to another step/,
  );
  await guard.assertUnchanged();
  await writeFile(path.join(root, "src/example.test.ts"), "shell bypass");
  await assert.rejects(
    guard.assertUnchanged(),
    /Protected files changed.*example.test.ts/,
  );
  await writeFile(
    path.join(root, "src/example.test.ts"),
    "original assertions",
  );
  await writeFile(path.join(root, "src/new.test.ts"), "new assertion");
  await assert.rejects(guard.assertUnchanged(), /new.test.ts/);
  await rm(path.join(root, "src/new.test.ts"));
  await rm(path.join(root, "src/example.test.ts"));
  await assert.rejects(guard.assertUnchanged(), /example.test.ts/);
});

test("ownership globs reject outside paths rather than silently protecting nothing", async () => {
  for (const pattern of ["/tmp/test.ts", "../test.ts", "!**/*.test.ts", ""]) {
    await assert.rejects(
      ProtectedPaths.capture(os.tmpdir(), [pattern]),
      /project-relative/,
    );
  }
});
