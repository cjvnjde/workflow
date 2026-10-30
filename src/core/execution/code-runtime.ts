import { z } from "zod";
import { CancellationScope, isCancellation } from "@temporalio/workflow";
import {
  artifactNameSchema,
  outcomeSchema,
  resultSchema,
  resolveAgentSettings,
  type BlockResult,
  type WorkflowNode,
  type WorkflowRun,
} from "../../contracts/domain.js";
import type { CodeBlock, BlockContext, ExecResult, StepOptions } from "../../sdk/workflow-sdk.js";
import type { CodeOperation } from "../../contracts/code-schema.js";
import { modelOverride, utf8Bytes } from "./program-steps.js";
import { failureMessage } from "./failure-message.js";
import { toolReference } from "../../sdk/tool-sdk.js";
import type { WorkflowTool } from "../../sdk/tool-sdk.js";
import { serializeEvidenceValue, type EvidenceValue } from "../../contracts/evidence-value.js";

/** Pure block code runs durably; every host effect is recorded as an activity. */
export async function executeCode(options: {
  run: WorkflowRun;
  node: WorkflowNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous authored blocks retain their own generic input/output types at this boundary.
  block: CodeBlock<any, any>;
  step: StepOptions;
  operation(value: CodeOperation): Promise<unknown>;
  log(message: string): Promise<void>;
  recordInputs?(value: {
    raw: EvidenceValue;
    effective: EvidenceValue;
    inputError?: string;
  }): Promise<void>;
}): Promise<{ result: BlockResult; error?: string }> {
  const { run, node, block, step } = options;
  const definition = block.options;
  const executor = run.blocks[node.block]!.definition.executor;
  if (executor?.kind !== "code") throw new Error("Missing code block snapshot");
  const scope = new CancellationScope({
    cancellable: true,
    timeout: executor.timeoutMs,
  });
  let pending: Promise<unknown> | undefined,
    calls = 0,
    closed = false;
  let summary = "",
    outcome: BlockResult["outcome"] = "pass";
  let disposition: BlockResult["disposition"];
  const artifacts: Record<string, string> = {};
  const effect = <T>(call: () => Promise<unknown>): Promise<T> => {
    if (closed) return Promise.reject(new Error("This block has already finished"));
    if (pending)
      return Promise.reject(new Error("Await each block operation before starting another"));
    if (++calls > executor.maxOperations)
      return Promise.reject(
        new Error(`Block operation limit exceeded (${executor.maxOperations})`),
      );
    const operation = call() as Promise<T>;
    pending = operation;
    void operation
      .finally(() => {
        if (pending === operation) pending = undefined;
      })
      .catch(() => {});
    return operation;
  };
  let inputValue: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous authored blocks retain their own generic input/output types at this boundary.
  const context: BlockContext<any> = {
    call: async (tool, input) => {
      const parsed = tool.input.parse(input);
      assertJSON(parsed);
      const serialized = JSON.stringify(parsed);
      if (utf8Bytes(serialized) > 256_000)
        throw new Error("Tool input exceeds 256 KB; pass a focused input or file reference");
      return tool.output.parse(
        await effect(() =>
          options.operation({
            kind: "tool",
            tool: toolReference(tool),
            input: JSON.parse(serialized),
          }),
        ),
      );
    },
    get input() {
      return inputValue;
    },
    request: run.plan.task,
    prompt: step.prompt ?? run.plan.task,
    models: JSON.parse(JSON.stringify(run.program!.models)),
    model: resolveAgentSettings(
      run.config.agent,
      run.blocks[node.block]?.definition.agent,
      node.agent,
    ),
    visit: run.visits[node.id]!,
    ai: (async (args: {
      prompt: string;
      context?: "workflow" | "none";
      tools?: "none" | readonly WorkflowTool[];
      role?: "test-author" | "repair" | "verification" | "review";
      capabilities?: { skills?: string[]; mcp?: Record<string, string[]>; optionalMcp?: string[] };
      instructions?: string;
      protectedPaths?: string[];
      writablePaths?: string[];
      workspace?: string;
      model?: Parameters<typeof modelOverride>[0];
      output?: z.ZodType;
    }) => {
      if (args.tools !== undefined && args.prompt.length > 32_000)
        throw new Error(
          "AI prompts with explicit tools must fit within 32000 characters; select focused input first",
        );
      const outputSchema = args.output ? z.toJSONSchema(args.output) : undefined;
      const result = await effect<BlockResult>(() =>
        options.operation({
          kind: "ai",
          context: args.context,
          tools: typeof args.tools === "string" ? args.tools : args.tools?.map(toolReference),
          role: args.role,
          capabilities: args.capabilities,
          prompt: args.prompt,
          instructions: args.instructions,
          protectedPaths: args.protectedPaths,
          writablePaths: args.writablePaths,
          workspace: args.workspace,
          model: modelOverride(args.model),
          outputSchema,
        }),
      );
      if (result.outcome !== "pass") throw new Error(result.summary);
      if (!args.output) return result.summary;
      return args.output.parse(JSON.parse(result.artifacts.data!));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous authored blocks retain their own generic input/output types at this boundary.
    }) as BlockContext<any>["ai"],
    exec: (command, settings) =>
      effect<ExecResult>(() =>
        options.operation({
          kind: "exec",
          command,
          timeoutMs: settings?.timeoutMs ?? 120_000,
          env: settings?.env,
        }),
      ),
    readFile: (path) => effect<string>(() => options.operation({ kind: "read", path })),
    writeFile: async (path, content) => {
      await effect(() => options.operation({ kind: "write", path, content }));
    },
    log: (message) => effect<void>(() => options.log(z.string().max(16_000).parse(message))),
    artifact: (name, content) => {
      if (closed) throw new Error("This block has already finished");
      if (name === "data" || name === "summary")
        throw new Error(
          "data and summary are published from the block result; choose another artifact name",
        );
      const candidate = {
        ...artifacts,
        [artifactNameSchema.parse(name)]: z.string().max(64_000).parse(content),
      };
      if (utf8Bytes(JSON.stringify(candidate)) > 128_000)
        throw new Error("Block artifacts exceed 128 KB. Publish concise results.");
      artifacts[name] = content;
    },
    summary: (value) => {
      const text = z.string().parse(value);
      const marker = "\n… [summary truncated: showing beginning and end] …\n";
      // A verbose failing check must still reach its declared diagnostic route.
      // Keep both setup context and the final failure, without changing artifacts/data.
      const head = Math.floor((16_000 - marker.length) / 2);
      summary =
        text.length <= 16_000
          ? text
          : text.slice(0, head) + marker + text.slice(-(16_000 - marker.length - head));
    },
    disposition: (value) => {
      disposition = value;
      outcome = value === "blocked" ? "fail" : value === "changes-requested" ? "retry" : "pass";
    },
    outcome: (value) => {
      const next = outcomeSchema.parse(value);
      if (next !== outcome) disposition = undefined;
      outcome = next;
    },
  };
  try {
    const rawInputs = options.recordInputs ? serializeEvidenceValue(step.inputs ?? {}) : undefined;
    try {
      const input = JSON.parse(JSON.stringify(step.inputs ?? {}));
      inputValue = definition.input ? definition.input.parse(input) : input;
    } catch (error) {
      const message = failureMessage(error).slice(0, 16_000);
      await options.recordInputs?.({
        raw: rawInputs!,
        effective: {
          state: "unavailable",
          reasonCode: "validation-failed",
          reason: "Input normalization or schema validation failed",
        },
        inputError: message,
      });
      throw error;
    }
    // Observability is separate from user effects and consumes no maxOperations.
    await options.recordInputs?.({
      raw: rawInputs!,
      effective: serializeEvidenceValue(inputValue),
    });
    const raw = await Promise.race([
      scope.run(() => Promise.resolve(definition.run(context))),
      scope.cancelRequested,
    ]);
    if (pending)
      throw new Error(
        "The block returned before an operation finished. Await every ctx.ai/exec/readFile/writeFile/log call.",
      );
    const data = definition.output ? definition.output.parse(raw) : raw;
    if (data !== undefined) assertJSON(data);
    const serialized = JSON.stringify(data);
    if (data !== undefined && serialized === undefined)
      throw new Error("Block output must be JSON serializable");
    if (serialized !== undefined) artifacts.data = serialized;
    const result = resultSchema.parse({
      outcome,
      disposition,
      artifacts,
      summary:
        summary ||
        (typeof data === "string"
          ? data || `${node.label} completed.`
          : data === undefined
            ? `${node.label} completed.`
            : `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``
        ).slice(0, 16_000),
    });
    if (utf8Bytes(JSON.stringify(run)) + 3 * utf8Bytes(JSON.stringify(result)) > 1_500_000)
      throw new Error(
        "Workflow result is too large. Publish concise outputs or split the workflow.",
      );
    return { result };
  } catch (error) {
    scope.cancel();
    if (pending) await pending.catch(() => {});
    // A lost host activity may already have changed the project. Preserve the
    // engine's explicit recovery/resume boundary rather than blindly retrying it.
    if (isCancellation(error) || (error instanceof Error && error.name === "ActivityFailure"))
      throw error;
    const message = failureMessage(error).slice(0, 16_000);
    return {
      result: { outcome: "fail", summary: message, artifacts: {} },
      error: message,
    };
  } finally {
    closed = true;
  }
}

function assertJSON(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    !value ||
    ancestors.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(
      "Block output must contain JSON values (no cycles, class instances, functions, bigint or nonfinite numbers)",
    );
  }
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    if (item === undefined && !Array.isArray(value)) continue;
    assertJSON(item, ancestors);
  }
  ancestors.delete(value);
}
