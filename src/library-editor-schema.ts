import { z } from "zod";
import { agentOverrideSchema, bundleSchema, identifierSchema, priceSchema } from "./domain.js";

export const availableModelSchema = z.object({
  provider: z.string(), id: z.string(), name: z.string(), reasoning: z.boolean(),
  imageInput: z.boolean().optional(),
  thinkingLevels: z.array(z.string()), contextWindow: z.number(), maxTokens: z.number(),
  cost: priceSchema.nullable(),
}).strict();
export const modelCatalogSchema = z.object({ models: z.array(availableModelSchema), warnings: z.array(z.string()) }).strict();
export type AvailableModel = z.infer<typeof availableModelSchema>;
export const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

export const libraryChangesSchema = z.object({
  summary: z.string().min(1).max(8000),
  blocks: z.array(z.object({ bundle: bundleSchema, rationale: z.string().min(1).max(4000) }).strict()).max(50),
  remove: z.array(identifierSchema).max(50).optional(),
}).strict().refine((changes) => changes.blocks.length > 0 || !!changes.remove?.length, "Propose at least one block change");
export type LibraryChanges = z.infer<typeof libraryChangesSchema>;
export const libraryProposalSchema = z.object({
  id: z.string().uuid(), createdAt: z.string(), status: z.enum(["draft", "applied", "rejected"]),
  kind: z.enum(["regenerate", "models", "manual"]), baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  allowedModels: z.array(z.string()), changes: libraryChangesSchema,
  appliedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type LibraryProposal = z.infer<typeof libraryProposalSchema>;
export const approvedLibrarySchema = z.object({
  version: z.literal(1), blocks: z.record(identifierSchema, bundleSchema),
  // The inline source is an atomic publication/recovery snapshot. Once listed
  // here, the editable block.ts file is authoritative for subsequent loads.
  sourceFiles: z.array(identifierSchema).optional(),
  sourceBaselines: z.record(identifierSchema, z.string().regex(/^[a-f0-9]{64}$/).nullable()).optional(),
}).strict();
export const modelAssignmentsSchema = z.object({
  summary: z.string().min(1).max(8000),
  assignments: z.array(z.object({
    block: identifierSchema,
    agent: agentOverrideSchema.pick({ provider: true, model: true, thinking: true }).required(),
    rationale: z.string().min(1).max(4000),
  }).strict()).min(1).max(50),
}).strict();
