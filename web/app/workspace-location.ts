import { useNavigate, useSearch } from "@tanstack/react-router";

export const settingsSections = [
  "providers",
  "profiles",
  "cases",
  "blocks",
  "capabilities",
  "execution",
  "triggers",
  "automations",
  "memory",
] as const;
export type SettingsSection = (typeof settingsSections)[number];
export const workflowViews = [
  "results",
  "workflow",
  "data",
  "timeline",
  "activity",
  "artifacts",
  "edit",
] as const;
export type WorkflowView = (typeof workflowViews)[number];
export type InspectionLocation = {
  workspaceView?: WorkflowView;
  step?: string;
  visit?: number;
  operation?: string;
  session?: string;
};

/** Keep inspection links and browser history aligned with the visible workspace. */
export function useWorkspaceLocation() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  return {
    section: search.section ?? "providers",
    workspaceView: search.workspaceView,
    step: search.step,
    visit: search.visit,
    operation: search.operation,
    session: search.evidenceSession,
    setSettingsSection: (section: SettingsSection) =>
      navigate({ to: "/", search: (previous) => ({ ...previous, section }) }),
    setInspection: (location: InspectionLocation) =>
      navigate({
        to: "/",
        search: (previous) => {
          const { session, ...inspection } = location;
          return {
            ...previous,
            ...inspection,
            ...("session" in location ? { evidenceSession: session } : {}),
          };
        },
      }),
  };
}
