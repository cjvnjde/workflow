import type { UsagePhase, UsageTotals } from "../../../src/contracts/index.js";

export const usagePhaseLabels: Record<UsagePhase, string> = {
  planning: "Planning",
  execution: "Execution",
  setup: "Project setup",
  design: "Settings design",
  refinement: "Workflow refinement",
  library: "Library generation",
};

export function usageTokens(usage: UsageTotals) {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** A recorded amount is a lower bound when pricing or historical coverage is missing. */
export function usageCost(
  usage: Pick<UsageTotals, "costUsd" | "unpricedRequests">,
  incomplete = false,
) {
  const partial = incomplete || usage.unpricedRequests > 0;
  if (partial && usage.costUsd === 0) return "Unknown";
  const amount =
    usage.costUsd > 0 && usage.costUsd < 0.0001
      ? "less than $0.0001"
      : `$${usage.costUsd.toFixed(4)}`;
  if (partial) return usage.costUsd < 0.0001 ? "Partial amount recorded" : `At least ${amount}`;
  return amount;
}
