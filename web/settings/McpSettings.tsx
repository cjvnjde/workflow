import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { McpServer } from "../../src/contracts/index.js";
import { request } from "../shared/api.js";
import { useAutosize } from "../shared/autosize.js";
import Field from "../shared/Field.js";
import Icon from "../shared/Icon.js";

const discoverySchema = z.object({
  tools: z.array(z.object({ name: z.string(), description: z.string(), readOnly: z.boolean() })),
});
type Discovery = {
  server: McpServer;
  tools: z.infer<typeof discoverySchema>["tools"];
  busy: boolean;
  error: string;
};
export interface McpSettingsProps {
  modelValue: McpServer;
  onUpdateModelValue: (server: McpServer) => void;
  onRemove: () => void;
}

export default function McpSettings({
  modelValue: server,
  onUpdateModelValue,
  onRemove,
}: McpSettingsProps) {
  const [discovery, setDiscovery] = useState<Discovery>();
  const controller = useRef<AbortController | null>(null);
  const publishServer = useRef(onUpdateModelValue);
  useEffect(() => {
    publishServer.current = onUpdateModelValue;
  }, [onUpdateModelValue]);
  const argumentsRef = useAutosize(server.args.join("\n"));
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [server],
  );
  const current = discovery?.server === server ? discovery : undefined;
  const busy = current?.busy ?? false;
  const catalog = current?.tools ?? [];
  const tools = [
    ...new Map(
      [
        ...catalog,
        ...server.tools
          .filter((name) => !catalog.some((tool) => tool.name === name))
          .map((name) => ({
            name,
            description: "Previously discovered · reconnect to refresh",
            readOnly: false,
          })),
      ].map((tool) => [tool.name, tool]),
    ).values(),
  ];

  function update(patch: Partial<McpServer>) {
    const next = { ...server, ...patch };
    setDiscovery((value) => (value?.server === server ? { ...value, server: next } : value));
    onUpdateModelValue(next);
  }
  function cancel() {
    controller.current?.abort();
    controller.current = null;
    setDiscovery((value) => (value ? { ...value, busy: false } : value));
  }
  async function inspect() {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setDiscovery({ server, tools: catalog, busy: true, error: "" });
    try {
      const result = await request("/api/settings/mcp/inspect", discoverySchema, {
        method: "POST",
        body: server,
        signal: active.signal,
      });
      if (active.signal.aborted) return;
      const next = { ...server, tools: result.tools.map((tool) => tool.name), planningTools: [] };
      setDiscovery({ server: next, tools: result.tools, busy: false, error: "" });
      publishServer.current(next);
    } catch (failure) {
      if (!active.signal.aborted)
        setDiscovery({
          server,
          tools: catalog,
          busy: false,
          error: failure instanceof Error ? failure.message : String(failure),
        });
    } finally {
      if (controller.current === active) controller.current = null;
    }
  }

  return (
    <article className="settings-card">
      <fieldset disabled={busy}>
        <div className="card-title">
          <Icon name="workflow" />
          <strong>{server.name}</strong>
          <label className="checkbox">
            <input
              checked={server.enabled}
              type="checkbox"
              aria-label={`Enable ${server.name}`}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            Enabled
          </label>
          <button className="icon-button" aria-label={`Remove ${server.name}`} onClick={onRemove}>
            <Icon name="close" />
          </button>
        </div>
        <div className="field-grid">
          <Field label="MCP server name">
            {({ id }) => (
              <input
                id={id}
                value={server.name}
                onChange={(event) => update({ name: event.target.value })}
              />
            )}
          </Field>
          <Field label="MCP transport">
            {({ id }) => (
              <select
                id={id}
                value={server.transport}
                onChange={(event) =>
                  update({ transport: event.target.value as McpServer["transport"] })
                }
              >
                <option value="http">Streamable HTTP</option>
                <option value="stdio">Local command (stdio)</option>
              </select>
            )}
          </Field>
        </div>
        {server.transport === "http" ? (
          <Field label="MCP endpoint">
            {({ id }) => (
              <input
                id={id}
                value={server.url}
                onChange={(event) => update({ url: event.target.value })}
              />
            )}
          </Field>
        ) : (
          <>
            <Field label="MCP executable">
              {({ id }) => (
                <input
                  id={id}
                  value={server.command}
                  placeholder="npx"
                  onChange={(event) => update({ command: event.target.value })}
                />
              )}
            </Field>
            <Field label="MCP arguments" help="One argument per line.">
              {({ id }) => (
                <textarea
                  id={id}
                  ref={argumentsRef}
                  value={server.args.join("\n")}
                  rows={3}
                  onChange={(event) =>
                    update({ args: event.target.value ? event.target.value.split("\n") : [] })
                  }
                />
              )}
            </Field>
          </>
        )}
        <Field
          label="Token environment variable (optional)"
          help="Name of a server-side environment variable. Its value is never returned to the browser."
        >
          {({ id }) => (
            <input
              id={id}
              value={server.tokenEnv ?? ""}
              placeholder="MY_MCP_TOKEN"
              onChange={(event) => update({ tokenEnv: event.target.value || undefined })}
            />
          )}
        </Field>
      </fieldset>
      <button disabled={busy} onClick={() => void inspect()}>
        {busy ? "Connecting…" : "Connect & discover tools"}
      </button>
      {busy && <button onClick={cancel}>Cancel discovery</button>}
      {current?.error && (
        <p className="inline-error" role="alert">
          {current.error}
        </p>
      )}
      <p className="muted">
        All tools from an enabled server are available to execution blocks. The coordinator does not
        call MCP tools while planning. Local servers inherit the application’s environment.
      </p>
      {tools.length > 0 && (
        <div className="mcp-tools">
          {tools.map((tool) => (
            <div key={tool.name}>
              <strong>{tool.name}</strong>
              <small>{tool.description}</small>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
