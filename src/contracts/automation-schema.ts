import { z } from "zod";
import {
  agentOverrideSchema,
  identifierSchema,
  usageSchema,
  configSchema,
  bundleSchema,
} from "./domain.js";
import { workSignalSchema } from "./automation-signal-schema.js";
export { workSignalSchema, discoveryResultSchema } from "./automation-signal-schema.js";
export type { WorkSignal, DiscoveryResult } from "./automation-signal-schema.js";

const key = z.string().trim().min(1).max(300);
const json = z.json();
export type AutomationJson = z.infer<typeof json>;
const record = z.record(z.string().max(200), json);
const instant = z.string().datetime({ offset: true });
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

export const automationScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("signal") }).strict(),
  z
    .object({ kind: z.literal("interval"), seconds: z.number().int().min(1).max(31_536_000) })
    .strict(),
  z
    .object({
      kind: z.literal("cron"),
      expression: z.string().trim().min(9).max(120),
      timezone: z.string().min(1).max(100),
    })
    .strict(),
  z.object({ kind: z.literal("once"), at: instant }).strict(),
]);
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;
export const automationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workflow"), runId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("block"), blockId: identifierSchema }).strict(),
]);
export type AutomationTarget = z.infer<typeof automationTargetSchema>;

export const automationExecutionSchema = z
  .object({
    workspace: z.enum(["worktree", "project"]).default("worktree"),
    baseRef: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
      .default("HEAD"),
    environment: z.array(envName).max(50).default([]),
    resources: z.array(key).max(20).default([]),
    skills: z.array(z.string().max(100)).max(100).optional(),
    mcpServers: z.array(z.string().max(100)).max(15).optional(),
    modelProfile: z.string().max(100).optional(),
    agent: agentOverrideSchema.optional(),
    maxSteps: z.number().int().min(1).max(500).default(30),
    maxCommands: z.number().int().min(0).max(1000).default(50),
    maxModelCalls: z.number().int().min(0).max(1000).default(20),
    maxToolCalls: z.number().int().min(1).max(1000).default(100),
    maxCostUsd: z.number().positive().optional(),
  })
  .strict();
export type AutomationExecution = z.infer<typeof automationExecutionSchema>;

export const automationRouteSchema = z
  .object({
    id: identifierSchema,
    signalKind: key,
    sourceId: key.optional(),
    match: z
      .record(z.string().min(1).max(200), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .default({}),
    revisionPolicy: z.enum(["advance", "current", "any"]).default("current"),
    target: automationTargetSchema.optional(),
    inputs: record.default({}),
    priority: z.number().int().min(-100).max(100).default(0),
    approval: z.enum(["automatic", "required"]).default("automatic"),
    execution: automationExecutionSchema.optional(),
  })
  .strict();
export type AutomationRoute = z.infer<typeof automationRouteSchema>;

export const automationConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).default(""),
    enabled: z.boolean().default(false),
    schedule: automationScheduleSchema,
    target: automationTargetSchema,
    mode: z.enum(["direct", "discovery"]).default("direct"),
    inputs: record.default({}),
    routes: z.array(automationRouteSchema).max(50).default([]),
    execution: automationExecutionSchema.default(() => automationExecutionSchema.parse({})),
    policy: z
      .object({
        approval: z.enum(["automatic", "required"]).default("automatic"),
        missedRuns: z.enum(["skip", "latest", "catch-up"]).default("latest"),
        maxCatchUp: z.number().int().min(1).max(20).default(3),
        overlap: z.enum(["queue", "skip"]).default("skip"),
        concurrency: z.number().int().min(1).max(32).default(2),
        maxQueued: z.number().int().min(1).max(10_000).default(100),
        cooldownSeconds: z.number().int().min(0).max(86400).default(0),
        supersede: z.boolean().default(true),
        maxCostUsd: z.number().positive().optional(),
        retry: z
          .object({
            safe: z.enum(["never", "read-only"]).default("never"),
            maxAttempts: z.number().int().min(1).max(10).default(3),
            backoffSeconds: z.number().int().min(1).max(3600).default(30),
          })
          .strict()
          .default(() => ({ safe: "never" as const, maxAttempts: 3, backoffSeconds: 30 })),
      })
      .strict()
      .default(() => ({
        approval: "automatic" as const,
        missedRuns: "latest" as const,
        maxCatchUp: 3,
        overlap: "skip" as const,
        concurrency: 2,
        maxQueued: 100,
        cooldownSeconds: 0,
        supersede: true,
        retry: { safe: "never" as const, maxAttempts: 3, backoffSeconds: 30 },
      })),
    output: z
      .object({
        target: automationTargetSchema,
        reconcile: automationTargetSchema.optional(),
        approval: z.enum(["required", "automatic"]).default("required"),
        execution: automationExecutionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.routes.map((route) => route.id)).size !== value.routes.length)
      ctx.addIssue({ code: "custom", message: "Route IDs must be unique", path: ["routes"] });
    if (value.mode === "discovery" && value.routes.length === 0)
      ctx.addIssue({
        code: "custom",
        message: "Discovery requires at least one route",
        path: ["routes"],
      });
    if (value.policy.maxCostUsd !== undefined && value.execution.maxCostUsd === undefined)
      ctx.addIssue({
        code: "custom",
        message: "An automation spending cap requires a per-job execution.maxCostUsd reservation",
        path: ["execution", "maxCostUsd"],
      });
  });
export type AutomationConfig = z.infer<typeof automationConfigSchema>;
export const saveAutomationSchema = z
  .object({
    id: z.string().uuid().optional(),
    revision: z.number().int().nonnegative().optional(),
    config: automationConfigSchema,
  })
  .strict();

export const automationVersionSchema = z
  .object({
    id: z.string().uuid(),
    config: automationConfigSchema,
    targets: z.record(
      z.string(),
      z
        .object({
          title: z.string(),
          executionVersion: z.string().optional(),
          source: z.string().optional(),
          input: record.optional(),
          settings: configSchema,
          blocks: z.record(identifierSchema, bundleSchema),
          models: z.record(z.string(), agentOverrideSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type AutomationVersionInfo = z.infer<typeof automationVersionSchema>;

export const automationSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    versionId: z.string().uuid(),
    config: automationConfigSchema,
    state: z.enum(["enabled", "paused", "disabled"]),
    createdAt: instant,
    updatedAt: instant,
    nextFireAt: z.number().nullable(),
    lastFireAt: z.number().optional(),
    lastAdmittedAt: z.number().optional(),
    checkpoint: json.optional(),
    error: z.string().max(4000).optional(),
  })
  .strict();
export type Automation = z.infer<typeof automationSchema>;
export const automationCaseSchema = z
  .object({
    id: z.string(),
    sourceId: key,
    correlationKey: key,
    currentRevision: key,
    observedAt: instant,
    revisionObservedAt: instant.optional(),
    updatedAt: instant,
    references: z.record(z.string(), z.string()),
    payload: record,
    lastSignalKind: key,
    lastJobId: z.string().uuid().optional(),
    lastRunId: z.string().uuid().optional(),
  })
  .strict();
export type AutomationCase = z.infer<typeof automationCaseSchema>;
export const automationJobStatusSchema = z.enum([
  "queued",
  "admitted",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "needs_attention",
]);
export const automationJobSchema = z
  .object({
    id: z.string().uuid(),
    automationId: z.string().uuid(),
    automationName: z.string(),
    versionId: z.string().uuid(),
    key: z.string(),
    phase: z.enum(["direct", "discovery", "reaction", "output", "reconcile"]),
    targetKey: z.string(),
    caseId: z.string().optional(),
    parentJobId: z.string().uuid().optional(),
    signal: workSignalSchema.optional(),
    revisionPolicy: z.enum(["advance", "current", "any"]).default("current"),
    input: record,
    runId: z.string().uuid(),
    prepared: z.boolean().default(false),
    previousRunId: z.string().uuid().optional(),
    status: automationJobStatusSchema,
    priority: z.number().int(),
    createdAt: instant,
    updatedAt: instant,
    availableAt: z.number(),
    attempt: z.number().int().positive(),
    priorRunIds: z.array(z.string().uuid()).default([]),
    test: z.boolean().default(false),
    approval: z.enum(["automatic", "required", "approved"]),
    reason: z.string().max(4000).optional(),
    runStatus: z.string().optional(),
    usage: usageSchema.optional(),
    usageIncomplete: z.boolean().default(false),
    result: json.optional(),
    effects: z.enum(["none", "possible", "reconciled"]).default("none"),
    workspace: z.string().optional(),
    publicationKey: z.string().optional(),
  })
  .strict();
export type AutomationJob = z.infer<typeof automationJobSchema>;
export const automationAuditSchema = z
  .object({
    id: z.number().int(),
    time: instant,
    automationId: z.string().uuid(),
    jobId: z.string().uuid().optional(),
    signalKey: z.string().optional(),
    kind: z.string(),
    message: z.string(),
  })
  .strict();
export type AutomationAudit = z.infer<typeof automationAuditSchema>;
export const automationObservationSchema = z
  .object({
    key: z.string(),
    automationId: z.string().uuid(),
    signal: workSignalSchema,
    disposition: z.string(),
    caseId: z.string().optional(),
    receivedAt: instant,
    versionId: z.string().uuid(),
  })
  .strict();
export type AutomationObservation = z.infer<typeof automationObservationSchema>;
export const schedulerSettingsSchema = z
  .object({
    revision: z.number().int().nonnegative().default(0),
    concurrency: z.number().int().min(1).max(32).default(2),
    maxQueued: z.number().int().min(1).max(50_000).default(1000),
    maxCostUsd: z.number().positive().optional(),
  })
  .strict();
export type SchedulerSettings = z.infer<typeof schedulerSettingsSchema>;
export const automationStateSchema = z
  .object({
    automations: z.array(automationSchema),
    jobs: z.array(automationJobSchema),
    cases: z.array(automationCaseSchema),
    observations: z.array(automationObservationSchema),
    audit: z.array(automationAuditSchema),
    settings: schedulerSettingsSchema,
    usage: z.record(z.string(), usageSchema),
    error: z.string().optional(),
  })
  .strict();
export type AutomationState = z.infer<typeof automationStateSchema>;
export const ingestSignalsSchema = z
  .object({
    signals: z.array(workSignalSchema).max(500),
    checkpoint: json.optional(),
  })
  .strict();
export const automationActionSchema = z.enum([
  "enable",
  "pause",
  "disable",
  "resume",
  "run-now",
  "test",
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;
export const automationJobActionSchema = z.enum([
  "approve",
  "pause",
  "resume",
  "cancel",
  "retry",
  "reconcile",
  "resolve",
  "cleanup",
]);
export type AutomationJobAction = z.infer<typeof automationJobActionSchema>;
export const automationRunOwnershipSchema = z
  .object({
    automationId: z.string().uuid(),
    jobId: z.string().uuid(),
    workspace: z.enum(["worktree", "project"]),
    baseRef: z.string(),
    previousRunId: z.string().uuid().optional(),
    execution: automationExecutionSchema,
  })
  .strict();
export type AutomationRunOwnership = z.infer<typeof automationRunOwnershipSchema>;
