import type {
  Block,
  CodeBlock,
  Model,
  Outcome,
  StepResult,
} from "./workflow-sdk.js";

export interface FlowContext<I = Record<string, unknown>> {
  readonly input: I;
  readonly request: string;
  readonly models: Readonly<Record<string, Model>>;
  /** Latest completed output; absent before the first visit. */
  output<O>(step: FlowStep<O>): O | undefined;
  output<O = unknown>(id: string): O | undefined;
  result<O>(step: FlowStep<O>): StepResult<O> | undefined;
  result<O = unknown>(id: string): StepResult<O> | undefined;
  /** Current (one-based) iteration of an enclosing loop. */
  iteration(id: string): number;
}
export type Deferred<T> = T | ((context: FlowContext) => T);
export type OutcomeAction = "continue" | "stop" | "repeat";
export type FlowStepOptions<I = Record<string, unknown>> = {
  label?: string;
  prompt?: Deferred<string>;
  inputs?: Deferred<I>;
  model?: Model | string;
  maxVisits?: number;
  /** Nonpassing outcomes stop by default. repeat restarts the enclosing loop. */
  on?: Partial<Record<Outcome, OutcomeAction>>;
};
export type FlowStep<O = unknown> = {
  kind: "step";
  id: string;
  block: CodeBlock<any, O> | Block<O> | string;
  options: FlowStepOptions<any>;
  readonly _output?: O;
};
export type FlowNode =
  | FlowStep<any>
  | {
      kind: "sequence";
      children: FlowNode[];
    }
  | {
      kind: "parallel";
      children: FlowNode[];
      concurrency: number;
      label?: string;
    }
  | {
      kind: "when";
      id: string;
      condition: (context: FlowContext) => boolean;
      then: FlowNode;
      otherwise?: FlowNode;
    }
  | {
      kind: "loop";
      id: string;
      body: FlowNode;
      until: (context: FlowContext) => boolean;
      maxIterations: number;
    };

export function step<I extends Record<string, unknown>, O>(
  id: string,
  block: CodeBlock<I, O>,
  options?: FlowStepOptions<I>,
): FlowStep<O>;
export function step<O = unknown>(
  id: string,
  block: string | Block<O>,
  options?: FlowStepOptions,
): FlowStep<O>;
export function step(
  id: string,
  block: CodeBlock<any, any> | Block<any> | string,
  options: FlowStepOptions<any> = {},
): FlowStep<any> {
  return { kind: "step", id, block, options };
}
export function sequence(...children: FlowNode[]): FlowNode {
  return { kind: "sequence", children };
}
export function parallel(
  children: FlowNode[],
  options: { concurrency?: number; label?: string } = {},
): FlowNode {
  return {
    kind: "parallel",
    children,
    concurrency: options.concurrency ?? 4,
    label: options.label,
  };
}
export function when(
  id: string,
  condition: (context: FlowContext) => boolean,
  then: FlowNode,
  otherwise?: FlowNode,
): FlowNode {
  return { kind: "when", id, condition, then, otherwise };
}
export function repeatUntil(
  id: string,
  options: {
    body: FlowNode;
    until: (context: FlowContext) => boolean;
    maxIterations: number;
  },
): FlowNode {
  return { kind: "loop", id, ...options };
}

/** Serializable structure for previewing a flow without running any block or condition. */
export type FlowStructure = {
  kind: FlowNode["kind"];
  id: string;
  label: string;
  children: FlowStructure[];
  condition?: string;
  concurrency?: number;
  maxIterations?: number;
  step?: {
    reference:
      | string
      | {
          kind: "code";
          name?: string;
          description?: string;
          source: string;
          timeoutMs?: number;
          maxOperations?: number;
        };
    options: {
      label?: string;
      prompt?: string;
      inputs?: Record<string, unknown>;
      model?: Model | string;
      maxVisits?: number;
      on?: FlowStepOptions["on"];
    };
  };
};

/** @internal Used by the compiler and runtime to verify the reviewed structure. */
export function describeFlow(root: FlowNode): FlowStructure {
  const ids = new Set<string>();
  const ancestors = new Set<FlowNode>();
  let count = 0;
  function visit(node: FlowNode, path: string, depth: number): FlowStructure {
    if (
      !node ||
      typeof node !== "object" ||
      depth > 20 ||
      ++count > 200 ||
      ancestors.has(node)
    )
      throw new Error(
        "Composition must be an acyclic tree of at most 200 nodes and 20 levels",
      );
    ancestors.add(node);
    const id = "id" in node ? node.id : `group-${path}`;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || ids.has(id))
      throw new Error(
        `Composition IDs must be unique lowercase kebab-case: ${id}`,
      );
    ids.add(id);
    const children: FlowStructure[] = [];
    const base: FlowStructure = { kind: node.kind, id, label: id, children };
    const child = (value: FlowNode, index: number) =>
      visit(value, `${path}-${index}`, depth + 1);
    switch (node.kind) {
      case "step": {
        if (typeof node.block !== "string" && node.block?.kind !== "code")
          throw new Error(
            "Composition steps use a TypeScript block or a saved block ID",
          );
        const o = node.options;
        if (
          o.maxVisits !== undefined &&
          (!Number.isInteger(o.maxVisits) ||
            o.maxVisits < 1 ||
            o.maxVisits > 30)
        )
          throw new Error(`Invalid maxVisits at ${id}`);
        for (const [outcome, action] of Object.entries(o.on ?? {})) {
          if (
            !["pass", "retry", "fail"].includes(outcome) ||
            !["continue", "stop", "repeat"].includes(action)
          )
            throw new Error(`Invalid outcome action at ${id}`);
        }
        base.label =
          o.label ??
          (typeof node.block === "string"
            ? node.block
            : (node.block.options.name ?? id));
        base.step = {
          reference:
            typeof node.block === "string"
              ? node.block
              : {
                  kind: "code",
                  name: node.block.options.name,
                  description: node.block.options.description,
                  source: node.block.options.run.toString(),
                  timeoutMs: node.block.options.timeoutMs,
                  maxOperations: node.block.options.maxOperations,
                },
          options: {
            ...o,
            prompt: typeof o.prompt === "function" ? undefined : o.prompt,
            inputs: typeof o.inputs === "function" ? undefined : o.inputs,
          },
        };
        break;
      }
      case "sequence":
      case "parallel":
        if (!Array.isArray(node.children) || !node.children.length)
          throw new Error(`Empty ${node.kind}: ${id}`);
        children.push(...node.children.map(child));
        base.label =
          node.kind === "sequence" ? "Sequence" : (node.label ?? "Parallel");
        if (node.kind === "parallel") {
          if (
            !Number.isInteger(node.concurrency) ||
            node.concurrency < 1 ||
            node.concurrency > 8
          )
            throw new Error("Parallel concurrency must be between 1 and 8");
          base.concurrency = node.concurrency;
        }
        break;
      case "when":
        if (typeof node.condition !== "function")
          throw new Error(`Missing condition at ${id}`);
        base.condition = node.condition.toString().slice(0, 2000);
        children.push(child(node.then, 0));
        if (node.otherwise) children.push(child(node.otherwise, 1));
        break;
      case "loop":
        if (
          typeof node.until !== "function" ||
          !Number.isInteger(node.maxIterations) ||
          node.maxIterations < 1 ||
          node.maxIterations > 30
        )
          throw new Error(
            `Loop ${id} needs an until condition and maxIterations between 1 and 30`,
          );
        base.condition = node.until.toString().slice(0, 2000);
        base.maxIterations = node.maxIterations;
        children.push(child(node.body, 0));
        break;
      default:
        throw new Error("Unknown composition primitive");
    }
    ancestors.delete(node);
    return base;
  }
  return visit(root, "root", 0);
}
