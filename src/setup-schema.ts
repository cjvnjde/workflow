import { z } from "zod";
import { agentOverrideSchema, configSchema } from "./domain.js";

export const executionSettingsSchema = configSchema.pick({ instructions: true, commands: true, maxSteps: true, budget: true }).extend({ configRevision: z.string() });

export const providerStatusSchema = z.array(z.object({
  id: z.string(), name: z.string(),
  method: z.enum(["oauth", "api_key"]),
  source: z.enum(["stored", "environment", "config", "runtime"]),
}));
export const setupSchema = z.object({
  providers: providerStatusSchema,
  userAgent: agentOverrideSchema,
  projectAgent: agentOverrideSchema,
  configRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const projectModelUpdateSchema = z.object({
  configRevision: setupSchema.shape.configRevision,
  // null removes model overrides, retaining the project's execution limits.
  agent: agentOverrideSchema.pick({ provider: true, model: true, thinking: true }).required().nullable(),
}).strict();

export type Setup = z.infer<typeof setupSchema>;
