import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type {
  McpServer,
  OrchestrationSettings,
  projectCapabilitiesSchema,
} from "../../src/contracts/index.js";
import { request } from "../shared/api.js";
import { useAutosize } from "../shared/autosize.js";
import Field from "../shared/Field.js";
import Icon from "../shared/Icon.js";
import McpSettings from "./McpSettings.js";

type CapabilitiesValue = OrchestrationSettings["capabilities"];
type Skill = CapabilitiesValue["skills"][number];
export interface CapabilitiesProps {
  value: CapabilitiesValue;
  onChange: (value: CapabilitiesValue) => void;
  projectCapabilities?: z.infer<typeof projectCapabilitiesSchema>;
}
const inspectionSchema = z.object({
  tools: z.array(z.object({ name: z.string(), description: z.string(), readOnly: z.boolean() })),
});

function SkillSettings({
  skill,
  onChange,
  onRemove,
}: {
  skill: Skill;
  onChange: (value: Skill) => void;
  onRemove: () => void;
}) {
  const instructionsRef = useAutosize(skill.content);
  function update(patch: Partial<Skill>) {
    onChange({ ...skill, ...patch });
  }
  return (
    <article className="settings-card">
      <div className="card-title">
        <strong>{skill.name}</strong>
        <label className="checkbox">
          <input
            checked={skill.enabled}
            type="checkbox"
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          Enabled
        </label>
        <button className="icon-button" aria-label={`Remove ${skill.name}`} onClick={onRemove}>
          <Icon name="close" />
        </button>
      </div>
      <Field label="Skill name">
        {({ id }) => (
          <input
            id={id}
            value={skill.name}
            onChange={(event) => update({ name: event.target.value })}
          />
        )}
      </Field>
      <Field label="Skill description">
        {({ id }) => (
          <input
            id={id}
            value={skill.description}
            onChange={(event) => update({ description: event.target.value })}
          />
        )}
      </Field>
      <Field label="Skill instructions">
        {({ id }) => (
          <textarea
            id={id}
            value={skill.content}
            ref={instructionsRef}
            rows={6}
            onChange={(event) => update({ content: event.target.value })}
          />
        )}
      </Field>
    </article>
  );
}

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

  function projectName(kind: string, id: string) {
    const key = kind === "skill" ? "skills" : "mcpServers";
    return projectCapabilities?.capabilities[key].find((item) => item.id === id)?.name ?? id;
  }
  function enabled(kind: string, id: string) {
    const key = kind === "skill" ? "skills" : "mcpServers";
    return (
      capabilities[key].find((item) => item.id === id)?.enabled ??
      projectCapabilities?.capabilities[key].find((item) => item.id === id)?.enabled ??
      false
    );
  }
  function override(kind: string, id: string) {
    if (kind === "skill") {
      if (capabilities.skills.some((item) => item.id === id)) return;
      const item = projectCapabilities?.capabilities.skills.find((item) => item.id === id);
      if (item)
        onChange({
          ...capabilities,
          skills: [...capabilities.skills, structuredClone(item)],
        });
    } else {
      if (capabilities.mcpServers.some((item) => item.id === id)) return;
      const item = projectCapabilities?.capabilities.mcpServers.find((item) => item.id === id);
      if (item)
        onChange({
          ...capabilities,
          mcpServers: [...capabilities.mcpServers, structuredClone(item)],
        });
    }
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
  function addSkill() {
    onChange({
      ...capabilities,
      skills: [
        ...capabilities.skills,
        {
          id: `skill-${crypto.randomUUID().slice(0, 8)}`,
          name: "New skill",
          description: "",
          content: "Write the skill's instructions here.",
          enabled: true,
        },
      ],
    });
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
      <article className="settings-card">
        <h2>From this project</h2>
        <p>
          Skills are discovered from .agents/skills, .claude/skills, .codex/skills and .pi/skills.
          MCP servers come from .mcp.json, .codex/config.toml, .vscode/mcp.json and .pi/mcp.json.
          New runs reload these files; existing runs keep their snapshot.
        </p>
        <p>
          Entries below with the same ID override project files, including disabling them. Edit
          discovered entries in their source files.
        </p>
        {!projectCapabilities?.sources.length ? (
          <p>No project skills or MCP servers found.</p>
        ) : (
          <ul>
            {projectCapabilities.sources.map((source) => (
              <li key={source.kind + source.id}>
                <strong>{projectName(source.kind, source.id)}</strong> ·{" "}
                {enabled(source.kind, source.id) ? "Enabled" : "Disabled"} · {source.kind} ·{" "}
                {source.path}
                <button onClick={() => override(source.kind, source.id)}>
                  Customize in Workflow
                </button>
                {source.kind === "mcp" && (
                  <button disabled={!!inspecting} onClick={() => void inspect(source.id)}>
                    Test connection
                  </button>
                )}
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
          <h2>Skills</h2>
          <p>
            Explicit instructions available during planning and in execution steps. Enable only what
            this project needs.
          </p>
        </div>
        <button onClick={addSkill}>
          <Icon name="plus" />
          Add skill
        </button>
      </div>
      {capabilities.skills.map((skill) => (
        <SkillSettings
          key={skill.id}
          skill={skill}
          onChange={(value) =>
            onChange({
              ...capabilities,
              skills: capabilities.skills.map((item) => (item.id === skill.id ? value : item)),
            })
          }
          onRemove={() =>
            onChange({
              ...capabilities,
              skills: capabilities.skills.filter((item) => item.id !== skill.id),
            })
          }
        />
      ))}
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
