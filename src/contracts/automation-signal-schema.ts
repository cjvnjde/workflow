import { z } from "zod";

/** JSON retained in durable history, bounded independently of its display preview. */
export const boundedJSONSchema = z.json().superRefine((value, ctx) => {
  const text = JSON.stringify(value);
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > 256_000) {
      ctx.addIssue({
        code: "custom",
        message: "Durable JSON exceeds 256 KB; return focused data or references",
      });
      break;
    }
  }
});
const key = z.string().trim().min(1).max(300);
const record = z.record(z.string().max(200), boundedJSONSchema);
/** Provider-neutral identity; payload changes do not imply a new observation. */
export const workSignalSchema = z
  .object({
    id: key.optional(),
    sourceId: key,
    resourceKey: key,
    signalKind: key,
    revision: key,
    fingerprint: key,
    observedAt: z.string().datetime({ offset: true }),
    correlationKey: key.optional(),
    payload: record.default({}),
    references: z.record(z.string().max(100), z.string().max(2000)).default({}),
    metadata: record.default({}),
  })
  .strict();
export type WorkSignal = z.infer<typeof workSignalSchema>;
export const discoveryResultSchema = z
  .object({
    signals: z.array(workSignalSchema).max(500),
    checkpoint: boundedJSONSchema.optional(),
  })
  .strict();
export type DiscoveryResult = z.infer<typeof discoveryResultSchema>;

/** Scheduler input contains identifiers and persisted evidence, never model conversations. */
export const automationContextSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    phase: z.enum(["direct", "discovery", "reaction", "output", "reconcile"]),
    checkpoint: boundedJSONSchema.optional(),
    publicationKey: z.string().max(300).optional(),
  })
  .strict();
export const automationCaseContextSchema = z
  .object({
    id: z.string(),
    sourceId: key,
    correlationKey: key,
    currentRevision: key,
    references: z.record(z.string(), z.string()),
    lastJobId: z.string().uuid().optional(),
    lastRunId: z.string().uuid().optional(),
  })
  .passthrough();
export type AutomationContext = z.infer<typeof automationContextSchema>;
export type AutomationCaseContext = z.infer<typeof automationCaseContextSchema>;
