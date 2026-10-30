import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "../../infrastructure/atomic-file.js";
import { attemptDirectory } from "./attempt-store.js";
import type { AgentSettings, WorkflowRun } from "../../contracts/domain.js";
import type { UsageSession } from "../../contracts/usage-schema.js";
import {
  attemptEvidenceSchema,
  evidenceIdentitySchema,
  sessionContextEvidenceSchema,
  sessionPromptEvidenceSchema,
  sessionToolEvidenceSchema,
  stepInputsEvidenceSchema,
  stepOutputEvidenceSchema,
  stepEvidenceCaptureSchema,
  stepEvidenceTransportSchema,
  serializeEvidenceValue,
  EVIDENCE_CAPTURE_MAX_BYTES,
  EVIDENCE_CHUNK_MAX_BYTES,
  type AttemptEvidence,
  type EvidenceIdentity,
  type EvidenceContentRef,
  type EvidenceValue,
  type StoredEvidenceValue,
  type StepEvidenceTransport,
  type StepOutputEvidence,
  type SessionEvidence,
} from "../../contracts/evidence-schema.js";

/** Full application context is bounded separately from compact step snapshots. */
export const EVIDENCE_CONTENT_MAX_BYTES = 8 * 1024 * 1024;
export type SessionEvidenceIdentity = EvidenceIdentity & {
  sessionId: string;
  operationId: string;
  activityAttempt?: number;
};
export type SessionContextCapture = {
  systemPrompt: string;
  settings: AgentSettings;
  contextMode?: "workflow" | "none";
  tools: { name: string; description: string; parameters: unknown }[];
};
export type SessionPromptCapture = {
  index: number;
  kind: "initial" | "continuation";
  text: string;
  images?: { mimeType: string; data: string }[];
};
export type SessionToolCapture = {
  callId: string;
  name?: string;
  state: "started" | "completed" | "failed" | "interrupted";
  input?: unknown;
  output?: unknown;
  details?: unknown;
  error?: string;
};
const sessionIdentitySchema = evidenceIdentitySchema
  .extend({
    sessionId: z.string().uuid(),
    operationId: z.string().min(1).max(500),
    activityAttempt: z.number().int().positive().optional(),
  })
  .strict();
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const hash = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");
const unavailable = (reason: string) => ({ state: "unavailable" as const, reason });

/** Immutable, run-owned evidence; independent of the bounded event stream. */
export class EvidenceStore {
  constructor(readonly project: string) {}
  private root(identity: EvidenceIdentity) {
    const value = evidenceIdentitySchema.parse({
      runId: identity.runId,
      nodeId: identity.nodeId,
      visit: identity.visit,
    });
    return path.join(
      attemptDirectory(this.project, value.runId, value.nodeId, value.visit),
      "evidence",
    );
  }
  private async json<T>(filename: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      return schema.parse(JSON.parse(await readFile(filename, "utf8")));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  private async immutable(filename: string, value: unknown) {
    const contents = JSON.stringify(value);
    try {
      if ((await readFile(filename, "utf8")) !== contents)
        throw new Error("Captured evidence is immutable; a replay supplied different data.");
      return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(filename), `.${randomUUID()}.immutable`);
    try {
      await atomicWrite(temporary, contents);
      try {
        await link(temporary, filename);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        if ((await readFile(filename, "utf8")) !== contents)
          throw new Error(
            "Captured evidence is immutable; a concurrent write supplied different data.",
            { cause: error },
          );
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async blob(
    identity: EvidenceIdentity,
    value: string | Uint8Array,
    mediaType: string,
  ): Promise<EvidenceContentRef> {
    const bytes = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
    if (bytes > EVIDENCE_CONTENT_MAX_BYTES) throw new Error("Evidence content exceeds 8 MiB");
    const id = hash(value),
      directory = path.join(this.root(identity), "content");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(directory, id), value);
    return { id, bytes, mediaType, exact: true };
  }
  private async text(identity: EvidenceIdentity, value: string): Promise<StoredEvidenceValue> {
    if (Buffer.byteLength(value) > EVIDENCE_CONTENT_MAX_BYTES)
      return {
        state: "unavailable",
        reasonCode: "oversized",
        reason: "Text exceeds the 8 MiB inspector content limit.",
      };
    return {
      state: "captured",
      ref: await this.blob(identity, value, "text/plain; charset=utf-8"),
    };
  }
  private async value(
    identity: EvidenceIdentity,
    value: EvidenceValue,
  ): Promise<StoredEvidenceValue> {
    return value.state === "json"
      ? {
          state: "captured",
          ref: await this.blob(identity, JSON.stringify(value.value), "application/json"),
        }
      : value;
  }
  async hasInputs(identity: EvidenceIdentity) {
    return !!(await this.json(
      path.join(this.root(identity), "inputs.json"),
      stepInputsEvidenceSchema,
    ));
  }
  async captureStep(identity: EvidenceIdentity, raw: StepEvidenceTransport) {
    const transport = stepEvidenceTransportSchema.parse(raw);
    let capture;
    if (transport.kind === "chunk") {
      if (
        transport.index >= transport.total ||
        Buffer.byteLength(transport.data) > EVIDENCE_CHUNK_MAX_BYTES
      )
        throw new Error("Invalid evidence chunk");
      const directory = path.join(this.root(identity), "input-parts");
      await this.immutable(path.join(directory, "count.json"), transport.total);
      await this.immutable(path.join(directory, `${transport.index}.json`), transport.data);
      const parts = await Promise.all(
        Array.from({ length: transport.total }, (_, index) =>
          this.json(path.join(directory, `${index}.json`), z.string()),
        ),
      );
      if (parts.some((part) => part === null)) return;
      const text = parts.join("");
      if (Buffer.byteLength(text) > EVIDENCE_CAPTURE_MAX_BYTES)
        throw new Error("Invalid evidence capture size");
      capture = stepEvidenceCaptureSchema.parse(JSON.parse(text));
    } else {
      if (Buffer.byteLength(JSON.stringify(transport)) > EVIDENCE_CHUNK_MAX_BYTES)
        throw new Error("Large evidence must use chunked transport");
      capture = transport;
    }
    const [rawValue, effective, prompt] = await Promise.all([
      this.value(identity, capture.raw),
      this.value(identity, capture.effective),
      capture.captureWarning
        ? {
            state: "unavailable" as const,
            reasonCode: "oversized" as const,
            reason: capture.captureWarning,
          }
        : this.text(identity, capture.prompt),
    ]);
    await this.immutable(
      path.join(this.root(identity), "inputs.json"),
      stepInputsEvidenceSchema.parse({
        raw: rawValue,
        effective,
        prompt,
        dependencies: capture.dependencies,
        inputError: capture.inputError,
        captureWarning: capture.captureWarning,
      }),
    );
  }
  async captureOutput(
    identity: EvidenceIdentity,
    result: NonNullable<WorkflowRun["attempts"][number]["result"]>,
  ): Promise<StepOutputEvidence> {
    let data: EvidenceValue = { state: "undefined" };
    if (result.artifacts.data !== undefined) {
      try {
        data = serializeEvidenceValue(JSON.parse(result.artifacts.data));
      } catch {
        data = {
          state: "unavailable",
          reasonCode: "unsupported",
          reason:
            "This historical data artifact is not valid JSON; its original text remains available.",
        };
      }
    }
    const artifacts = Object.fromEntries(
      await Promise.all(
        Object.entries(result.artifacts).map(async ([key, value]) => [
          key,
          await this.blob(identity, value, "text/plain; charset=utf-8"),
        ]),
      ),
    );
    const output = stepOutputEvidenceSchema.parse({
      data: await this.value(identity, data),
      artifacts,
      summary: await this.blob(identity, result.summary, "text/plain; charset=utf-8"),
      outcome: result.outcome,
    });
    await this.immutable(path.join(this.root(identity), "output.json"), output);
    return output;
  }
  private sessionRoot(identity: SessionEvidenceIdentity) {
    const valid = sessionIdentitySchema.parse(identity);
    return path.join(
      this.root({ runId: valid.runId, nodeId: valid.nodeId, visit: valid.visit }),
      "sessions",
      valid.sessionId,
    );
  }
  private async session(identity: SessionEvidenceIdentity) {
    const root = this.sessionRoot(identity);
    await this.immutable(path.join(root, "identity.json"), sessionIdentitySchema.parse(identity));
    return root;
  }
  async captureSessionContext(identity: SessionEvidenceIdentity, payload: SessionContextCapture) {
    // TypeBox schemas carry symbol annotations that are not sent to models.
    const tools = JSON.stringify(payload.tools);
    const systemPrompt = payload.systemPrompt,
      settings = structuredClone(payload.settings),
      contextMode = payload.contextMode;
    identity = sessionIdentitySchema.parse(identity);
    const root = await this.session(identity);
    const content =
      Buffer.byteLength(systemPrompt) > EVIDENCE_CONTENT_MAX_BYTES ||
      Buffer.byteLength(tools) > EVIDENCE_CONTENT_MAX_BYTES
        ? unavailable("Application context exceeds the 8 MiB inspector content limit.")
        : {
            state: "available" as const,
            value: sessionContextEvidenceSchema.parse({
              systemPrompt: await this.blob(identity, systemPrompt, "text/plain; charset=utf-8"),
              settings,
              tools: await this.blob(identity, tools, "application/json"),
              contextMode,
            }),
          };
    await this.immutable(path.join(root, "context.json"), content);
  }
  async captureSessionPrompt(identity: SessionEvidenceIdentity, payload: SessionPromptCapture) {
    payload = { ...payload, images: payload.images?.map((image) => ({ ...image })) };
    identity = sessionIdentitySchema.parse(identity);
    const root = await this.session(identity);
    const images: StoredEvidenceValue[] = [];
    for (const image of payload.images ?? []) {
      const value = Buffer.from(image.data, "base64");
      images.push(
        value.byteLength > EVIDENCE_CONTENT_MAX_BYTES
          ? {
              state: "unavailable",
              reasonCode: "oversized",
              reason: "Image exceeds the 8 MiB inspector content limit.",
            }
          : {
              state: "captured",
              ref: await this.blob(
                identity,
                value,
                /^image\/(png|jpeg|webp|gif)$/.test(image.mimeType)
                  ? image.mimeType
                  : "application/octet-stream",
              ),
            },
      );
    }
    const prompt = sessionPromptEvidenceSchema.parse({
      index: payload.index,
      kind: payload.kind,
      text: await this.text(identity, payload.text),
      images,
    });
    await this.immutable(path.join(root, `prompt-${prompt.index}.json`), prompt);
  }
  async captureSessionTool(identity: SessionEvidenceIdentity, payload: SessionToolCapture) {
    const snapshots = (["input", "output", "details"] as const)
      .filter((key) => Object.hasOwn(payload, key))
      .map((key) => [key, serializeEvidenceValue(payload[key])] as const);
    const { callId, name, state, error } = payload;
    identity = sessionIdentitySchema.parse(identity);
    const root = await this.session(identity);
    const values = Object.fromEntries(
      await Promise.all(
        snapshots.map(async ([key, value]) => [key, await this.value(identity, value)]),
      ),
    );
    const tool = sessionToolEvidenceSchema.parse({ callId, name, state, ...values, error });
    await this.immutable(path.join(root, `tool-${hash(callId)}-${state}.json`), tool);
  }
  async captureCall(
    identity: EvidenceIdentity,
    operationId: string,
    payload: { prompt: string; instructions?: string; contextMode: "workflow" | "none" },
  ) {
    const value = {
      prompt: await this.text(identity, payload.prompt),
      instructions:
        payload.instructions === undefined
          ? { state: "undefined" as const }
          : await this.text(identity, payload.instructions),
      contextMode: payload.contextMode,
    };
    await this.immutable(
      path.join(this.root(identity), "calls", `${hash(operationId)}.json`),
      value,
    );
  }
  private async names(directory: string) {
    try {
      return await readdir(directory);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }
  async readAttempt(
    run: WorkflowRun,
    identity: EvidenceIdentity,
    usage: UsageSession[] = [],
  ): Promise<AttemptEvidence> {
    const validated = evidenceIdentitySchema.parse(identity);
    const attempt =
      run.id === validated.runId &&
      run.attempts.find(
        (item) => item.nodeId === validated.nodeId && item.visit === validated.visit,
      );
    if (!attempt)
      throw Object.assign(new Error("Execution attempt not found"), { statusCode: 404 });
    const root = this.root(identity);
    const finished =
      !!attempt.finishedAt || ["completed", "failed", "cancelled", "rejected"].includes(run.status);
    const inputs = await this.json(path.join(root, "inputs.json"), stepInputsEvidenceSchema);
    const output =
      (await this.json(path.join(root, "output.json"), stepOutputEvidenceSchema)) ??
      (attempt.result ? await this.captureOutput(identity, attempt.result) : null);
    const matching = usage
      .filter(
        (item) =>
          item.runId === run.id && item.nodeId === identity.nodeId && item.visit === identity.visit,
      )
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const sessionIds = new Set([
      ...matching.map((item) => item.id),
      ...(await this.names(path.join(root, "sessions"))).filter(
        (id) => z.string().uuid().safeParse(id).success,
      ),
    ]);
    const sessions: SessionEvidence[] = [];
    for (const sessionId of sessionIds) {
      const directory = path.join(root, "sessions", sessionId);
      const saved = await this.json(path.join(directory, "identity.json"), sessionIdentitySchema);
      const ledger = matching.find((item) => item.id === sessionId) ?? null;
      if (
        saved &&
        (saved.runId !== identity.runId ||
          saved.nodeId !== identity.nodeId ||
          saved.visit !== identity.visit)
      )
        throw new Error("Session evidence identity mismatch");
      const operationId = saved?.operationId ?? ledger?.operationId;
      if (!operationId) continue;
      const names = await this.names(directory);
      const prompts = (
        await Promise.all(
          names
            .filter((name) => /^prompt-\d+\.json$/.test(name))
            .map((name) => this.json(path.join(directory, name), sessionPromptEvidenceSchema)),
        )
      )
        .filter((item) => item !== null)
        .sort((a, b) => a.index - b.index);
      const toolRecords = (
        await Promise.all(
          names
            .filter((name) =>
              /^tool-[a-f0-9]{64}-(started|completed|failed|interrupted)\.json$/.test(name),
            )
            .map((name) => this.json(path.join(directory, name), sessionToolEvidenceSchema)),
        )
      ).filter((item) => item !== null);
      const tools = new Map<string, z.infer<typeof sessionToolEvidenceSchema>>();
      for (const tool of toolRecords.sort(
        (a, b) => Number(a.state !== "started") - Number(b.state !== "started"),
      ))
        tools.set(tool.callId, { ...tools.get(tool.callId), ...tool });
      sessions.push({
        sessionId,
        operationId,
        activityAttempt: saved?.activityAttempt ?? ledger?.activityAttempt,
        usage: ledger,
        context:
          (await this.json(
            path.join(directory, "context.json"),
            attemptEvidenceSchema.shape.sessions.element.shape.context,
          )) ?? unavailable("Application context was not captured for this session."),
        prompts,
        tools: [...tools.values()],
        call: await this.json(
          path.join(root, "calls", `${hash(operationId)}.json`),
          attemptEvidenceSchema.shape.sessions.element.shape.call.options[0].shape.value,
        ).then((value) =>
          value
            ? { state: "available" as const, value }
            : unavailable("Original call input was not captured for this session."),
        ),
      });
    }
    return attemptEvidenceSchema.parse({
      ...validated,
      version: 1,
      inputs: inputs
        ? { state: "available", value: inputs }
        : {
            state: finished ? "unavailable" : "pending",
            reason: finished
              ? "This attempt has no exact input capture. Historical node context is not a typed snapshot."
              : "Waiting for this attempt's input capture.",
          },
      output: output
        ? { state: "available", value: output }
        : {
            state: finished ? "unavailable" : "pending",
            reason: finished
              ? "This attempt did not publish a result."
              : "This attempt has not published a result yet.",
          },
      sessions,
    });
  }
  async content(evidence: AttemptEvidence, id: string) {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(id);
    let reference: EvidenceContentRef | undefined;
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if ("id" in value && value.id === id && "exact" in value && value.exact === true)
        reference = value as EvidenceContentRef;
      for (const nested of Object.values(value)) visit(nested);
    };
    visit(evidence);
    if (!reference)
      throw Object.assign(new Error("Evidence content not found in this attempt"), {
        statusCode: 404,
      });
    const expectedRoot = path.join(
      await realpath(this.project),
      path.relative(this.project, this.root(evidence)),
    );
    const root = await realpath(expectedRoot);
    if (root !== expectedRoot)
      throw Object.assign(new Error("Evidence directory is outside its attempt"), {
        statusCode: 404,
      });
    const filename = await realpath(path.join(root, "content", id)).catch((error) => {
      if (missing(error))
        throw Object.assign(new Error("Evidence content file is missing"), { statusCode: 404 });
      throw error;
    });
    if (!filename.startsWith(`${root}${path.sep}`))
      throw Object.assign(new Error("Evidence content is outside its attempt"), {
        statusCode: 404,
      });
    const data = await readFile(filename);
    if (data.byteLength !== reference.bytes || hash(data) !== id)
      throw new Error("Evidence content failed its integrity check");
    return { ref: reference, data };
  }
}
