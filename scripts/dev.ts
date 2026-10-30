import { setTimeout as delay } from "node:timers/promises";

export async function waitForBackend(url: string, pid: number, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(750)]),
      });
      const health: unknown = await response.json();
      if (
        response.ok &&
        health &&
        typeof health === "object" &&
        "pid" in health &&
        health.pid === pid &&
        "status" in health &&
        health.status === "ready"
      ) {
        return;
      }
    } catch {
      signal.throwIfAborted();
    }
    await delay(150, undefined, { signal });
  }
  signal.throwIfAborted();
}

async function dev() {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Development server stopped"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const server = Bun.spawn([process.execPath, "src/cli/index.ts", "serve", "--no-web"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  let web: ReturnType<typeof Bun.spawn> | undefined;
  let stopping = false;
  const exited = server.exited.then((code) => {
    if (!stopping) controller.abort(new Error(`Workflow backend exited (${code})`));
    return code;
  });
  try {
    console.log("Starting Workflow… Waiting for the backend before opening Vite.");
    await waitForBackend(
      "http://127.0.0.1:4310/api/health",
      server.pid,
      AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
    );
    controller.signal.throwIfAborted();
    web = Bun.spawn(
      [
        process.execPath,
        "--bun",
        "node_modules/vite/bin/vite.js",
        "--host",
        "127.0.0.1",
        "--strictPort",
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    await Promise.race([
      web.exited.then((code) => {
        if (code !== 0) throw new Error(`Vite exited (${code})`);
      }),
      new Promise<never>((_resolve, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason);
        else
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
            once: true,
          });
      }),
    ]);
  } finally {
    stopping = true;
    server.kill("SIGTERM");
    web?.kill("SIGTERM");
    const force = setTimeout(() => {
      server.kill("SIGKILL");
      web?.kill("SIGKILL");
    }, 8000);
    await Promise.allSettled([exited, web?.exited]);
    clearTimeout(force);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (import.meta.main) {
  await dev().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "Development server stopped") {
      console.error(message);
      process.exitCode = 1;
    }
  });
}
