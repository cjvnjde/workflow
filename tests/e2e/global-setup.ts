import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export default async function setup() {
  const occupied = await fetch("http://127.0.0.1:4311", { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );
  if (occupied)
    throw new Error("E2E backend port 4311 is already in use; stop the existing server first.");
  const server = spawn(process.execPath, ["tests/e2e/server.ts"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let failure: Error | undefined;
  server.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  server.on("error", (error) => {
    failure = error;
  });
  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
  server.once("close", resolveClosed);
  const stop = async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 10_000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (failure || server.exitCode !== null || server.signalCode !== null) {
        throw new Error(
          `E2E server failed to start: ${failure?.message ?? server.exitCode}\n${output}`,
        );
      }
      try {
        const response = await fetch("http://127.0.0.1:4311/api/project", {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) return stop;
      } catch {
        // The backend does not listen until its isolated project is initialized.
      }
      await delay(100);
    }
    throw new Error(`E2E server startup timed out\n${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
