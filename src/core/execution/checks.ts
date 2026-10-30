import type { Block, CheckResult, ProjectConfig } from "../../contracts/domain.js";
import type { ExecutionEnvironment } from "../../sdk/tool-sdk.js";
import { runProcess } from "../../infrastructure/process.js";

export async function runCheck(
  project: string,
  config: ProjectConfig,
  check: Block["checks"][number],
  signal: AbortSignal,
  environment?: ExecutionEnvironment,
): Promise<CheckResult> {
  const command = config.commands[check.command];
  if (!command?.argv[0]) throw new Error(`Unknown check command: ${check.command}`);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const result = environment
    ? await environment.exec(command.argv.map(quote).join(" "), {
        timeoutMs: command.timeoutMs,
        signal,
      })
    : await runProcess(project, command.argv, signal, command.timeoutMs);
  return {
    ...(result.outputRef ? { outputRef: result.outputRef } : {}),
    command: check.command,
    expected: check.expect,
    exitCode: result.exitCode,
    matched:
      !result.timedOut &&
      result.exitCode !== null &&
      (check.expect === "success" ? result.exitCode === 0 : result.exitCode !== 0),
    output: result.timedOut ? `Check timed out.\n${result.output}` : result.output,
  };
}
