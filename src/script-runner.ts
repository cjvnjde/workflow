import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateBlockResult, type BlockRunner } from "./block-runner.js";
import { runProcess } from "./process.js";

/** Execute the exact source from the approved block snapshot, without an agent. */
export const runScriptBlock: BlockRunner = async (execution) => {
  const script = execution.bundle.definition.executor;
  if (script?.kind !== "script") throw new Error("Block has no script executor");
  execution.signal.throwIfAborted();
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-script-"));
  const input = path.join(directory, "input.json");
  const resultFile = path.join(directory, "result.json");
  const label = `${script.language} (${script.runtime})`;
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending) execution.emit("script_output", pending);
    pending = "";
  };
  const artifacts = (content: string) => Object.fromEntries(
    execution.bundle.definition.outputs.map((name) => [name, content.slice(-64_000)]),
  );
  try {
    await writeFile(input, JSON.stringify({
      version: 1, project: execution.project, task: execution.task,
      node: { id: execution.node.id, label: execution.node.label, goal: execution.node.goal },
      visit: execution.visit, inputs: execution.inputs,
      outputs: execution.bundle.definition.outputs,
      attachments: execution.config.attachments ?? [],
    }), { mode: 0o600 });
    const code = script.language === "typescript"
      ? new Bun.Transpiler({ loader: "ts", target: script.runtime === "node" ? "node" : "bun" }).transformSync(script.code)
      : script.code;
    const argv = script.runtime === "bash" ? ["bash", "-e", "-o", "pipefail", "-s"]
      : script.runtime === "bun" ? [process.execPath, "run", "-"]
      : ["node", "--input-type=module"];
    execution.emit("script_start", `${label} · timeout ${script.timeoutMs / 1000}s · no model call`);
    const processResult = await runProcess(execution.project, argv, execution.signal, script.timeoutMs, {
      ...process.env, WORKFLOW_INPUT: input, WORKFLOW_RESULT: resultFile, WORKFLOW_PROJECT: execution.project,
    }, {
      stdin: code,
      onOutput(chunk) {
        pending = (pending + chunk).slice(-6000);
        timer ??= setTimeout(flush, 150);
      },
    });
    flush();
    execution.signal.throwIfAborted();
    const matched = !processResult.timedOut && processResult.exitCode !== null &&
      (script.expect === "success" ? processResult.exitCode === 0 : processResult.exitCode !== 0);
    const status = `${label}: ${processResult.timedOut ? "timed out" : `exit ${processResult.exitCode ?? "unknown"}`} · ${matched ? "condition met" : "condition NOT met"}`;
    const diagnostics = `${status}\n${processResult.output}`;
    execution.emit("script_end", diagnostics);
    const info = await lstat(resultFile).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info) {
      if (!info.isFile() || info.size > 256_000) throw new Error("Script result must be a regular JSON file below 256 KB.");
      const result = validateBlockResult(JSON.parse(await readFile(resultFile, "utf8")), execution.bundle);
      if (!matched && result.outcome === "pass") {
        result.outcome = "retry";
        result.summary = `${result.summary.slice(0, 8000)}\n\n${diagnostics.slice(-7500)}`;
      }
      return result;
    }
    return {
      outcome: matched ? "pass" : "retry",
      summary: `${status}\n${processResult.output.slice(-15_500)}`,
      artifacts: artifacts(diagnostics),
    };
  } catch (error) {
    execution.signal.throwIfAborted();
    flush();
    const summary = `Script could not complete: ${error instanceof Error ? error.message : String(error)}`.slice(0, 16_000);
    execution.emit("script_error", summary);
    return { outcome: "retry", summary, artifacts: artifacts(summary) };
  } finally {
    flush();
    await rm(directory, { recursive: true, force: true });
  }
};
