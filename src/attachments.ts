import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ImageContent } from "@earendil-works/pi-ai";
import { atomicWrite } from "./atomic-file.js";
import { attachmentSchema, type Attachment } from "./capability-schema.js";

const uploadSchema = z.object({ name: z.string().min(1).max(200), mimeType: z.string().max(100), data: z.string().max(8_000_000) }).strict();
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const textExtensions = new Set([".txt", ".md", ".json", ".csv", ".log", ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".css", ".html", ".xml", ".yaml", ".yml", ".sh", ".sql", ".toml", ".diff", ".patch", ".svg"]);
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
async function readBounded(filename: string, limit: number) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) { throw new Error("Invalid attachment file size or type"); }
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const { bytesRead } = await handle.read(buffer, size, limit + 1 - size, null);
      if (!bytesRead) { break; }
      size += bytesRead;
    }
    if (size > limit) { throw new Error("Attachment exceeds the file size limit"); }
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
export class Attachments {
  constructor(private readonly project: string) {}
  private file(id: string, suffix: string) { return path.join(this.project, ".workflow", "attachments", `${z.string().uuid().parse(id)}.${suffix}`); }
  async add(value: unknown): Promise<Attachment> {
    const input = uploadSchema.parse(value);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) { throw new Error("Invalid attachment encoding"); }
    const data = Buffer.from(input.data, "base64");
    const image = imageTypes.has(input.mimeType);
    if (!image && !input.mimeType.startsWith("text/") && !textExtensions.has(path.extname(input.name).toLowerCase())) { throw new Error("Attach PNG, JPEG, WebP, GIF, or a text/code file. Other formats are not supported yet."); }
    if (!data.length || data.length > (image ? 6_000_000 : 256_000)) { throw new Error(image ? "Images must be between 1 byte and 6 MB" : "Text attachments must be between 1 byte and 256 KB"); }
    if (image) {
      const valid = input.mimeType === "image/png" ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : input.mimeType === "image/jpeg" ? data[0] === 255 && data[1] === 216 && data[2] === 255
        : input.mimeType === "image/gif" ? /^GIF8[79]a/.test(data.subarray(0, 6).toString())
        : data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP";
      if (!valid) { throw new Error("Image content does not match its file type"); }
    } else {
      try { new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw new Error("Text attachments must be UTF-8"); }
      if (data.includes(0)) { throw new Error("Binary attachments are not supported"); }
    }
    const entry: Attachment = { id: randomUUID(), name: path.basename(input.name.replaceAll("\\", "/")).replace(/[\x00-\x1f]/g, ""), mimeType: image ? input.mimeType : "text/plain", size: data.length, sha256: digest(data), kind: image ? "image" : "text" };
    attachmentSchema.parse(entry);
    await mkdir(path.dirname(this.file(entry.id, "json")), { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(path.dirname(this.file(entry.id, "json")), ".gitignore"), "*\n");
    await atomicWrite(this.file(entry.id, "data"), data);
    await atomicWrite(this.file(entry.id, "json"), JSON.stringify(entry));
    return entry;
  }
  async get(id: string) {
    const entry = attachmentSchema.parse(JSON.parse((await readBounded(this.file(id, "json"), 4000)).toString("utf8")));
    if (entry.id !== id) { throw new Error("Attachment identity does not match its storage path"); }
    return entry;
  }
  async read(entry: Attachment) {
    const data = await readBounded(this.file(entry.id, "data"), entry.kind === "image" ? 6_000_000 : 256_000);
    if (digest(data) !== entry.sha256 || data.length !== entry.size) { throw new Error(`Attachment changed: ${entry.name}`); }
    return data;
  }
  async context(entries: Attachment[]) {
    const images: ImageContent[] = [];
    const texts: { name: string; text: string }[] = [];
    for (const entry of entries) {
      const data = await this.read(entry);
      if (entry.kind === "image") { images.push({ type: "image", mimeType: entry.mimeType, data: data.toString("base64") }); }
      else { texts.push({ name: entry.name, text: data.toString("utf8") }); }
    }
    return { images, texts };
  }
}
