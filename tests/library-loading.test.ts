import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadLibrary } from "../src/core/library/library.js";
import { fixture } from "./helpers.js";

test("directory libraries receive the same resource validation as published libraries", async (t) => {
  const { project } = await fixture(t);
  const filename = path.join(project, ".workflow", "blocks", "review", "block.json");
  const block = JSON.parse(await readFile(filename, "utf8"));
  await writeFile(filename, JSON.stringify({ ...block, skills: ["prompt.md"] }));
  await assert.rejects(loadLibrary(project), /Invalid or duplicate block resource/);
});

test("directory libraries reject nonregular resources without waiting for file input", async (t) => {
  const { project } = await fixture(t);
  const filename = path.join(project, ".workflow", "blocks", "review", "block.json");
  const block = JSON.parse(await readFile(filename, "utf8"));
  await writeFile(filename, JSON.stringify({ ...block, skills: ["."] }));
  await assert.rejects(loadLibrary(project), /regular file/);
});
