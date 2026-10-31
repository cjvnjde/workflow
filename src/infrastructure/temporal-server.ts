import { dlopen, ptr } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { z } from "zod";
import { userPaths } from "./user-paths.js";

const version = "1.9.1";
const receiptSchema = z
  .object({
    pid: z.number().int().positive(),
    port: z.number().int().min(1).max(65535),
    binary: z.string().optional(),
  })
  .strict();

async function executable() {
  const platform =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined;
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : undefined;
  if (!platform || !arch) {
    throw new Error(
      "Managed Temporal supports Linux/macOS x64/arm64. Use --temporal-address to connect to a server on other platforms.",
    );
  }
  const directory = path.join(
    userPaths().directory,
    "cache",
    "temporal",
    `${version}-${platform}-${arch}`,
  );
  const binary = path.join(directory, "temporal");
  if (await Bun.file(binary).exists()) {
    return binary;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  console.log(
    `Downloading the managed Temporal server ${version} (one-time; no global installation)…`,
  );
  const response = await fetch(
    `https://temporal.download/cli/archive/v${version}?platform=${platform}&arch=${arch}`,
    { signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok) {
    throw new Error(
      `Temporal download failed (${response.status}). Retry with internet access or use --temporal-address.`,
    );
  }
  const files = await new Bun.Archive(await response.arrayBuffer()).files();
  const file = files.get("temporal");
  if (!file) {
    throw new Error("The official Temporal archive did not contain its executable");
  }
  const temporary = `${binary}.${randomUUID()}.tmp`;
  await writeFile(temporary, new Uint8Array(await file.arrayBuffer()), { mode: 0o700 });
  await chmod(temporary, 0o700);
  await rename(temporary, binary);

  return binary;
}

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a Temporal port");
  }
  await new Promise<void>((resolve, reject) => {
    socket.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  return address.port;
}

const darwinInspector =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        sysctl: {
          args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"],
          returns: "i32",
        },
      })
    : undefined;

async function processArguments(pid: number, binary: string) {
  if (process.platform === "linux") {
    try {
      return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
  if (!darwinInspector) {
    return undefined;
  }
  // CTL_KERN / KERN_PROCARGS2 preserves argv boundaries, unlike ps output.
  const name = new Int32Array([1, 49, pid]);
  const size = new BigUint64Array(1);
  if (darwinInspector.symbols.sysctl(ptr(name), name.length, null, ptr(size), null, 0) !== 0) {
    return undefined;
  }
  const buffer = Buffer.alloc(Number(size[0]));
  if (
    buffer.length < 4 ||
    darwinInspector.symbols.sysctl(ptr(name), name.length, ptr(buffer), ptr(size), null, 0) !== 0
  ) {
    return undefined;
  }
  const length = Number(size[0]);
  const count = buffer.readInt32LE(0);
  const executableEnd = buffer.indexOf(0, 4);
  if (count < 1 || executableEnd < 4 || buffer.toString("utf8", 4, executableEnd) !== binary) {
    return undefined;
  }
  // The kernel puts its executable path and alignment padding before argv.
  let offset = executableEnd + 1;
  while (offset < length && buffer[offset] === 0) offset++;
  const args: string[] = [];
  for (let index = 0; index < count; index++) {
    const end = buffer.indexOf(0, offset);
    if (end < offset || end >= length) return undefined;
    args.push(buffer.toString("utf8", offset, end));
    offset = end + 1;
  }

  return args;
}

async function ownsProcess(pid: number, binary: string, database: string, port: number) {
  const args = await processArguments(pid, binary);
  const option = (name: string, value: string) => {
    const index = args?.indexOf(name) ?? -1;
    return index >= 3 && args?.[index + 1] === value;
  };

  return (
    args?.[0] === binary &&
    args[1] === "server" &&
    args[2] === "start-dev" &&
    option("--db-filename", database) &&
    option("--port", String(port)) &&
    option("--ip", "127.0.0.1")
  );
}

export async function startTemporalServer(project: string, namespace: string) {
  const directory = path.join(project, ".workflow", "temporal");
  const database = path.join(directory, "temporal.sqlite");
  const receiptPath = path.join(directory, "server.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const binary = await executable();
  let previous: z.infer<typeof receiptSchema> | undefined;
  try {
    previous = receiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const previousBinary = previous?.binary ?? binary;
  if (previous && (await ownsProcess(previous.pid, previousBinary, database, previous.port))) {
    return {
      address: `127.0.0.1:${previous.port}`,
      stop: async () => {
        if (await ownsProcess(previous.pid, previousBinary, database, previous.port)) {
          process.kill(previous.pid, "SIGTERM");
          const deadline = Date.now() + 5000;
          while (await ownsProcess(previous.pid, previousBinary, database, previous.port)) {
            if (Date.now() > deadline) {
              process.kill(previous.pid, "SIGKILL");
              break;
            }
            await Bun.sleep(50);
          }
        }
        await rm(receiptPath, { force: true });
      },
    };
  }
  if (previous) {
    try {
      process.kill(previous.pid, 0);
      throw new Error(
        `A prior Temporal service may still be running (PID ${previous.pid}). Reuse it with --temporal-address 127.0.0.1:${previous.port}, or stop it before restarting.`,
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw error;
      }
    }
  }
  const port = await freePort();
  const log = await open(path.join(directory, "server.log"), "a", 0o600);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(
      [
        binary,
        "server",
        "start-dev",
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--namespace",
        namespace,
        "--db-filename",
        database,
        "--headless",
        "--log-level",
        "warn",
        "--dynamic-config-value",
        "frontend.enableServerVersionCheck=false",
      ],
      { stdin: "ignore", stdout: log.fd, stderr: log.fd },
    );
  } finally {
    await log.close();
  }
  const temporary = `${receiptPath}.tmp`;
  await writeFile(temporary, JSON.stringify({ pid: child.pid, port, binary }) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, receiptPath);

  return {
    address: `127.0.0.1:${port}`,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
        try {
          await child.exited;
        } finally {
          clearTimeout(timeout);
        }
      }
      await rm(receiptPath, { force: true });
    },
  };
}
