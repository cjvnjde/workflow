import { z } from "zod";
import { attachmentSchema, capabilitiesSchema } from "./capability-schema.js";
import { codeExecutorSchema } from "./code-schema.js";
import { scriptExecutorSchema } from "./script-schema.js";
import { programSourceSchema } from "./program-schema.js";

export const identifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/)
  .refine(
    (value) => value !== "constructor" && value !== "prototype",
    "Reserved identifier",
  );
export const artifactNameSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
  .refine(value => !value.includes("..") && !["constructor", "prototype"].includes(value), "Use a simple artifact name or filename without path segments");
export const outcomeSchema = z.enum(["pass", "retry", "fail"]);
const agentFields = {
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  timeoutMs: z.number().int().min(1000).max(3_600_000),
  maxToolCalls: z.number().int().min(1).max(1000),
};
export const agentOverrideSchema = z.object(agentFields).partial().strict();
export const agentSchema = z
  .object({
    ...agentFields,
    thinking: agentFields.thinking.default("medium"),
    timeoutMs: agentFields.timeoutMs.default(600_000),
    maxToolCalls: agentFields.maxToolCalls.default(100),
  })
  .strict();
export const commandSchema = z
  .object({
    argv: z
      .array(z.string())
      .min(1)
      .refine(
        (argv) => !!argv[0]?.trim(),
        "Command executable must not be empty",
      ),
    timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
  })
  .strict();
const priceRates = {
  input: z.number().nonnegative(), output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().default(0), cacheWrite: z.number().nonnegative().default(0),
};
export const priceSchema = z.object({ ...priceRates, tiers: z.array(z.object({ ...priceRates, inputTokensAbove: z.number().nonnegative() }).strict()).optional() }).strict();
export const budgetSchema = z.object({
  maxCostUsd: z.number().positive().optional(),
  inputTokensPerCall: z.number().int().positive().default(4000),
  outputTokensPerCall: z.number().int().positive().default(1000),
  callsPerVisit: z.number().int().positive().max(1000).default(4),
  prices: z.record(z.string(), priceSchema).default({}),
}).strict();
export const usageSchema = z.object({
  inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(), cacheWriteTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(), requests: z.number().int().nonnegative(),
  unpricedRequests: z.number().int().nonnegative(),
}).strict();
export const recoverySchema = z.object({
  status: z.enum(["committed", "restored", "conflict", "none"]),
  restored: z.array(z.string()), conflicts: z.array(z.string()),
}).strict();
export const estimateSchema = z.object({
  expectedCostUsd: z.number().nonnegative().nullable(),
  worstCaseCostUsd: z.number().nonnegative().nullable(),
  expectedVisits: z.number().int().nonnegative(), maxVisits: z.number().int().nonnegative(),
  unpricedNodes: z.array(z.string()), assumptions: z.string(),
}).strict();
export const configSchema = z
  .object({
    version: z.literal(1),
    instructions: z.string().default(""),
    agent: agentSchema.default(() => agentSchema.parse({})),
    coordinator: agentOverrideSchema.optional(),
    capabilities: capabilitiesSchema.optional(),
    attachments: z.array(attachmentSchema).max(8).optional(),
    commands: z.record(identifierSchema, commandSchema).default({}),
    budget: budgetSchema.optional(),
    recovery: z.object({ rollbackOnFailure: z.boolean().default(true) }).strict().optional(),
    maxSteps: z.number().int().min(1).max(500).default(30),
  })
  .strict();
export const blockSchema = z
  .object({
    id: identifierSchema,
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(4000),
    executor: z.discriminatedUnion("kind", [
      codeExecutorSchema,
      scriptExecutorSchema,
      // Compatibility for existing snapshots; new authoring uses TypeScript.
      z.object({ kind: z.literal("command"), command: identifierSchema, expect: z.enum(["success", "failure"]).default("success") }).strict(),
      z.object({
        kind: z.literal("function"),
        function: z.literal("git-push"),
        // A configured remote name, never an arbitrary destination URL or shell fragment.
        remote: z.string().min(1).max(200).regex(/^[^\s\x00-\x1f]+$/).optional(),
      }).strict(),
    ]).optional(),
    // Legacy snapshots retain this metadata for replay/approval compatibility.
    // Local tools no longer enforce per-block file permission rules.
    permissions: z
      .object({
        read: z.array(z.string()).default(["**/*"]),
        write: z.array(z.string()).default([]),
        deny: z.array(z.string()).default([]),
        writeDeny: z.array(z.string()).default([]),
      })
      .strict().optional(),
    contract: z.object({
      inputs: z.string().max(2000).default(""), outputs: z.string().max(2000).default(""),
      effects: z.string().max(2000).default(""), failure: z.string().max(2000).default(""),
    }).strict().optional(),
    skills: z.array(z.string()).default([]),
    outputs: z
      .array(artifactNameSchema)
      .refine(
        (outputs) =>
          new Set(outputs).size === outputs.length &&
          !outputs.includes("summary"),
        "Outputs must be unique; summary is host-owned",
      )
      .default([]),
    checks: z
      .array(
        z
          .object({
            command: identifierSchema,
            expect: z.enum(["success", "failure"]),
          })
          .strict(),
      )
      .default([]),
    agent: agentOverrideSchema.optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const bundleSchema = z
  .object({
    definition: blockSchema,
    prompt: z.string().min(1).default("Behavior, models, inputs and outputs are defined in TypeScript."),
    skills: z.array(
      z.object({ path: z.string(), content: z.string() }).strict(),
    ),
  })
  .strict();
const inputSchema = z
  .object({
    node: identifierSchema,
    artifact: artifactNameSchema,
    as: identifierSchema.optional(),
    required: z.boolean().default(false),
  })
  .strict();
export const nodeSchema = z
  .object({
    id: identifierSchema,
    block: identifierSchema,
    label: z.string().min(1).max(120),
    goal: z.string().min(1).max(8000),
    inputs: z.array(inputSchema).default([]),
    maxVisits: z.number().int().min(1).max(30).default(3),
    agent: agentOverrideSchema.optional(),
    context: z.record(z.string().min(1).max(120), z.string().max(64_000)).optional(),
    on: z
      .object({ pass: z.string(), retry: z.string(), fail: z.string() })
      .strict(),
  })
  .strict();
export const planSchema = z
  .object({
    title: z.string().min(1).max(200),
    task: z.string().min(1).max(32_000),
    entry: identifierSchema,
    nodes: z.array(nodeSchema).min(1).max(50),
  })
  .strict();
export const resultSchema = z
  .object({
    outcome: outcomeSchema,
    disposition: z.enum(["work-completed", "accepted", "changes-requested", "blocked"]).optional(),
    summary: z.string().min(1).max(16_000),
    artifacts: z.record(artifactNameSchema, z.string().max(64_000)).default({}),
  })
  .strict();
export const checkResultSchema = z
  .object({
    command: z.string(),
    expected: z.enum(["success", "failure"]),
    exitCode: z.number().nullable(),
    matched: z.boolean(),
    output: z.string(),
  })
  .strict();
export const eventSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    time: z.string(),
    kind: z.string(),
    nodeId: z.string().optional(),
    message: z.string(),
  })
  .strict();
const flowStructureSchema: z.ZodType<import("./composition-sdk.js").FlowStructure> = z.lazy(() => z.object({
  kind: z.enum(["step", "sequence", "parallel", "when", "loop"]),
  id: identifierSchema, label: z.string().max(200), children: z.array(flowStructureSchema).max(200),
  condition: z.string().max(2000).optional(), concurrency: z.number().int().min(1).max(8).optional(), maxIterations: z.number().int().min(1).max(30).optional(),
  step: z.object({
    reference: z.union([identifierSchema, z.object({ kind: z.literal("code"), name: z.string().optional(), description: z.string().optional(), source: z.string(), timeoutMs: z.number().optional(), maxOperations: z.number().optional() }).strict()]),
    options: z.object({ label: z.string().optional(), prompt: z.string().optional(), inputs: z.record(z.string(), z.unknown()).optional(), model: z.union([z.string(), agentOverrideSchema]).optional(), maxVisits: z.number().optional(), on: z.object({pass:z.enum(["continue","stop","repeat"]).optional(),retry:z.enum(["continue","stop","repeat"]).optional(),fail:z.enum(["continue","stop","repeat"]).optional()}).strict().optional() }).strict(),
  }).strict().optional(),
}).strict());
export const runSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().optional(),
    revision: z.number().int().nonnegative().default(0),
    temporalWorkflowId: z.string().optional(),
    // Host-only start receipt; omitted from Temporal inputs for archived versions.
    temporalStart: z.enum(["pending", "confirmed"]).optional(),
    approvedAt: z.string().optional(),
    executionVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    executionProtocol: z.literal(2).optional(),
    estimate: estimateSchema.optional(),
    usage: usageSchema.optional(),
    mode: z.enum(["demo", "live"]),
    status: z.enum([
      "draft",
      "running",
      "pausing",
      "paused",
      "completed",
      "failed",
      "cancelled",
      "rejected",
      "interrupted",
    ]),
    plan: planSchema.extend({ nodes: z.array(nodeSchema).max(500) }),
    program: programSourceSchema.extend({
      composition: z.enum(["graph", "structured"]).optional(),
      structure: flowStructureSchema.optional(),
      catalog: z.record(identifierSchema, bundleSchema),
      models: z.record(z.string(), agentOverrideSchema),
    }).optional(),
    output: z.string().max(64_000).optional(),
    transitions: z.array(z.object({
      from: identifierSchema, to: z.string(), outcome: outcomeSchema,
    }).strict()).max(501).optional(),
    config: configSchema,
    blocks: z.record(identifierSchema, bundleSchema),
    cursor: z.string(),
    activeNodes: z.array(identifierSchema).max(8).optional(),
    groups: z.record(z.string(), z.object({ state: z.enum(["running", "completed", "failed", "skipped"]), iteration: z.number().int().optional(), branch: z.enum(["then", "otherwise"]).optional(), decision: z.object({ result: z.boolean().optional(), route: z.enum(["then", "otherwise", "repeat", "exit", "limit"]), reason: z.string() }).strict().optional() }).strict()).optional(),
    visits: z.record(z.string(), z.number()),
    artifacts: z.record(z.string(), z.record(z.string(), z.string())),
    attempts: z.array(
      z
        .object({
          nodeId: z.string(),
          visit: z.number(),
          startedAt: z.string(),
          finishedAt: z.string().optional(),
          error: z.string().optional(),
          result: resultSchema.optional(),
          checks: z.array(checkResultSchema).default([]),
          usage: usageSchema.optional(),
          recovery: recoverySchema.optional(),
        })
        .strict(),
    ),
    error: z.string().optional(),
  })
  .strict();

export type UsageTotals = z.infer<typeof usageSchema>;
export type RecoveryResult = z.infer<typeof recoverySchema>;
export type BudgetEstimate = z.infer<typeof estimateSchema>;
export type AgentSettings = z.infer<typeof agentSchema>;
export function resolveAgentSettings(
  base: z.infer<typeof agentOverrideSchema>,
  ...overrides: (z.infer<typeof agentOverrideSchema> | undefined)[]
) {
  let settings = { ...base };
  for (const override of overrides) {
    if (!override) { continue; }
    if (override.provider && override.provider !== settings.provider) {
      delete settings.model;
    }
    settings = { ...settings, ...override };
  }
  return agentSchema.parse(settings);
}
export type ProjectConfig = z.infer<typeof configSchema>;
export type Block = z.infer<typeof blockSchema>;
export type BlockBundle = z.infer<typeof bundleSchema>;
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type WorkflowPlan = z.infer<typeof planSchema>;
export type BlockResult = z.infer<typeof resultSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
export type RunEvent = z.infer<typeof eventSchema>;
export type WorkflowRun = z.infer<typeof runSchema>;
export function executionTimeoutMs(config: ProjectConfig, bundle: BlockBundle, node: WorkflowNode) {
  if (bundle.definition.executor?.kind === "code") return bundle.definition.executor.timeoutMs;
  if (bundle.definition.executor?.kind === "script") {
    // Leave time for process termination and any host checks after the script.
    return bundle.definition.executor.timeoutMs + 2000 + bundle.definition.checks.reduce(
      (sum, check) => sum + (config.commands[check.command]?.timeoutMs ?? 0) + 2000, 0,
    );
  }
  return resolveAgentSettings(config.agent, bundle.definition.agent, node.agent).timeoutMs;
}

/** Old saved runs keep permission metadata; agents use the current tool contract. */
export function blocksForAgent(blocks: Library["blocks"]) {
  return Object.fromEntries(Object.entries(blocks).map(([id, bundle]) => {
    const { permissions: _legacy, ...definition } = bundle.definition;
    return [id, { ...bundle, definition }];
  }));
}
export type Library = {
  config: ProjectConfig;
  blocks: Record<string, BlockBundle>;
};

export function validatePlan(value: unknown, library: Library) {
  const plan = planSchema.parse(value);
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  if (nodes.size !== plan.nodes.length || !nodes.has(plan.entry)) {
    throw new Error("Node IDs must be unique and the entry must exist");
  }

  for (const node of plan.nodes) {
    const bundle = library.blocks[node.block];
    if (!bundle) {
      throw new Error(`Unknown block: ${node.block}`);
    }
    for (const target of Object.values(node.on)) {
      if (
        target !== "$complete" &&
        target !== "$failed" &&
        !nodes.has(target)
      ) {
        throw new Error(`Unknown transition target: ${target}`);
      }
    }
    const aliases = new Set<string>();
    for (const input of node.inputs) {
      const source = nodes.get(input.node);
      const outputs =
        source && library.blocks[source.block]?.definition.outputs;
      const alias = input.as ?? input.artifact;
      if (
        !source ||
        (input.artifact !== "summary" && !outputs?.includes(input.artifact) &&
          !(input.artifact === "data" && library.blocks[source.block]?.definition.executor?.kind === "code"))
      ) {
        throw new Error(`Invalid handoff: ${input.node}.${input.artifact}`);
      }
      if (aliases.has(alias)) {
        throw new Error(`Duplicate input alias: ${alias}`);
      }
      aliases.add(alias);
    }
  }

  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) {
      return;
    }
    reachable.add(id);
    const node = nodes.get(id);
    if (node) {
      Object.values(node.on).forEach(visit);
    }
  };
  visit(plan.entry);
  if (plan.nodes.some((node) => !reachable.has(node.id))) {
    throw new Error("All nodes must be reachable from the entry");
  }
  if (!reachable.has("$complete")) {
    throw new Error("The graph must contain a reachable completion route");
  }

  return plan;
}

export function resolveInputs(node: WorkflowNode, run: WorkflowRun) {
  const inputs: Record<string, string> = { ...node.context };
  for (const input of node.inputs) {
    const value = run.artifacts[input.node]?.[input.artifact];
    if (value === undefined && input.required) {
      throw new Error(
        `Missing required artifact: ${input.node}.${input.artifact}`,
      );
    }
    if (value !== undefined) {
      inputs[input.as ?? input.artifact] = value;
    }
  }

  return inputs;
}
