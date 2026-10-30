import { z } from "zod";
import { bundleSchema, nodeSchema, type WorkflowRun } from "../../contracts/domain.js";
import type {
  AgentOptions,
  Block,
  CodeBlock,
  Model,
  ScriptOptions,
  StepOptions,
} from "../../sdk/workflow-sdk.js";

export const modelOverride = (model: Model | string | undefined) =>
  typeof model === "string" ? { model } : model;

/** Materialize a step only when its TypeScript call is reached. */

export function programStep(
  run: WorkflowRun,
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve generic input/output types across heterogeneous authored blocks.
  block: Block | CodeBlock<any, any> | string,
  options: StepOptions = {},
) {
  if (!run.program) throw new Error("Missing TypeScript workflow snapshot");
  if (run.program.composition === "graph") {
    const node = run.plan.nodes.find((node) => node.id === id);
    if (!node || block !== node.block || run.cursor !== id)
      throw new Error(`Step ${id} does not match the approved graph`);
    return node;
  }
  if (run.program.composition === "structured") {
    const node = run.plan.nodes.find((node) => node.id === id);
    if (!node) throw new Error(`Step ${id} is absent from the reviewed composition`);
    const changed = nodeSchema.parse({
      ...node,
      goal: options.prompt ?? run.plan.task,
      context: Object.fromEntries(
        Object.entries(options.inputs ?? {})
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
      ),
    });
    if (
      utf8Bytes(
        JSON.stringify({
          ...run,
          plan: {
            ...run.plan,
            nodes: run.plan.nodes.map((item) => (item.id === id ? changed : item)),
          },
        }),
      ) > 1_300_000
    )
      throw new Error(
        "Workflow context is too large. Pass concise handoffs or split this workflow.",
      );
    Object.assign(node, changed);
    return node;
  }
  let bundle;
  if (typeof block === "string") {
    const saved = run.program.catalog[block];
    if (!saved) throw new Error(`Unknown Settings block: ${block}`);
    bundle = bundleSchema.parse(saved);
  } else {
    const definition = block.options;
    const outputSchema =
      block.kind !== "code" && definition.output ? z.toJSONSchema(definition.output) : undefined;
    // Summary is already published for every step. Accept the natural spelling
    // in code without duplicating the host-owned artifact contract.
    const outputs = [
      ...new Set([
        ...(("outputs" in definition ? definition.outputs : []) ?? []).filter(
          (name) => name !== "summary",
        ),
        ...(outputSchema ? ["data"] : []),
      ]),
    ];
    const code = block.kind === "code" ? block.options : undefined;
    const agent = block.kind === "agent" ? (definition as AgentOptions) : undefined;
    const script = block.kind === "script" ? (definition as ScriptOptions) : undefined;
    bundle = bundleSchema.parse({
      definition: {
        id,
        name: definition.name ?? options.label ?? id,
        description:
          definition.description ??
          options.prompt?.slice(0, 4000) ??
          (code ? "TypeScript block" : agent ? "AI task" : "Script task"),
        outputs,
        outputSchema,
        agent: agent && modelOverride(agent.model),
        executor: code
          ? {
              kind: "code",
              source: code.run.toString(),
              timeoutMs: code.timeoutMs,
              maxOperations: code.maxOperations,
            }
          : script && {
              kind: "script",
              language: script.language,
              runtime: script.runtime ?? (script.language === "bash" ? "bash" : "bun"),
              code: script.code,
              timeoutMs: script.timeoutMs,
              expect: script.expect,
            },
      },
      prompt:
        (agent?.instructions ??
          (code
            ? "Behavior is defined in TypeScript."
            : "Execute the script and return its result.")) +
        ("outputs" in definition && definition.outputs?.includes("summary")
          ? "\nPublish the requested summary in the result's summary field; it is also exposed as artifacts.summary."
          : ""),
      skills: [],
    });
  }
  // A reused block can have different inputs, model or generated source on each visit.
  bundle.definition.id = id;
  const plan = {
    ...run.plan,
    nodes: run.plan.nodes.map((node) => ({ ...node, on: { ...node.on } })),
  };
  const transitions = [...(run.transitions ?? [])];
  const previous = run.attempts.at(-1);
  const previousNode = previous && plan.nodes.find((node) => node.id === previous.nodeId);
  if (previousNode && previous?.result) {
    previousNode.on[previous.result.outcome] = id;
    transitions.push({ from: previousNode.id, to: id, outcome: previous.result.outcome });
  }
  const current = plan.nodes.find((node) => node.id === id);
  const node = nodeSchema.parse({
    id,
    block: id,
    label: options.label ?? bundle.definition.name,
    goal: options.prompt ?? run.plan.task,
    agent: modelOverride(options.model),
    maxVisits: options.maxVisits ?? 30,
    context: Object.fromEntries(
      Object.entries(options.inputs ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
    ),
    on: current?.on ?? { pass: "$complete", retry: "$failed", fail: "$failed" },
  });
  if (!plan.nodes.length) plan.entry = id;
  if (current) plan.nodes[plan.nodes.indexOf(current)] = node;
  else plan.nodes.push(node);
  const blocks = { ...run.blocks, [id]: bundle };
  const candidate = JSON.stringify({ ...run, plan, blocks, transitions, cursor: id });
  const bytes = utf8Bytes(candidate);
  if (bytes > 1_300_000)
    throw new Error("Workflow context is too large. Pass concise handoffs or split this workflow.");
  run.plan = plan;
  run.blocks = blocks;
  run.transitions = transitions;
  run.cursor = id;
  return node;
}

/** UTF-8 sizing shared with code running in Temporal's VM (no host APIs). */
export function utf8Bytes(value: string) {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}
