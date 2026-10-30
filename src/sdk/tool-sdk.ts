import { z } from "zod";
import type { ToolPresentation } from "../contracts/operation-schema.js";
import type { ExecResult } from "./workflow-sdk.js";

/** Effects supplied by the execution host. Implementations own cancellation and file recovery. */
export interface ExecutionEnvironment {
  readonly id: string;
  readText(path: string): Promise<string>;
  listFiles?(pattern?: string): Promise<string[]>;
  editText?(path: string, oldText: string, newText: string): Promise<void>;
  inspectGit?(input: { base?: string; path?: string }): Promise<unknown>;
  writeText(path: string, content: string): Promise<void>;
  exec(
    command: string,
    options?: {
      timeoutMs?: number;
      env?: Record<string, string>;
      signal?: AbortSignal;
      onOutput?: (chunk: string) => void;
      onCapture?: (ref: import("../contracts/operation-schema.js").CommandOutputRef) => void;
    },
  ): Promise<ExecResult>;
}
/** Serializable effect surface exposed inside an authored tool worker. */
export interface ToolEnvironment {
  readonly id: string;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  exec(
    command: string,
    options?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<ExecResult>;
}
export interface ToolContext {
  readonly env: ToolEnvironment;
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly request: string;
  summary(text: string): void;
  details(value: unknown): void;
  progress(text: string): Promise<void>;
  /** Human-facing display data; never changes the typed return or model summary. */
  present(value: ToolPresentation): void;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous authored blocks retain their own generic input/output types at this boundary.
export type WorkflowTool<I = any, O = any> = {
  readonly kind: "tool";
  readonly name: string;
  readonly version: number;
  readonly description: string;
  /** safe tools may only read; interrupted unsafe tools require explicit recovery. */
  readonly replay: "safe" | "unsafe";
  readonly timeoutMs: number;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  execute(input: I, context: ToolContext): O | Promise<O>;
};
const tools = new Map<string, WorkflowTool>();

/** Define at module scope. Static imports and captured helpers are archived with the workflow. */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(definition: {
  name: string;
  version?: number;
  description: string;
  input: I;
  output: O;
  replay?: "safe" | "unsafe";
  timeoutMs?: number;
  execute(input: z.output<I>, context: ToolContext): z.input<O> | Promise<z.input<O>>;
}): WorkflowTool<z.output<I>, z.output<O>> {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(definition.name) || definition.name === "submit_result")
    throw new Error("Tool names must be lowercase identifiers and cannot be submit_result");
  if (!definition.description.trim() || definition.description.length > 4000)
    throw new Error("Tools need a description of at most 4000 characters");
  const version = definition.version ?? 1,
    timeoutMs = definition.timeoutMs ?? 120_000;
  if (
    !Number.isInteger(version) ||
    version < 1 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 600_000
  )
    throw new Error("Invalid tool version or timeout");
  if (definition.replay !== undefined && !["safe", "unsafe"].includes(definition.replay))
    throw new Error("Tool replay must be safe or unsafe");
  // Both entry points use the same JSON contract, including the model's tool schema.
  z.toJSONSchema(definition.input);
  z.toJSONSchema(definition.output);
  if (tools.has(definition.name)) throw new Error(`Duplicate tool name: ${definition.name}`);
  if (tools.size >= 64) throw new Error("A workflow can define at most 64 tools");
  const tool = Object.freeze({
    ...definition,
    kind: "tool" as const,
    version,
    timeoutMs,
    replay: definition.replay ?? "unsafe",
  });
  tools.set(tool.name, tool as WorkflowTool);
  return tool as WorkflowTool<z.output<I>, z.output<O>>;
}
/** @internal Exported into the immutable host-tool bundle by the compiler. */
export function __workflowTools() {
  return [...tools.values()];
}

export function toolReference(tool: WorkflowTool) {
  if (tool.kind !== "tool") throw new Error("Use a tool returned by defineTool");
  return { name: tool.name, version: tool.version, replay: tool.replay };
}
