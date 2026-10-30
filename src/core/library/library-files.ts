import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Library } from "../../contracts/domain.js";
import { approvedLibrarySchema } from "../../contracts/library-editor-schema.js";
import { atomicWrite } from "../../infrastructure/atomic-file.js";
import { codeExecutorSchema } from "../../contracts/code-schema.js";
import { publicationCheckpoint } from "../settings/settings-publication.js";

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const sourcePath = (project: string, id: string) =>
  path.join(project, ".workflow", "blocks", id, "block.ts");
const fingerprint = (source: string | undefined) =>
  source === undefined ? null : createHash("sha256").update(source).digest("hex");

export async function readLibrarySource(project: string, id: string) {
  const root = await realpath(path.join(project, ".workflow", "blocks"));
  const filename = await realpath(sourcePath(project, id));
  const info = await lstat(filename);
  if (!filename.startsWith(root + path.sep) || !info.isFile() || info.size > 512_000) {
    throw new Error(
      `Block ${id} source must be a regular file inside .workflow/blocks below 512 KB.`,
    );
  }
  return codeExecutorSchema.shape.source.parse(await readFile(filename, "utf8"));
}

async function sourceBeforeWrite(project: string, id: string) {
  const root = path.join(project, ".workflow", "blocks");
  const directory = path.join(root, id);
  const filename = sourcePath(project, id);
  try {
    if ((await lstat(root)).isSymbolicLink())
      throw new Error(
        "Cannot publish library source through a symbolic .workflow/blocks directory.",
      );
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error(`Cannot publish block ${id} through a symbolic directory.`);
    const info = await lstat(filename);
    if (!info.isFile() || info.size > 512_000)
      throw new Error(`Cannot overwrite nonregular or oversized source for block ${id}.`);
    return await readFile(filename, "utf8");
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** Caller holds the library write lease. Each visible manifest is complete. */
export async function publishLibraryFiles(
  project: string,
  blocks: Library["blocks"],
  beforePublish: () => Promise<void>,
  recoverBaselines?: Record<string, string | null>,
) {
  const sources = Object.entries(blocks).flatMap(([id, bundle]) =>
    bundle.definition.executor?.kind === "code"
      ? [{ id, source: bundle.definition.executor.source }]
      : [],
  );
  const previous = new Map<string, string | undefined>();
  for (const { id, source } of sources) {
    const existing = await sourceBeforeWrite(project, id);
    if (recoverBaselines && fingerprint(existing) !== recoverBaselines[id] && existing !== source) {
      throw new Error(
        `Block ${id} was manually edited after interrupted publication. The edit is preserved; reconcile it with the saved library snapshot before reapplying.`,
      );
    }
    previous.set(id, existing);
  }
  const filename = path.join(project, ".workflow", "library.json");
  const sourceBaselines =
    recoverBaselines ??
    Object.fromEntries([...previous].map(([id, source]) => [id, fingerprint(source)]));
  const snapshot =
    JSON.stringify(approvedLibrarySchema.parse({ version: 1, blocks, sourceBaselines }), null, 2) +
    "\n";
  await atomicWrite(filename, snapshot, 0o600, beforePublish);
  await publicationCheckpoint(project, "library:inline");
  // Keep the complete inline snapshot active until every editable source file
  // exists. A crash here retains usable code; reapplying repairs materialization.
  for (const { id, source } of sources) {
    await mkdir(path.dirname(sourcePath(project, id)), { recursive: true });
    await atomicWrite(sourcePath(project, id), source, 0o600, async () => {
      if ((await sourceBeforeWrite(project, id)) !== previous.get(id)) {
        throw new Error(
          `Block ${id} source changed while publishing. The new library snapshot is saved; the manual file edit was preserved. Review and reapply the proposal.`,
        );
      }
    });
    await publicationCheckpoint(project, `library:source:${id}`);
  }
  const manifest =
    JSON.stringify(
      approvedLibrarySchema.parse({
        version: 1,
        blocks,
        sourceFiles: sources.map((item) => item.id),
      }),
      null,
      2,
    ) + "\n";
  await atomicWrite(filename, manifest, 0o600, async () => {
    if ((await readFile(filename, "utf8")) !== snapshot)
      throw new Error(
        "The library changed while publishing editable source files. Reload before retrying.",
      );
  });
  await publicationCheckpoint(project, "library:manifest");
}
