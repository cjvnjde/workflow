import { validatePlan, type Library, type WorkflowNode } from "./domain.js";

export function createTemplate(
  task: string,
  kind: "bug" | "feature",
  library: Library,
) {
  const makeNode = (
    id: string,
    block: string,
    pass: string,
    retry: string,
  ): WorkflowNode => ({
    id,
    block,
    label: library.blocks[block]?.definition.name ?? block,
    goal: task,
    maxVisits: 3,
    inputs: [],
    on: { pass, retry, fail: "$failed" },
  });
  const review = makeNode("review", "review", "$complete", "work");
  const work = makeNode(
    "work",
    kind === "bug" ? "fix" : "implement",
    kind === "bug" ? "review" : "verify",
    "work",
  );
  work.inputs.push({
    node: "review",
    artifact: "feedback",
    required: false,
    as: "review-feedback",
  });
  work.inputs.push({
    node: "review",
    artifact: "summary",
    required: false,
    as: "review-evidence",
  });
  work.inputs.push({
    node: "work",
    artifact: "summary",
    required: false,
    as: "previous-attempt",
  });
  review.inputs.push({
    node: "work",
    artifact: "implementation",
    required: true,
  });
  let nodes: WorkflowNode[];
  if (kind === "bug") {
    const reproduce = makeNode("prepare", "reproduce", "work", "prepare");
    work.inputs.push({
      node: "prepare",
      artifact: "reproduction",
      required: true,
    });
    review.inputs.push({
      node: "prepare",
      artifact: "reproduction",
      required: true,
    });
    nodes = [reproduce, work, review];
  } else {
    const requirements = makeNode("prepare", "requirements", "work", "prepare");
    const verify = makeNode("verify", "verify", "review", "work");
    verify.inputs.push({
      node: "prepare",
      artifact: "requirements",
      required: true,
    });
    verify.inputs.push({
      node: "work",
      artifact: "implementation",
      required: true,
    });
    work.inputs.push({
      node: "prepare",
      artifact: "requirements",
      required: true,
    });
    work.inputs.push({
      node: "verify",
      artifact: "feedback",
      required: false,
      as: "test-feedback",
    });
    work.inputs.push({
      node: "verify",
      artifact: "summary",
      required: false,
      as: "test-evidence",
    });
    review.inputs.push({
      node: "prepare",
      artifact: "requirements",
      required: true,
    });
    nodes = [requirements, work, verify, review];
  }

  return validatePlan(
    {
      title:
        kind === "bug"
          ? "Reproduce → fix → review"
          : "Specify → implement → test → review",
      task,
      entry: "prepare",
      nodes,
    },
    library,
  );
}
