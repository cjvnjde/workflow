/** Public, browser-safe data contract. No engine, filesystem, HTTP server, or UI imports. */
export * from "./domain.js";
export * from "./auth-schema.js";
export * from "./capability-schema.js";
export * from "./design-schema.js";
export * from "./library-editor-schema.js";
export * from "./orchestration-schema.js";
export * from "./program-schema.js";
export * from "./setup-schema.js";
export * from "./task-schema.js";
export * from "./operation-schema.js";
export * from "./execution-history.js";
export * from "./trigger-schema.js";
export * from "./usage-schema.js";
export * from "./setup-job-schema.js";
export * from "./evidence-schema.js";
export * from "./memory-schema.js";
export type { FlowStructure } from "./composition-sdk.js";

import { z } from "zod";
import { bundleSchema, configSchema, identifierSchema, runSchema } from "./domain.js";
import { programSourceSchema } from "./program-schema.js";

export const projectSchema = z.object({
  project: z.string(), mode: z.enum(["demo", "live"]),
  config: configSchema, blocks: z.record(identifierSchema, bundleSchema),
});
export const runListSchema = z.array(runSchema.pick({
  id: true, status: true, mode: true, createdAt: true, updatedAt: true,
  revision: true, deletedAt: true, cursor: true,
}).extend({ title: z.string(), task: z.string() }));
export const createProgramSchema = programSourceSchema.extend({
  title: z.string().trim().min(1).max(200), task: z.string().trim().min(1).max(32_000),
});
export type CreateProgram = z.input<typeof createProgramSchema>;
export type RunAction = "approve" | "reject" | "pause" | "resume" | "cancel" | "recover" | "keep-recovery-files";

/** A bounded byte-range page from a saved command transcript. */
export const commandOutputPageSchema = z.object({
  id: z.string().uuid(), stream: z.enum(["stdout", "stderr", "output"]), text: z.string(),
  offset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(), hasMore: z.boolean(), truncated: z.boolean(),
});
export type CommandOutputPage = z.infer<typeof commandOutputPageSchema>;
