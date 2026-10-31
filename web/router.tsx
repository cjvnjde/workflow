import { createRouter, type Router } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.js";
import { createQueryClient } from "./shared/query-client.js";

export type WorkflowRouter = Router<typeof routeTree>;

export function getRouter() {
  return createRouter({
    routeTree,
    context: { queryClient: createQueryClient() },
    scrollRestoration: true,
    defaultPendingComponent: () => <p role="status">Loading Workflow…</p>,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: WorkflowRouter;
  }
}
