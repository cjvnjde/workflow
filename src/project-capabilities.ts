import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { capabilitiesSchema, mcpServerSchema, skillSchema, type Capabilities } from "./capability-schema.js";

export const skillDirectories = [".agents/skills", ".claude/skills", ".codex/skills", ".pi/skills"];
export const mcpFiles = [".mcp.json", ".codex/config.toml", ".vscode/mcp.json", ".pi/mcp.json"];

/** Discover without launching servers. Saved overrides win, including disabled entries. */
export async function discoverProjectCapabilities(project: string) {
  const capabilities: Capabilities = { skills: [], mcpServers: [] };
  const sources: { kind: "skill" | "mcp"; id: string; path: string }[] = [];
  const warnings: string[] = [];
  for (const directory of skillDirectories) {
    const loaded = loadSkillsFromDir({ dir: path.join(project, directory), source: "project" });
    for (const diagnostic of loaded.diagnostics) warnings.push(`${directory}: ${diagnostic.message}`);
    for (const skill of loaded.skills) {
      if (capabilities.skills.some(item => item.id === skill.name)) continue;
      try {
        if ((await stat(skill.filePath)).size > 64_000) throw new Error("Skill exceeds 64 KB");
        const content = await readFile(skill.filePath, "utf8");
        capabilities.skills.push(skillSchema.parse({ id: skill.name, name: skill.name, description: skill.description,
          content: `Skill source: ${skill.filePath}\nResolve referenced resources relative to ${skill.baseDir}.\n\n${content}`,
          enabled: !skill.disableModelInvocation }));
        sources.push({ kind: "skill", id: skill.name, path: path.relative(project, skill.filePath) });
      } catch { warnings.push(`${path.relative(project, skill.filePath)}: skill could not be loaded (check name and size).`); }
    }
  }
  for (const filename of mcpFiles) {
    let raw: Record<string, any>;
    try {
      const file = path.join(project, filename);
      if ((await stat(file)).size > 256_000) throw new Error("Configuration exceeds 256 KB");
      const text = await readFile(file, "utf8");
      raw = filename.endsWith(".toml") ? Bun.TOML.parse(text) : JSON.parse(text);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) warnings.push(`${filename}: could not parse MCP configuration.`);
      continue;
    }
    const servers = raw.mcpServers ?? raw.mcp_servers ?? raw.servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) { warnings.push(`${filename}: no MCP server map found.`); continue; }
    for (const [id, value] of Object.entries(servers)) {
      if (capabilities.mcpServers.some(item => item.id === id)) continue;
      try {
        const server = value as Record<string, any>;
        // Do not copy literal credentials into settings, events, or frozen runs.
        if (server.env || server.headers || server.http_headers || server.env_http_headers || server.env_vars || (server.type && !["http", "stdio"].includes(server.type))) {
          throw new Error("Unsupported environment, headers or transport");
        }
        const expand = (s: string) => s.replaceAll("${workspaceFolder}", project);
        const parsed = mcpServerSchema.parse({ id, name: id, enabled: server.enabled !== false && server.disabled !== true,
          transport: server.url ? "http" : "stdio", url: server.url ?? "", command: server.command ? expand(server.command) : "",
          args: (server.args ?? []).map(expand), tokenEnv: server.bearer_token_env_var });
        capabilities.mcpServers.push(parsed);
        sources.push({ kind: "mcp", id, path: filename });
      } catch { warnings.push(`${filename}: MCP server “${id}” was not loaded. Check its ID/transport; literal env and custom headers are not imported. Use inherited environment or bearer_token_env_var.`); }
    }
  }
  return { capabilities: capabilitiesSchema.parse(capabilities), sources, warnings };
}

export function mergeCapabilities(discovered: Capabilities, overrides: Capabilities): Capabilities {
  return capabilitiesSchema.parse({
    skills: [...new Map([...discovered.skills, ...overrides.skills].map(item => [item.id, item])).values()],
    mcpServers: [...new Map([...discovered.mcpServers, ...overrides.mcpServers].map(item => [item.id, item])).values()],
  });
}
