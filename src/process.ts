import { spawn } from "node:child_process";
import { createCommandCapture } from "./command-output.js";
import type { CommandOutputRef } from "./operation-schema.js";

export type ProcessResult = { exitCode: number | null; stdout: string; stderr: string; output: string; timedOut: boolean; outputRef?: CommandOutputRef };

/** Bounded output and process-group cancellation for scripts and checks. */
export async function runProcess(
  project: string, argv: string[], signal: AbortSignal, timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  options: { stdin?: string; onOutput?: (chunk: string) => void; captureDirectory?: string; onCapture?: (ref: CommandOutputRef) => void } = {},
): Promise<ProcessResult> {
  signal.throwIfAborted();
  if (!argv[0]) throw new Error("Command executable must not be empty");
  const capture = options.captureDirectory ? await createCommandCapture(options.captureDirectory) : undefined;
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: project, shell: false, detached: process.platform !== "win32",
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], env,
    });
    let stdout = "", stderr = "", output = "", timedOut = false;
    let captureFailure: unknown;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signalName: NodeJS.Signals) => {
      try {
        if (process.platform === "win32" || !child.pid) child.kill(signalName);
        else process.kill(-child.pid, signalName);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
          output = `${output}\nCould not terminate process: ${String(error)}`.slice(-32_000);
      }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
    };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    // Streams buffer incomplete UTF-8 characters across chunk boundaries.
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-32_000);
      output = (output + chunk).slice(-32_000);
      try { capture?.append("stdout", chunk); options.onOutput?.(chunk); } catch (error) { captureFailure = error; stop(); }
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-32_000);
      output = (output + chunk).slice(-32_000);
      try { capture?.append("stderr", chunk); options.onOutput?.(chunk); } catch (error) { captureFailure = error; stop(); }
    });
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
    };
    async function finish(exitCode: number | null, error?: unknown) {
      if (settled) return;
      settled = true;
      if (signal.aborted || timedOut || captureFailure) kill("SIGKILL");
      cleanup();
      try {
        const outputRef = await capture?.finish();
        if (outputRef) options.onCapture?.(outputRef);
        if (error || captureFailure) reject(error ?? captureFailure);
        else if (signal.aborted) reject(signal.reason);
        else resolve({ exitCode, stdout, stderr, output, timedOut, ...(outputRef ? { outputRef } : {}) });
      } catch (error) { reject(error); }
    }
    child.once("error", error => { void finish(null, error); });
    child.once("close", exitCode => { void finish(exitCode); });
    // An interpreter can reject input or exit before consuming the whole script.
    // Its exit/error is the result; a closed stdin must not crash the host.
    child.stdin?.on("error", () => {});
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}
