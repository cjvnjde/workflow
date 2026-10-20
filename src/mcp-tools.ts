import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Capabilities, McpServer } from "./capability-schema.js";

async function connect(server: McpServer, project: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const client = new McpClient({ name: "workflow", version: "0.1.0", requestTimeoutMs: 15_000, roots: [{ name: "Project", uri: pathToFileURL(project).href }] });
  const abort = () => { void client.close().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const close = async () => { signal.removeEventListener("abort", abort); await client.close(); };
  try {
    const token = server.tokenEnv ? process.env[server.tokenEnv] : undefined;
    if (server.tokenEnv && !token) { throw new Error("Configured MCP token environment variable is not set"); }
    await client.connect(server.transport === "http"
      ? new StreamableHttpTransport({ url: server.url, headers: token ? { Authorization: `Bearer ${token}` } : {}, maxMessageBytes: 1_000_000 })
      : new StdioTransport({ command: server.command, args: server.args, cwd: project, inheritEnv: true,
        maxMessageBytes: 1_000_000, maxStderrBytes: 8000 }));
    signal.throwIfAborted();
    return { client, close };
  } catch { await close().catch(() => {}); throw new Error(`Could not connect to MCP server “${server.name}”. Check its endpoint/command and credentials.`); }
}

export async function inspectMcp(server: McpServer, project: string, signal: AbortSignal) {
  const connection = await connect(server, project, signal);
  try {
    return (await connection.client.listTools({ signal })).slice(0, 100).map((tool) => ({ name: tool.name, description: tool.description ?? "", readOnly: tool.annotations?.readOnlyHint === true }));
  } finally { await connection.close(); }
}

export async function mcpTools(capabilities: Capabilities | undefined, project: string, signal: AbortSignal) {
  const connections: Awaited<ReturnType<typeof connect>>[] = [];
  const tools: ToolDefinition[] = [];
  const close = async () => { await Promise.allSettled(connections.map((connection) => connection.close())); };
  try {
    for (const server of capabilities?.mcpServers ?? []) {
      if (!server.enabled) { continue; }
      const connection = await connect(server, project, signal); connections.push(connection);
      const available = await connection.client.listTools({ signal });
      for (const tool of available) {
        const name = tool.name;
        const suffix = createHash("sha256").update(`${server.id}/${name}`).digest("hex").slice(0, 10);
        tools.push(defineTool({
          name: `mcp_${server.id.slice(0, 20)}_${name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 20)}_${suffix}`,
          label: `${server.name} · ${name}`, description: (tool.description ?? name).slice(0, 8000),
          parameters: Type.Unsafe<Record<string, unknown>>({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
          async execute(_id, args, callSignal) {
            const activeSignal = callSignal ? AbortSignal.any([signal, callSignal]) : signal;
            activeSignal.throwIfAborted();
            try {
              const result = await connection.client.callTool(name, args, { signal: activeSignal, timeoutMs: 60_000 });
              const content = toLlmContent(result);
              if (Buffer.byteLength(JSON.stringify(content)) > 200_000) { throw new Error("MCP result exceeds the 200 KB context limit"); }
              return { content, details: undefined, isError: result.isError === true };
            } catch { activeSignal.throwIfAborted(); throw new Error(`MCP tool failed: ${server.name} / ${name}`); }
          },
        }));
      }
    }
    return { tools, close };
  } catch (error) { await close(); throw error; }
}
