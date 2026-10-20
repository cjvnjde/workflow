import type { Block } from "../src/domain.js";

export function executionLabel(executor: Block["executor"]) {
  if (executor?.kind === "function") return "Function: Git push";
  if (executor?.kind === "command") return `Command: ${executor.command}`;
  return "AI agent";
}
