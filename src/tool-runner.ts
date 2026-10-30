import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ExecutionEnvironment } from "./tool-sdk.js";
import {
  boundedEvidence,
  toolPresentationSchema,
  type ToolPresentation,
  type CommandOutputRef,
  toolReferenceSchema,
  type OperationRecorder,
} from "./operation-schema.js";

const descriptorSchema = toolReferenceSchema.extend({
  description: z.string(),
  timeoutMs: z.number().int().min(100).max(600_000),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()),
});
export type ToolDescriptor = z.infer<typeof descriptorSchema>;
export type ToolResult = {
  presentation?: ToolPresentation;
  data: z.infer<ReturnType<typeof z.json>>;
  summary?: string;
  details?: z.infer<ReturnType<typeof z.json>>;
};
const resultSchema = z.object({
  presentation: toolPresentationSchema.optional().catch(undefined),
  data: z.json(),
  summary: z.string().max(16_000).optional(),
  details: z.json().optional(),
});
type ToolReference = z.infer<typeof toolReferenceSchema>;

async function openTools(codePath: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const code = await readFile(codePath, "utf8");
  signal.throwIfAborted();
  const worker = new Worker(
    new URL(
      import.meta.url.endsWith(".ts") ? "./tool-worker.ts" : "./tool-worker.js",
      import.meta.url,
    ).href,
  );
  const ready = Promise.withResolvers<ToolDescriptor[]>();
  const result = Promise.withResolvers<ToolResult>();
  // Attach rejection handlers immediately: initialization can fail before the caller waits for a result.
  void ready.promise.catch(() => {});
  void result.promise.catch(() => {});
  let effect:
    | ((message: {
        id: number;
        method: string;
        args: unknown[];
      }) => Promise<void>)
    | undefined;
  const fail = (error: unknown) => {
    ready.reject(error);
    result.reject(error);
  };
  const abort = () => {
    fail(signal.reason);
    worker.terminate();
  };
  const timer = setTimeout(() => {
    fail(new Error("Tool initialization timed out"));
    worker.terminate();
  }, 5000);
  signal.addEventListener("abort", abort, { once: true });
  worker.onerror = (error) => {
    fail(new Error(error.message));
  };
  worker.onmessage = (event) => {
    try {
      const message = event.data;
      if (message.type === "ready") {
        clearTimeout(timer);
        ready.resolve(z.array(descriptorSchema).max(64).parse(message.tools));
      } else if (message.type === "result") {
        if (Buffer.byteLength(JSON.stringify({ data: message.data, summary: message.summary, details: message.details })) > 256_000)
          throw new Error("Tool result exceeds 256 KB");
        result.resolve(resultSchema.parse(message));
      } else if (message.type === "error")
        fail(new Error(String(message.error)));
      else if (message.type === "effect") {
        if (!effect)
          throw new Error(
            "Tool effects cannot run during module initialization",
          );
        void effect(message).catch(fail);
      }
    } catch (error) {
      fail(error);
    }
  };
  worker.postMessage({ type: "open", code });
  if (signal.aborted) abort();
  const close = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    worker.terminate();
  };
  try {
    return {
      tools: await ready.promise,
      worker,
      result: result.promise,
      close,
      setEffect: (handler: typeof effect) => {
        effect = handler;
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
export async function describeTools(
  codePath: string,
  references: readonly ToolReference[],
  signal: AbortSignal,
) {
  const runtime = await openTools(codePath, signal);
  try {
    if (new Set(references.map((ref) => ref.name)).size !== references.length)
      throw new Error("AI tool selection contains duplicate names");
    return references.map((ref) => matchTool(runtime.tools, ref));
  } finally {
    runtime.close();
  }
}
function matchTool(tools: ToolDescriptor[], ref: ToolReference) {
  const tool = tools.find(
    (tool) =>
      tool.name === ref.name &&
      tool.version === ref.version &&
      tool.replay === ref.replay,
  );
  if (!tool)
    throw new Error(
      `Define ${ref.name}@${ref.version} at module scope; it is not in this workflow's frozen tool registry`,
    );
  return tool;
}

export async function executeTool(options: {
  codePath: string;
  tool: ToolReference;
  input: unknown;
  callId: string;
  request: string;
  signal: AbortSignal;
  environment: (signal: AbortSignal) => Promise<ExecutionEnvironment>;
  record: OperationRecorder;
}): Promise<ToolResult> {
  const input = JSON.stringify(options.input);
  if (input === undefined || Buffer.byteLength(input) > 256_000) throw new Error("Tool input must be JSON below 256 KB");
  const cancellation = new AbortController();
  const signal = AbortSignal.any([options.signal, cancellation.signal]);
  const runtime = await openTools(options.codePath, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let calls = 0,
    pending = false;
  const effects = new Set<Promise<void>>();
  try {
    const tool = matchTool(runtime.tools, options.tool);
    timer = setTimeout(
      () =>
        cancellation.abort(
          new Error(`Tool timed out after ${tool.timeoutMs}ms`),
        ),
      tool.timeoutMs,
    );
    const environment = await options.environment(signal);
    runtime.setEffect((message) => {
      const job = (async () => {
        const id = `${options.callId}/effect-${++calls}`;
        const kind =
          message.method === "readText"
            ? "read"
            : message.method === "writeText"
              ? "write"
              : "exec";
        let started = false;
        const effectStarted = performance.now();
        let capturedOutput: CommandOutputRef | undefined;
        try {
          signal.throwIfAborted();
          if (pending)
            throw new Error(
              "Await each tool environment operation before starting another",
            );
          if (calls > 64)
            throw new Error("Tool environment operation limit exceeded (64)");
          if (
            !["readText", "writeText", "exec", "progress"].includes(
              message.method,
            )
          )
            throw new Error("Unknown environment operation");
          if (
            tool.replay === "safe" &&
            ["writeText", "exec"].includes(message.method)
          )
            throw new Error(
              "Replay-safe tools may only read; use replay: unsafe for commands and writes",
            );
          pending = true;
          started = true;
          const args = message.args;
          const name = z.string().min(1).max(128_000).parse(args[0]);
          if (message.method === "progress") {
            await options.record({
              id: options.callId,
              name: tool.name,
              kind: "tool",
              state: "progress",
              summary: name.slice(0, 16_000),
            });
            runtime.worker.postMessage({
              type: "settle",
              id: message.id,
              value: null,
            });
            return;
          }
          await options.record({
            id,
            parentId: options.callId,
            environmentId: environment.id,
            name: message.method,
            kind,
            state: "started",
            input: name.slice(0, 16_000),
          });
          const value =
            message.method === "readText"
              ? await environment.readText(name)
              : message.method === "writeText"
                ? await environment.writeText(
                    name,
                    z.string().max(256_000).parse(args[1]),
                  )
                : await environment.exec(
                    name,
                    { ...z
                      .object({
                        timeoutMs: z
                          .number()
                          .int()
                          .min(100)
                          .max(600_000)
                          .optional(),
                        env: z.record(z.string(), z.string()).optional(),
                      })
                      .strict()
                      .optional()
                      .parse(args[1] ?? undefined),
                      // This callback is host-owned; authored options remain
                      // strict JSON and cannot replace capture or cancellation.
                      signal,
                      onCapture: ref => { capturedOutput = ref; },
                    },
                  );
          if (kind === "exec") capturedOutput ??= (value as import("./workflow-sdk.js").ExecResult).outputRef;
          signal.throwIfAborted();
          const evidence = boundedEvidence(value);
          await options.record({
            id,
            parentId: options.callId,
            environmentId: environment.id,
            name: message.method,
            kind,
            state: "completed",
            durationMs: performance.now() - effectStarted,
            ...(kind === "exec" ? { outputRef: (value as import("./workflow-sdk.js").ExecResult).outputRef,
              presentation: {card: "command" as const, command: name.slice(0,16000), exitCode: (value as import("./workflow-sdk.js").ExecResult).exitCode,
                output: (value as import("./workflow-sdk.js").ExecResult).output.slice(-32000)} } : {}),
            output: evidence.value,
            truncated: evidence.truncated,
          });
          runtime.worker.postMessage({
            type: "settle",
            id: message.id,
            value: value ?? null,
          });
        } catch (error) {
          if (started && message.method !== "progress")
            await options.record({
              id,
              parentId: options.callId,
              name: message.method,
              kind,
              state: signal.aborted ? "interrupted" : "failed",
              environmentId: environment.id,
              outputRef: capturedOutput,
              durationMs: performance.now() - effectStarted,
              summary: String(error).slice(0, 16_000),
            });
          runtime.worker.postMessage({
            type: "settle",
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (started) pending = false;
        }
      })();
      effects.add(job);
      void job.finally(() => effects.delete(job)).catch(() => {});
      return job;
    });
    runtime.worker.postMessage({
      type: "invoke",
      name: tool.name,
      version: tool.version,
      input: options.input,
      info: {
        callId: options.callId,
        request: options.request,
        environment: environment.id,
      },
    });
    return await runtime.result;
  } finally {
    clearTimeout(timer);
    cancellation.abort(new Error("Tool invocation closed"));
    runtime.close();
    await Promise.allSettled(effects);
  }
}
