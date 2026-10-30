import { z } from "zod";
import { agentSchema, identifierSchema } from "./domain.js";
import { usageSessionSchema } from "./usage-schema.js";
import { evidenceDependencySchema, unavailableEvidenceSchema } from "./evidence-value.js";
export * from "./evidence-value.js";

export const evidenceIdentitySchema = z
  .object({
    runId: z.string().uuid(),
    nodeId: identifierSchema,
    visit: z.number().int().positive(),
  })
  .strict();
export type EvidenceIdentity = z.infer<typeof evidenceIdentitySchema>;
export const evidenceContentRefSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    mediaType: z.string(),
    exact: z.literal(true),
  })
  .strict();
export type EvidenceContentRef = z.infer<typeof evidenceContentRefSchema>;
export const storedEvidenceValueSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("captured"), ref: evidenceContentRefSchema }).strict(),
  z.object({ state: z.literal("undefined") }).strict(),
  unavailableEvidenceSchema,
]);
export type StoredEvidenceValue = z.infer<typeof storedEvidenceValueSchema>;
const section = <T extends z.ZodType>(schema: T) =>
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("available"), value: schema }).strict(),
    z.object({ state: z.enum(["pending", "unavailable"]), reason: z.string() }).strict(),
  ]);
export const stepInputsEvidenceSchema = z
  .object({
    raw: storedEvidenceValueSchema,
    effective: storedEvidenceValueSchema,
    prompt: storedEvidenceValueSchema,
    dependencies: z.array(evidenceDependencySchema),
    inputError: z.string().optional(),
    captureWarning: z.string().optional(),
  })
  .strict();
export const stepOutputEvidenceSchema = z
  .object({
    data: storedEvidenceValueSchema,
    artifacts: z.record(z.string(), evidenceContentRefSchema),
    summary: evidenceContentRefSchema,
    outcome: z.enum(["pass", "retry", "fail"]),
  })
  .strict();
export const sessionContextEvidenceSchema = z
  .object({
    systemPrompt: evidenceContentRefSchema,
    settings: agentSchema,
    tools: evidenceContentRefSchema,
    contextMode: z.enum(["workflow", "none"]).optional(),
  })
  .strict();
export const sessionPromptEvidenceSchema = z
  .object({
    index: z.number().int().nonnegative(),
    kind: z.enum(["initial", "continuation"]),
    text: storedEvidenceValueSchema,
    images: z.array(storedEvidenceValueSchema),
  })
  .strict();
export const sessionToolEvidenceSchema = z
  .object({
    callId: z.string(),
    name: z.string().optional(),
    state: z.enum(["started", "completed", "failed", "interrupted"]),
    input: storedEvidenceValueSchema.optional(),
    output: storedEvidenceValueSchema.optional(),
    details: storedEvidenceValueSchema.optional(),
    error: z.string().optional(),
  })
  .strict();
export const sessionEvidenceSchema = z
  .object({
    sessionId: z.string().uuid(),
    operationId: z.string(),
    activityAttempt: z.number().int().positive().optional(),
    usage: usageSessionSchema.nullable(),
    context: section(sessionContextEvidenceSchema),
    prompts: z.array(sessionPromptEvidenceSchema),
    tools: z.array(sessionToolEvidenceSchema),
    call: section(
      z
        .object({
          prompt: storedEvidenceValueSchema,
          instructions: storedEvidenceValueSchema,
          contextMode: z.enum(["workflow", "none"]),
        })
        .strict(),
    ),
  })
  .strict();
export const attemptEvidenceSchema = evidenceIdentitySchema
  .extend({
    version: z.literal(1),
    inputs: section(stepInputsEvidenceSchema),
    output: section(stepOutputEvidenceSchema),
    sessions: z.array(sessionEvidenceSchema),
  })
  .strict();
export type AttemptEvidence = z.infer<typeof attemptEvidenceSchema>;
export type SessionEvidence = z.infer<typeof sessionEvidenceSchema>;
export type StepInputsEvidence = z.infer<typeof stepInputsEvidenceSchema>;
export type StepOutputEvidence = z.infer<typeof stepOutputEvidenceSchema>;
export type SessionContextEvidence = z.infer<typeof sessionContextEvidenceSchema>;
export type SessionPromptEvidence = z.infer<typeof sessionPromptEvidenceSchema>;
export type SessionToolEvidence = z.infer<typeof sessionToolEvidenceSchema>;
