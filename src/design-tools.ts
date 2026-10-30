import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { textResult } from "./block-runner.js";
import { describeBlocks, readBlockDetail } from "./block-catalog.js";
import type { DesignOptions } from "./settings-designer.js";

export type DesignResource = "tasks" | "runs" | "task" | "run" | "events";
export type DesignInspector = (resource: DesignResource, id?: string) => Promise<unknown>;

// A shared, transport-independent tool surface. The chat adapter exposes these
// named operations with JSON schemas, just as an MCP tool client would.
export function designInspectionTools(options: Pick<DesignOptions, "library" | "settings" | "models" | "inspect" | "signal">) {
  return [defineTool({
    name: "workflow_inspect",
    label: "Inspect Workflow",
    description: 'Read project configuration, model catalog, reusable blocks, tasks, runs, or run events. This tool never modifies state. Use task IDs for task, run IDs for run/events. Blocks without path returns descriptions only, at most 32 per page. For a selected block use path:["block-id"] or path:["block-id","definition","executor","source"] for TypeScript; ["block-id","definition","contract"] selects documented handoffs. Selected block details return exact text pages: offset counts UTF-16 characters and limit counts thousands of characters, capped at 16000. Follow nextOffset; complete means the whole selected value is present in this response. Other resources use path for object keys/array indices and offset/limit for lists or long text. Configuration/blocks reflect the start of this design turn; run/task evidence is live.',
    parameters: Type.Object({
      resource: Type.Union(["configuration", "models", "blocks", "tasks", "runs", "task", "run", "events"].map(value => Type.Literal(value))),
      id: Type.Optional(Type.String({ format: "uuid" })),
      path: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 12 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, args, executionSignal) {
      const check = () => { options.signal.throwIfAborted(); executionSignal?.throwIfAborted(); };
      check();
      if (args.resource === "blocks") {
        const value = args.path?.length
          ? readBlockDetail(options.library.blocks, { id: args.path[0]!, path: args.path.slice(1), offset: args.offset, limit: Math.min(args.limit ?? 20, 16) * 1000 })
          : describeBlocks(options.library.blocks, { offset: args.offset, limit: Math.min(args.limit ?? 20, 32) });
        check();
        return textResult(JSON.stringify(value));
      }
      let value: unknown;
      if (args.resource === "configuration") value = { execution: options.library.config, orchestration: options.settings };
      else if (args.resource === "models") value = options.models;
      else {
        if (!options.inspect) throw new Error("Workflow history inspection is unavailable in this host");
        value = await options.inspect(args.resource as DesignResource, args.id);
      }
      for (const key of args.path ?? []) {
        if (!value || typeof value !== "object" || !Object.hasOwn(value, key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error(`Unknown field: ${key}`);
        value = (value as Record<string, unknown>)[key];
      }
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 20;
      if (Array.isArray(value) || typeof value === "string") {
        const total = value.length;
        const count = typeof value === "string" ? limit * 1000 : limit;
        value = { items: value.slice(offset, offset + count), total, nextOffset: offset + count < total ? offset + count : null };
      }
      const json = JSON.stringify(value);
      if (json.length > 60000) return textResult(JSON.stringify({ error: "Result exceeds 60000 characters. Select a field with path or a smaller list page with limit.", keys: value && typeof value === "object" ? Object.keys(value) : [] }));
      check();
      return textResult(json);
    },
  })];
}
