import { z } from "zod";

/** Inert display data, independent of model-facing summaries and typed results. */
export const toolPresentationSchema = z.object({
  card: z.enum(["generic", "command", "file-read", "file-diff", "search"]),
  title: z.string().max(1000).optional(), path: z.string().max(4000).optional(),
  command: z.string().max(16000).optional(), cwd: z.string().max(4000).optional(),
  exitCode: z.number().int().nullable().optional(), output: z.string().max(32000).optional(),
  before: z.string().max(32000).nullable().optional(), after: z.string().max(32000).optional(),
  matches: z.array(z.object({path:z.string(), line:z.number().int().positive().optional(), text:z.string().optional()}).strict()).max(500).optional(),
  truncated: z.boolean().optional(),
}).strict();
export type ToolPresentation = z.infer<typeof toolPresentationSchema>;
export const commandOutputRefSchema = z.object({
  id: z.string().uuid(), stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(), outputBytes: z.number().int().nonnegative(), truncated: z.boolean(),
}).strict();
export type CommandOutputRef = z.infer<typeof commandOutputRefSchema>;

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
    kind: z.enum(["tool", "ai", "exec", "read", "write", "request", "wait"]),
    state: z.enum([
      "started",
      "progress",
      "completed",
      "failed",
      "interrupted",
    ]),
    attempt: z.number().int().positive().optional(),
    visit: z.number().int().positive().optional(),
    parentAttempt: z.number().int().positive().optional(),
    sessionId: z.string().optional(),
    environmentId: z.string().optional(),
    presentation: toolPresentationSchema.optional(),
    outputRef: commandOutputRefSchema.optional(),
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
