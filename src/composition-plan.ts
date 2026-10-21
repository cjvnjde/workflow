import { z } from "zod";
import type { FlowStructure } from "./composition-sdk.js";
import {
  bundleSchema,
  nodeSchema,
  type Library,
  type WorkflowPlan,
} from "./domain.js";
import { modelOverride } from "./program-steps.js";

/** Build the UI's step catalog; execution follows the composition, not these legacy route fields. */
export function compositionPlan(
  structure: FlowStructure,
  title: string,
  task: string,
  library: Library,
) {
  const blocks: Library["blocks"] = {};
  const nodes: WorkflowPlan["nodes"] = [];
  const visit = (item: FlowStructure) => {
    if (item.kind === "step") {
      const { reference, options } = item.step!;
      const bundle =
        typeof reference === "string"
          ? library.blocks[reference]
          : bundleSchema.parse({
              definition: {
                id: item.id,
                name: reference.name ?? item.label,
                description: reference.description ?? "TypeScript block",
                executor: {
                  kind: "code",
                  source: reference.source,
                  timeoutMs: reference.timeoutMs,
                  maxOperations: reference.maxOperations,
                },
              },
              skills: [],
            });
      if (!bundle) throw new Error(`Unknown Settings block: ${reference}`);
      blocks[item.id] = bundleSchema.parse(bundle);
      blocks[item.id]!.definition.id = item.id;
      nodes.push(
        nodeSchema.parse({
          id: item.id,
          block: item.id,
          label:
            options.label ??
            (typeof reference === "string"
              ? bundle.definition.name
              : item.label),
          goal: options.prompt ?? task,
          maxVisits: options.maxVisits ?? 30,
          agent: modelOverride(options.model),
          on: { pass: "$complete", retry: "$failed", fail: "$failed" },
        }),
      );
    }
    for (const child of item.children) visit(child);
  };
  visit(structure);
  if (!nodes.length)
    throw new Error("Composition must contain at least one step");
  return {
    plan: {
      title: z.string().min(1).max(200).parse(title),
      task,
      entry: nodes[0]!.id,
      nodes,
    },
    blocks,
  };
}
