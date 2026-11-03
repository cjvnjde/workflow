import { QueryClient } from "@tanstack/react-query";

export const workflowQueryKeys = {
  project: ["project"] as const,
  sessions: ["sessions"] as const,
  run: (id: string | undefined) => ["run", id] as const,
  events: (id: string | undefined) => ["run-events", id] as const,
  taskDetails: ["task"] as const,
  task: (id: string | undefined) => ["task", id] as const,
  setup: ["setup"] as const,
  usage: ["usage"] as const,
};

/** Each router owns its cache; server requests must never share a QueryClient. */
export function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
