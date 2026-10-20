import { spawn } from "node:child_process";

export type ProcessResult = { exitCode: number | null; stdout: string; stderr: string; output: string; timedOut: boolean };

/** Bounded output and process-group cancellation for host functions and checks. */
export async function runProcess(
  project: string, argv: string[], signal: AbortSignal, timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  signal.throwIfAborted();
  if (!argv[0]) throw new Error("Command executable must not be empty");
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: project, shell: false, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"], env,
    });
    let stdout = "", stderr = "", output = "", timedOut = false;
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-32_000);
      output = (output + chunk).slice(-32_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-32_000);
      output = (output + chunk).slice(-32_000);
    });
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (exitCode) => {
      // The parent can exit on SIGTERM while a child with redirected stdio
      // ignores it. Finish stopping the group before clearing the fallback
      // timer or reporting that cancellation/timeout has completed.
      if (signal.aborted || timedOut) kill("SIGKILL");
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else resolve({ exitCode, stdout, stderr, output, timedOut });
    });
  });
}
