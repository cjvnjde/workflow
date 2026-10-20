import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadLibrary } from "../src/library.js";
import { loadUserSettings, saveUserSettings, userPaths } from "../src/user-settings.js";
import { fixture } from "./helpers.js";

test("terminal model/thinking defaults apply to new projects while explicit project settings take precedence", async (t) => {
  const context = await fixture(t);
  const previous = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = path.join(context.project, "private-user-settings");
  t.after(() => {
    if (previous === undefined) { delete process.env.WORKFLOW_HOME; }
    else { process.env.WORKFLOW_HOME = previous; }
  });
  const settings = await loadUserSettings();
  settings.agent = { provider: "openai", model: "chosen-model", thinking: "high" };
  await saveUserSettings(settings);
  const inherited = await loadLibrary(context.project);
  assert.equal(inherited.config.agent.provider, "openai");
  assert.equal(inherited.config.agent.model, "chosen-model");
  assert.equal(inherited.config.agent.thinking, "high");
  assert.equal((await stat(userPaths().settings)).mode & 0o777, 0o600);
  assert.equal((await stat(userPaths().directory)).mode & 0o777, 0o700);
  const configFile = path.join(context.project, ".workflow", "config.json");
  const source: unknown = JSON.parse(await readFile(configFile, "utf8"));
  const { configSchema } = await import("../src/domain.js");
  const config = configSchema.parse(source);
  await writeFile(configFile, JSON.stringify({ ...config, agent: { provider: "anthropic", model: "project-model", thinking: "low" } }));
  const explicit = await loadLibrary(context.project);
  assert.equal(explicit.config.agent.provider, "anthropic");
  assert.equal(explicit.config.agent.model, "project-model");
  assert.equal(explicit.config.agent.thinking, "low");
});
