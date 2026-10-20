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

export class FileJournal {
  private state: z.infer<typeof journalSchema> = { version: 1, files: {} };
  private constructor(private readonly directory: string) {}

  static async open(directory: string) {
    const journal = new FileJournal(directory);
    try { journal.state = journalSchema.parse(JSON.parse(await readFile(path.join(directory, "files.json"), "utf8"))); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { throw error; }
    }
    return journal;
  }

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
    if (this.state.result && this.state.result.status !== "conflict") { return this.state.result; }
    const restored: string[] = [];
    const conflicts: string[] = [];
    if (!commit) {
      for (const [relativePath, entry] of Object.entries(this.state.files).reverse()) {
        try {
          const before = entry.before === null ? null : Buffer.from(entry.before, "base64");
          const current = await workspace.snapshot(relativePath);
          if (current.content === null ? before === null : before !== null && fileHash(current.content) === fileHash(before)) {
            // Already original: the write never published, or recovery was interrupted after restoring it.
            restored.push(relativePath);
          } else if (current.content !== null && (fileHash(current.content) === entry.afterHash || fileHash(current.content) === entry.previousHash)) {
            await workspace.restore(relativePath, fileHash(current.content), before, entry.mode);
            restored.push(relativePath);
          } else { conflicts.push(relativePath); }
        } catch { conflicts.push(relativePath); }
      }
    }
    this.state.result = { status: commit ? "committed" : conflicts.length ? "conflict" : restored.length ? "restored" : "none", restored, conflicts };
    await this.save();
    return this.state.result;
  }
}
