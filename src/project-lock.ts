import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";

export async function acquireProjectLock(project: string, onCompromised: (error: Error) => void) {
  const directory = path.join(project, ".workflow");
  const filename = path.join(directory, "lock");
  const token = randomUUID();
  let release: () => Promise<void>;
  try {
    // proper-lockfile keys its in-process registry by target, not lockfilePath.
    // Library mutations lock config.json; the server must have its own target.
    release = await lockfile.lock(directory, {
      lockfilePath: path.join(directory, "server-lease"),
      stale: 5000,
      update: 1000,
      retries: { retries: 30, minTimeout: 200, maxTimeout: 200, randomize: false },
      onCompromised,
    });
  } catch (error) {
    throw new Error("Another server owns this project, or its lease could not be acquired. Stop the existing server before restarting.", { cause: error });
  }
  try {
    try {
      const owner = z.object({ pid: z.number().int().positive() }).passthrough().parse(JSON.parse(await readFile(filename, "utf8")));
      try {
        process.kill(owner.pid, 0);
        throw new Error(`Another server owns this project (PID ${owner.pid})`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          throw error;
        }
      }
      await unlink(filename);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await writeFile(filename, JSON.stringify({ pid: process.pid, project, token }) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    await release();
    throw error;
  }

  return async () => {
    try {
      const owner = z.object({ token: z.string().optional() }).passthrough().parse(JSON.parse(await readFile(filename, "utf8")));
      if (owner.token === token) { await unlink(filename); }
    } finally { await release(); }
  };
}
