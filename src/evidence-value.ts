import { z } from "zod";

/** Inspector limits do not change block execution or schema behavior. */
export const EVIDENCE_VALUE_MAX_BYTES = 2 * 1024 * 1024;
export const EVIDENCE_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
export const EVIDENCE_CHUNK_MAX_BYTES = 512 * 1024;
export const unavailableEvidenceSchema = z.object({
  state: z.literal("unavailable"), reasonCode: z.enum(["unsupported", "oversized", "validation-failed"]), reason: z.string(),
}).strict();
export const evidenceValueSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("json"), value: z.json() }).strict(),
  z.object({ state: z.literal("undefined") }).strict(), unavailableEvidenceSchema,
]);
export type EvidenceValue = z.infer<typeof evidenceValueSchema>;
export type UnavailableEvidence = z.infer<typeof unavailableEvidenceSchema>;
export const evidenceDependencySchema = z.object({
  producerNodeId: z.string(), producerVisit: z.number().int().positive().nullable(),
  kind: z.enum(["output", "result", "artifact"]), usedBy: z.enum(["inputs", "prompt"]),
  artifact: z.string().optional(), inputName: z.string().optional(),
}).strict();
export type EvidenceDependency = z.infer<typeof evidenceDependencySchema>;
export const stepEvidenceCaptureSchema = z.object({
  kind: z.literal("inputs"), raw: evidenceValueSchema, effective: evidenceValueSchema,
  prompt: z.string(), dependencies: z.array(evidenceDependencySchema), inputError: z.string().optional(), captureWarning: z.string().optional(),
}).strict();
export type StepEvidenceCapture = z.infer<typeof stepEvidenceCaptureSchema>;
export const stepEvidenceTransportSchema = z.union([stepEvidenceCaptureSchema, z.object({
  kind: z.literal("chunk"), index: z.number().int().min(0).max(15), total: z.number().int().min(1).max(16), data: z.string(),
}).strict()]);
export type StepEvidenceTransport = z.infer<typeof stepEvidenceTransportSchema>;

/** UTF-8 byte count without host globals; also runs inside Temporal's VM. */
export function evidenceBytes(value: string) {
  let size = 0;
  for (const character of value) { const point = character.codePointAt(0)!; size += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4; }
  return size;
}

/** Refuse lossy JSON coercions, getters and transformed object instances. */
export function serializeEvidenceValue(value: unknown): EvidenceValue {
  if (value === undefined) return { state: "undefined" };
  const seen = new Set<object>();
  const check = (item: unknown, at: string): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) return;
    if (typeof item !== "object" || item === null) throw new Error(`${at}: ${typeof item} is not lossless JSON`);
    if (seen.has(item)) throw new Error(`${at}: cyclic value`);
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new Error(`${at}: transformed object is not plain JSON`);
    if (Object.getOwnPropertySymbols(item).length) throw new Error(`${at}: symbol properties are not JSON`);
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor || !("value" in descriptor)) throw new Error(`${at}[${index}]: sparse arrays/getters are not JSON`);
        check(descriptor.value, `${at}[${index}]`);
      }
      if (Object.keys(item).length !== item.length) throw new Error(`${at}: extra array properties are not JSON`);
    } else for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) throw new Error(`${at}.${key}: hidden properties/getters are not JSON`);
      check(descriptor.value, `${at}.${key}`);
    }
    seen.delete(item);
  };
  try {
    check(value, "$");
    const text = JSON.stringify(value);
    if (evidenceBytes(text) > EVIDENCE_VALUE_MAX_BYTES) return { state: "unavailable", reasonCode: "oversized", reason: "Value exceeds the 2 MiB inspector snapshot limit; execution is unchanged." };
    return { state: "json", value: JSON.parse(text) };
  } catch (error) {
    return { state: "unavailable", reasonCode: "unsupported", reason: error instanceof Error ? error.message : "Value is not lossless JSON" };
  }
}

export function serializeStepEvidence(value: StepEvidenceCapture): StepEvidenceTransport[] {
  let capture = stepEvidenceCaptureSchema.parse(value);
  let text = JSON.stringify(capture);
  if (evidenceBytes(text) > EVIDENCE_CAPTURE_MAX_BYTES) {
    const unavailable: UnavailableEvidence = { state: "unavailable", reasonCode: "oversized", reason: "Combined input evidence exceeds the 8 MiB inspector limit; execution is unchanged." };
    capture = { kind: "inputs", raw: unavailable, effective: unavailable, prompt: "", captureWarning: "Prompt and dependencies exceeded the combined inspector capture limit.", dependencies: [] };
    text = JSON.stringify(capture);
  }
  if (evidenceBytes(text) <= EVIDENCE_CHUNK_MAX_BYTES) return [capture];
  const parts: string[] = [];
  let part = "", bytes = 0;
  for (const character of text) {
    const length = evidenceBytes(character);
    if (bytes + length > EVIDENCE_CHUNK_MAX_BYTES) { parts.push(part); part = ""; bytes = 0; }
    part += character; bytes += length;
  }
  if (part) parts.push(part);
  return parts.map((data, index) => ({ kind: "chunk", index, total: parts.length, data }));
}
