import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resultSchema, type WorkflowRun } from "./domain.js";
import type { CodeOperation } from "./code-schema.js";
import type { ExecResult } from "./workflow-sdk.js";
import { localExecutionEnvironment, type ExecutionEnvironmentFactory } from "./execution-environment.js";
import type { FileJournal } from "./recovery.js";
import type { CommandOutputRef } from "./operation-schema.js";

/** Host command effect. The TypeScript callback itself stays in durable history. */
export async function executeCodeCommand(
  project: string,
  run: WorkflowRun,
  operation: Extract<CodeOperation, { kind: "exec" }>,
  signal: AbortSignal,
  emit: (kind: string, message: string) => void,
  options: { environmentFactory?: ExecutionEnvironmentFactory; journal?: FileJournal; outputDirectory?: string; onCapture?: (ref: CommandOutputRef) => void; onEnvironment?: (id: string) => void } = {},
): Promise<ExecResult> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-command-"));
  const input = path.join(directory, "input.json"),
    output = path.join(directory, "result.json");
  const node = run.plan.nodes.find((node) => node.id === run.cursor)!;
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending) emit("script_output", pending);
    pending = "";
  };
  try {
    // Older scripts can keep their JSON input/result convention when converted
    // to a code block. Ordinary commands need neither file.
    await writeFile(
      input,
      JSON.stringify({
        version: 1,
        project,
        task: run.plan.task,
        node: { id: node.id, label: node.label, goal: node.goal },
        visit: run.visits[node.id],
        inputs: node.context ?? {},
        outputs: run.blocks[node.block]?.definition.outputs ?? [],
        attachments: run.config.attachments ?? [],
      }),
      { mode: 0o600 },
    );
    const factory = options.environmentFactory ?? localExecutionEnvironment;
    const environment = await factory({ project, signal, journal: options.journal, outputDirectory: options.outputDirectory, onCapture: options.onCapture });
    options.onEnvironment?.(environment.id);
    // Legacy JSON-file exchange names host-local temp files. A custom execution
    // world must opt into its own protocol instead of receiving unusable paths.
    if (factory !== localExecutionEnvironment && /\bWORKFLOW_(INPUT|RESULT)\b/.test(operation.command)) {
      throw new Error("WORKFLOW_INPUT/WORKFLOW_RESULT compatibility commands require the local execution environment");
    }
    const result: ExecResult = await environment.exec(operation.command, {
      timeoutMs: operation.timeoutMs,
      env: {
        ...operation.env,
        ...(factory === localExecutionEnvironment ? { WORKFLOW_INPUT: input, WORKFLOW_RESULT: output, WORKFLOW_PROJECT: project } : {}),
      },
      signal,
      onOutput(chunk) {
        pending = (pending + chunk).slice(-6000);
        timer ??= setTimeout(flush, 150);
      },
    });
    signal.throwIfAborted();
    const info = await lstat(output).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    if (info) {
      if (!info.isFile() || info.size > 256_000)
        throw new Error(
          "Command result must be a regular JSON file below 256 KB",
        );
      result.result = resultSchema.parse(
        JSON.parse(await readFile(output, "utf8")),
      );
    }
    return result;
  } finally {
    flush();
    await rm(directory, { recursive: true, force: true });
  }
}
