import { z } from "zod";
import { agentSchema } from "./domain.js";

export const setupModelSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), thinking: agentSchema.shape.thinking }).strict();
export const setupStageIdSchema = z.enum(["profiles", "cases", "blocks", "validation", "applying"]);
export const setupCountsSchema = z.object({ profiles: z.number().int().nonnegative(), cases: z.number().int().nonnegative(), blocks: z.number().int().nonnegative() }).strict();
export const completedSetupSchema = z.object({
  completedAt: z.string(), model: setupModelSchema, jobId: z.string().uuid().optional(),
  generationId: z.string().optional(), libraryProposalId: z.string().uuid(), counts: setupCountsSchema.optional(),
}).strict();
export const setupJobSchema = z.object({
  id: z.string().uuid(), usageScopeId: z.string().uuid(), revision: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(),
  status: z.enum(["queued", "running", "cancelling", "interrupted", "failed", "conflicted", "completed", "cancelled"]),
  stage: setupStageIdSchema, model: setupModelSchema, instructions: z.string().max(8000), maxSetupCostUsd: z.number().positive().optional(),
  stages: z.array(z.object({ id: setupStageIdSchema, status: z.enum(["pending", "running", "completed", "failed", "interrupted"]),
    attempt: z.number().int().nonnegative(), startedAt: z.string().optional(), completedAt: z.string().optional(), summary: z.string().optional(), error: z.string().optional(),
  }).strict()),
  activity: z.string().default(""), error: z.string().optional(),
  conflict: z.object({ message: z.string(), paths: z.array(z.string()).optional(), requiresRegeneration: z.boolean() }).strict().optional(),
  result: setupCountsSchema.extend({ completedAt: z.string(), generationId: z.string() }).strict().optional(),
  actions: z.object({ canResume: z.boolean(), canCancel: z.boolean() }).strict(),
}).strict();
export const setupJobsLatestSchema = z.object({ job: setupJobSchema.nullable() }).strict();
export const startSetupSchema = z.object({
  instructions: z.string().trim().max(8000).default(""), regenerate: z.boolean().default(false), maxSetupCostUsd: z.number().positive().optional(),
  model: setupModelSchema.extend({ thinking: setupModelSchema.shape.thinking.optional() }).optional(),
}).strict();
export const setupJobActionSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
export const resumeSetupSchema = setupJobActionSchema.extend({ maxSetupCostUsd: z.number().positive().optional() }).strict();
export type SetupJob = z.infer<typeof setupJobSchema>;
export type SetupStageId = z.infer<typeof setupStageIdSchema>;
export type CompletedSetup = z.infer<typeof completedSetupSchema>;
export type StartSetup = z.input<typeof startSetupSchema>;
