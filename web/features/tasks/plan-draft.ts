import { z } from "zod";
import {
  nodeSchema,
  planSchema,
  validatePlan,
  type Library,
  type WorkflowPlan,
} from "../../../src/contracts/index.js";

// Forms allow temporarily empty fields. The original domain rules still govern saving.
const editablePlanSchema = planSchema.extend({
  title: z.string(),
  task: z.string(),
  nodes: z.array(
    nodeSchema.extend({
      label: z.string(),
      goal: z.string(),
      maxVisits: z.number(),
      inputs: z.array(
        nodeSchema.shape.inputs.unwrap().element.extend({ as: z.string().optional() }),
      ),
    }),
  ),
});

export function readPlanDraft(
  text: string,
  library: Library,
): {
  plan?: WorkflowPlan;
  validPlan?: WorkflowPlan;
  error?: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "The JSON is incomplete or invalid. Fix it below to return to step controls." };
  }
  const editable = editablePlanSchema.safeParse(value);
  try {
    const validPlan = validatePlan(value, library);
    return { plan: validPlan, validPlan };
  } catch (error) {
    return {
      plan: editable.success ? editable.data : undefined,
      error:
        error instanceof z.ZodError
          ? error.issues
              .slice(0, 3)
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join(" · ")
          : error instanceof Error
            ? error.message
            : "The graph is invalid.",
    };
  }
}
