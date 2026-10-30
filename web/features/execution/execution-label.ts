import type { Block, WorkflowRun } from "../../../src/contracts/index.js";

export function executionLabel(executor: Block["executor"]) {
  if (executor?.kind === "code") return "TypeScript";
  if (executor?.kind === "script")
    return executor.language === "bash"
      ? "Bash script"
      : `${executor.language === "typescript" ? "TypeScript" : "JavaScript"} · ${executor.runtime === "bun" ? "Bun" : "Node"}`;
  if (executor?.kind === "function") return "Function: Git push";
  if (executor?.kind === "command") return `Command: ${executor.command}`;
  return "AI agent";
}

/** Imported TypeScript programs have a runtime trace; generated tasks have a planned graph. */
export function isSourceWorkflow(run: WorkflowRun) {
  return !!run.program && run.program.composition !== "graph";
}
