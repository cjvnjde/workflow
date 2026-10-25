import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import { atomicWrite } from "./atomic-file.js";
import { fileHash, type FileJournal, type FileSnapshot } from "./recovery.js";

import type { ProtectedPaths } from "./protected-paths.js";

const largeDirectories = new Set([".git", ".workflow", "node_modules", "dist", "test-results", "playwright-report"]);
const maxFileBytes = 1_000_000;

export class Workspace {
  private constructor(
    readonly root: string,
    private readonly options: { journal?: FileJournal; signal?: AbortSignal; protect?: ProtectedPaths } = {},
  ) {}

  static async create(root: string, options: { journal?: FileJournal; signal?: AbortSignal; protect?: ProtectedPaths } = {}) {
    return new Workspace(await realpath(root), options);
  }

  private resolve(filename: string) {
    if (!filename || filename.includes("\0")) { throw new Error("Provide a nonempty file path without NUL characters"); }
    const expanded = filename === "~" ? homedir() : filename.startsWith("~/") ? path.join(homedir(), filename.slice(2)) : filename;
    return path.resolve(this.root, expanded);
  }

  private async physicalPath(filename: string): Promise<string> {
    try { return await realpath(filename); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { throw error; }
      const parent = path.dirname(filename);
      if (parent === filename) { throw error; }
      return path.join(await this.physicalPath(parent), path.basename(filename));
    }
  }

  private async checkedPath(input: string, operation: "read" | "write", links = 0): Promise<string> {
    if (links > 40) { throw new Error("Too many symbolic links"); }
    this.options.signal?.throwIfAborted();
    if (operation === "write") this.options.protect?.assertWritable(this.resolve(input));
    const filename = await this.physicalPath(this.resolve(input));
    try {
      const info = await lstat(filename);
      // A dangling final link also names its target, rather than being replaced.
      if (info.isSymbolicLink()) {
        return this.checkedPath(path.resolve(path.dirname(filename), await readlink(filename)), operation, links + 1);
      }
      if (!info.isFile()) { throw new Error(`Expected a regular file: ${input}`); }
    } catch (error) {
      if (!(operation === "write" && error instanceof Error && "code" in error && error.code === "ENOENT")) { throw error; }
    }
    if (operation === "write") this.options.protect?.assertWritable(filename);
    return filename;
  }

  async read(relativePath: string) {
    const filename = await this.checkedPath(relativePath, "read");
    const handle = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxFileBytes) {
        throw new Error("Only text files up to 1 MB can be read");
      }

      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  async snapshot(relativePath: string): Promise<FileSnapshot> {
    const filename = this.resolve(relativePath);
    // Journals record physical paths. If a directory/file was replaced by a link
    // after the write, automatic recovery must not restore into its new target.
    let current = path.parse(filename).root;
    for (const part of filename.slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) { throw new Error(`Recovery target changed to a link: ${relativePath}`); }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { throw error; }
        break;
      }
    }
    let handle;
    try { handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") { return { content: null, mode: 0o644 }; }
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxFileBytes) { throw new Error("Recovery requires a regular file up to 1 MB"); }
      return { content: await handle.readFile(), mode: info.mode & 0o777 };
    } finally { await handle.close(); }
  }

  async restore(relativePath: string, expectedHash: string, before: Buffer | null, mode: number) {
    const current = await this.snapshot(relativePath);
    if (current.content === null || fileHash(current.content) !== expectedHash) { throw new Error(`Recovery conflict: ${relativePath}`); }
    const filename = await this.checkedPath(relativePath, "write");
    if (before === null) { await unlink(filename); }
    else { await atomicWrite(filename, before, mode); }
  }

  async write(relativePath: string, content: string) {
    this.options.signal?.throwIfAborted();
    if (Buffer.byteLength(content) > maxFileBytes) { throw new Error("Writes are limited to 1 MB"); }
    const filename = await this.checkedPath(relativePath, "write");
    const publish = () => this.writeChecked(filename, content);
    if (this.options.journal) await this.options.journal.write(filename, publish);
    else await publish();
  }

  private async writeChecked(filename: string, content: string) {
    this.options.signal?.throwIfAborted();
    if (Buffer.byteLength(content) > maxFileBytes) throw new Error("Writes are limited to 1 MB");
    const snapshot = await this.snapshot(filename);
    await mkdir(path.dirname(filename), { recursive: true });
    const relative = path.relative(this.root, filename);
    const journalPath = relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? filename : relative;
    await this.options.journal?.prepare(journalPath, snapshot, Buffer.from(content));
    this.options.signal?.throwIfAborted();
    await atomicWrite(filename, content, snapshot.mode, () => this.options.signal?.throwIfAborted());
  }

  async edit(relativePath: string, oldText: string, newText: string) {
    if (!oldText) {
      throw new Error("oldText must not be empty");
    }
    const filename = await this.checkedPath(relativePath, "write");
    const change = async () => {
      const content = await this.read(filename);
      const first = content.indexOf(oldText);
      if (first < 0 || content.indexOf(oldText, first + 1) >= 0) {
        throw new Error("oldText must match exactly once");
      }
      await this.writeChecked(
        filename,
        content.slice(0, first) + newText + content.slice(first + oldText.length),
      );
    };
    if (this.options.journal) await this.options.journal.write(filename, change);
    else await change();
  }

  async list(pattern = "**/*") {
    const files: string[] = [];
    let inspected = 0;
    const walk = async (directory: string, prefix: string) => {
      this.options.signal?.throwIfAborted();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        inspected += 1;
        if (inspected > 20_000 || files.length >= 2000) {
          return;
        }
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        // Keep broad discovery useful; explicit globs can inspect these directories.
        if (entry.isDirectory() && largeDirectories.has(entry.name) && !pattern.includes(entry.name)) { continue; }
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(path.join(directory, entry.name), relativePath);
        } else if (
          entry.isFile() &&
          minimatch(relativePath, pattern, { dot: true, nonegate: true })
        ) {
          files.push(relativePath);
        }
      }
    };
    await walk(this.root, "");

    return files.sort();
  }
}
