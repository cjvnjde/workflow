import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { userPaths } from "../infrastructure/user-paths.js";

/** Publish complete, private runtime files once per executable build. */
export async function unpackRuntime(archive: string, id: string) {
  const parent = path.join(userPaths().directory, "cache", "runtime");
  const directory = path.join(parent, id);
  const complete = path.join(directory, ".complete");
  try {
    await access(complete);
    return directory;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(parent, `${id}-`));
  try {
    await new Bun.Archive(Bun.file(archive)).extract(staging);
    await writeFile(path.join(staging, ".complete"), "", { mode: 0o600 });
    try {
      await rename(staging, directory);
    } catch (error) {
      // A concurrent invocation may have published this same build first.
      if (!(
        error instanceof Error &&
        "code" in error &&
        ["EEXIST", "ENOTEMPTY"].includes(String(error.code))
      ))
        throw error;
      await access(complete);
    }
    return directory;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function runStandalone(archive: string, id: string) {
  const runtime = await unpackRuntime(archive, id);
  // Child hosts and script blocks use process.execPath as a Bun interpreter.
  // The executable already contains Bun; its children must run their supplied
  // script rather than re-entering this bootstrap.
  process.env.BUN_BE_BUN = "1";
  await import(pathToFileURL(path.join(runtime, "dist/cli.js")).href);
}
