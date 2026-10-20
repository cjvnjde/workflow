import type { Block, CheckResult, ProjectConfig } from "./domain.js";
import { runProcess } from "./process.js";

export async function runCheck(
  project: string,
  config: ProjectConfig,
  check: Block["checks"][number],
  signal: AbortSignal,
): Promise<CheckResult> {
  const command = config.commands[check.command];
  if (!command?.argv[0]) throw new Error(`Unknown check command: ${check.command}`);
  const result = await runProcess(project, command.argv, signal, command.timeoutMs);
  return {
    command: check.command, expected: check.expect, exitCode: result.exitCode,
    matched: !result.timedOut && result.exitCode !== null &&
      (check.expect === "success" ? result.exitCode === 0 : result.exitCode !== 0),
    output: result.timedOut ? `Check timed out.\n${result.output}` : result.output,
  };
}
