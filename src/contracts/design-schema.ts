import { z } from "zod";
import { libraryChangesSchema } from "./library-editor-schema.js";
import { modelProfileSchema, taskCaseSchema } from "./orchestration-schema.js";
import { capabilitiesSchema } from "./capability-schema.js";
import { executionSettingsSchema } from "./setup-schema.js";

export const designScopeSchema = z.enum([
  "project",
  "profiles",
  "cases",
  "blocks",
  "capabilities",
  "execution",
]);
export type DesignScope = z.infer<typeof designScopeSchema>;
export const designScopes: Record<
  DesignScope,
  { title: string; description: string; placeholder: string }
> = {
  project: {
    title: "Workflow",
    description: "Improve this project’s workflows, settings and reusable blocks from any page.",
    placeholder: "What should Workflow do differently?",
  },
  profiles: {
    title: "Model profiles",
    description: "Choose models and describe when the orchestrator should use each one.",
    placeholder: "Use a strong reviewer and a fast model for routine changes…",
  },
  cases: {
    title: "Task instructions",
    description: "Shape how different kinds of requests should be handled.",
    placeholder: "Add a release-readiness case that checks tests and the changelog…",
  },
  blocks: {
    title: "Blocks",
    description: "Design reusable steps, their instructions, outputs and checks.",
    placeholder: "Add a test script block that returns diagnostics to implementation…",
  },
  capabilities: {
    title: "Skills & MCP",
    description: "Write project skills and connect MCP servers.",
    placeholder: "Write a skill for our coding conventions…",
  },
  execution: {
    title: "Execution settings",
    description: "Configure project instructions, commands and execution limits.",
    placeholder: "Add a lint command and cap workflows at 20 steps…",
  },
};
const summary = z.string().trim().min(1).max(8000);
export const designProposalSchema = z.discriminatedUnion("scope", [
  z
    .object({
      scope: z.literal("profiles"),
      summary,
      profiles: z.array(modelProfileSchema).max(30),
      coordinatorProfile: z.string(),
    })
    .strict(),
  z
    .object({
      scope: z.literal("cases"),
      summary,
      instructions: z.string().max(16000),
      cases: z.array(taskCaseSchema).max(40),
      suggestBlocks: z.boolean(),
    })
    .strict(),
  z.object({ scope: z.literal("blocks"), summary, changes: libraryChangesSchema }).strict(),
  z
    .object({ scope: z.literal("capabilities"), summary, capabilities: capabilitiesSchema })
    .strict(),
  z
    .object({
      scope: z.literal("execution"),
      summary,
      settings: executionSettingsSchema.omit({ configRevision: true }),
    })
    .strict(),
]);
export const designPageContextSchema = z
  .object({
    page: z.enum(["task", "settings"]),
    section: z
      .enum([
        "providers",
        "profiles",
        "cases",
        "blocks",
        "capabilities",
        "execution",
        "triggers",
        "memory",
      ])
      .optional(),
    blockId: z.string().max(200).optional(),
    taskId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(),
  })
  .strict();
export type DesignPageContext = z.infer<typeof designPageContextSchema>;
export const designMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(16000),
    time: z.string(),
    context: designPageContextSchema.optional(),
  })
  .strict();
export const designSessionSchema = z
  .object({
    id: z.string().uuid(),
    scope: designScopeSchema,
    revision: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
    status: z.enum(["idle", "working", "ready", "applied", "failed"]),
    messages: z.array(designMessageSchema).max(80),
    toolActivity: z
      .array(
        z
          .object({
            kind: z.enum(["tool_start", "tool_end"]),
            message: z.string().max(2000),
            time: z.string(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    proposal: designProposalSchema.optional(),
    error: z.string().optional(),
    activity: z.string().default(""),
    text: z.string().default(""),
    base: z
      .object({ orchestration: z.string(), library: z.string(), config: z.string() })
      .optional(),
    libraryProposalId: z.string().uuid().optional(),
  })
  .strict();
export const designTurnSchema = z
  .object({
    message: z.string().trim().min(1).max(8000),
    revision: z.number().int().nonnegative(),
    context: designPageContextSchema.optional(),
  })
  .strict();
export type DesignProposal = z.infer<typeof designProposalSchema>;
export type DesignSession = z.infer<typeof designSessionSchema>;
export type DesignMessage = z.infer<typeof designMessageSchema>;
