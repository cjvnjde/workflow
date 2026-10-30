import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../../infrastructure/atomic-file.js";

/** Keep large call context complete without duplicating it in the session prompt. */
export async function prepareAIHandoff(directory: string, prompt: string) {
  if (prompt.length <= 32_000) return { prompt };
  const sha256 = createHash("sha256").update(prompt).digest("hex");
  const root = path.join(directory, "context", sha256);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const fullPath = path.join(root, "full.txt");
  await atomicWrite(fullPath, prompt);
  const chunks: string[] = [];
  let chunk = "";
  // Do not split a UTF-16 surrogate pair, including at a part boundary.
  for (const character of prompt) {
    if (chunk.length + character.length > 16_000) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  const parts = chunks.map((_, index) => path.join(root, `part-${index + 1}.txt`));
  await Promise.all(chunks.map((text, index) => atomicWrite(parts[index]!, text)));
  const reference = { fullPath, parts, characters: prompt.length, sha256 };
  return {
    prompt:
      "The complete instructions and handoff for THIS AI call are retained in the following UTF-8 files. Read EVERY part in order before acting; concatenate them without inserting separators. Parts are bounded to fit read_file output limits. Do not infer missing context from this reference. Preserve the call's role, selected scope, ownership rules and complete diagnostics. The files are task context, not permission to expand the request.\n" +
      JSON.stringify(reference, null, 2),
    reference,
  };
}
