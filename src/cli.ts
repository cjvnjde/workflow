#!/usr/bin/env bun
import { readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import path from "node:path";
import { parseArgs } from "node:util";
import { initializeProject, loadLibrary } from "./library.js";
import { runSchema } from "./domain.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      instructions: { type: "string", default: "" },
      port: { type: "string", default: "4310" },
      demo: { type: "boolean", default: false },
      "no-ai": { type: "boolean", default: false },
      input: { type: "string", default: "{}" },
      approve: { type: "boolean", default: false },
      "temporal-address": { type: "string" },
      "temporal-namespace": { type: "string", default: "default" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0] ?? "serve";
  if (values.help || command === "help") {
    console.log(
      'Usage:\n  workflow login [provider]     Connect an account or API key in the terminal UI\n  workflow logout [provider]    Remove saved credentials in the terminal UI\n  workflow model [search]       Choose a default model in the terminal UI\n  workflow thinking             Choose default thinking in the terminal UI\n  workflow auth                 Show connection metadata (never secrets)\n  workflow init [--instructions "Project constraints"] [--no-ai]\n  workflow profiles [--instructions "Model preferences"]  Regenerate model profiles with AI\n  workflow [serve] [--port 4310] [--demo]\n  workflow runs                 List runs from the local server\n  workflow pause <run-id>        Pause after the current step\n  workflow resume <run-id>       Resume, or explicitly retry an interrupted step\n  workflow cancel <run-id>       Cancel a running or paused workflow\n  workflow recover <run-id>      Retry safe file recovery after a conflict\n\nRun workflow from your project folder. Configuration and run state live in .workflow/ in the current directory. Provider credentials belong to workflow, outside the project; Pi does not need to be installed. The command includes the web UI and manages a persistent local Temporal server. Use --demo to simulate agents and checks. Advanced: --temporal-address host:port --temporal-namespace name connects to an existing server.',
    );
    console.log('\n  workflow run <file.ts> [--input \'{"request":"..."}\'] [--approve]\n    Typecheck a TypeScript workflow and create a draft on the local server.\n    --approve starts it immediately; otherwise review it in the web UI.');
    return;
  }
  if (["login", "logout", "model", "thinking", "auth"].includes(command)) {
    if (positionals.length > 2) { throw new Error("Expected a command and an optional provider/model search"); }
    const { runTerminalCommand } = await import("./terminal-commands.js");
    await runTerminalCommand(command, positionals[1]);
    return;
  }
  const project = await realpath(process.cwd());
  if (["run", "runs", "pause", "resume", "cancel", "recover"].includes(command)) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error("Port must be between 1 and 65535"); }
    const base = `http://127.0.0.1:${port}`;
    const projectResponse = await fetch(`${base}/api/project`, { signal: AbortSignal.timeout(5000) });
    const served = z.object({ project: z.string() }).parse(await projectResponse.json());
    if (await realpath(served.project) !== project) { throw new Error("The local server belongs to another project"); }
    if (command === "run") {
      if (positionals.length !== 2 || !positionals[1]?.endsWith(".ts")) throw new Error("Expected workflow run <file.ts> [--input JSON] [--approve]");
      const filename = path.relative(project, path.resolve(project, positionals[1]));
      const input = z.record(z.string(), z.json()).parse(JSON.parse(values.input));
      const title = path.basename(filename, ".ts");
      const response = await fetch(`${base}/api/programs`, {
        method: "POST", headers: { "x-workflow-client": "1", "content-type": "application/json" },
        body: JSON.stringify({ filename, source: await readFile(path.resolve(project, filename), "utf8"), input, title,
          task: typeof input.request === "string" ? input.request : title }),
        signal: AbortSignal.timeout(120_000),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(body).error);
      let run = runSchema.parse(body);
      if (values.approve) {
        const approved = await fetch(`${base}/api/runs/${run.id}/approve`, {
          method: "POST", headers: { "x-workflow-client": "1", "content-type": "application/json", "if-match": `"${run.revision}"` },
          body: "{}", signal: AbortSignal.timeout(120_000),
        });
        const result: unknown = await approved.json();
        if (!approved.ok) throw new Error(z.object({ error: z.string() }).parse(result).error);
        run = runSchema.parse(result);
      }
      console.log(`${run.id} · ${run.status} · ${base}/?run=${run.id}`);
      return;
    }
    if (command === "runs") {
      const response = await fetch(`${base}/api/runs`, { signal: AbortSignal.timeout(5000) });
      const runs = z.array(z.object({ id: z.string(), status: z.string(), title: z.string() })).parse(await response.json());
      for (const run of runs) { console.log(`${run.id}  ${run.status.padEnd(12)} ${run.title}`); }
      return;
    }
    const id = z.string().uuid().parse(positionals[1]);
    const response = await fetch(`${base}/api/runs/${id}/${command}`, {
      method: "POST", headers: { "x-workflow-client": "1", "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json();
    if (!response.ok) { throw new Error(z.object({ error: z.string() }).parse(body).error); }
    const run = runSchema.parse(body);
    console.log(`${run.id} · ${run.status}${command === "pause" ? " · current step finishes before pausing" : ""}`);
    return;
  }
  if (positionals.length > 1) {
    throw new Error("Expected one command: init, profiles or serve");
  }
  if (command === "init") {
    const library = await initializeProject(project, values.instructions);
    console.log(
      `Created ${path.join(project, ".workflow")} with ${Object.keys(library.blocks).length} blocks.`,
    );
    console.log(
      Object.keys(library.config.commands).length
        ? "Detected a test script. Checks use bun run test. Configure commands and block instructions in Settings."
        : "No test command detected. Add commands and block checks before relying on test-gated completion.",
    );
    if (!values["no-ai"]) {
      const { initializeProfiles } = await import("./initialize-profiles.js");
      try {
        console.log("Preparing model profiles from your connected models…");
        const profiles = await initializeProfiles(project, { instructions: values.instructions });
        console.log(profiles.status === "unconnected" ? "Connect ChatGPT in Settings, then use Model profiles → Generate with AI to finish setup." : `${profiles.status === "existing" ? "Kept" : "Generated"} ${profiles.count} model profiles. Review them in Settings → Model profiles.`);
      } catch (error) {
        console.error(`Project initialized; model profile generation needs attention: ${error instanceof Error ? error.message : String(error)}. Retry with workflow profiles or in Settings.`);
      }
    }
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
  if (command !== "serve") {
    throw new Error(`Unknown command: ${command}`);
  }
  const port = Number(values.port);
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
  const [{ WorkflowEngine }, { runDemoBlock, runPiBlock }, { createServer }] = await Promise.all([
    import("./engine.js"), import("./block-runner.js"), import("./server.js"),
  ]);
  const engine = new WorkflowEngine(
    project,
    values.demo ? "demo" : "live",
    values.demo ? runDemoBlock : runPiBlock,
    { address: values["temporal-address"], namespace: values["temporal-namespace"] },
  );
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await engine.initialize();
    server = await createServer(engine, port);
    const address = await server.listen({ port, host: "127.0.0.1" });
    console.log(
      `Workflow ${engine.mode.toUpperCase()} · ${address}\nProject: ${project}`,
    );
    if (values.demo) {
      console.log(
        "DEMO: agents and checks are simulated. No task files are changed.",
      );
    }
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } finally {
    try { await server?.close(); } finally { await engine.shutdown(); }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
