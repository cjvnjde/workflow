import type {
  FlowContext,
  FlowNode,
  FlowStep,
  StepResult,
} from "./workflow-sdk.js";
import type { FlowStructure } from "./composition-sdk.js";
import type { StepOptions } from "./workflow-sdk.js";
import type { EvidenceDependency } from "./evidence-schema.js";

export type GroupState = {
  state: "running" | "completed" | "failed" | "skipped";
  iteration?: number;
  branch?: "then" | "otherwise";
  decision?: { result?: boolean; route: "then" | "otherwise" | "repeat" | "exit" | "limit"; reason: string };
};
type State = {
  results: Map<string, StepResult>;
  visits: Map<string, number>;
  iterations: Map<string, number>;
  written: Set<string>;
  last?: StepResult;
};
type Stop = { failed?: boolean; parent?: Stop; loop?: string };
class RepeatIteration extends Error {}
/** Internal admission cancellation: a sibling stopped this composition scope. */
export class FlowDispatchStopped extends Error {}

/** Execute the declared tree. Branch-local results merge only after a parallel join. */
export async function executeFlow(options: {
  recordDecisions?: boolean;
  flow: FlowNode;
  structure: FlowStructure;
  input: Record<string, unknown>;
  request: string;
  models: FlowContext["models"];
  /** Actual completed visit, including explicit retries after interruptions. */
  visit?(id: string): number;
  step(
    node: FlowStep<any>,
    options: StepOptions,
    stopped: () => boolean,
    dependencies: EvidenceDependency[],
  ): Promise<StepResult>;
  group(id: string, state: GroupState): Promise<void>;
}): Promise<string> {
  const state: State = {
    results: new Map(),
    visits: new Map(),
    iterations: new Map(),
    written: new Set(),
  };
  const clone = <T>(value: T): T =>
    value === undefined ? value : JSON.parse(JSON.stringify(value));
  const context = (state: State, usedBy?: () => EvidenceDependency["usedBy"] | undefined, dependencies?: EvidenceDependency[]): FlowContext => ({
    input: clone(options.input),
    request: options.request,
    models: clone(options.models),
    output: (reference: string | FlowStep<any>) => {
      const id = typeof reference === "string" ? reference : reference.id;
      recordRead(id, "output", state, usedBy?.(), dependencies);
      return clone(state.results.get(id)?.data) as any;
    },
    result: (reference: string | FlowStep<any>) => {
      const id = typeof reference === "string" ? reference : reference.id;
      recordRead(id, "result", state, usedBy?.(), dependencies);
      return clone(state.results.get(id)) as any;
    },
    iteration: (id) => state.iterations.get(id) ?? 0,
  });
  const recordRead = (id: string, kind: EvidenceDependency["kind"], state: State, usedBy?: EvidenceDependency["usedBy"], dependencies?: EvidenceDependency[]) => {
    if (!usedBy || !dependencies) return;
    const producerVisit = state.visits.get(id) ?? null;
    if (!dependencies.some(item => item.producerNodeId === id && item.producerVisit === producerVisit && item.kind === kind && item.usedBy === usedBy)) {
      dependencies.push({ producerNodeId: id, producerVisit, kind, usedBy });
    }
  };
  const predicate = (fn: (ctx: FlowContext) => boolean, state: State) => {
    const answer = fn(context(state));
    if (typeof answer !== "boolean")
      throw new Error(
        "Workflow conditions must return a boolean synchronously",
      );
    return answer;
  };
  const stopped = (stop?: Stop): boolean =>
    !!stop && (stop.failed === true || stopped(stop.parent));
  const halt = (stop: Stop | undefined, error: unknown) => {
    for (let current = stop; current; current = current.parent)
      if (!(error instanceof RepeatIteration) || current.loop === error.message)
        current.failed = true;
  };
  const skip = async (shape: FlowStructure): Promise<void> => {
    await options.group(shape.id, { state: "skipped" });
    for (const child of shape.children) await skip(child);
  };
  async function execute(
    node: FlowNode,
    shape: FlowStructure,
    state: State,
    loop?: string,
    stop?: Stop,
  ): Promise<void> {
    if (stopped(stop)) {
      await skip(shape);
      return;
    }
    if (node.kind === "step") {
      try {
        await options.group(shape.id, { state: "running" });
        const dependencies: EvidenceDependency[] = [];
        // Keep the shared callback context and original evaluation order. Only
        // the active provenance label changes between prompt and input reads.
        let usedBy: EvidenceDependency["usedBy"] | undefined = "prompt";
        const ctx = context(state, () => usedBy, dependencies);
        const label = node.options.label;
        const prompt = typeof node.options.prompt === "function" ? node.options.prompt(ctx) : node.options.prompt;
        usedBy = "inputs";
        const inputs = typeof node.options.inputs === "function" ? node.options.inputs(ctx) : node.options.inputs;
        usedBy = undefined;
        const result = await options.step(
          node,
          {
            label,
            prompt,
            inputs,
            model: node.options.model,
            maxVisits: node.options.maxVisits,
          },
          () => stopped(stop),
          dependencies,
        );
        state.results.set(node.id, result);
        state.visits.set(node.id, options.visit?.(node.id) ?? (state.visits.get(node.id) ?? 0) + 1);
        state.written.add(node.id);
        state.last = result;
        await options.group(shape.id, { state: "completed" });
        const action =
          node.options.on?.[result.outcome] ??
          (result.outcome === "pass" ? "continue" : "stop");
        if (action === "repeat") {
          if (!loop)
            throw new Error(`Step ${node.id} requested repeat outside a loop`);
          throw new RepeatIteration(loop);
        }
        if (action === "stop")
          throw new Error(
            result.summary || `Step ${node.id}: ${result.outcome}`,
          );
        return;
      } catch (error) {
        if (error instanceof FlowDispatchStopped && stopped(stop)) {
          await skip(shape);
          return;
        }
        halt(stop, error);
        throw error;
      }
    }
    try {
      await options.group(shape.id, { state: "running" });
      if (node.kind === "sequence") {
        for (let i = 0; i < node.children.length; i++)
          await execute(
            node.children[i]!,
            shape.children[i]!,
            state,
            loop,
            stop,
          );
      } else if (node.kind === "parallel") {
        let next = 0;
        const shared: Stop = { parent: stop, loop };
        const branches: State[] = node.children.map(() => ({
          results: new Map(state.results),
          visits: new Map(state.visits),
          iterations: new Map(state.iterations),
          written: new Set(),
        }));
        const errors: { error: unknown }[] = [];
        const started = new Set<number>();
        await Promise.all(
          Array.from(
            { length: Math.min(node.concurrency, node.children.length) },
            async () => {
              while (!stopped(shared) && next < node.children.length) {
                const index = next++;
                started.add(index);
                try {
                  await execute(
                    node.children[index]!,
                    shape.children[index]!,
                    branches[index]!,
                    loop,
                    shared,
                  );
                } catch (error) {
                  errors[index] = { error };
                  shared.failed = true;
                }
              }
            },
          ),
        );
        for (let i = 0; i < branches.length; i++)
          if (!started.has(i)) await skip(shape.children[i]!);
        for (const branch of branches)
          for (const id of branch.written) {
            state.results.set(id, branch.results.get(id)!);
            state.visits.set(id, branch.visits.get(id)!);
            state.written.add(id);
          }
        // A join's result is deterministic: the last declared branch that ran,
        // independent of network completion order.
        state.last =
          branches.findLast((branch) => branch.last)?.last ?? state.last;
        const failures = errors.filter(Boolean);
        if (failures.length)
          throw (failures.find(
            ({ error }) => !(error instanceof RepeatIteration),
          ) ?? failures[0])!.error;
      } else if (node.kind === "when") {
        const yes = predicate(node.condition, state);
        await options.group(shape.id, {
          state: "running",
          branch: yes ? "then" : "otherwise",
          ...(options.recordDecisions === false ? {} : { decision: { result: yes, route: yes ? "then" as const : "otherwise" as const, reason: "Branch predicate evaluated" } }),
        });
        const selected = yes ? node.then : node.otherwise;
        const skipped = shape.children[yes ? 1 : 0];
        if (skipped) await skip(skipped);
        if (selected)
          await execute(
            selected,
            shape.children[yes ? 0 : 1]!,
            state,
            loop,
            stop,
          );
      } else {
        let done = false;
        for (let iteration = 1; iteration <= node.maxIterations; iteration++) {
          if (stopped(stop)) return;
          state.iterations.set(node.id, iteration);
          await options.group(shape.id, { state: "running", iteration });
          try {
            await execute(node.body, shape.children[0]!, state, node.id, stop);
          } catch (error) {
            if (
              !(error instanceof RepeatIteration) ||
              error.message !== node.id
            )
              throw error;
            if (options.recordDecisions !== false) await options.group(shape.id, { state: "running", iteration, decision: { route: iteration === node.maxIterations ? "limit" : "repeat", reason: "Step outcome requested another iteration; exit predicate was not evaluated" } });
            continue;
          }
          const satisfied = predicate(node.until, state);
          if (options.recordDecisions !== false) await options.group(shape.id, { state: "running", iteration, decision: { result: satisfied, route: satisfied ? "exit" : iteration === node.maxIterations ? "limit" : "repeat", reason: "Exit predicate evaluated" } });
          if (satisfied) {
            done = true;
            break;
          }
        }
        if (!done)
          throw new Error(
            `Loop ${node.id} did not satisfy its condition after ${node.maxIterations} iterations`,
          );
      }
      await options.group(shape.id, {
        state: "completed",
        iteration: state.iterations.get(shape.id),
      });
    } catch (error) {
      halt(stop, error);
      await options.group(shape.id, {
        state: error instanceof RepeatIteration ? "completed" : "failed",
      });
      throw error;
    }
  }
  try {
    await execute(options.flow, options.structure, state);
  } catch (error) {
    if (error instanceof RepeatIteration)
      throw new Error("A step requested repeat outside its loop");
    throw error;
  }
  return state.last?.summary ?? "Workflow completed.";
}
