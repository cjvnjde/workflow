import { z } from "zod";
import { agentOverrideSchema, identifierSchema } from "./domain.js";
import { capabilitiesSchema } from "./capability-schema.js";

export const taskCaseSchema = z.object({
  id: identifierSchema, name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(2000), instructions: z.string().trim().min(1).max(16_000),
  enabled: z.boolean().default(true),
}).strict();
export const modelProfileSchema = z.object({
  id: identifierSchema, name: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(4000),
  agent: agentOverrideSchema.pick({ provider: true, model: true, thinking: true }).required(),
  enabled: z.boolean().default(true),
}).strict();
export const defaultCases = [
  { id: "bug", name: "Bug fix", description: "Something is broken, incorrect, regressed, or produces an error.", instructions: "Establish the failing behavior and acceptance criteria. Reproduce it with a focused check when useful. Keep implementation separate from independent testing and review. Failed tests should return diagnostic artifacts to implementation, never silently weaken tests. Build the smallest appropriate graph for the actual request; there is no fixed sequence.", enabled: true },
  { id: "feature", name: "Feature", description: "Add or change user-facing behavior or a capability.", instructions: "Extract observable acceptance criteria from the request and attachments. Inspect existing conventions. Compose implementation, independent verification and review as the task warrants. Route failed verification back to implementation with focused feedback. Avoid unnecessary steps for small changes.", enabled: true },
  { id: "maintenance", name: "Maintenance", description: "Refactoring, documentation, dependency updates, cleanup, or developer tooling.", instructions: "Preserve existing behavior unless the request asks otherwise. Define appropriate validation for the change. Use a cheaper model for mechanical work and stronger reasoning for consequential migrations or review. Compose only the blocks needed.", enabled: true },
  { id: "investigation", name: "Investigation", description: "Understand, inspect, compare, diagnose, or explain something before making changes.", instructions: "Prefer read-only inspection. Produce evidence-backed findings and useful next actions. Do not implement changes unless the request calls for them. Ask a question only when a missing answer prevents meaningful progress.", enabled: true },
];
export const orchestrationSchema = z.object({
  version: z.literal(1).default(1),
  instructions: z.string().max(16_000).default(""),
  approval: z.enum(["review", "automatic"]).default("review"),
  suggestBlocks: z.boolean().default(true),
  coordinatorProfile: z.string().default(""),
  profiles: z.array(modelProfileSchema).max(30).default([]),
  cases: z.array(taskCaseSchema).max(40).default(() => structuredClone(defaultCases)),
  capabilities: capabilitiesSchema.default(() => ({ skills: [], mcpServers: [] })),
}).strict().superRefine((settings, ctx) => {
  for (const key of ["profiles", "cases"] as const) {
    if (new Set(settings[key].map((item) => item.id)).size !== settings[key].length) { ctx.addIssue({ code: "custom", path: [key], message: "IDs must be unique" }); }
  }
  for (const key of ["skills", "mcpServers"] as const) {
    if (new Set(settings.capabilities[key].map((item) => item.id)).size !== settings.capabilities[key].length) { ctx.addIssue({ code: "custom", path: ["capabilities", key], message: "IDs must be unique" }); }
  }
  if (settings.coordinatorProfile && !settings.profiles.some((profile) => profile.id === settings.coordinatorProfile && profile.enabled)) {
    ctx.addIssue({ code: "custom", path: ["coordinatorProfile"], message: "Choose an enabled coordinator profile" });
  }
});
export const orchestrationStateSchema = z.object({ revision: z.string(), settings: orchestrationSchema });
export type OrchestrationSettings = z.infer<typeof orchestrationSchema>;
export type OrchestrationState = z.infer<typeof orchestrationStateSchema>;
