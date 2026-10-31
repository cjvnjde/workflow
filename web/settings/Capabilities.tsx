import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type {
  McpServer,
  OrchestrationSettings,
  projectCapabilitiesSchema,
} from "../../src/contracts/index.js";
import { request } from "../shared/api.js";
import Icon from "../shared/Icon.js";
import McpSettings from "./McpSettings.js";

type CapabilitiesValue = OrchestrationSettings["capabilities"];
export interface CapabilitiesProps {
  value: CapabilitiesValue;
  onChange: (value: CapabilitiesValue) => void;
  projectCapabilities?: z.infer<typeof projectCapabilitiesSchema>;
}
const inspectionSchema = z.object({
  tools: z.array(z.object({ name: z.string(), description: z.string(), readOnly: z.boolean() })),
});

export default function Capabilities({
  value: capabilities,
  onChange,
  projectCapabilities,
}: CapabilitiesProps) {
  const [connectionStatus, setConnectionStatus] = useState<Record<string, string>>({});
  const [inspecting, setInspecting] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const skills = [
    ...new Map(
      [...(projectCapabilities?.capabilities.skills ?? []), ...capabilities.skills].map((skill) => [
        skill.id,
        skill,
      ]),
    ).values(),
  ];
  const serverSources =
    projectCapabilities?.sources.filter((source) => source.kind === "mcp") ?? [];
  function overrideServer(id: string) {
    if (capabilities.mcpServers.some((item) => item.id === id)) return;
    const item = projectCapabilities?.capabilities.mcpServers.find((item) => item.id === id);
    if (item)
      onChange({
        ...capabilities,
        mcpServers: [...capabilities.mcpServers, structuredClone(item)],
      });
  }
  async function inspect(id: string) {
    const server: McpServer | undefined =
      capabilities.mcpServers.find((item) => item.id === id) ??
      projectCapabilities?.capabilities.mcpServers.find((item) => item.id === id);
    if (!server) return;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setInspecting(id);
    setConnectionStatus((value) => ({ ...value, [id]: "Connecting…" }));
    try {
      const result = await request("/api/settings/mcp/inspect", inspectionSchema, {
        method: "POST",
        body: server,
        signal: active.signal,
      });
      if (!active.signal.aborted)
        setConnectionStatus((value) => ({
          ...value,
          [id]: `Connected · ${result.tools.length} tools: ${result.tools.map((tool) => tool.name).join(", ")}`,
        }));
    } catch (error) {
      if (!active.signal.aborted)
        setConnectionStatus((value) => ({
          ...value,
          [id]: error instanceof Error ? error.message : String(error),
        }));
    } finally {
      if (!active.signal.aborted) setInspecting(undefined);
      if (controller.current === active) controller.current = null;
    }
  }
  function addServer() {
    onChange({
      ...capabilities,
      mcpServers: [
        ...capabilities.mcpServers,
        {
          id: `mcp-${crypto.randomUUID().slice(0, 8)}`,
          name: "New MCP server",
          transport: "http",
          url: "http://localhost:3000/mcp",
          command: "",
          args: [],
          tools: [],
          planningTools: [],
          enabled: false,
        },
      ],
    });
  }
  return (
    <section>
      <div className="settings-section-title">
        <div>
          <h2>Skills</h2>
          <p>Available to planning and execution. Manage skills in their source files, not here.</p>
        </div>
      </div>
      <details className="settings-card">
        <summary>How to add skills</summary>
        <p>
          Use Pi-compatible SKILL.md files with name and description frontmatter. Put shared skills
          in ~/.agents/skills or ~/.pi/agent/skills (PI_CODING_AGENT_DIR is respected). Project
          skills load from .agents/skills, .claude/skills, .codex/skills and .pi/skills; ancestor
          .agents/skills directories are searched up to the repository root.
        </p>
        <p>
          New tasks reload these files; existing runs keep their snapshot. Reload settings to
          refresh this list. Project definitions win name collisions; saved Workflow overrides still
          apply. Skills marked disable-model-invocation are not automatically used.
        </p>
      </details>
      {!skills.length ? (
        <p className="muted">No skills found in the project or user skill directories.</p>
      ) : (
        <ul className="skill-list">
          {skills.map((skill) => (
            <li key={skill.id}>
              <strong>{skill.name}</strong>
              {!skill.enabled && <small> · Disabled</small>}
              <p>{skill.description}</p>
              <small>
                {capabilities.skills.some((item) => item.id === skill.id)
                  ? "Workflow settings"
                  : projectCapabilities?.sources.find(
                      (source) => source.kind === "skill" && source.id === skill.id,
                    )?.path}
              </small>
            </li>
          ))}
        </ul>
      )}
      <article className="settings-card">
        <h2>Discovered MCP servers</h2>
        <p>
          Read from .mcp.json, .codex/config.toml, .vscode/mcp.json and .pi/mcp.json. Edit these
          files directly or customize a server in Workflow. New runs reload the files; existing runs
          keep their snapshot.
        </p>
        {!serverSources.length ? (
          <p>No project MCP servers found.</p>
        ) : (
          <ul>
            {serverSources.map((source) => (
              <li key={source.id}>
                <strong>
                  {
                    projectCapabilities?.capabilities.mcpServers.find(
                      (item) => item.id === source.id,
                    )?.name
                  }
                </strong>{" "}
                ·{" "}
                {(capabilities.mcpServers.find((item) => item.id === source.id)?.enabled ??
                projectCapabilities?.capabilities.mcpServers.find((item) => item.id === source.id)
                  ?.enabled)
                  ? "Enabled"
                  : "Disabled"}{" "}
                · {source.path}
                <button onClick={() => overrideServer(source.id)}>Customize in Workflow</button>
                <button disabled={!!inspecting} onClick={() => void inspect(source.id)}>
                  Test connection
                </button>
                {connectionStatus[source.id] && <p role="status">{connectionStatus[source.id]}</p>}
              </li>
            ))}
          </ul>
        )}
        {projectCapabilities?.warnings.map((warning) => (
          <p key={warning} role="status">
            {warning}
          </p>
        ))}
      </article>
      <div className="settings-section-title">
        <div>
          <h2>MCP servers</h2>
          <p>
            Connect a local process or Streamable HTTP endpoint. All tools from enabled servers are
            available to execution blocks. The coordinator composes graphs from supplied context
            without calling MCP tools.
          </p>
        </div>
        <button onClick={addServer}>
          <Icon name="plus" />
          Add MCP server
        </button>
      </div>
      {capabilities.mcpServers.map((server) => (
        <McpSettings
          key={server.id}
          value={server}
          onChange={(value) =>
            onChange({
              ...capabilities,
              mcpServers: capabilities.mcpServers.map((item) =>
                item.id === server.id ? value : item,
              ),
            })
          }
          onRemove={() =>
            onChange({
              ...capabilities,
              mcpServers: capabilities.mcpServers.filter((item) => item.id !== server.id),
            })
          }
        />
      ))}
    </section>
  );
}
