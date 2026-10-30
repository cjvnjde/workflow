import path from "node:path";
import { userPaths } from "./user-settings.js";
import { realpath } from "node:fs/promises";
import { WorkflowClient } from "./client.js";
import type { TemporalOptions } from "./temporal-runtime.js";
import { discoverProjectServer } from "./host-discovery.js";

export interface TerminalOptions {
  project: string;
  port?: number;
  server?: string;
  demo?: boolean;
  temporal?: TemporalOptions;
  session?: string;
  signal?: AbortSignal;
}

/** Host ownership stays outside the presentation and its HTTP-only controller. */
export async function connectTerminal(options: TerminalOptions) {
  const port = options.port ?? 4310;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be between 0 and 65535");
  if (options.server) {
    const url = new URL(options.server);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("--server requires an HTTP(S) URL without credentials, query, or fragment");
    const client = new WorkflowClient({ baseUrl: options.server });
    const project = await client.project(AbortSignal.timeout(5000));
    if (options.demo && project.mode !== "demo") throw new Error("The selected server is live. Start a demo engine before attaching with --demo.");
    return { client, owned: false, started: false, close: async () => {} };
  }
  const discovered = options.port === undefined ? await discoverProjectServer(options.project) : undefined;
  const candidates = [...new Set([...(discovered ? [discovered] : []), ...(port ? [`http://127.0.0.1:${port}`] : [])])];
  for (const baseUrl of candidates) {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) }).catch(() => undefined);
    if (response) {
      if (!response.ok) throw new Error(`The service at ${baseUrl} is not a ready Workflow server.`);
      const client = new WorkflowClient({ baseUrl });
      const project = await client.project(AbortSignal.timeout(5000));
      if (await realpath(project.project) !== await realpath(options.project)) throw new Error("The local server belongs to another project. Use --port 0 for a private engine or --server to select it explicitly.");
      if (project.mode !== (options.demo ? "demo" : "live")) throw new Error(`The running host is ${project.mode}. Use the matching --demo mode, or workflow stop before switching modes.`);
      return { client, owned: false, started: false, close: async () => {} };
    }
  }
  const { startProjectHost } = await import("./host-lifecycle.js");
  const host = await startProjectHost({ project: options.project, port: options.port, mode: options.demo ? "demo" : "live",
    temporal: options.temporal, signal: options.signal });
  return { client: new WorkflowClient({ baseUrl: host.url }), owned: false, started: host.started, close: async () => {} };
}

export async function runTerminalWorkspace(options: TerminalOptions) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("workflow tui requires an interactive terminal. Use workflow run/exec for scripts.");
  let stop!: () => void;
  const finished = new Promise<void>(resolve => { stop = resolve; });
  let stopping = false;
  const startup = new AbortController();
  const onStop = () => { stopping = true; startup.abort(new Error("Terminal startup cancelled")); stop(); };
  process.once("SIGINT", onStop); process.once("SIGTERM", onStop);
  let host: Awaited<ReturnType<typeof connectTerminal>> | undefined;
  let renderer: import("@opentui/core").CliRenderer | undefined;
  let parser: import("@opentui/core").TreeSitterClient | undefined;
  let controller: import("./tui/controller.js").TerminalController | undefined;
  let view: import("./tui/view.js").TerminalWorkspace | undefined;
  try {
    console.log("Starting Workflow terminal workspace…");
    host = await connectTerminal({ ...options, signal: startup.signal });
    if (stopping) return;
    const [{ createCliRenderer, TreeSitterClient }, { TerminalController }, { TerminalWorkspace }, { colors }] = await Promise.all([
      import("@opentui/core"), import("./tui/controller.js"), import("./tui/view.js"), import("./tui/presentation.js"),
    ]);
    renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], backgroundColor: colors.base,
      targetFps: 30, maxFps: 60, useMouse: true, openConsoleOnError: false, onDestroy: onStop });
    controller = new TerminalController(host.client);
    controller.on("quit", onStop);
    parser = new TreeSitterClient({ dataPath: path.join(userPaths().directory, "cache", "terminal") });
    view = new TerminalWorkspace(renderer, controller, parser);
    await controller.initialize();
    if (options.session) await controller.openSessionById(options.session);
    controller.state.notice = `${host.started ? "Background host started" : "Attached to server"} · execution continues after clients close. Use workflow stop to shut down.\nBrowser: ${controller.browserUrl()}`;
    controller.changed();
    if (!stopping) await finished;
  } finally {
    try { await controller?.close(); }
    finally {
      try {
        try { view?.destroy(); }
        finally {
          try { await parser?.destroy(); }
          finally { renderer?.destroy(); await renderer?.closed; }
        }
      }
      finally {
        try { await host?.close(); }
        finally { process.removeListener("SIGINT", onStop); process.removeListener("SIGTERM", onStop); }
      }
    }
  }
}
