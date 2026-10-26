import { z } from "zod";
import { attachmentSchema } from "./capability-schema.js";
import { eventSchema } from "./domain.js";

export const questionSchema = z.object({ question: z.string().min(1).max(2000), options: z.array(z.string().min(1).max(200)).max(4).default([]) }).strict();
export const taskSchema = z.object({
  id: z.string().uuid(), createdAt: z.string(), updatedAt: z.string(), revision: z.number().int().nonnegative(),
  deletedAt: z.string().optional(),
  sourceRunId: z.string().uuid().optional(),
  status: z.enum(["queued", "planning", "needs_input", "ready", "failed", "cancelled"]),
  prompt: z.string().min(1).max(32_000), attachments: z.array(attachmentSchema).max(8),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })),
  question: questionSchema.optional(), runId: z.string().uuid().optional(),
  caseId: z.string().optional(), caseName: z.string().optional(), rationale: z.string().optional(),
  suggestedBlocks: z.array(z.object({ id: z.string(), rationale: z.string() })).default([]),
  events: z.array(eventSchema).default([]), error: z.string().optional(),
  approval: z.enum(["review", "automatic"]),
}).strict();
export const taskListSchema = z.array(taskSchema.omit({ events: true, answers: true }));
export const newTaskSchema = z.object({ approval: z.enum(["review", "automatic"]).optional(), sourceRunId: z.string().uuid().optional(), prompt: z.string().trim().min(1).max(32_000), attachments: z.array(z.string().uuid()).max(8).default([]) }).strict();
export type TaskRequest = z.infer<typeof taskSchema>;
