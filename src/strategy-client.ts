import { z } from "zod";
import type { WorkflowClient } from "./client.js";
import type { StrategyPreview } from "./memory-schema.js";

const changesSchema = z.object({
  title: z.string().optional(), description: z.string().optional(), details: z.string().optional(), tags: z.array(z.string()).optional(),
}).strict();

export function formatStrategyPreview(preview: StrategyPreview) {
  return [
    "REMEMBER THIS APPROACH", preview.entry.title, preview.entry.description, "", preview.entry.details,
    "", "SOURCE METADATA", "Historical model choices are hints. Future planning composes a fresh workflow using current models and instructions.",
    JSON.stringify(preview.metadata, null, 2), "",
    preview.memoryEnabled ? "Project memory is enabled." : "Project memory is disabled. Saving this approach will leave it disabled.",
    ...(preview.existingEntry ? [`Already remembered as ${preview.existingEntry.id}. Edit the saved note in Memory settings.`] : []),
  ].join("\n");
}

export async function runRememberCommand(client: WorkflowClient, args: string[], options: { input: string; save?: boolean; json: boolean }) {
  if (args.length !== 1) throw new Error("Use workflow remember <run-id> [--save] [--input JSON] [--json].");
  const id = z.string().uuid().parse(args[0]);
  const changes = changesSchema.parse(JSON.parse(options.input));
  const signal = AbortSignal.timeout(15_000);
  const preview = await client.strategyPreview(id, signal);
  preview.entry = { ...preview.entry, ...changes };
  if (!options.save) {
    console.log(options.json ? JSON.stringify(preview) : `${formatStrategyPreview(preview)}\n\nPreview only. Repeat this command with --save to keep the approach, preserving any --input edits. Use --input JSON to supply edited title, description, details or tags.`);
    return;
  }
  const result = await client.rememberStrategy(id, {
    sourceRunRevision: preview.sourceRunRevision, memoryRevision: preview.memoryRevision, ...preview.entry,
  }, signal);
  console.log(options.json ? JSON.stringify(result) : `${result.reused ? "Already remembered" : "Remembered"}: ${result.entry.title}\nEntry: ${result.entry.id}\n${result.state.enabled ? "Available to future planning through project memory." : "Project memory remains disabled. Enable it in Settings or with workflow memory on when wanted."}`);
}
