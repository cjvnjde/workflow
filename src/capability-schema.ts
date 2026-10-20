import { z } from "zod";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const skillSchema = z.object({
  id, name: z.string().trim().min(1).max(100), description: z.string().max(1000),
  content: z.string().min(1).max(64_000), enabled: z.boolean().default(true),
}).strict();
export const mcpServerSchema = z.object({
  id, name: z.string().trim().min(1).max(100), enabled: z.boolean().default(false),
  transport: z.enum(["http", "stdio"]).default("http"),
  url: z.string().max(2000).default(""), command: z.string().max(1000).default(""),
  args: z.array(z.string().max(2000)).max(40).default([]),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  // Compatibility/discovery metadata. Enabled servers expose all tools in every phase.
  tools: z.array(z.string().min(1).max(200)).max(100).default([]),
  planningTools: z.array(z.string().min(1).max(200)).max(100).default([]),
}).strict().superRefine((server, ctx) => {
  if (server.transport === "http") {
    try {
      const url = new URL(server.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) { throw new Error(); }
    } catch { ctx.addIssue({ code: "custom", message: "Use an HTTP(S) MCP endpoint without credentials, query parameters or a fragment", path: ["url"] }); }
  } else if (!server.command.trim()) { ctx.addIssue({ code: "custom", message: "A local MCP server needs a command", path: ["command"] }); }
});
export const capabilitiesSchema = z.object({
  skills: z.array(skillSchema).max(30).default([]),
  mcpServers: z.array(mcpServerSchema).max(15).default([]),
}).strict();
export const attachmentSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(200), mimeType: z.string(),
  size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["image", "text"]),
}).strict();
export type Attachment = z.infer<typeof attachmentSchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
