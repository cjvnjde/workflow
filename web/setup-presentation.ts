import type { SetupJob, SetupStageId } from "../src/contracts.js";

export const setupStageLabels: Record<SetupStageId, string> = {
  profiles: "Choose model roles",
  cases: "Design task instructions",
  blocks: "Build reusable blocks",
  validation: "Validate the library",
  applying: "Save project setup",
};
export const setupStatusLabels: Record<SetupJob["status"], string> = {
  queued: "Waiting to start",
  running: "Setup in progress",
  cancelling: "Stopping setup",
  interrupted: "Setup interrupted",
  failed: "Setup needs attention",
  conflicted: "Project settings changed",
  completed: "Setup completed",
  cancelled: "Setup stopped",
};
export function setupActive(job: Pick<SetupJob, "status"> | null) {
  return !!job && ["queued", "running", "cancelling"].includes(job.status);
}
