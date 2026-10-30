import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { WorkflowClient } from "../client/client.js";
import { projectHostStatus, startProjectHost } from "../host/host-lifecycle.js";
import { startSetupSchema, type SetupJob } from "../contracts/setup-job-schema.js";
import type { TemporalOptions } from "../infrastructure/temporal-runtime.js";

export const setupCommands = ["setup", "generate", "setup-status", "setup-resume", "setup-cancel"];
function print(job: SetupJob | null, json: boolean) {
  if (json) console.log(JSON.stringify(job));
  else if (!job)
    console.log("No setup job yet. Run workflow setup to generate project configuration.");
  else {
    console.log(
      `${job.id} · ${job.status} · ${job.stage} · ${job.model.provider}/${job.model.model}`,
    );
    for (const stage of job.stages)
      console.log(
        `${stage.id.padEnd(12)} ${stage.status}${stage.summary ? ` · ${stage.summary}` : ""}`,
      );
    if (job.error) console.log(job.error);
    if (job.status === "completed" && job.result)
      console.log(
        `Saved ${job.result.profiles} profiles, ${job.result.cases} task workflows, and ${job.result.blocks} blocks.`,
      );
    else
      console.log(
        `Inspect: workflow setup-status ${job.id}${job.actions.canResume ? `\nResume: workflow setup-resume ${job.id}` : ""}`,
      );
  }
}

export async function runSetupCommand(
  command: string,
  args: string[],
  options: {
    project: string;
    port?: string;
    server?: string;
    model?: string;
    thinking?: string;
    instructions?: string;
    regenerate: boolean;
    maxSetupCostUsd?: number;
    json: boolean;
    wait: boolean;
    demo?: boolean;
    web?: boolean;
    temporal?: TemporalOptions;
  },
) {
  const start = command === "setup" || command === "generate";
  if (
    args.length > (command === "setup-status" ? 1 : start ? 0 : 1) ||
    (!start && command !== "setup-status" && !args.length)
  )
    throw new Error(`Use workflow ${command}${start ? "" : " <setup-id>"}`);
  let baseUrl = options.server;
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("--server must be an HTTP(S) URL without credentials, query, or fragment");
  } else {
    const port = options.port === undefined ? undefined : Number(options.port);
    const host =
      start || command === "setup-resume"
        ? await startProjectHost({
            project: options.project,
            port,
            mode: options.demo ? "demo" : "live",
            web: options.web,
            temporal: options.temporal,
          })
        : await projectHostStatus(options.project, port);
    if (host.status === "stopped")
      throw new Error(
        "Workflow is stopped. Run workflow start to inspect or cancel its saved setup job.",
      );
    baseUrl = host.url;
  }
  const client = new WorkflowClient({ baseUrl });
  let job: SetupJob | null;
  if (start) {
    if (options.thinking && !options.model)
      throw new Error(
        "Use --thinking with --model provider/model-id, or workflow thinking to change the shared default.",
      );
    const split = options.model?.indexOf("/");
    if (options.model && (!split || split < 1 || split === options.model.length - 1))
      throw new Error("Use --model provider/model-id.");
    const model = options.model
      ? {
          provider: options.model.slice(0, split),
          model: options.model.slice(split! + 1),
          thinking: options.thinking,
        }
      : undefined;
    job = await client.startSetup(
      startSetupSchema.parse({
        instructions: options.instructions,
        regenerate: options.regenerate || command === "generate",
        maxSetupCostUsd: options.maxSetupCostUsd,
        model,
      }),
      AbortSignal.timeout(45_000),
    );
  } else {
    job = args[0]
      ? await client.setupJob(z.string().uuid().parse(args[0]), AbortSignal.timeout(5000))
      : (await client.latestSetup(AbortSignal.timeout(5000))).job;
    if (command === "setup-resume" && job)
      job = await client.resumeSetup(
        job.id,
        job.revision,
        AbortSignal.timeout(5000),
        options.maxSetupCostUsd,
      );
    if (command === "setup-cancel" && job)
      job = await client.cancelSetup(job.id, job.revision, AbortSignal.timeout(30_000));
  }
  if (options.wait && job && ["queued", "running", "cancelling"].includes(job.status)) {
    const controller = new AbortController();
    const stop = () =>
      controller.abort(new Error("Stopped waiting; setup continues in the background host."));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      let previous = "";
      while (["queued", "running", "cancelling"].includes(job.status)) {
        const progress = `${job.id} · ${job.status} · ${job.stage}`;
        if (progress !== previous) {
          console.error(progress);
          previous = progress;
        }
        await delay(500, undefined, { signal: controller.signal });
        job = await client.setupJob(job.id, controller.signal);
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      if (!options.json) console.log(String(controller.signal.reason));
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
  print(job, options.json);
  if (job && !options.json) {
    const usage = await client.setupUsage(job.id, AbortSignal.timeout(5000));
    console.log(
      `Known setup cost: $${usage.total.costUsd.toFixed(6)}${usage.limits.totalCostUsd === undefined ? "" : ` / $${usage.limits.totalCostUsd} total limit`}`,
    );
    for (const warning of usage.warnings) console.log(warning);
  }
  if (
    options.wait &&
    job &&
    ["failed", "conflicted", "cancelled", "interrupted"].includes(job.status)
  )
    process.exitCode = 1;
}
