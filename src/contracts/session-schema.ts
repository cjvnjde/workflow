import { z } from "zod";

export const sessionHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().max(256).optional(),
    search: z.string().trim().max(200).default(""),
  })
  .strict();
export type SessionHistoryQuery = z.input<typeof sessionHistoryQuerySchema>;
export const sessionSummarySchema = z.object({
  id: z.string(),
  runId: z.string().uuid().optional(),
  title: z.string(),
  status: z.string(),
  createdAt: z.string(),
  revision: z.number().int().nonnegative(),
  runRevision: z.number().int().nonnegative(),
  deletedAt: z.string().optional(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export const sessionHistoryPageSchema = z.object({
  items: z.array(sessionSummarySchema),
  nextCursor: z.string().nullable(),
});
export type SessionHistoryPage = z.infer<typeof sessionHistoryPageSchema>;
