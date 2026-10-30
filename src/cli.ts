#!/usr/bin/env bun
import { realpath } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { initializeProject, loadLibrary } from "./library.js";
import { clientCommands, runClientCommand, readProgram, printRun, executionExitCode } from "./terminal-client.js";
import { waitForRun } from "./client.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      instructions: { type: "string", default: "" },
      port: { type: "string" },
      session: { type: "string" },
      "host-id": { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
      "max-task-cost": { type: "string" },
      "max-setup-cost": { type: "string" },
      regenerate: { type: "boolean", default: false },
      demo: { type: "boolean", default: false },
      "no-ai": { type: "boolean", default: false },
      input: { type: "string", default: "{}" },
      approve: { type: "boolean", default: false },
      "no-web": { type: "boolean", default: false },
      server: { type: "string" },
      wait: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "temporal-address": { type: "string" },
      "temporal-namespace": { type: "string", default: "default" },
      "temporal-workflow-bundle": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0] ?? "start";
  if (values.help || command === "help") {
    console.log(`Usage:
  workflow init [--instructions "Project constraints"]  Create local configuration; no AI call
  workflow setup [--model provider/id] [--thinking level] [--instructions "Preferences"] [--regenerate] [--max-setup-cost USD]
  workflow profiles [--instructions "Model preferences"]
  workflow [start] [--port 4310] [--no-web] [--demo] [--json]  Start or reuse a background host
  workflow status [--json]      Inspect this project's host
  workflow stop [--json]        Stop the verified host and drain its worker
  workflow serve [--port 4310] [--no-web] [--demo]  Foreground host
  workflow tui [session-id] [--session ID] [--server URL] [--demo]
  workflow attach <session-id> [--server URL]  Reopen the same session in the terminal
  workflow exec <file.ts> [--input JSON] [--json]
  workflow run <file.ts> [--input JSON] [--approve] [--wait]
  workflow task "Request" [--max-task-cost USD]  Budget planning and execution together
  workflow usage [task-or-run-id] [--json]  Inspect persisted project/session spending
  workflow tasks               List tasks
  workflow task-show <task-id>  Inspect planning, questions, and the linked run
  workflow answer <task-id> "Answer"
  workflow runs                List runs
  workflow show <run-id>        Inspect the full draft or result
  workflow approve <run-id> [--wait]
  workflow reject <run-id>
  workflow events <run-id>      Print persisted activity
  workflow watch <run-id>       Wait until completion or attention is needed
  workflow pause <run-id>       Pause after the current step
  workflow resume <run-id>      Resume or explicitly retry an interrupted step
  workflow cancel <run-id>
  workflow recover <run-id>
  workflow login [provider]    Connect an account or API key in the terminal UI
  workflow logout [provider]
  workflow model [search]
  workflow thinking
  workflow auth

Run workflow from your project folder. State lives in .workflow/ in the current directory.
serve includes the web UI; --no-web starts only the API and worker.
tui starts or attaches to a detached project host; execution continues after every client closes.
Use /web for the browser URL, and workflow stop to shut down the host.
Session IDs open saved work; workflow resume <run-id> explicitly restarts paused execution.
exec explicitly approves and executes a TypeScript workflow without an HTTP server or GUI.
run creates a draft on a running server; inspect it with show, then approve it.
Client commands accept --port, --server URL (explicitly selects that server's project), and --json.
watch/--wait/exec exit 0 on completion, 1 on failure/cancellation, 2 when attention is needed.
--demo simulates agents/checks. Advanced: --temporal-address host:port --temporal-namespace name.
Provider credentials belong to Workflow, outside the project; Pi does not need to be installed.`);
    return;
  }
  if (["login", "logout", "model", "thinking", "auth"].includes(command)) {
    if (positionals.length > 2) { throw new Error("Expected a command and an optional provider/model search"); }
    const { runTerminalCommand } = await import("./terminal-commands.js");
    await runTerminalCommand(command, positionals[1]);
    return;
  }
  const project = await realpath(process.cwd());
  const costLimit = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Spending limits must be positive finite USD amounts");
    return parsed;
  };
  const maxTaskCostUsd = costLimit(values["max-task-cost"]), maxSetupCostUsd = costLimit(values["max-setup-cost"]);
  if (maxTaskCostUsd !== undefined && command !== "task") throw new Error("--max-task-cost is a task request override; configure project defaults in Settings for other workflows.");
  if (maxSetupCostUsd !== undefined && !["setup", "generate"].includes(command)) throw new Error("--max-setup-cost applies to workflow setup or generate.");
  if (["start", "status", "stop"].includes(command)) {
    if (positionals.length > 1 || values.server) throw new Error(`Use workflow ${command} from the project folder, with optional --port and --json.`);
    const { startProjectHost, projectHostStatus, stopProjectHost } = await import("./host-lifecycle.js");
    const port = values.port === undefined ? undefined : Number(values.port);
    const result = command === "start"
      ? await startProjectHost({ project, port, mode: values.demo ? "demo" : "live", web: values["no-web"] ? false : undefined,
          temporal: { address: values["temporal-address"], namespace: values["temporal-namespace"], workflowBundlePath: values["temporal-workflow-bundle"] } })
      : command === "stop" ? await stopProjectHost(project, port) : await projectHostStatus(project, port);
    if (values.json) console.log(JSON.stringify(result));
    else if (result.status === "stopped") console.log(`Workflow stopped · ${project}`);
    else console.log(`Workflow ${result.mode.toUpperCase()} · ${result.status} · ${result.url} · ${result.background ? "background" : "foreground"}\nProject: ${project}\nHost: ${result.hostId} · PID ${result.pid}\nUse workflow stop to shut down the host.`);
    return;
  }
  if (command === "tui" || command === "attach") {
    if (positionals.length > 2 || positionals[1] && values.session) throw new Error("Use workflow tui [session-id] or --session ID, with optional --server URL.");
    const session = values.session ?? positionals[1];
    if (command === "attach" && !session) throw new Error("Use workflow attach <task-or-run-id> [--server URL].");
    // Keep the native renderer in a separately loaded bundle for headless commands.
    const terminalEntry = new URL("./tui.js", import.meta.url).href;
    const { runTerminalWorkspace } = await import(terminalEntry) as typeof import("./tui.js");
    await runTerminalWorkspace({ project, port: values.port === undefined ? undefined : Number(values.port), server: values.server, demo: values.demo, session,
      temporal: { address: values["temporal-address"], namespace: values["temporal-namespace"], workflowBundlePath: values["temporal-workflow-bundle"] } });
    return;
  }
  if (clientCommands.includes(command)) {
    await runClientCommand(command, positionals.slice(1), {
      project, port: values.port, server: values.server, input: values.input,
      approve: values.approve, wait: values.wait, json: values.json,
      maxTaskCostUsd,
    });
    return;
  }
  if (command === "exec") {
    if (positionals.length !== 2) throw new Error("Expected workflow exec <file.ts> [--input JSON]");
    if (values.server) throw new Error("exec runs locally; use run --server URL --approve --wait for a server");
    const program = await readProgram(project, positionals[1], values.input);
    const { createApplication } = await import("./core/index.js");
    const controller = new AbortController();
    const stop = () => controller.abort(new Error("Execution interrupted. Resume the saved run with workflow serve and workflow resume."));
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    let app: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      app = await createApplication({ project, mode: values.demo ? "demo" : "live", startTriggers: false,
        temporal: { address: values["temporal-address"], namespace: values["temporal-namespace"], workflowBundlePath: values["temporal-workflow-bundle"] } });
      controller.signal.throwIfAborted();
      const draft = await app.createProgram(program, controller.signal);
      controller.signal.throwIfAborted();
      const running = await app.approve(draft.id, draft.revision);
      const current = app;
      const run = await waitForRun(() => current.getRun(running.id), {
        signal: controller.signal,
        onUpdate: values.json ? undefined : updated => console.error(`${updated.id} · ${updated.status}`),
      });
      printRun(run, values.json);
      process.exitCode = executionExitCode(run);
    } finally {
      try { await app?.close(); }
      finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    }
    return;
  }
  if (positionals.length > 1) {
    throw new Error("Expected one command: init, setup, profiles or serve");
  }
  if (command === "init") {
    const library = await initializeProject(project, values.instructions);
    console.log(
      `Created ${path.join(project, ".workflow")} with ${Object.keys(library.blocks).length} blocks.`,
    );
    console.log(
      Object.keys(library.config.commands).length
        ? `Detected a test script. Checks use ${library.config.commands.test?.argv.join(" ")}. Configure commands and block instructions in Settings.`
        : "No test command detected. Add commands and block checks before relying on test-gated completion.",
    );
    console.log("Next: workflow login (once per user), workflow model (choose a default), then workflow setup to tailor blocks, model profiles, and task workflows to this project.");
    return;
  }
  if (command === "setup" || command === "generate") {
    const { initializeSetup } = await import("./initialize-setup.js");
    if (values.thinking && !values.model) throw new Error("Use --thinking together with --model provider/id, or workflow thinking to change your user default.");
    if (values.model) {
      const split = values.model.indexOf("/");
      if (split < 1 || split === values.model.length - 1) throw new Error("Use --model provider/model-id.");
      const [{ availableModels }, { projectModelSettings, updateProjectModel }] = await Promise.all([import("./available-models.js"), import("./project-model.js")]);
      const catalog = await availableModels(AbortSignal.timeout(30_000), true);
      const provider = values.model.slice(0, split), model = values.model.slice(split + 1);
      const choice = catalog.models.find(item => item.provider === provider && item.id === model);
      if (!choice) throw new Error(`Model ${values.model} is not available from your connected providers. Run workflow login or workflow model.`);
      const thinking = values.thinking ?? (choice.thinkingLevels.includes("medium") ? "medium" : choice.thinkingLevels[0] ?? "off");
      await updateProjectModel(project, { configRevision: (await projectModelSettings(project)).configRevision, agent: { provider, model, thinking } }, catalog.models);
    }
    console.log("Tailoring reusable blocks, model profiles, and task workflows with your default model…");
    const setup = await initializeSetup(project, { instructions: values.instructions, maxSetupCostUsd, regenerate: values.regenerate || command === "generate", emit: (_kind, message) => console.error(message) });
    if (setup.status === "unconnected") throw new Error("No connected provider. Run workflow login, choose workflow model, then retry workflow setup.");
    console.log(`${setup.status === "existing" ? "Kept" : "Generated"} ${setup.profiles} model profiles, ${setup.cases} task workflows, and ${setup.blocks} blocks. Run workflow or workflow tui to start working.`);
    return;
  }
  if (command === "profiles") {
    const { initializeProfiles } = await import("./initialize-profiles.js");
    console.log("Generating model profiles from the project and connected catalog…");
    const profiles = await initializeProfiles(project, { instructions: values.instructions, regenerate: true });
    if (profiles.status === "unconnected") { throw new Error("Connect a provider in Settings before generating model profiles."); }
    console.log(`Saved ${profiles.count} model profiles. Review them in Settings → Model profiles.`);
    return;
  }
  if (command !== "serve" && command !== "__host") {
    throw new Error(`Unknown command: ${command}`);
  }
  const port = Number(values.port ?? "4310");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Port must be an integer between 0 and 65535");
  }
  try {
    await loadLibrary(project);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `No complete .workflow/ configuration in ${project}. Run workflow init in this folder first.`,
      );
    }
    throw error;
  }
  const { runHost } = await import("./host.js");
  await runHost({ project, port, mode: values.demo ? "demo" : "live", web: !values["no-web"],
    background: command === "__host", hostId: values["host-id"],
    temporal: { address: values["temporal-address"], namespace: values["temporal-namespace"], workflowBundlePath: values["temporal-workflow-bundle"] } });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.connected) process.send?.({ type: "error", message }, () => { process.disconnect?.(); });
  process.exitCode = 1;
});
