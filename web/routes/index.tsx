import { createFileRoute, redirect } from "@tanstack/react-router";
import { WorkflowApp } from "../app/workflow-app.js";
import {
  settingsSections,
  workflowViews,
  type SettingsSection,
  type WorkflowView,
} from "../app/workspace-location.js";

export type WorkspaceSearch = {
  view?: "settings";
  task?: string;
  run?: string;
  session?: string;
  section?: SettingsSection;
  workspaceView?: WorkflowView;
  step?: string;
  visit?: number;
  operation?: string;
  evidenceSession?: string;
};

function validateSearch(search: Record<string, unknown>): WorkspaceSearch {
  const task = typeof search.task === "string" && search.task ? search.task : undefined;
  return {
    view: search.view === "settings" ? "settings" : undefined,
    task,
    run: !task && typeof search.run === "string" && search.run ? search.run : undefined,
    session: typeof search.session === "string" && search.session ? search.session : undefined,
    section: settingsSections.find((section) => section === search.section),
    workspaceView: workflowViews.find((view) => view === search.workspaceView),
    step: typeof search.step === "string" && search.step ? search.step : undefined,
    visit:
      Number.isSafeInteger(Number(search.visit)) && Number(search.visit) > 0
        ? Number(search.visit)
        : undefined,
    operation:
      typeof search.operation === "string" && search.operation ? search.operation : undefined,
    evidenceSession:
      typeof search.evidenceSession === "string" && search.evidenceSession
        ? search.evidenceSession
        : undefined,
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
