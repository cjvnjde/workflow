import { z } from "zod";
import type { FlowNode } from "./composition-sdk.js";
import type { WorkflowTool } from "./tool-sdk.js";
export { defineTool, __workflowTools } from "./tool-sdk.js";
export type { WorkflowTool, ToolContext, ExecutionEnvironment } from "./tool-sdk.js";
export { z };
export { step, sequence, parallel, when, repeatUntil, describeFlow } from "./composition-sdk.js";
export type { FlowNode, FlowStep, FlowContext, FlowStructure } from "./composition-sdk.js";

export type Model = {
  provider?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  maxToolCalls?: number;
  /** Opt-in bounded parallel read batches; omitted keeps sequential tools. */
  maxParallelTools?: number;
};
export type Outcome = "pass" | "retry" | "fail";
export type StepResult<T = unknown> = {
  disposition?: "work-completed" | "accepted" | "changes-requested" | "blocked";
  outcome: Outcome;
  summary: string;
  artifacts: Record<string, string>;
  data?: T;
};
export type StepOptions = {
  prompt?: string;
  label?: string;
  model?: Model | string;
  inputs?: Record<string, unknown>;
  maxVisits?: number;
};
type Common = { name?: string; description?: string; outputs?: string[] };
export type AgentOptions<S extends z.ZodType = z.ZodType> = Common & {
  instructions: string;
  model?: Model | string;
  output?: S;
};
export type ScriptOptions<S extends z.ZodType = z.ZodType> = Common & {
  language: "bash" | "javascript" | "typescript";
  runtime?: "bash" | "bun" | "node";
  code: string;
  timeoutMs?: number;
  expect?: "success" | "failure";
  output?: S;
};
/** A reusable definition. Constructing a block never executes it. */
export type Block<T = unknown> = {
  readonly kind: "agent" | "script";
  readonly options: AgentOptions | ScriptOptions;
  /** Type-only marker: data is produced by the step, not the definition. */
  readonly _output?: T;
};
/** @deprecated Use block({async run(ctx) { return ctx.ai(...); }}). */
export function agent<S extends z.ZodType>(
  options: AgentOptions<S>,
): Block<z.output<S>> {
  return { kind: "agent", options };
}
/** @deprecated Use block({async run(ctx) { return ctx.exec(...); }}). */
export function script<S extends z.ZodType>(
  options: ScriptOptions<S>,
): Block<z.output<S>> {
  return { kind: "script", options };
}
export type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  output: string;
  timedOut: boolean;
  /** Scoped retained command transcript; previews may be abbreviated. */
  outputRef?: import("./operation-schema.js").CommandOutputRef;
  /** Result written by an existing WORKFLOW_RESULT script, when present. */
  result?: StepResult;
};
export type AIOptions<S extends z.ZodType = z.ZodType> = {
  /** Omit inherited task, graph, inputs, attachments and project instructions. Tools remain available. */
  context?: "workflow" | "none";
  /** Text-only transformation: only the structured-result tool is available. */
  tools?: "none" | readonly WorkflowTool[];
  role?: "test-author" | "repair" | "verification" | "review";
  capabilities?: { skills?: string[]; mcp?: Record<string, string[]>; optionalMcp?: string[] };
  /** Project-relative globs owned by other steps; checked before accepting this call. */
  protectedPaths?: string[];
  writablePaths?: string[];
  workspace?: string;
  prompt: string;
  instructions?: string;
  model?: Model | string;
  output?: S;
};
export interface BlockContext<I> {
  /** Invoke the same frozen, typed capability an AI call can use. */
  call<A, O>(tool: WorkflowTool<A, O>, input: A): Promise<O>;
  readonly input: I;
  readonly request: string;
  readonly prompt: string;
  readonly models: Readonly<Record<string, Model>>;
  readonly model: Model;
  readonly visit: number;
  /** A durable model/tool session. A schema returns typed data; otherwise returns Markdown. */
  ai<S extends z.ZodType>(
    options: AIOptions<S> & { output: S },
  ): Promise<z.output<S>>;
  ai(options: AIOptions): Promise<string>;
  /** Run Bash in the project. Nonzero exits are returned so code can route test feedback. */
  exec(
    command: string,
    options?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  log(message: string): Promise<void>;
  artifact(name: string, content: string): void;
  summary(markdown: string): void;
  /** Record a routing outcome while returning structured feedback to the caller. */
  outcome(value: Outcome): void;
  /** Describe acceptance separately from successful authoring; also sets the matching routing outcome. */
  disposition(value: "work-completed" | "accepted" | "changes-requested" | "blocked"): void;
}
export type CodeBlock<I = Record<string, unknown>, O = unknown> = {
  readonly kind: "code";
  readonly options: {
    name?: string;
    description?: string;
    input?: z.ZodType<I>;
    output?: z.ZodType<O>;
    timeoutMs?: number;
    maxOperations?: number;
    run(context: BlockContext<I>): O | Promise<O>;
  };
};
/** One reusable unit of TypeScript. AI, processes and files are optional capabilities inside it. */
export function block<I extends z.ZodType, O extends z.ZodType>(definition: {
  name?: string;
  description?: string;
  input: I;
  output: O;
  timeoutMs?: number;
  maxOperations?: number;
  run(context: BlockContext<z.output<I>>): z.input<O> | Promise<z.input<O>>;
}): CodeBlock<z.output<I>, z.output<O>>;
export function block<O extends z.ZodType>(definition: {
  name?: string;
  description?: string;
  output: O;
  timeoutMs?: number;
  maxOperations?: number;
  run(
    context: BlockContext<Record<string, unknown>>,
  ): z.input<O> | Promise<z.input<O>>;
}): CodeBlock<Record<string, unknown>, z.output<O>>;
export function block<I extends z.ZodType, O>(definition: {
  name?: string;
  description?: string;
  input: I;
  timeoutMs?: number;
  maxOperations?: number;
  run(context: BlockContext<z.output<I>>): O | Promise<O>;
}): CodeBlock<z.output<I>, Awaited<O>>;
export function block<O>(definition: {
  name?: string;
  description?: string;
  timeoutMs?: number;
  maxOperations?: number;
  run(context: BlockContext<Record<string, unknown>>): O | Promise<O>;
}): CodeBlock<Record<string, unknown>, Awaited<O>>;
export function block(
  definition: CodeBlock<any, any>["options"],
): CodeBlock<any, any> {
  return { kind: "code", options: definition };
}
export interface WorkflowContext<I> {
  /** Engine graph adapter with explicit outcome routes. Block code normally uses typed ctx.step results. */
  stepResult(
    id: string,
    block: string,
    options?: StepOptions,
  ): Promise<StepResult>;
  readonly input: I;
  readonly request: string;
  readonly models: Readonly<Record<string, Model>>;
  step<I, O>(
    id: string,
    block: CodeBlock<I, O>,
    options?: StepOptions & { inputs?: I },
  ): Promise<O>;
  /** Each awaited step is durable. Reuse an ID in a loop to record another visit. */
  step<T>(
    id: string,
    block: Block<T>,
    options?: StepOptions,
  ): Promise<StepResult<T>>;
  /** Reuse a saved block from the project's frozen Settings library. */
  step<T = StepResult>(
    id: string,
    block: string,
    options?: StepOptions,
  ): Promise<T>;
}
export type WorkflowDefinition<I = unknown> = {
  name: string;
  input?: z.ZodType<I>;
} & ({ run(context: WorkflowContext<I>): Promise<unknown>; flow?: never } | { flow: FlowNode; run?: never });
export function workflow<S extends z.ZodType>(definition: { name: string; input: S; flow: FlowNode }): WorkflowDefinition<z.output<S>> & { flow: FlowNode };
export function workflow(definition: { name: string; flow: FlowNode }): WorkflowDefinition<Record<string, unknown>> & { flow: FlowNode };
export function workflow<S extends z.ZodType>(definition: {
  name: string;
  input: S;
  run(context: WorkflowContext<z.output<S>>): Promise<unknown>;
}): WorkflowDefinition<z.output<S>>;
export function workflow(definition: {
  name: string;
  run(context: WorkflowContext<Record<string, unknown>>): Promise<unknown>;
}): WorkflowDefinition<Record<string, unknown>>;
export function workflow<I>(
  definition: WorkflowDefinition<I>,
): WorkflowDefinition<I> {
  return definition;
}
