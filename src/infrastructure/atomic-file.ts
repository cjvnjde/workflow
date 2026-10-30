import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Publish a complete file, retaining the previous file if the write fails. */
export async function atomicWrite(
  filename: string,
  content: string | Uint8Array,
  mode = 0o600,
  beforePublish?: () => void | Promise<void>,
) {
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(content);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforePublish?.();
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}
