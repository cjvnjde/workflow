import { z } from "zod";
import { usageSchema } from "./domain.js";

export const MEMORY_ENTRY_LIMIT = 100;
export const MEMORY_PAGE_LIMIT = 32;
export const MEMORY_PAGE_BYTES = 16 * 1024;
export const MEMORY_STATE_BYTES = 1024 * 1024;
const count = z.number().int().nonnegative();
const textFields = {
  title: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(300),
  details: z.string().max(4000), tags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
};
export const memoryTextSchema = z.object(textFields).strict();
export const memoryDescriptionSchema = z.object({
  id: z.string().uuid(), kind: z.enum(["note", "preference", "observation", "strategy"]),
  title: textFields.title, description: textFields.description, tags: textFields.tags,
  createdAt: z.string(), updatedAt: z.string(),
}).strict();
export const memorySourceSchema = z.object({
  runId: z.string().uuid(), nodeId: z.string(), visit: z.number().int().positive(), taskId: z.string().uuid().optional(), at: z.string(),
}).strict();
export const memoryObservationSchema = z.object({
  taskCaseId: z.string().max(128), taskCaseName: z.string().max(200), blockId: z.string().max(128),
  model: z.object({ provider: z.string(), model: z.string(), thinking: z.string() }).strict().nullable(),
  runs: count, runStatuses: z.object({ completed: count, failed: count, cancelled: count }).strict(),
  visits: count, outcomes: z.object({ pass: count, retry: count, fail: count, interrupted: count }).strict(),
  sessions: count, sessionStatuses: z.object({ running: count, completed: count, failed: count, cancelled: count, interrupted: count }).strict(),
  checks: z.object({ total: count, matched: count, unmatched: count }).strict(),
  dispositions: z.object({ workCompleted: count, accepted: count, changesRequested: count, blocked: count }).strict(),
  usage: usageSchema, usageIncomplete: z.boolean(), sources: z.array(memorySourceSchema).max(5), firstObservedAt: z.string(), lastObservedAt: z.string(),
}).strict();
export const strategyModelHintSchema = z.object({
  provider: z.string().min(1).max(256), model: z.string().min(1).max(256), thinking: z.string().max(40),
  source: z.enum(["observed", "configured"]),
}).strict();
export const strategyRoleSchema = z.object({
  nodeId: z.string().max(128), label: z.string().max(100), blockId: z.string().max(128).nullable(),
  executionKind: z.enum(["code", "agent", "script", "command", "function"]), visits: count,
  modelHints: z.array(strategyModelHintSchema).max(4), omittedModelHints: count,
}).strict();
export const strategyMetadataSchema = z.object({
  version: z.literal(1), sourceRunId: z.string().uuid(), sourceRunRevision: count, sourceTaskId: z.string().uuid().optional(),
  taskType: z.object({ id: z.string().max(128), name: z.string().max(200) }).strict(),
  mode: z.enum(["live", "demo"]), completedAt: z.string(), roles: z.array(strategyRoleSchema).max(12), omittedRoles: count,
  models: z.array(strategyModelHintSchema).max(12), omittedModels: count,
  outcomes: z.object({ pass: count, retry: count, fail: count, interrupted: count }).strict(),
  dispositions: z.object({ workCompleted: count, accepted: count, changesRequested: count, blocked: count }).strict(),
  checks: z.object({ total: count, matched: count, unmatched: count }).strict(),
  usage: usageSchema, usageIncomplete: z.boolean(),
}).strict();
export const memoryEntrySchema = memoryDescriptionSchema.extend({
  details: textFields.details, edited: z.boolean(), observation: memoryObservationSchema.optional(), strategy: strategyMetadataSchema.optional(),
}).strict().refine(entry => (entry.kind === "observation") === !!entry.observation && (entry.kind === "strategy") === !!entry.strategy, "Memory provenance must match its entry kind");
export const memoryStateSchema = z.object({
  enabled: z.boolean(), revision: z.string(), entries: z.array(memoryDescriptionSchema).max(MEMORY_ENTRY_LIMIT), limit: z.literal(MEMORY_ENTRY_LIMIT),
}).strict();
export const memoryCatalogSchema = z.object({
  enabled: z.boolean(), revision: z.string(), total: count, nextOffset: count.nullable(), entries: z.array(memoryDescriptionSchema).max(MEMORY_PAGE_LIMIT),
}).strict();
export const memoryMutationSchema = z.object({ state: memoryStateSchema, entry: memoryEntrySchema }).strict();
export const strategyPreviewSchema = z.object({
  sourceRunId: z.string().uuid(), sourceRunRevision: count, memoryRevision: z.string(), memoryEnabled: z.boolean(),
  entry: memoryTextSchema, metadata: strategyMetadataSchema, existingEntry: memoryEntrySchema.nullable(),
}).strict();
export const rememberStrategySchema = z.object({ sourceRunRevision: count, memoryRevision: z.string(), ...textFields }).strict();
export const rememberStrategyResultSchema = memoryMutationSchema.extend({ reused: z.boolean() });
export const memorySettingsUpdateSchema = z.object({ revision: z.string(), enabled: z.boolean() }).strict();
export const createMemoryEntrySchema = z.object({ revision: z.string(), kind: z.enum(["note", "preference"]), ...textFields }).strict();
export const updateMemoryEntrySchema = z.object({ revision: z.string(), ...textFields }).strict();
export const deleteMemoryEntrySchema = z.object({ revision: z.string() }).strict();
export const memoryQuerySchema = z.object({
  query: z.string().max(200).optional(), offset: count.default(0), limit: z.number().int().min(1).max(MEMORY_PAGE_LIMIT).default(MEMORY_PAGE_LIMIT),
}).strict();
export type MemoryDescription = z.infer<typeof memoryDescriptionSchema>;
export type MemoryObservation = z.infer<typeof memoryObservationSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryState = z.infer<typeof memoryStateSchema>;
export type MemoryCatalog = z.infer<typeof memoryCatalogSchema>;
export type MemoryMutation = z.infer<typeof memoryMutationSchema>;
export type CreateMemoryEntry = z.input<typeof createMemoryEntrySchema>;
export type UpdateMemoryEntry = z.input<typeof updateMemoryEntrySchema>;
export type MemoryQuery = z.input<typeof memoryQuerySchema>;
export type StrategyModelHint = z.infer<typeof strategyModelHintSchema>;
export type StrategyRole = z.infer<typeof strategyRoleSchema>;
export type StrategyMetadata = z.infer<typeof strategyMetadataSchema>;
export type StrategyPreview = z.infer<typeof strategyPreviewSchema>;
export type RememberStrategy = z.input<typeof rememberStrategySchema>;
export type RememberStrategyResult = z.infer<typeof rememberStrategyResultSchema>;
