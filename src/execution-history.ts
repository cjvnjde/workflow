/** Browser-safe execution read model. Append order, never wall-clock sorting, owns identity. */
import { z } from "zod";
import { eventSchema, type RunEvent } from "./domain.js";
import { operationRecordSchema, type OperationRecord } from "./operation-schema.js";

export const historyQuerySchema = z.object({
  before: z.coerce.number().int().nonnegative().optional(),
  asOf: z.coerce.number().int().min(-1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
}).strict();
export type HistoryQuery = z.input<typeof historyQuerySchema>;
export const historyPageSchema = z.object({
  events: z.array(z.object({ cursor: z.number().int().nonnegative(), event: eventSchema })),
  asOf: z.number().int().min(-1), total: z.number().int().nonnegative(),
  nextBefore: z.number().int().nonnegative().optional(), hasMore: z.boolean(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;

// Results need these records across the entire run, independently of the
// bounded live feed. Omit chat deltas and tool payloads from this read model.
const reportEvidenceKinds = new Set([
  "flow_decision", "model_session", "model_session_end", "execution_workspace",
  "file_evidence", "file_evidence_unavailable", "ownership_contract",
  "ownership_evidence", "ownership_violation", "capability_warning",
]);
export const isReportEvidenceEvent = (event: RunEvent) => reportEvidenceKinds.has(event.kind);
export const reportEvidenceSchema = z.object({
  events: z.array(eventSchema),
  asOf: z.number().int().min(-1), total: z.number().int().nonnegative(),
  available: z.boolean(),
});
export type ReportEvidence = z.infer<typeof reportEvidenceSchema>;
export const executionOperationSchema = z.object({
  key: z.string(), id: z.string(), parentId: z.string().optional(), parentKey: z.string().optional(),
  name: z.string(), kind: operationRecordSchema.shape.kind, state: operationRecordSchema.shape.state,
  nodeId: z.string().optional(), visit: z.number().int().positive().optional(), attempt: z.number().int().positive().optional(),
  sessionId: z.string().optional(), environmentId: z.string().optional(),
  startedAt: z.string().optional(), finishedAt: z.string().optional(), durationMs: z.number().nonnegative().optional(),
  summary: z.string().optional(), truncated: z.boolean().optional(),
  firstCursor: z.number().int().nonnegative(), lastCursor: z.number().int().nonnegative(), eventCount: z.number().int().positive(),
  operation: operationRecordSchema,
});
export type ExecutionOperation = z.infer<typeof executionOperationSchema>;
export const executionSnapshotSchema = z.object({
  version: z.literal(1), asOf: z.number().int().min(-1), total: z.number().int().nonnegative(),
  operations: z.array(executionOperationSchema),
});
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;
export const operationEventsSchema = z.object({ events: z.array(eventSchema), asOf: z.number().int().min(-1), operation: executionOperationSchema.optional() });

export function operationKey(id: string, visit?: number, attempt?: number) {
  return `${encodeURIComponent(id)}:${visit ?? 0}:${attempt ?? 0}`;
}

/** Mutable builder is local to one read; published values are detached JSON data. */
export class ExecutionProjection {
  readonly operations = new Map<string, ExecutionOperation>();
  private readonly current = new Map<string, ExecutionOperation>();
  constructor(private readonly compact = false) {}

  apply(event: RunEvent, cursor: number): string | undefined {
    const source = event.operation;
    if (!source) return;
    const parent = source.parentId ? this.current.get(source.parentId) : undefined;
    const visit = source.visit ?? parent?.visit;
    const attempt = source.attempt ?? source.parentAttempt ?? parent?.attempt;
    const key = operationKey(source.id, visit, attempt);
    const previous = this.operations.get(key);
    const operation = { ...previous?.operation, ...source, ...(visit === undefined ? {} : { visit }), ...(attempt === undefined ? {} : { attempt }) };
    if (this.compact) {
      if (!operation.summary) operation.summary = preview(operation);
      delete operation.input; delete operation.output;
      // Request timing is small factual metadata, useful without opening a large payload.
      if (!["request", "wait"].includes(operation.kind) || JSON.stringify(operation.details ?? null).length > 4000) delete operation.details;
      if (operation.presentation && JSON.stringify(operation.presentation).length > 4000) {
        delete operation.presentation; operation.truncated = true;
      }
    }
    const wasTerminal = previous && ["completed", "failed", "interrupted"].includes(previous.state);
    const terminal = ["completed", "failed", "interrupted"].includes(operation.state);
    // A delayed progress notification may supplement evidence, never reopen settled work.
    if (wasTerminal && !terminal) operation.state = previous.state;
    const record: ExecutionOperation = {
      key, id: source.id, name: source.name, kind: source.kind, state: operation.state,
      nodeId: event.nodeId ?? previous?.nodeId, visit, attempt,
      parentId: source.parentId ?? previous?.parentId,
      parentKey: source.parentId ? operationKey(source.parentId, visit, source.parentAttempt ?? parent?.attempt ?? attempt) : previous?.parentKey,
      sessionId: source.sessionId ?? previous?.sessionId ?? parent?.sessionId,
      environmentId: source.environmentId ?? previous?.environmentId ?? parent?.environmentId,
      startedAt: previous?.startedAt ?? (source.state === "started" ? event.time : undefined),
      finishedAt: terminal ? event.time : previous?.finishedAt,
      durationMs: source.durationMs ?? previous?.durationMs,
      summary: operation.summary, truncated: operation.truncated,
      firstCursor: previous?.firstCursor ?? cursor, lastCursor: cursor, eventCount: (previous?.eventCount ?? 0) + 1,
      operation,
    };
    this.operations.set(key, record); this.current.set(source.id, record);
    return key;
  }
}
function preview(op: OperationRecord): string {
  if (typeof op.input === "string") return op.input.split("\n")[0]!.slice(0, 300);
  if (op.input && typeof op.input === "object" && !Array.isArray(op.input)) {
    const value = op.input.command ?? op.input.path ?? op.input.pattern;
    if (typeof value === "string") return value.split("\n")[0]!.slice(0, 300);
  }
  return op.name;
}

export function projectOperations(events: readonly RunEvent[], compact = false): ExecutionOperation[] {
  const projection = new ExecutionProjection(compact);
  const seen = new Set<string>();
  events.forEach((event, cursor) => {
    if (seen.has(event.id)) return;
    seen.add(event.id); projection.apply(event, cursor);
  });
  return [...projection.operations.values()];
}
