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
  agent: agentOverrideSchema.required({ provider: true, model: true, thinking: true }),
  enabled: z.boolean().default(true),
}).strict();
export const defaultCases = [
  { id: "bug", name: "Bug fix", description: "Something is broken, incorrect, regressed, or produces an error.", instructions: "Establish the reported failing behavior and acceptance criteria. Passing neighboring happy paths does not prove the reported defect is fixed: verify relevant failure boundaries and distinguish unconfirmed scope from confirmed working behavior. Establish a valid failing regression before production repair; invalid test code belongs to the test author, valid failing assertions to production repair, and infrastructure failures block acceptance. Preserve valid regressions during production repair and keep test correction explicit. Follow completed test authoring with a separate acceptance gate and independent review; never weaken tests silently. Build the smallest appropriate graph for the actual request; there is no fixed sequence.", enabled: true },
  { id: "feature", name: "Feature", description: "Add or change user-facing behavior or a capability.", instructions: "Extract observable acceptance criteria from the request and attachments. Inspect existing conventions. Compose implementation, independent verification and review as the task warrants. Route production defects to implementation and invalid test code to test authoring, with focused feedback. Avoid unnecessary steps for small changes.", enabled: true },
  { id: "maintenance", name: "Maintenance", description: "Refactoring, documentation, dependency updates, cleanup, or developer tooling.", instructions: "Preserve existing behavior unless the request asks otherwise. Define appropriate validation for the change. Use a cheaper model for mechanical work and stronger reasoning for consequential migrations or review. Compose only the blocks needed.", enabled: true },
  { id: "investigation", name: "Investigation", description: "Understand, inspect, compare, diagnose, or explain something before making changes.", instructions: "Prefer read-only inspection. Produce evidence-backed findings and useful next actions. Do not implement changes unless the request calls for them. Ask a question only when a missing answer prevents meaningful progress. If unavailable evidence prevents fulfilling the requested scope, preserve useful partial findings but return fail and clearly state what remains blocked. Do not declare a requested comparison complete from local-only checks. Partial results count as success only when the user explicitly permits that reduced scope.", enabled: true },
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
export const projectCapabilitiesSchema = z.object({ capabilities: capabilitiesSchema, sources: z.array(z.object({ kind: z.enum(["skill", "mcp"]), id: z.string(), path: z.string() })), warnings: z.array(z.string()) });
export const orchestrationStateSchema = z.object({ revision: z.string(), settings: orchestrationSchema, projectCapabilities: projectCapabilitiesSchema.optional() });
export type OrchestrationSettings = z.infer<typeof orchestrationSchema>;
export type OrchestrationState = z.infer<typeof orchestrationStateSchema>;
