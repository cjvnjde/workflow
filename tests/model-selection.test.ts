import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { chooseModel } from "../src/cli/terminal-commands.js";
import type { WorkflowTerminal } from "../src/terminal/terminal-ui.js";
import { loadUserSettings, saveUserSettings } from "../src/core/settings/user-settings.js";

test("choosing a global model saves compatible thinking and preserves supported preferences", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-model-choice-"));
  const previous = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = directory;
  t.onTestFinished(async () => {
    if (previous === undefined) delete process.env.WORKFLOW_HOME;
    else process.env.WORKFLOW_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  });
  let model: Model<Api> = {
    id: "text",
    provider: "test",
    name: "Text",
    api: "openai-completions",
    baseUrl: "https://unused.test",
    reasoning: false,
    input: ["text"],
    contextWindow: 32000,
    maxTokens: 4000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const runtime = {
    getAvailable: async () => [model],
    getModel: () => undefined,
  } as unknown as ModelRuntime;
  const ui = {
    signal: new AbortController().signal,
    show: async () => model,
  } as unknown as WorkflowTerminal;
  await chooseModel(ui, runtime);
  assert.equal(
    (await loadUserSettings()).agent.thinking,
    "off",
    "Non-reasoning models must not inherit the implicit medium setting",
  );

  const settings = await loadUserSettings();
  settings.agent.thinking = "max";
  settings.agent.maxToolCalls = 21;
  await saveUserSettings(settings);
  model = { ...model, id: "reasoning", reasoning: true };
  await chooseModel(ui, runtime);
  const normalized = await loadUserSettings();
  assert.equal(
    normalized.agent.thinking,
    "medium",
    "A new model without max support gets a valid default",
  );
  assert.equal(normalized.agent.maxToolCalls, 21);
  normalized.agent.thinking = "low";
  await saveUserSettings(normalized);
  await chooseModel(ui, runtime);
  assert.equal(
    (await loadUserSettings()).agent.thinking,
    "low",
    "Supported explicit thinking preferences survive model changes",
  );
});
