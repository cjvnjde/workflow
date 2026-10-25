import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { textResult } from "./block-runner.js";
import { blocksForAgent } from "./domain.js";
import type { DesignOptions } from "./settings-designer.js";

export type DesignResource = "tasks" | "runs" | "task" | "run" | "events";
export type DesignInspector = (resource: DesignResource, id?: string) => Promise<unknown>;

// A shared, transport-independent tool surface. The chat adapter exposes these
// named operations with JSON schemas, just as an MCP tool client would.
export function designInspectionTools(options: Pick<DesignOptions, "library" | "settings" | "models" | "inspect" | "signal">) {
  return [defineTool({
    name: "workflow_inspect",
    label: "Inspect Workflow",
    description: "Read project configuration, model catalog, reusable blocks, tasks, runs, or run events. Works from every page. This tool never modifies state. Use task IDs for task, run IDs for run/events. Use path (object keys/array indices) to select details, and offset/limit to page lists or long text. Responses include total and nextOffset when paginated. Configuration reflects the start of this design turn; run/task evidence is live.",
    parameters: Type.Object({
      resource: Type.Union(["configuration", "models", "blocks", "tasks", "runs", "task", "run", "events"].map(value => Type.Literal(value))),
      id: Type.Optional(Type.String({ format: "uuid" })),
      path: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 12 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, args) {
      options.signal.throwIfAborted();
      let value: unknown;
      if (args.resource === "configuration") value = { execution: options.library.config, orchestration: options.settings };
      else if (args.resource === "models") value = options.models;
      else if (args.resource === "blocks") value = blocksForAgent(options.library.blocks);
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
      options.signal.throwIfAborted();
      return textResult(json);
    },
  })];
}
