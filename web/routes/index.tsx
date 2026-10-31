import { createFileRoute, redirect } from "@tanstack/react-router";
import { WorkflowApp } from "../app/workflow-app.js";

export type WorkspaceSearch = {
  view?: "settings";
  task?: string;
  run?: string;
  session?: string;
};

function validateSearch(search: Record<string, unknown>): WorkspaceSearch {
  const task = typeof search.task === "string" && search.task ? search.task : undefined;
  return {
    view: search.view === "settings" ? "settings" : undefined,
    task,
    run: !task && typeof search.run === "string" && search.run ? search.run : undefined,
    session: typeof search.session === "string" && search.session ? search.session : undefined,
  };
}

export const Route = createFileRoute("/")({
  ssr: false,
  validateSearch,
  beforeLoad: ({ location, search }) => {
    // Migrate shared links from the former hash router through Router itself.
    const legacy = new URLSearchParams(location.hash);
    if (!legacy.has("settings") && !legacy.has("task") && !legacy.has("run")) return;
    const task = legacy.get("task") || undefined;
    throw redirect({
      to: "/",
      search: {
        view: legacy.has("settings") ? "settings" : undefined,
        task,
        run: task ? undefined : legacy.get("run") || undefined,
        session: search.session,
      },
      hash: "",
      replace: true,
    });
  },
  component: WorkflowApp,
});
