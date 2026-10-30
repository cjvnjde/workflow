import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { WorkflowVersions } from "../src/infrastructure/workflow-versions.js";
import { fixture } from "./helpers.js";

test("version archives retain earlier bundles and verify content integrity", async (t) => {
  const { project } = await fixture(t);
  const versions = new WorkflowVersions(path.join(project, ".workflow/versions"));
  const bundle = path.join(project, "bundle.js");
  await writeFile(bundle, "version one");
  const first = await versions.install(bundle);
  await writeFile(bundle, "version two");
  const second = await versions.install(bundle);
  assert.notEqual(first.id, second.id);
  assert.equal(await readFile((await versions.load(first.id)).codePath, "utf8"), "version one");
  await writeFile((await versions.load(first.id)).codePath, "corrupt");
  await assert.rejects(versions.load(first.id), /corrupt/);
  await assert.rejects(versions.load("../escape"));
});

test("incompatible Temporal SDK versions fail safely rather than replaying with another runtime", async (t) => {
  const { project } = await fixture(t);
  const versions = new WorkflowVersions(path.join(project, ".workflow/versions"));
  const bundle = path.join(project, "bundle.js");
  await writeFile(bundle, "bundle");
  const manifest = await versions.install(bundle);
  await writeFile(
    path.join(project, ".workflow/versions", manifest.id, "manifest.json"),
    JSON.stringify({ ...manifest, sdkVersion: "another-sdk" }),
  );
  await assert.rejects(versions.load(manifest.id), /requires Temporal SDK/);
});
