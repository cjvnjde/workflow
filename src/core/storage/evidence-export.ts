import type { WorkflowClient } from "../../client/client.js";
import {
  evidenceContentRefSchema,
  type AttemptEvidence,
  type EvidenceContentRef,
  type StoredEvidenceValue,
} from "../../contracts/evidence-schema.js";

type Content =
  | { state: "available"; ref: EvidenceContentRef; text: string }
  | { state: "omitted" | "unavailable"; ref: EvidenceContentRef; reason: string; url: string };
export type EvidenceExport = { evidence: AttemptEvidence; contents: Record<string, Content> };

/** Export stored text/JSON with an explicit bound; binary images remain links. */
export async function exportAttemptEvidence(
  client: WorkflowClient,
  runId: string,
  nodeId: string,
  visit: number,
  signal?: AbortSignal,
  maxBytes = 16 * 1024 * 1024,
): Promise<EvidenceExport> {
  const evidence = await client.attemptEvidence(runId, nodeId, visit, signal);
  const refs = new Map<string, EvidenceContentRef>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const ref = evidenceContentRefSchema.safeParse(value);
    if (ref.success) {
      refs.set(ref.data.id, ref.data);
      return;
    }
    for (const entry of Object.values(value)) collect(entry);
  };
  collect(evidence);
  const contents: Record<string, Content> = {};
  const pending: EvidenceContentRef[] = [];
  let remaining = maxBytes;
  for (const ref of refs.values()) {
    const binary = !ref.mediaType.startsWith("text/") && !ref.mediaType.includes("json");
    if (binary || ref.bytes > remaining) {
      contents[ref.id] = {
        state: "omitted",
        ref,
        reason: binary
          ? "Binary content is available through its download link."
          : `This export's ${maxBytes}-byte display budget was reached; the complete stored content remains available.`,
        url: client.evidenceContentUrl(runId, nodeId, visit, ref.id, true),
      };
    } else {
      pending.push(ref);
      remaining -= ref.bytes;
    }
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (next < pending.length) {
        const ref = pending[next++]!;
        signal?.throwIfAborted();
        try {
          contents[ref.id] = {
            state: "available",
            ref,
            text: await client.evidenceContent(runId, nodeId, visit, ref.id, signal),
          };
        } catch (error) {
          signal?.throwIfAborted();
          contents[ref.id] = {
            state: "unavailable",
            ref,
            reason: error instanceof Error ? error.message : String(error),
            url: client.evidenceContentUrl(runId, nodeId, visit, ref.id, true),
          };
        }
      }
    }),
  );
  return { evidence, contents };
}

export function formatEvidenceExport(value: EvidenceExport) {
  const { evidence, contents } = value;
  const content = (ref: EvidenceContentRef) => {
    const stored = contents[ref.id];
    if (!stored) return `Content ${ref.id} was not loaded.`;
    if (stored.state !== "available") return `${stored.reason}\n${stored.url}`;
    if (ref.mediaType.includes("json")) {
      try {
        return JSON.stringify(JSON.parse(stored.text), null, 2);
      } catch {
        /* Keep original text if it is not JSON. */
      }
    }
    return stored.text;
  };
  const stored = (entry: StoredEvidenceValue) =>
    entry.state === "captured"
      ? content(entry.ref)
      : entry.state === "undefined"
        ? "undefined (no value supplied)"
        : `Unavailable: ${entry.reason}`;
  const rows = [`Step ${evidence.nodeId} · visit ${evidence.visit}`, `Run ${evidence.runId}`, ""];
  if (evidence.inputs.state === "available") {
    const input = evidence.inputs.value;
    rows.push(
      "INPUTS BEFORE SCHEMA",
      stored(input.raw),
      "",
      "INPUTS RECEIVED BY THE BLOCK",
      stored(input.effective),
      "",
      "STEP PROMPT",
      stored(input.prompt),
    );
    if (input.dependencies.length)
      rows.push(
        "",
        "READ FROM PREVIOUS STEPS",
        ...input.dependencies.map(
          (dep) =>
            `${dep.producerNodeId} · visit ${dep.producerVisit ?? "unavailable"} · ${dep.kind}${dep.artifact ? ` ${dep.artifact}` : ""} → ${dep.usedBy}${dep.inputName ? `.${dep.inputName}` : ""}`,
        ),
      );
    if (input.inputError) rows.push(`Input error: ${input.inputError}`);
    if (input.captureWarning) rows.push(`Capture note: ${input.captureWarning}`);
  } else rows.push(`Inputs ${evidence.inputs.state}: ${evidence.inputs.reason}`);
  if (evidence.output.state === "available") {
    const output = evidence.output.value;
    rows.push(
      "",
      `OUTPUT · ${output.outcome}`,
      stored(output.data),
      "",
      "SUMMARY",
      content(output.summary),
    );
    for (const [name, ref] of Object.entries(output.artifacts))
      rows.push("", `ARTIFACT ${name}`, content(ref));
  } else rows.push("", `Output ${evidence.output.state}: ${evidence.output.reason}`);
  for (const session of evidence.sessions) {
    rows.push("", `AI SESSION ${session.sessionId}`, `Operation ${session.operationId}`);
    if (session.usage)
      rows.push(
        `${session.usage.provider}/${session.usage.model} · ${session.usage.thinking} · ${session.usage.status} · $${session.usage.usage.costUsd.toFixed(6)} reported`,
      );
    if (session.call.state === "available")
      rows.push(
        "Caller context mode: " + session.call.value.contextMode,
        "CALLER PROMPT",
        stored(session.call.value.prompt),
        "CALLER INSTRUCTIONS",
        stored(session.call.value.instructions),
      );
    if (session.context.state === "available")
      rows.push(
        "APPLICATION SYSTEM PROMPT",
        content(session.context.value.systemPrompt),
        "SELECTED TOOLS",
        content(session.context.value.tools),
      );
    else rows.push(`Session context ${session.context.state}: ${session.context.reason}`);
    for (const prompt of session.prompts)
      rows.push(
        `${prompt.kind.toUpperCase()} PROMPT ${prompt.index + 1}`,
        stored(prompt.text),
        ...prompt.images.map((image) => stored(image)),
      );
    for (const tool of session.tools)
      rows.push(
        `TOOL ${tool.name ?? tool.callId} · ${tool.state} · ${tool.callId}`,
        ...(tool.input ? ["Input:", stored(tool.input)] : []),
        ...(tool.output ? ["Output:", stored(tool.output)] : []),
        ...(tool.details ? ["Details:", stored(tool.details)] : []),
        ...(tool.error ? [tool.error] : []),
      );
  }
  return rows.join("\n");
}
