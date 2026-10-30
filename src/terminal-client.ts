import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { WorkflowClient, waitForRun } from "./client.js";
import type { CreateProgram, RunAction, WorkflowRun } from "./contracts.js";
import { discoverProjectServer } from "./host-discovery.js";
import { exportAttemptEvidence, formatEvidenceExport } from "./evidence-export.js";
import { runMemoryCommand } from "./memory-client.js";

export const clientCommands = ["run", "runs", "show", "events", "watch", "approve", "reject", "pause", "resume", "cancel", "recover", "tasks", "task", "task-show", "answer", "usage", "data", "memory"];
export async function readProgram(project: string, filename: string | undefined, inputJson: string): Promise<CreateProgram> {
  if (!filename?.endsWith(".ts")) throw new Error("Expected a project-relative TypeScript file (*.ts)");
  const relative = path.relative(project, path.resolve(project, filename));
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Workflow source must be inside the current project");
  const input = z.record(z.string(), z.json()).parse(JSON.parse(inputJson));
  const title = path.basename(relative, ".ts");
  return { filename: relative, source: await readFile(path.resolve(project, relative), "utf8"), input, title,
    task: typeof input.request === "string" ? input.request : title };
}
export function printRun(run: WorkflowRun, json: boolean) {
  console.log(json ? JSON.stringify(run) : `${run.id} · ${run.status}${run.error ? ` · ${run.error}` : ""}`);
}
export function executionExitCode(run: WorkflowRun) {
  return run.status === "completed" ? 0 : ["draft", "paused", "interrupted"].includes(run.status) ? 2 : 1;
}

export async function runClientCommand(command: string, args: string[], options: {
  project: string; port?: string; server?: string; input: string; approve: boolean; wait: boolean; json: boolean;
  maxTaskCostUsd?: number;
}) {
  const port = Number(options.port ?? "4310");
  if (!options.server && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Port must be between 1 and 65535");
  if (options.server) {
    const url = new URL(options.server);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("--server must be an HTTP(S) URL without credentials, query, or fragment");
    }
  }
  const discovered = !options.server && options.port === undefined ? await discoverProjectServer(options.project) : undefined;
  let baseUrl = options.server ?? discovered ?? `http://127.0.0.1:${port}`;
  if (discovered && !await fetch(`${discovered}/api/health`, { signal: AbortSignal.timeout(1500) }).then(response => response.ok).catch(() => false)) baseUrl = `http://127.0.0.1:${port}`;
  const client = new WorkflowClient({ baseUrl });
  const served = await client.project(AbortSignal.timeout(5000));
  // An explicit endpoint selects that server's project, including over an SSH tunnel.
  if (!options.server && await realpath(served.project) !== await realpath(options.project)) throw new Error("The local server belongs to another project");
  if (command === "memory") { await runMemoryCommand(client, args, options); return; }
  if (command === "data") {
    if (args.length < 2 || args.length > 3) throw new Error("Use workflow data <run-id> <step-id> [visit] [--json].");
    const signal = AbortSignal.timeout(60_000);
    const run = await client.run(z.string().uuid().parse(args[0]), signal);
    const nodeId = args[1]!;
    const visit = args[2] ? z.coerce.number().int().positive().parse(args[2]) : run.visits[nodeId];
    if (!visit) throw new Error("This step has not run yet. Use workflow show to inspect the draft.");
    const evidence = await exportAttemptEvidence(client, run.id, nodeId, visit, signal);
    console.log(options.json ? JSON.stringify(evidence) : formatEvidenceExport(evidence));
    return;
  }
  if (command === "usage") {
    if (args.length > 1) throw new Error("workflow usage accepts at most one task or run ID");
    const signal = AbortSignal.timeout(15_000);
    const selected = args[0] ? await client.resolveSession(args[0], signal) : undefined;
    const report = !selected ? await client.usage(signal) : selected.kind === "task" ? await client.taskUsage(selected.id, signal) : await client.runUsage(selected.id, signal);
    if (options.json) console.log(JSON.stringify(report));
    else {
      console.log(`${report.scope.kind} usage · $${report.total.costUsd.toFixed(6)} known cost · ${report.total.requests} reported requests`);
      for (const phase of report.phases) console.log(`${phase.phase.padEnd(12)} $${phase.usage.costUsd.toFixed(6)} · ${phase.usage.requests} requests`);
      if (report.limits.totalCostUsd !== undefined) console.log(`Total limit: $${report.limits.totalCostUsd}; remaining: ${report.limits.remainingCostUsd === null ? "unknown" : `$${report.limits.remainingCostUsd.toFixed(6)}`}`);
      for (const warning of report.warnings) console.log(warning);
    }
    return;
  }
  const expectedArgs = ["runs", "tasks"].includes(command) ? 0 : command === "answer" ? 2 : 1;
  if (args.length !== expectedArgs) throw new Error(`workflow ${command} expects ${expectedArgs} argument(s)`);
  if (command === "runs") {
    const runs = await client.runs(AbortSignal.timeout(5000));
    if (options.json) console.log(JSON.stringify(runs));
    else for (const run of runs) console.log(`${run.id}  ${run.status.padEnd(12)} ${run.title}`);
    return;
  }
  if (command === "tasks") {
    const tasks = await client.tasks(AbortSignal.timeout(5000));
    if (options.json) console.log(JSON.stringify(tasks));
    else for (const task of tasks) console.log(`${task.id}  ${task.status.padEnd(12)} ${task.prompt}`);
    return;
  }
  if (["task", "task-show", "answer"].includes(command)) {
    const signal = AbortSignal.timeout(15_000);
    const task = command === "task" ? await client.createTask(args[0]!, signal, options.maxTaskCostUsd)
      : command === "task-show" ? await client.task(z.string().uuid().parse(args[0]), signal)
      : await client.answerTask(z.string().uuid().parse(args[0]), args[1]!, (await client.task(args[0]!, signal)).revision, signal);
    console.log(JSON.stringify(task, null, options.json ? undefined : 2));
    return;
  }
  if (command === "events") {
    const events = await client.events(z.string().uuid().parse(args[0]), AbortSignal.timeout(5000));
    if (options.json) console.log(JSON.stringify(events));
    else for (const event of events) console.log(`${event.time} ${event.kind} ${event.message}`);
    return;
  }
  let run: WorkflowRun;
  if (command === "run") {
    run = await client.createProgram(await readProgram(options.project, args[0], options.input), AbortSignal.timeout(120_000));
    if (options.approve) run = await client.action(run.id, "approve", run.revision, AbortSignal.timeout(120_000));
  } else {
    const id = z.string().uuid().parse(args[0]);
    run = command === "show" || command === "watch" ? await client.run(id, AbortSignal.timeout(5000))
      : await client.action(id, command as RunAction,
        command === "approve" ? (await client.run(id, AbortSignal.timeout(5000))).revision : undefined, AbortSignal.timeout(120_000));
  }
  if (options.wait || command === "watch") {
    const controller = new AbortController();
    const stop = () => controller.abort(new Error("Stopped waiting. The server retains control of this run."));
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      run = await waitForRun(() => client.run(run.id, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])), {
        signal: controller.signal,
        onUpdate: options.json ? undefined : updated => console.error(`${updated.id} · ${updated.status}`),
      });
      process.exitCode = executionExitCode(run);
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  }
  if (command === "show") console.log(JSON.stringify(run, null, options.json ? undefined : 2));
  else printRun(run, options.json);
}
