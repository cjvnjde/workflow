import { z } from "zod";

export const githubRepositorySchema = z
  .string()
  .trim()
  .max(140)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/,
    "Use owner/repository",
  )
  .refine((value) => ![".", ".."].includes(value.split("/")[1]!), "Use a repository name")
  .transform((value) => value.toLowerCase());
export const triggerEventKindSchema = z.enum(["issue.opened", "pull_request.opened"]);
export const githubEventSchema = z
  .object({
    id: z.string().min(1),
    kind: triggerEventKindSchema,
    repository: githubRepositorySchema,
    number: z.number().int().positive(),
    title: z.string().max(1000),
    body: z.string().max(32_000),
    bodyTruncated: z.boolean().default(false),
    url: z.string().url(),
    author: z.string(),
    labels: z.array(z.string()),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    headSha: z.string().optional(),
    baseSha: z.string().optional(),
    headRef: z.string().optional(),
    baseRef: z.string().optional(),
    draft: z.boolean().optional(),
  })
  .strict();
export type GithubEvent = z.infer<typeof githubEventSchema>;

export const triggerConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    repository: githubRepositorySchema,
    event: triggerEventKindSchema,
    workflowRunId: z.string().uuid(),
    enabled: z.boolean().default(false),
    pollSeconds: z.number().int().min(30).max(3600).default(60),
    labels: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    authors: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    includeDrafts: z.boolean().default(false),
    maxCostUsd: z.number().positive().optional(),
    result: z.enum(["local", "github-comment"]).default("local"),
  })
  .strict();
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;
export const triggerSchema = triggerConfigSchema.extend({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  versionId: z.string().uuid(),
  createdAt: z.string().datetime(),
  cursor: z.string().datetime(),
  lastPollAt: z.string().datetime().optional(),
  nextPollAt: z.number(),
  error: z.string().optional(),
  workflowTitle: z.string(),
  executionVersion: z.string(),
});
export type Trigger = z.infer<typeof triggerSchema>;
export const triggerJobSchema = z
  .object({
    id: z.string().uuid(),
    triggerId: z.string().uuid(),
    versionId: z.string().uuid(),
    triggerName: z.string(),
    event: githubEventSchema,
    runId: z.string().uuid(),
    createdAt: z.string().datetime(),
    status: z.enum([
      "queued",
      "draft",
      "running",
      "publishing",
      "completed",
      "failed",
      "cancelled",
    ]),
    test: z.boolean(),
    error: z.string().optional(),
    runStatus: z.string().optional(),
    delivery: z.enum(["pending", "posting", "published", "uncertain"]).default("pending"),
    resultUrl: z.string().optional(),
    nextDeliveryAt: z.number().default(0),
  })
  .strict();
export type TriggerJob = z.infer<typeof triggerJobSchema>;
export const triggerStateSchema = z.object({
  triggers: z.array(triggerSchema),
  jobs: z.array(triggerJobSchema),
  error: z.string().optional(),
});
export type TriggerState = z.infer<typeof triggerStateSchema>;
export const saveTriggerSchema = z
  .object({
    id: z.string().uuid().optional(),
    revision: z.number().int().nonnegative().optional(),
    config: triggerConfigSchema,
  })
  .strict();
