import { discoverProjectCapabilities } from "./project-capabilities.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { orchestrationSchema, orchestrationStateSchema } from "./orchestration-schema.js";
import { atomicWrite } from "./atomic-file.js";
import { resolveAgentSettings } from "./domain.js";
import { validateModelChoice } from "./library-proposals.js";
import type { AvailableModel } from "./library-editor-schema.js";
import { readSettingsPart, withProjectSettingsWrite } from "./settings-publication.js";

const filename = (project: string) => path.join(project, ".workflow", "orchestration.json");
async function contents(project: string) {
  try { return await readFile(filename(project), "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") { return ""; } throw error; }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export async function loadOrchestration(project: string) {
  return readSettingsPart(project, "orchestration", async () => {
    const text = await contents(project);
    return { revision: hash(text), settings: orchestrationSchema.parse(text ? JSON.parse(text) : {}), projectCapabilities: await discoverProjectCapabilities(project) };
  });
}
export async function saveOrchestration(project: string, value: unknown, models: AvailableModel[]) {
  return withProjectSettingsWrite(project, async () => {
  const input = orchestrationStateSchema.parse(value);
  const current = await loadOrchestration(project);
  if (current.revision !== input.revision) { throw new Error("Settings changed in another session. Reload settings before saving."); }
  for (const profile of input.settings.profiles) {
    // Disconnected existing profiles remain editable. New model choices must be available.
    const previous = current.settings.profiles.find((item) => item.id === profile.id);
    if (profile.enabled && (!previous?.enabled || JSON.stringify(previous.agent) !== JSON.stringify(profile.agent))) {
      validateModelChoice(resolveAgentSettings(profile.agent), models);
    }
  }
  if (Buffer.byteLength(JSON.stringify(input.settings)) > 400_000) { throw new Error("Settings are too large. Reduce skill content below 400 KB in total."); }
  await atomicWrite(filename(project), JSON.stringify(input.settings, null, 2) + "\n", 0o600, async () => {
    if (hash(await contents(project)) !== input.revision) { throw new Error("Settings changed while saving. Reload and try again."); }
  });
  return await loadOrchestration(project);
  });
}
