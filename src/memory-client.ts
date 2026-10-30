import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { WorkflowClient } from "./client.js";
import type { MemoryEntry, MemoryState } from "./memory-schema.js";

const entryFile = z.object({
  revision: z.string().optional(), kind: z.enum(["note", "preference"]).optional(),
  title: z.string(), description: z.string(), details: z.string(), tags: z.array(z.string()).optional(),
}).strict();

export function formatMemoryState(state: MemoryState) {
  return [
    `Project memory: ${state.enabled ? "enabled" : "disabled"} · ${state.entries.length}/${state.limit} entries`,
    "No extra AI jobs. Disabled memory retains entries but stops future planner reads and collection.",
    ...state.entries.flatMap(entry => [`${entry.id} · ${entry.kind} · ${entry.title}`, `  ${entry.description}`]),
  ].join("\n");
}

export function formatMemoryEntry(entry: MemoryEntry) {
  return [entry.title, `${entry.kind} · ${entry.id}`, entry.description, "", entry.details,
    ...(entry.edited && entry.kind === "observation" ? ["", "Text includes your annotation; recorded facts remain unchanged."] : []),
    ...(entry.observation ? ["", "RECORDED FACTS", "Associated execution outcomes are not model quality rankings.", JSON.stringify(entry.observation, null, 2)] : []),
  ].join("\n");
}

export async function runMemoryCommand(client: WorkflowClient, args: string[], options: { project: string; json: boolean }) {
  const [action = "list", ...rest] = args;
  const argumentCounts: Record<string, number> = { list: 0, on: 0, off: 0, show: 1, add: 1, update: 2, remove: 1 };
  const count = argumentCounts[action];
  if (count === undefined || rest.length !== count) throw new Error("Use workflow memory [list|on|off|show ID|add entry.json|update ID entry.json|remove ID] [--json].");
  const signal = AbortSignal.timeout(15_000);
  const state = await client.memory(signal);
  if (action === "show") {
    const entry = await client.memoryEntry(z.string().uuid().parse(rest[0]), signal);
    console.log(options.json ? JSON.stringify({ revision: state.revision, entry }) : formatMemoryEntry(entry));
    return;
  }
  if (action === "add" || action === "update") {
    const filename = path.resolve(options.project, rest[action === "add" ? 0 : 1]!);
    if ((await stat(filename)).size > 1024 * 1024) throw new Error("Memory entry files must be smaller than 1 MiB.");
    const input = entryFile.parse(JSON.parse(await readFile(filename, "utf8")));
    const revision = input.revision ?? state.revision;
    const { title, description, details, tags } = input;
    if (action === "add" && !input.kind) throw new Error('New memory requires kind: "note" or "preference".');
    if (action === "update" && input.kind) throw new Error("Updating a memory does not change its kind; omit kind from the file.");
    const result = action === "add"
      ? await client.createMemoryEntry({ revision, kind: input.kind!, title, description, details, tags }, signal)
      : await client.updateMemoryEntry(z.string().uuid().parse(rest[0]), { revision, title, description, details, tags }, signal);
    console.log(options.json ? JSON.stringify(result) : formatMemoryEntry(result.entry));
    return;
  }
  const result = action === "on" || action === "off" ? await client.setMemoryEnabled(action === "on", state.revision, signal)
    : action === "remove" ? await client.deleteMemoryEntry(z.string().uuid().parse(rest[0]), state.revision, signal) : state;
  console.log(options.json ? JSON.stringify(result) : formatMemoryState(result));
}
