import { constants, createReadStream, closeSync, openSync, writeSync } from "node:fs";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicWrite } from "./atomic-file.js";
import { commandOutputRefSchema, type CommandOutputRef } from "../contracts/operation-schema.js";

export type CommandOutputStream = "stdout" | "stderr" | "output";
const streams = ["stdout", "stderr", "output"] as const;
/** A runaway process cannot fill the disk indefinitely. The retained prefix is labeled. */
const captureLimit = 64 * 1024 * 1024;

/** Private per-attempt command transcripts. No model-controlled paths enter storage names. */
export async function createCommandCapture(directory: string) {
  const id = randomUUID();
  const root = path.join(directory, "command-output", id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const files = {} as Record<CommandOutputStream, number>;
  try {
    for (const stream of streams)
      files[stream] = openSync(
        path.join(root, `${stream}.txt`),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
  } catch (error) {
    for (const fd of Object.values(files)) closeSync(fd);
    throw error;
  }
  const bytes = { stdout: 0, stderr: 0, output: 0 };
  let truncated = false,
    closed = false;
  const capped = new Set<CommandOutputStream>();
  function append(stream: "stdout" | "stderr", text: string) {
    if (closed) return;
    const data = Buffer.from(text);
    for (const target of [stream, "output"] as const) {
      if (capped.has(target)) continue;
      let count = Math.min(data.length, captureLimit - bytes[target]);
      if (count < data.length) {
        truncated = true;
        capped.add(target);
        while (count > 0 && (data[count]! & 0xc0) === 0x80) count--;
      }
      // Write synchronously to bound memory even if a subprocess floods stdout.
      let offset = 0;
      while (offset < count) offset += writeSync(files[target], data, offset, count - offset);
      bytes[target] += count;
    }
  }
  async function finish(): Promise<CommandOutputRef> {
    if (!closed) {
      closed = true;
      for (const fd of Object.values(files)) closeSync(fd);
    }
    const reference: CommandOutputRef = {
      id,
      stdoutBytes: bytes.stdout,
      stderrBytes: bytes.stderr,
      outputBytes: bytes.output,
      truncated,
    };
    await atomicWrite(path.join(root, "manifest.json"), JSON.stringify(reference));
    return reference;
  }
  return { append, finish };
}

async function outputFile(directory: string, id: string, stream: CommandOutputStream) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ||
    !streams.includes(stream)
  )
    throw new Error("Invalid command output identity");
  const root = await realpath(directory);
  const capture = await realpath(path.join(root, "command-output", id));
  if (capture !== path.join(root, "command-output", id))
    throw new Error("Command output must belong to this attempt");
  const manifest = commandOutputRefSchema.parse(
    JSON.parse(await readFile(path.join(capture, "manifest.json"), "utf8")),
  );
  if (manifest.id !== id) throw new Error("Command output identity mismatch");
  const filename = path.join(capture, `${stream}.txt`);
  return { filename, manifest };
}

/** Reads by UTF-8 byte offsets; callers may request the next returned offset. */
export async function readCommandOutput(
  directory: string,
  id: string,
  stream: CommandOutputStream = "output",
  options: { offset?: number; limit?: number } = {},
) {
  const offset = options.offset ?? 0,
    limit = options.limit ?? 32_000;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 256_000
  )
    throw new Error("Invalid command output range");
  const { filename, manifest } = await outputFile(directory, id, stream);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(limit + 4);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let start = 0,
      end = Math.min(limit, bytesRead);
    // Arbitrary offsets skip continuation bytes. Sequential nextOffset reads
    // preserve every character and never manufacture replacement characters.
    while (start < bytesRead && (buffer[start]! & 0xc0) === 0x80) start++;
    if (end < bytesRead) while (end > start && (buffer[end]! & 0xc0) === 0x80) end--;
    if (end <= start && start < bytesRead) {
      end = start + 1;
      while (end < bytesRead && (buffer[end]! & 0xc0) === 0x80) end++;
    }
    const total = manifest[`${stream}Bytes`];
    return {
      id,
      stream,
      text: buffer.subarray(start, end).toString("utf8"),
      offset: offset + start,
      nextOffset: offset + end,
      bytes: total,
      hasMore: offset + end < total,
      truncated: manifest.truncated,
    };
  } finally {
    await handle.close();
  }
}

/** A validated stream for the scoped HTTP download adapter, without loading it in memory. */
export async function streamCommandOutput(
  directory: string,
  id: string,
  stream: CommandOutputStream = "output",
) {
  const { filename, manifest } = await outputFile(directory, id, stream);
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  return { stream: createReadStream(filename, { fd, autoClose: true }), reference: manifest };
}
