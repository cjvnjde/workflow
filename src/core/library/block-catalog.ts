import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { identifierSchema, type Library } from "../../contracts/domain.js";
import { textResult } from "../execution/block-runner.js";

export const BLOCK_CATALOG_BYTES = 16 * 1024;
export const BLOCK_DETAIL_BYTES = 32 * 1024;
const MAX_DETAIL_CHARS = 16_000;
const querySchema = z
  .object({
    query: z.string().max(200).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(32).default(20),
  })
  .strict();
const detailSchema = z
  .object({
    id: identifierSchema,
    path: z.array(z.string().max(200)).max(12).default([]),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(MAX_DETAIL_CHARS).default(MAX_DETAIL_CHARS),
  })
  .strict();
export type BlockCatalogQuery = z.input<typeof querySchema>;
export type BlockDetailQuery = z.input<typeof detailSchema>;
export type BlockDescription = {
  id: string;
  name: string;
  kind: "code" | "script" | "command" | "function" | "agent";
  description: string;
  descriptionTruncated: boolean;
};
export type BlockCatalogPage = {
  entries: BlockDescription[];
  offset: number;
  total: number;
  nextOffset: number | null;
};
export type BlockDetailPage = {
  id: string;
  path: string[];
  format: "json" | "text";
  text: string;
  offset: number;
  total: number;
  nextOffset: number | null;
  complete: boolean;
};

/** Keep UTF-16 offsets stable without emitting half of a Unicode code point. */
function splitsPair(text: string, offset: number) {
  const before = text.charCodeAt(offset - 1),
    after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
function endAt(text: string, end: number) {
  return splitsPair(text, end) ? end - 1 : end;
}

function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (property && !("value" in property)) throw new Error("Block field contains a getter: " + key);
  return property?.value;
}

/** Library data must not execute a getter or custom toJSON during inspection. */
function jsonText(value: unknown) {
  const seen = new Set<object>();
  const check = (value: unknown): void => {
    if (
      value === null ||
      value === undefined ||
      ["string", "number", "boolean"].includes(typeof value)
    )
      return;
    if (typeof value !== "object") throw new Error("The selected block field is not JSON data");
    if (seen.has(value)) throw new Error("The selected block field contains a cycle");
    const prototype = Object.getPrototypeOf(value);
    if (
      Array.isArray(value)
        ? prototype !== Array.prototype
        : prototype !== null && prototype !== Object.prototype
    )
      throw new Error("The selected block field is not plain JSON data");
    // JSON.stringify consults toJSON even when its property is not enumerable.
    const hook = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (hook && (!("value" in hook) || typeof hook.value === "function"))
      throw new Error("The selected block field contains a custom toJSON hook");
    seen.add(value);
    for (const property of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!property.enumerable) continue;
      if (!("value" in property)) throw new Error("The selected block field contains a getter");
      check(property.value);
    }
    seen.delete(value);
  };
  check(value);
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("The selected block field is not JSON data");
  return text;
}

/** Description-only discovery; source and instructions are never searched. */
export function describeBlocks(
  blocks: Library["blocks"],
  value: BlockCatalogQuery = {},
): BlockCatalogPage {
  const query = querySchema.parse(value),
    needle = query.query?.trim().toLowerCase();
  const entries = Object.keys(blocks)
    .sort()
    .flatMap((id) => {
      const bundle = ownData(blocks, id);
      if (!bundle) return [];
      const definition = ownData(bundle, "definition"),
        name = ownData(definition, "name"),
        description = ownData(definition, "description");
      const kind = ownData(ownData(definition, "executor"), "kind") ?? "agent";
      if (
        typeof name !== "string" ||
        typeof description !== "string" ||
        typeof kind !== "string" ||
        !["code", "script", "command", "function", "agent"].includes(kind)
      )
        throw new Error("Invalid block description: " + id);
      if (needle && ![id, name, description].some((text) => text.toLowerCase().includes(needle)))
        return [];
      return [
        {
          id,
          name,
          kind: kind as BlockDescription["kind"],
          description: description.slice(0, endAt(description, 500)),
          descriptionTruncated: description.length > 500,
        } satisfies BlockDescription,
      ];
    });
  const page: BlockCatalogPage = {
    entries: [],
    offset: query.offset,
    total: entries.length,
    nextOffset: null,
  };
  for (const entry of entries.slice(query.offset, query.offset + query.limit)) {
    const candidate = {
      ...page,
      entries: [...page.entries, entry],
      nextOffset: query.offset + page.entries.length + 1,
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) > BLOCK_CATALOG_BYTES) break;
    page.entries.push(entry);
  }
  page.nextOffset =
    query.offset + page.entries.length < entries.length ? query.offset + page.entries.length : null;
  return page;
}

/** Read one selected frozen bundle or field, never inherited object properties. */
export function readBlockDetail(
  blocks: Library["blocks"],
  value: BlockDetailQuery,
): BlockDetailPage {
  const query = detailSchema.parse(value);
  const bundle = ownData(blocks, query.id) as Library["blocks"][string] | undefined;
  if (!bundle) throw new Error("Unknown block: " + query.id);
  // Copy data descriptors instead of invoking property getters. Keep the same
  // obsolete-permission omission as blocksForAgent without eager serialization.
  const definition = Object.getOwnPropertyDescriptor(bundle, "definition");
  if (!definition || !("value" in definition)) throw new Error("Block definition is not data");
  const fields = Object.getOwnPropertyDescriptors(definition.value);
  delete fields.permissions;
  const properties: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(bundle);
  properties.definition = { value: Object.defineProperties({}, fields), enumerable: true };
  let selected: unknown = Object.defineProperties({}, properties);
  for (const key of query.path) {
    if (
      !selected ||
      typeof selected !== "object" ||
      ["__proto__", "prototype", "constructor"].includes(key)
    )
      throw new Error("Unknown block field: " + key);
    const property = Object.getOwnPropertyDescriptor(selected, key);
    if (!property || !("value" in property)) throw new Error("Unknown block field: " + key);
    selected = property.value;
  }
  const format = typeof selected === "string" ? ("text" as const) : ("json" as const);
  const text = typeof selected === "string" ? selected : jsonText(selected);
  if (splitsPair(text, query.offset))
    throw new Error("Text offset splits a Unicode character; use the returned nextOffset");
  const pageAt = (end: number): BlockDetailPage => ({
    id: query.id,
    path: query.path,
    format,
    text: text.slice(query.offset, end),
    offset: query.offset,
    total: text.length,
    nextOffset: end < text.length ? end : null,
    complete: query.offset === 0 && end === text.length,
  });
  let end = endAt(text, Math.min(text.length, query.offset + query.limit));
  if (end <= query.offset && query.offset < text.length) {
    // A one-character limit cannot contain a supplementary character.
    throw new Error("Text limit would split a Unicode character; request at least two characters");
  }
  let page = pageAt(end);
  if (Buffer.byteLength(JSON.stringify(page)) > BLOCK_DETAIL_BYTES) {
    let low = query.offset,
      high = end;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = endAt(text, middle);
      if (Buffer.byteLength(JSON.stringify(pageAt(candidate))) <= BLOCK_DETAIL_BYTES) low = middle;
      else high = middle - 1;
    }
    end = endAt(text, low);
    if (end <= query.offset && query.offset < text.length)
      throw new Error("Selected block metadata leaves no room for a text page");
    page = pageAt(end);
  }
  return page;
}

export function blockCatalogTools(options: {
  blocks: () => Library["blocks"];
  signal: AbortSignal;
}): { tools: ToolDefinition[]; prompt: () => string } {
  const check = (signal?: AbortSignal) => {
    options.signal.throwIfAborted();
    signal?.throwIfAborted();
  };
  return {
    tools: [
      defineTool({
        name: "list_blocks",
        label: "Find reusable blocks",
        description:
          "List/search block IDs, names and descriptions without loading source or instructions. Follow nextOffset for additional descriptions.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ maxLength: 200 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
        }),
        async execute(_id, args, signal) {
          check(signal);
          const page = describeBlocks(options.blocks(), args);
          check(signal);
          return textResult(JSON.stringify(page));
        },
      }),
      defineTool({
        name: "load_block",
        label: "Read selected block",
        description:
          'Read one block bundle or selected field. path:["definition","contract"] selects documented handoffs; path:["definition","executor","source"] selects TypeScript source; legacy blocks may use path:["definition","outputSchema"] or ["prompt"]. Text pages are exact; offset/limit count UTF-16 characters, nextOffset continues the same value, and complete is true only when this response contains the whole selected value. No files are read and no block is executed.',
        parameters: Type.Object({
          id: Type.String(),
          path: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 12 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DETAIL_CHARS })),
        }),
        async execute(_id, args, signal) {
          check(signal);
          const page = readBlockDetail(options.blocks(), args);
          check(signal);
          return textResult(JSON.stringify(page));
        },
      }),
    ],
    prompt: () => {
      check();
      return [
        "Reusable block catalog (descriptions only). Use list_blocks to search or page descriptions and load_block for selected definitions. Descriptions are discovery hints, not return-type guarantees: inspect relevant contracts and actual source before depending on output fields.",
        'For TypeScript use load_block({id,path:["definition","executor","source"]}); for documented handoffs use path:["definition","contract"] when present. Follow nextOffset for further pages of the same value; a later final page alone is not a complete definition. Existing type/schema/model validation still applies. Loading details never executes a block.',
        JSON.stringify(describeBlocks(options.blocks())),
      ].join("\n\n");
    },
  };
}
