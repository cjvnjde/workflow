import type { OperationRecord } from "../../../src/contracts/index.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export function operationBody(operation: OperationRecord) {
  const input = object(operation.input),
    output = object(operation.output),
    details = object(operation.details);
  const presentation = object(operation.presentation) ?? object(details?.toolPresentation);
  const command =
    text(presentation?.command) ??
    text(input?.command) ??
    (operation.kind === "exec" ? text(operation.input) : undefined);
  const path =
    text(presentation?.path) ??
    text(input?.path) ??
    text(input?.file_path) ??
    (operation.kind === "read" || operation.kind === "write" ? text(operation.input) : undefined);
  const result = presentation?.output ?? output?.output ?? output?.stdout ?? operation.output;
  const exit = presentation?.exitCode ?? output?.exitCode ?? details?.exitCode;
  const oldText =
    (presentation?.before === null ? "" : text(presentation?.before)) ??
    text(presentation?.oldText) ??
    text(details?.before) ??
    text(input?.oldText);
  const newText =
    (presentation?.after === null ? "" : text(presentation?.after)) ??
    text(presentation?.newText) ??
    text(details?.after) ??
    text(input?.newText);
  const card =
    text(presentation?.card) ??
    (command || operation.name === "bash" ? "command" : path ? "file-read" : "generic");
  const resultBlocks = Array.isArray(result) ? result : object(result)?.content;
  const resultText =
    Array.isArray(resultBlocks) && resultBlocks.every((part) => object(part)?.type === "text")
      ? resultBlocks.map((part) => text(object(part)?.text) ?? "").join("\n")
      : undefined;
  const matches = Array.isArray(presentation?.matches)
    ? presentation.matches.flatMap((value) => {
        const match = object(value);
        return typeof match?.path === "string"
          ? [
              {
                path: match.path,
                line: typeof match.line === "number" ? match.line : undefined,
                text: text(match.text),
              },
            ]
          : [];
      })
    : undefined;
  return {
    card,
    command,
    path,
    cwd: text(presentation?.cwd) ?? text(input?.cwd) ?? text(details?.cwd),
    exitCode: typeof exit === "number" ? exit : undefined,
    title: text(presentation?.title) ?? operation.name,
    oldText,
    newText,
    result:
      resultText ??
      (typeof result === "string"
        ? result
        : result === undefined
          ? undefined
          : JSON.stringify(result, null, 2)),
    input: operation.input === undefined ? undefined : JSON.stringify(operation.input, null, 2),
    details:
      operation.details === undefined ? undefined : JSON.stringify(operation.details, null, 2),
    matches,
  };
}
export function durationLabel(milliseconds?: number) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "Timing unavailable";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${((milliseconds % 60_000) / 1000).toFixed(0)}s`;
}
