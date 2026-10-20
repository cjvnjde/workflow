import { z } from "zod";
import {
  bundleSchema,
  configSchema,
  identifierSchema,
  runSchema,
} from "../src/domain.js";

export const projectSchema = z.object({
  project: z.string(),
  mode: z.enum(["demo", "live"]),
  config: configSchema,
  blocks: z.record(identifierSchema, bundleSchema),
});
export const runListSchema = z.array(
  runSchema
    .pick({
      id: true,
      status: true,
      mode: true,
      createdAt: true,
      updatedAt: true,
      revision: true,
      deletedAt: true,
      cursor: true,
    })
    .extend({ title: z.string(), task: z.string() }),
);

export async function request<T>(
  url: string,
  schema: z.ZodType<T>,
  options?: { method?: string; body?: unknown; revision?: number; signal?: AbortSignal },
) {
  const response = await fetch(url, {
    method: options?.method ?? "GET",
    signal: options?.signal,
    headers: {
      ...(options?.body === undefined ? {} : { "content-type": "application/json" }),
      "x-workflow-client": "1",
      ...(options?.revision === undefined ? {} : { "if-match": `"${options.revision}"` }),
    },
    body:
      options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data: unknown = await response.json().catch(() => {
    throw new Error(response.ok
      ? "The server returned an invalid response. Refresh the page and try again."
      : `Request failed (${response.status}). Check that Workflow is running and try again.`);
  });
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(data);
    throw new Error(
      error.success ? error.data.error : `Request failed (${response.status})`,
    );
  }

  return schema.parse(data);
}
