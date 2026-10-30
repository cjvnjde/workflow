import type { RunEvent, WorkflowRun } from "../../../src/contracts/index.js";
export const statusLabel = (status: string) =>
  ({
    draft: "Awaiting approval",
    running: "Working",
    pausing: "Pausing",
    paused: "Paused",
    completed: "Completed",
    interrupted: "Needs attention",
    failed: "Failed",
    cancelled: "Cancelled",
    rejected: "Rejected",
    queued: "Queued",
    planning: "Planning",
    needs_input: "Needs your input",
    ready: "Workflow ready",
  })[status] ?? status;
export function stepState(run: WorkflowRun, id: string) {
  if (
    run.activeNodes?.includes(id) ||
    (!run.activeNodes && ["running", "pausing"].includes(run.status) && run.cursor === id)
  ) {
    return "running";
  }
  if (run.groups?.[id]?.state === "skipped") return "skipped";
  const last = run.attempts.filter((attempt) => attempt.nodeId === id).at(-1);
  return last?.error ? "failed" : (last?.result?.outcome ?? "pending");
}
export function currentActivity(event?: RunEvent) {
  if (!event) {
    return "Preparing the next step";
  }
  if (event.operation) {
    const op = event.operation;
    if (op.state === "failed" || op.state === "interrupted") return `${op.name} needs attention`;
    if (op.state === "completed") return "Working through the step";
    return op.summary ?? `Running ${op.name}`;
  }
  if (event.kind === "tool_start") {
    const tool = event.message.split(" ")[0] ?? "tool";
    return tool === "read_file" || tool === "list_files" || tool === "git_changes"
      ? "Reading the project"
      : tool === "write_file" || tool === "edit_file"
        ? "Editing files"
        : tool.startsWith("mcp_")
          ? "Using an MCP tool"
          : "Running a tool";
  }
  if (["check", "check_start"].includes(event.kind)) {
    return "Verifying changes";
  }
  if (event.kind === "agent_start" || event.kind === "tool_end") {
    return "Working through the step";
  }
  return event.kind === "node_start" ? "Starting the next step" : "Working";
}
