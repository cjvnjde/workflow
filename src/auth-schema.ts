import { z } from "zod";

export const loginMethodSchema = z.enum(["oauth", "api_key"]);
export const authOptionsSchema = z.array(z.object({
  id: z.string(), name: z.string(), methods: z.array(loginMethodSchema),
}));
const linkSchema = z.object({ url: z.string().url(), label: z.string().optional() });
export const authEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth_url"), url: z.string().url(), instructions: z.string().optional() }),
  z.object({ type: z.literal("device_code"), userCode: z.string(), verificationUri: z.string().url(), intervalSeconds: z.number().optional(), expiresInSeconds: z.number().optional() }),
  z.object({ type: z.literal("info"), message: z.string(), links: z.array(linkSchema).optional() }),
  z.object({ type: z.literal("progress"), message: z.string() }),
]);
export const authPromptSchema = z.object({
  id: z.string().uuid(), type: z.enum(["secret", "text", "manual_code", "select"]),
  message: z.string(), placeholder: z.string().optional(),
  options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() })).optional(),
});
export const authSessionSchema = z.object({
  id: z.string().uuid(), provider: z.string(), method: loginMethodSchema,
  status: z.enum(["pending", "succeeded", "cancelled", "failed"]),
  events: z.array(authEventSchema), prompt: authPromptSchema.optional(),
  message: z.string().optional(),
});
export const authStartSchema = z.object({ provider: z.string().min(1), method: loginMethodSchema }).strict();
export const authResponseSchema = z.object({ promptId: z.string().uuid(), value: z.string().min(1).max(16_000) }).strict();
export type AuthSession = z.infer<typeof authSessionSchema>;
