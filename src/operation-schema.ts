import { z } from "zod";

export const toolReferenceSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    version: z.number().int().positive(),
    replay: z.enum(["safe", "unsafe"]),
  })
  .strict();
export const operationRecordSchema = z
  .object({
    id: z.string(),
    parentId: z.string().optional(),
    name: z.string(),
    kind: z.enum(["tool", "ai", "exec", "read", "write"]),
    state: z.enum([
      "started",
      "progress",
      "completed",
      "failed",
      "interrupted",
    ]),
    attempt: z.number().int().positive().optional(),
    version: z.number().int().positive().optional(),
    replay: z.enum(["safe", "unsafe"]).optional(),
    input: z.json().optional(),
    output: z.json().optional(),
    details: z.json().optional(),
    summary: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type OperationRecord = z.infer<typeof operationRecordSchema>;
export type OperationRecorder = (record: OperationRecord) => Promise<void>;

export function boundedEvidence(value: unknown): {
  value?: z.infer<ReturnType<typeof z.json>>;
  truncated?: boolean;
} {
  if (value === undefined) return {};
  const text = JSON.stringify(value);
  if (text === undefined) return {};
  if (text.length > 16_000)
    return { value: text.slice(0, 16_000) + "…", truncated: true };
  return { value: JSON.parse(text) };
}
