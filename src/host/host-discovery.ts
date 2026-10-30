import { readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "../infrastructure/atomic-file.js";

export const hostInfoSchema = z.object({
  hostId: z.string().uuid(),
  project: z.string(),
  url: z.string(),
  pid: z.number().int().positive(),
  mode: z.enum(["live", "demo"]),
  background: z.boolean(),
  web: z.boolean(),
  startedAt: z.string(),
  state: z.enum(["ready", "stopping"]),
});
export type HostInfo = z.infer<typeof hostInfoSchema>;
const endpointSchema = z.object({
  project: z.string(),
  url: z.string(),
  token: z.string().uuid(),
  pid: z.number().int().positive(),
  hostId: z.string().uuid().optional(),
});
export type HostReceipt = z.infer<typeof endpointSchema>;
const filename = (project: string) => path.join(project, ".workflow", "server.json");

/** Discovery is a local hint. Clients must still verify the server's project. */
export async function readProjectServer(project: string): Promise<HostReceipt | undefined> {
  try {
    const endpoint = endpointSchema.parse(JSON.parse(await readFile(filename(project), "utf8")));
    const url = new URL(endpoint.url);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return;
    if ((await realpath(endpoint.project)) !== (await realpath(project))) return;
    return { ...endpoint, url: url.origin };
  } catch {
    return;
  }
}

export async function discoverProjectServer(project: string): Promise<string | undefined> {
  return (await readProjectServer(project))?.url;
}

/** Only the owning host removes its announcement; stale files are harmless. */
export async function announceProjectServer(
  project: string,
  url: string,
  control?: { hostId: string; token: string },
) {
  const token = control?.token ?? crypto.randomUUID();
  await atomicWrite(
    filename(project),
    JSON.stringify({ project, url, token, pid: process.pid, hostId: control?.hostId }) + "\n",
    0o600,
  );
  return async () => {
    try {
      const current = endpointSchema.parse(JSON.parse(await readFile(filename(project), "utf8")));
      if (current.token === token) await unlink(filename(project));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  };
}
