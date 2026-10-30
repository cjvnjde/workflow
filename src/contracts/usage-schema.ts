import { z } from "zod";
import { priceSchema, usageSchema } from "./domain.js";

export const usagePhaseSchema = z.enum([
  "planning",
  "execution",
  "setup",
  "design",
  "refinement",
  "library",
]);
export const usageOwnerKindSchema = z.enum(["task", "run", "setup", "design", "operation"]);
export const usageScopeSchema = z
  .object({
    id: z.string().uuid(),
    owner: z.object({ kind: usageOwnerKindSchema, id: z.string().uuid() }).strict(),
    createdAt: z.string(),
    maxCostUsd: z.number().positive().optional(),
    taskIds: z.array(z.string().uuid()).default([]),
    runIds: z.array(z.string().uuid()).default([]),
    runTasks: z.record(z.string().uuid(), z.string().uuid()).default({}),
  })
  .strict();
export const usageSessionSchema = z
  .object({
    id: z.string().uuid(),
    scopeId: z.string().uuid(),
    phase: usagePhaseSchema,
    operationId: z.string().min(1).max(500),
    taskId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(),
    setupId: z.string().uuid().optional(),
    designId: z.string().uuid().optional(),
    nodeId: z.string().optional(),
    visit: z.number().int().positive().optional(),
    activityAttempt: z.number().int().positive().optional(),
    setupStage: z.enum(["profiles", "cases", "blocks"]).optional(),
    provider: z.string(),
    model: z.string(),
    thinking: z.string(),
    pricing: z
      .object({ source: z.enum(["override", "catalog", "unknown"]), rates: priceSchema.nullable() })
      .strict(),
    usage: usageSchema,
    status: z.enum(["running", "completed", "failed", "cancelled", "interrupted"]),
    startedAt: z.string(),
    updatedAt: z.string(),
    endedAt: z.string().optional(),
    error: z.string().max(2000).optional(),
    // Used only to distinguish a genuinely live session from an abandoned record.
    pid: z.number().int().positive().optional(),
  })
  .strict();
export const usageReportSchema = z
  .object({
    scope: z
      .object({
        kind: z.enum(["project", ...usageOwnerKindSchema.options]),
        id: z.string().uuid().optional(),
      })
      .strict(),
    total: usageSchema,
    phases: z.array(
      z
        .object({
          phase: usagePhaseSchema,
          usage: usageSchema,
          sessionCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    models: z.array(
      z
        .object({
          provider: z.string(),
          model: z.string(),
          usage: usageSchema,
          sessionCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    sessions: z.array(usageSessionSchema),
    sessionCount: z.number().int().nonnegative(),
    sessionsTruncated: z.boolean(),
    // Included in total and execution already; this is attribution, not extra cost.
    legacyExecution: usageSchema,
    limits: z
      .object({
        totalCostUsd: z.number().positive().optional(),
        executionCostUsd: z.number().positive().optional(),
        remainingCostUsd: z.number().nonnegative().nullable(),
      })
      .strict(),
    incomplete: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();

export type UsagePhase = z.infer<typeof usagePhaseSchema>;
export type UsageScope = z.infer<typeof usageScopeSchema>;
export type UsageSession = z.infer<typeof usageSessionSchema>;
export type UsageReport = z.infer<typeof usageReportSchema>;

/** `project` is the original project, independent of an agent's worktree cwd. */
export type AccountingContext = Pick<
  UsageSession,
  | "scopeId"
  | "phase"
  | "operationId"
  | "taskId"
  | "runId"
  | "setupId"
  | "designId"
  | "nodeId"
  | "visit"
  | "activityAttempt"
  | "setupStage"
> & { project: string };
