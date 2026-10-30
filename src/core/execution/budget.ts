import type { z } from "zod";
import {
  type priceSchema,
  budgetSchema,
  resolveAgentSettings,
  type BudgetEstimate,
  type Library,
  type UsageTotals,
  type WorkflowPlan,
} from "../../contracts/domain.js";

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    requests: 0,
    unpricedRequests: 0,
  };
}
export function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return Object.fromEntries(
    Object.entries(left).map(([key, value]) => [key, value + right[key as keyof UsageTotals]]),
  ) as UsageTotals;
}

export function priceUsage(
  price: z.infer<typeof priceSchema>,
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
  cacheWrite1h = 0,
) {
  const totalInput = input + cacheRead + cacheWrite;
  const tier = [...(price.tiers ?? [])]
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)
    .find((candidate) => totalInput > candidate.inputTokensAbove);
  const rates = tier ?? price;
  return (
    (input * rates.input +
      output * rates.output +
      cacheRead * rates.cacheRead +
      (cacheWrite - cacheWrite1h) * rates.cacheWrite +
      cacheWrite1h * rates.input * 2) /
    1_000_000
  );
}

/** Estimates use approved price snapshots and assumptions, not a billing guarantee. */
export function estimateBudget(
  plan: WorkflowPlan,
  library: Library,
  mode: "live" | "demo" = "live",
): BudgetEstimate {
  const budget = budgetSchema.parse(library.config.budget ?? {});
  const costs = new Map<string, { typical: number | null; maximum: number | null }>();
  const unpricedNodes: string[] = [];
  const dynamicNodes: string[] = [];
  const slots: (number | null)[] = [];
  for (const node of plan.nodes) {
    const settings = resolveAgentSettings(
      library.config.agent,
      library.blocks[node.block]?.definition.agent,
      node.agent,
    );
    const price = budget.prices[`${settings.provider}/${settings.model}`];
    const executor = library.blocks[node.block]?.definition.executor;
    const dynamic = mode !== "demo" && executor?.kind === "code";
    const cost =
      mode === "demo" || (executor && !dynamic)
        ? 0
        : dynamic
          ? null
          : price
            ? priceUsage(price, budget.inputTokensPerCall, budget.outputTokensPerCall)
            : null;
    if (dynamic) dynamicNodes.push(node.id);
    else if (cost === null) unpricedNodes.push(node.id);
    const typical =
      cost === null ? null : cost * Math.min(budget.callsPerVisit, settings.maxToolCalls + 1);
    // Retries can make up to three requests per turn in the embedded runtime.
    const maximum = cost === null ? null : cost * (settings.maxToolCalls + 1) * 3;
    costs.set(node.id, { typical, maximum });
    for (let visit = 0; visit < node.maxVisits; visit += 1) {
      slots.push(maximum);
    }
  }
  const visited = new Map<string, number>();
  let cursor = plan.entry;
  let expectedCostUsd: number | null = 0;
  let expectedVisits = 0;
  while (costs.has(cursor) && expectedVisits < library.config.maxSteps) {
    const node = plan.nodes.find((candidate) => candidate.id === cursor)!;
    const visits = (visited.get(cursor) ?? 0) + 1;
    if (visits > node.maxVisits) {
      break;
    }
    visited.set(cursor, visits);
    const cost = costs.get(cursor)!.typical;
    expectedCostUsd = expectedCostUsd === null || cost === null ? null : expectedCostUsd + cost;
    expectedVisits += 1;
    cursor = node.on.pass;
  }
  const maxVisits = Math.min(library.config.maxSteps, slots.length);
  const worstCaseCostUsd = slots.some((cost) => cost === null)
    ? null
    : (slots as number[])
        .sort((a, b) => b - a)
        .slice(0, maxVisits)
        .reduce((sum, cost) => sum + cost, 0);
  return {
    expectedCostUsd,
    worstCaseCostUsd,
    expectedVisits,
    maxVisits,
    unpricedNodes,
    ...(dynamicNodes.length ? { dynamicNodes } : {}),
    assumptions: `Execution estimate: ${budget.inputTokensPerCall} input + ${budget.outputTokensPerCall} output tokens/call, ${budget.callsPerVisit} calls/visit on pass routes. Retry estimate includes visit/tool/step limits and up to 3 requests/turn. TypeScript can call AI dynamically, so its cost is unknown before execution. Actual token sizes and provider billing can exceed estimates. Planning and refinement are included separately in the task usage total.`,
  };
}
