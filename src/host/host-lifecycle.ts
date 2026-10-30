import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import {
  hostInfoSchema,
  readProjectServer,
  type HostInfo,
  type HostReceipt,
} from "./host-discovery.js";
import { loadLibrary } from "../core/library/library.js";
import type { TemporalOptions } from "../infrastructure/temporal-runtime.js";

export type HostStatus =
  | { status: "stopped"; project: string }
  | (HostInfo & { status: "running" | "stopping"; canStop: boolean });
export type StartHostOptions = {
  project: string;
  port?: number;
  mode?: "live" | "demo";
  web?: boolean;
  temporal?: TemporalOptions;
  signal?: AbortSignal;
};

function validPort(port: number | undefined) {
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535))
    throw new Error("Port must be between 0 and 65535.");
}
function matches(receipt: HostReceipt | undefined, host: HostInfo) {
  return receipt?.hostId === host.hostId && receipt.pid === host.pid && receipt.url === host.url;
}
async function probe(url: string, project: string): Promise<HostInfo | undefined> {
  const response = await fetch(`${url}/api/host`, { signal: AbortSignal.timeout(1500) }).catch(
    () => undefined,
  );
  if (!response) return;
  const parsed = hostInfoSchema.safeParse(await response.json().catch(() => undefined));
  if (!response.ok || !parsed.success)
    throw new Error(
      `The service at ${url} has no Workflow host controls. Use its foreground process to stop it, or choose --port 0.`,
    );
  const host = parsed.data;
  if (host.url !== url || (await realpath(host.project)) !== project)
    throw new Error(
      `The server at ${url} belongs to another project. Use --port 0 for this project or --server URL to attach explicitly.`,
    );
  return host;
}

/** Status is public metadata only; the shutdown token never leaves this module. */
export async function projectHostStatus(project: string, port?: number): Promise<HostStatus> {
  validPort(port);
  project = await realpath(project);
  const receipt = await readProjectServer(project);
  const candidates = [
    ...new Set([
      ...(receipt ? [receipt.url] : []),
      ...(port === 0 ? [] : [`http://127.0.0.1:${port ?? 4310}`]),
    ]),
  ];
  for (const url of candidates) {
    // An unrelated default-port service is not this project's status. An
    // explicit endpoint or an existing receipt still needs an exact match.
    const host = await probe(url, project).catch((error) => {
      if (!receipt && port === undefined) return undefined;
      throw error;
    });
    if (host) {
      if (port && Number(new URL(host.url).port) !== port)
        throw new Error(
          `The project is already running at ${host.url}. Omit --port to select its saved endpoint.`,
        );
      return {
        ...host,
        status: host.state === "ready" ? "running" : "stopping",
        canStop: matches(receipt, host),
      };
    }
  }
  return { status: "stopped", project };
}

async function withManagerLease<T>(project: string, work: () => Promise<T>) {
  // A distinct target avoids sharing proper-lockfile's registry with either the
  // execution lease or library writes. Serialize concurrent start/stop clients.
  const release = await lockfile.lock(path.join(project, ".workflow", "host-manager"), {
    realpath: false,
    lockfilePath: path.join(project, ".workflow", "host-manager-lease"),
    stale: 10_000,
    update: 2000,
    retries: { retries: 180, minTimeout: 250, maxTimeout: 500, randomize: false },
  });
  try {
    return await work();
  } finally {
    await release();
  }
}

/** The same source/built installation that loaded this module owns the child. */
export function hostCliEntry() {
  return fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../cli/index.ts" : "./cli.js", import.meta.url),
  );
}

async function spawnHost(options: StartHostOptions & { project: string }): Promise<HostInfo> {
  const hostId = randomUUID();
  const logfile = path.join(options.project, ".workflow", "host.log");
  const log = await open(logfile, "a", 0o600);
  await log.chmod(0o600);
  const args = [
    hostCliEntry(),
    "__host",
    "--host-id",
    hostId,
    "--port",
    String(options.port ?? 4310),
  ];
  if (options.mode === "demo") args.push("--demo");
  if (options.web === false) args.push("--no-web");
  if (options.temporal?.address) args.push("--temporal-address", options.temporal.address);
  if (options.temporal?.namespace) args.push("--temporal-namespace", options.temporal.namespace);
  if (options.temporal?.workflowBundlePath)
    args.push("--temporal-workflow-bundle", path.resolve(options.temporal.workflowBundlePath));
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, args, {
      cwd: options.project,
      env: process.env,
      detached: true,
      stdio: ["ignore", log.fd, log.fd, "ipc"],
    });
  } catch (error) {
    await log.close();
    throw error;
  }
  let ready: HostInfo | undefined;
  try {
    return await new Promise<HostInfo>((resolve, reject) => {
      let checking = false;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        child.removeListener("message", message);
        child.removeListener("error", error);
        child.removeListener("exit", exit);
        child.removeListener("disconnect", disconnected);
      };
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      };
      const abort = () => fail(options.signal?.reason ?? new Error("Host startup cancelled"));
      const error = (reason: Error) => fail(reason);
      const exit = (code: number | null) =>
        fail(
          new Error(
            `Background host exited ${code ?? "after a signal"} before becoming ready. See ${logfile}.`,
          ),
        );
      const disconnected = () => {
        if (!ready) {
          fail(new Error(`Background host disconnected before becoming ready. See ${logfile}.`));
          return;
        }
        settled = true;
        cleanup();
        child.unref();
        resolve(ready);
      };
      const message = (value: unknown) => {
        if (!value || typeof value !== "object" || !("type" in value)) return;
        if (value.type === "error" && "message" in value) {
          fail(
            new Error(`Background host could not start: ${String(value.message)}. See ${logfile}.`),
          );
          return;
        }
        if (value.type !== "ready" || !("host" in value) || checking) return;
        checking = true;
        void (async () => {
          const announced = hostInfoSchema.parse(value.host);
          if (announced.hostId !== hostId || announced.pid !== child.pid)
            throw new Error("Background host readiness identity did not match the child.");
          const status = await projectHostStatus(options.project, options.port);
          if (status.status !== "running" || status.hostId !== hostId || !status.canStop)
            throw new Error("Background host readiness could not be verified.");
          if (settled) return;
          ready = announced;
          child.send({ type: "detach", hostId }, (sendError) => {
            if (sendError) fail(sendError);
          });
        })().catch(fail);
      };
      const timer = setTimeout(
        () =>
          fail(
            new Error(`Background host did not become ready within 60 seconds. See ${logfile}.`),
          ),
        60_000,
      );
      child.on("message", message);
      child.once("error", error);
      child.once("exit", exit);
      child.once("disconnect", disconnected);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  } catch (error) {
    // This is the fresh child handle, never a PID taken from a saved receipt.
    // Before detach, disconnect also asks the child to clean up its worker.
    if (child.connected) child.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        Bun.sleep(10_000),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    throw error;
  } finally {
    await log.close();
  }
}

export async function startProjectHost(options: StartHostOptions) {
  validPort(options.port);
  const project = await realpath(options.project);
  await loadLibrary(project).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error(`Run workflow init in ${project} before starting its host.`);
    throw error;
  });
  return await withManagerLease(project, async () => {
    options.signal?.throwIfAborted();
    const existing = await projectHostStatus(project, options.port);
    if (existing.status !== "stopped") {
      if (existing.status === "stopping")
        throw new Error(
          "The project's host is stopping. Retry workflow start after shutdown completes.",
        );
      if (existing.mode !== (options.mode ?? "live"))
        throw new Error(
          `The running host is ${existing.mode}; requested ${options.mode ?? "live"}. Run workflow stop before switching modes.`,
        );
      if (options.port && Number(new URL(existing.url).port) !== options.port)
        throw new Error(
          `The project is already running at ${existing.url}. Omit --port to reuse it, or stop it first.`,
        );
      if (options.web !== undefined && existing.web !== options.web)
        throw new Error(
          `The running host ${existing.web ? "serves the web GUI" : "is API-only"}. Stop it before changing --no-web.`,
        );
      return { ...existing, started: false };
    }
    // Explain a default-port collision before creating an engine or worker.
    if (options.port !== 0) await probe(`http://127.0.0.1:${options.port ?? 4310}`, project);
    const host = await spawnHost({ ...options, project });
    return { ...host, status: "running" as const, canStop: true, started: true };
  });
}

export async function stopProjectHost(project: string, port?: number) {
  validPort(port);
  project = await realpath(project);
  // No project initialization is required to report an already stopped host.
  const first = await projectHostStatus(project, port);
  if (first.status === "stopped") return { status: "stopped" as const, project, stopped: false };
  return await withManagerLease(project, async () => {
    const current = await projectHostStatus(project, port);
    if (current.status === "stopped")
      return { status: "stopped" as const, project, stopped: false };
    const receipt = await readProjectServer(project);
    if (!matches(receipt, current) || !receipt)
      throw new Error(
        "The saved host identity does not match the running server. No shutdown was requested; no PID was signalled.",
      );
    if (port && Number(new URL(current.url).port) !== port)
      throw new Error(
        `The project is running at ${current.url}. Omit --port to stop its verified host.`,
      );
    const response = await fetch(`${current.url}/api/host/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: {
        "content-type": "application/json",
        "x-workflow-client": "1",
        "x-workflow-host-token": receipt.token,
      },
      body: JSON.stringify({ hostId: current.hostId }),
    });
    if (!response.ok)
      throw new Error(`Host refused shutdown (${response.status}). No PID was signalled.`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const saved = await readProjectServer(project);
      // Fastify can answer 503 while preClose drains the application. A timeout
      // or unavailable HTTP route alone never proves the worker has stopped.
      const active = await probe(current.url, project).catch(() => undefined);
      if (
        (!saved || saved.hostId !== current.hostId) &&
        (!active || active.hostId !== current.hostId)
      ) {
        return { status: "stopped" as const, project, stopped: true, hostId: current.hostId };
      }
      await Bun.sleep(100);
    }
    throw new Error(
      "The host is still draining active work. Check workflow status and .workflow/host.log; no force-stop was attempted.",
    );
  });
}
