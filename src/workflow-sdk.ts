import { z } from "zod";
export { z };

export type Model = {
  provider?: string; model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number; maxToolCalls?: number;
};
export type Outcome = "pass" | "retry" | "fail";
export type StepResult<T = unknown> = {
  outcome: Outcome; summary: string; artifacts: Record<string, string>; data?: T;
};
export type StepOptions = {
  prompt?: string; label?: string; model?: Model | string;
  inputs?: Record<string, unknown>; maxVisits?: number;
};
type Common = { name?: string; description?: string; outputs?: string[] };
export type AgentOptions<S extends z.ZodType = z.ZodType> = Common & {
  instructions: string; model?: Model | string; output?: S;
};
export type ScriptOptions<S extends z.ZodType = z.ZodType> = Common & {
  language: "bash" | "javascript" | "typescript"; runtime?: "bash" | "bun" | "node";
  code: string; timeoutMs?: number; expect?: "success" | "failure"; output?: S;
};
/** A reusable definition. Constructing a block never executes it. */
export type Block<T = unknown> = {
  readonly kind: "agent" | "script";
  readonly options: AgentOptions | ScriptOptions;
  /** Type-only marker: data is produced by the step, not the definition. */
  readonly _output?: T;
};
export function agent<S extends z.ZodType>(options: AgentOptions<S>): Block<z.output<S>> {
  return { kind: "agent", options };
}
export function script<S extends z.ZodType>(options: ScriptOptions<S>): Block<z.output<S>> {
  return { kind: "script", options };
}
export interface WorkflowContext<I> {
  readonly input: I;
  readonly request: string;
  readonly models: Readonly<Record<string, Model>>;
  /** Each awaited step is durable. Reuse an ID in a loop to record another visit. */
  step<T>(id: string, block: Block<T>, options?: StepOptions): Promise<StepResult<T>>;
  /** Reuse an agent or script from the project's frozen Settings block library. */
  step(id: string, block: string, options?: StepOptions): Promise<StepResult>;
}
export type WorkflowDefinition<I = unknown> = {
  name: string; input?: z.ZodType<I>;
  run(context: WorkflowContext<I>): Promise<unknown>;
};
export function workflow<S extends z.ZodType>(definition: {
  name: string; input: S; run(context: WorkflowContext<z.output<S>>): Promise<unknown>;
}): WorkflowDefinition<z.output<S>>;
export function workflow(definition: {
  name: string; run(context: WorkflowContext<Record<string, unknown>>): Promise<unknown>;
}): WorkflowDefinition<Record<string, unknown>>;
export function workflow<I>(definition: WorkflowDefinition<I>): WorkflowDefinition<I> {
  return definition;
}
