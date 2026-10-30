import { userPaths } from "../../infrastructure/user-paths.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { agentOverrideSchema } from "../../contracts/domain.js";

const settingsSchema = z
  .object({
    version: z.literal(1).default(1),
    deviceId: z
      .string()
      .uuid()
      .default(() => randomUUID()),
    agent: agentOverrideSchema.default({}),
  })
  .strict();
export type UserSettings = z.infer<typeof settingsSchema>;

export async function loadUserSettings() {
  try {
    return settingsSchema.parse(JSON.parse(await readFile(userPaths().settings, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }

    return settingsSchema.parse({});
  }
}

export async function saveUserSettings(value: UserSettings) {
  const settings = settingsSchema.parse(value);
  const paths = userPaths();
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const temporary = `${paths.settings}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, paths.settings);
}
