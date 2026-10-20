import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "./atomic-file.js";
import { agentOverrideSchema, configSchema, resolveAgentSettings } from "./domain.js";
import { validateModelChoice } from "./library-proposals.js";
import type { AvailableModel } from "./library-editor-schema.js";
import { executionSettingsSchema, projectModelUpdateSchema } from "./setup-schema.js";
import { loadUserSettings } from "./user-settings.js";

const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
const filename = (project: string) => path.join(project, ".workflow", "config.json");
const projectConfigSchema = configSchema.extend({ agent: agentOverrideSchema.optional() });

export async function projectModelSettings(project: string) {
  const text = await readFile(filename(project), "utf8");
  const config = projectConfigSchema.parse(JSON.parse(text));
  return {
    configRevision: fingerprint(text),
    projectAgent: config.agent ?? {},
    userAgent: (await loadUserSettings()).agent,
  };
}

export async function updateProjectModel(project: string, value: unknown, models: AvailableModel[]) {
  const input = projectModelUpdateSchema.parse(value);
  const text = await readFile(filename(project), "utf8");
  const checkRevision = (current: string) => {
    if (fingerprint(current) !== input.configRevision) {
      throw new Error("Project settings changed. Refresh setup before saving again.");
    }
  };
  checkRevision(text);
  const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
  const config = projectConfigSchema.parse(raw);
  const agent = { ...config.agent };
  delete agent.provider;
  delete agent.model;
  delete agent.thinking;
  if (input.agent) {
    validateModelChoice(resolveAgentSettings(agent, input.agent), models);
    Object.assign(agent, input.agent);
  }
  await atomicWrite(filename(project), JSON.stringify({ ...raw, agent }, null, 2) + "\n", 0o600, async () => {
    checkRevision(await readFile(filename(project), "utf8"));
  });
  return await projectModelSettings(project);
}

export async function executionSettings(project: string) {
  const text = await readFile(filename(project), "utf8");
  const { instructions, commands, maxSteps, budget } = configSchema.parse(projectConfigSchema.parse(JSON.parse(text)));
  return executionSettingsSchema.parse({ instructions, commands, maxSteps, budget, configRevision: fingerprint(text) });
}
export async function updateExecutionSettings(project: string, value: unknown) {
  const { configRevision, ...settings } = executionSettingsSchema.strict().parse(value);
  const text = await readFile(filename(project), "utf8");
  if (fingerprint(text) !== configRevision) { throw new Error("Project settings changed. Reload before saving."); }
  const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
  projectConfigSchema.parse({ ...raw, ...settings });
  const { loadLibrary, validateLibraryResources } = await import("./library.js");
  validateLibraryResources((await loadLibrary(project)).blocks, settings.commands);
  await atomicWrite(filename(project), JSON.stringify({ ...raw, ...settings }, null, 2) + "\n", 0o600, async () => {
    if (fingerprint(await readFile(filename(project), "utf8")) !== configRevision) { throw new Error("Project settings changed while saving."); }
  });
  return await executionSettings(project);
}
