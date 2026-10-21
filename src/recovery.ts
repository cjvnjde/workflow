import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "./atomic-file.js";
import { recoverySchema, type RecoveryResult } from "./domain.js";
import { Workspace } from "./workspace.js";

const entrySchema = z.object({ before: z.string().nullable(), mode: z.number().int(), afterHash: z.string(), previousHash: z.string().optional() }).strict();
const journalSchema = z.object({ version: z.literal(1), files: z.record(z.string(), entrySchema), result: recoverySchema.optional() }).strict();
export const fileHash = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");
export type FileSnapshot = { content: Buffer | null; mode: number };

/** Coordinate managed writes between parallel attempts in the shared workspace. */
export class FileClaims {
  private owners = new Map<string, Set<string>>();
  private queue = Promise.resolve();
  constructor(private readonly project: string) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action);
    this.queue = pending.then(() => {}, () => {});
    return pending;
  }
  restore(owner: string, paths: string[]) {
    return this.serial(async () => {
      for (const filename of paths) {
        const key = path.resolve(this.project, filename);
        const existing = this.owners.get(key) ?? new Set<string>();
        // Historical conflicts must not prevent the whole project from loading.
        // Keep all claims so new writes remain blocked until recovery resolves them.
        existing.add(owner); this.owners.set(key, existing);
      }
    });
  }
  write<T>(owner: string, filename: string, action: () => Promise<T>) {
    return this.serial(async () => {
      const key = path.resolve(this.project, filename);
      const existing = this.owners.get(key);
      if (existing && [...existing].some(held => held !== owner)) throw new Error(`Parallel file conflict: ${filename} is being changed by another step. Put dependent writes in sequence().`);
      this.owners.set(key, new Set([owner]));
      return action();
    });
  }
  settle(owner: string, action: (contested: (filename: string) => boolean) => Promise<RecoveryResult>) {
    return this.serial(async () => {
      const contested = new Set([...this.owners].filter(([, held]) => held.has(owner) && held.size > 1).map(([filename]) => filename));
      const result = await action(filename => contested.has(path.resolve(this.project, filename)));
      if (result.status !== "conflict") for (const [filename, held] of this.owners) {
        held.delete(owner); if (!held.size) this.owners.delete(filename);
      }
      return result;
    });
  }
}

export class FileJournal {
  private state: z.infer<typeof journalSchema> = { version: 1, files: {} };
  private constructor(private readonly directory: string, private readonly claims?: FileClaims) {}

  static async open(directory: string, claims?: FileClaims) {
    const journal = new FileJournal(directory, claims);
    try { journal.state = journalSchema.parse(JSON.parse(await readFile(path.join(directory, "files.json"), "utf8"))); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { throw error; }
    }
    if (!journal.state.result || journal.state.result.status === "conflict") await claims?.restore(directory, Object.keys(journal.state.files));
    return journal;
  }

  write<T>(filename: string, action: () => Promise<T>) { return this.claims ? this.claims.write(this.directory, filename, action) : action(); }

  private async save() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(this.directory, "files.json"), JSON.stringify(this.state) + "\n");
  }

  async prepare(relativePath: string, snapshot: FileSnapshot, next: Uint8Array) {
    if (this.state.result) { throw new Error("This step's file journal is already settled"); }
    const existing = this.state.files[relativePath];
    if (existing && (snapshot.content === null || fileHash(snapshot.content) !== existing.afterHash)) {
      throw new Error(`File changed outside this step: ${relativePath}`);
    }
    this.state.files[relativePath] = {
      before: existing ? existing.before : snapshot.content?.toString("base64") ?? null,
      mode: existing?.mode ?? snapshot.mode,
      afterHash: fileHash(next),
      previousHash: snapshot.content === null ? undefined : fileHash(snapshot.content),
    };
    // The original bytes and intended write reach disk before changing a project file.
    await this.save();
  }

  async settle(workspace: Workspace, commit: boolean): Promise<RecoveryResult> {
    return this.claims ? this.claims.settle(this.directory, contested => this.settleFiles(workspace, commit, contested)) : this.settleFiles(workspace, commit);
  }

  private async settleFiles(workspace: Workspace, commit: boolean, contested: (filename: string) => boolean = () => false): Promise<RecoveryResult> {
    if (this.state.result && this.state.result.status !== "conflict") { return this.state.result; }
    const restored: string[] = [];
    const conflicts: string[] = [];
    if (commit) conflicts.push(...Object.keys(this.state.files).filter(contested));
    if (!commit) {
      for (const [relativePath, entry] of Object.entries(this.state.files).reverse()) {
        try {
          const before = entry.before === null ? null : Buffer.from(entry.before, "base64");
          const current = await workspace.snapshot(relativePath);
          if (current.content === null ? before === null : before !== null && fileHash(current.content) === fileHash(before)) {
            // Already original: the write never published, or recovery was interrupted after restoring it.
            restored.push(relativePath);
          } else if (!contested(relativePath) && current.content !== null && (fileHash(current.content) === entry.afterHash || fileHash(current.content) === entry.previousHash)) {
            await workspace.restore(relativePath, fileHash(current.content), before, entry.mode);
            restored.push(relativePath);
          } else { conflicts.push(relativePath); }
        } catch { conflicts.push(relativePath); }
      }
    }
    this.state.result = { status: conflicts.length ? "conflict" : commit ? "committed" : restored.length ? "restored" : "none", restored, conflicts };
    await this.save();
    return this.state.result;
  }
}
