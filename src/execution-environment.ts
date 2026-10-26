import { Workspace } from "./workspace.js";
import { runProcess } from "./process.js";
import type { ExecutionEnvironment } from "./tool-sdk.js";
import type { FileJournal } from "./recovery.js";
import type { ProtectedPaths } from "./protected-paths.js";

export interface EnvironmentOptions {
  project: string;
  signal: AbortSignal;
  journal?: FileJournal;
  protect?: ProtectedPaths;
  isolated?: boolean;
  onOutput?: (text: string) => void;
}
export type ExecutionEnvironmentFactory = (
  options: EnvironmentOptions,
) => Promise<ExecutionEnvironment>;

export const localExecutionEnvironment: ExecutionEnvironmentFactory = async (
  options,
) => {
  const workspace = await Workspace.create(options.project, {
    signal: options.signal,
    journal: options.journal,
    protect: options.protect,
    absoluteJournalPaths: options.isolated,
    writeRootOnly: options.isolated,
  });
  return {
    id: `local:${workspace.root}`,
    readText: (filename) => workspace.read(filename),
    writeText: (filename, content) => workspace.write(filename, content),
    exec: (command, settings) =>
      runProcess(
        workspace.root,
        ["bash", "-e", "-o", "pipefail", "-c", command],
        options.signal,
        settings?.timeoutMs ?? 120_000,
        { ...process.env, ...settings?.env },
        { onOutput: options.onOutput },
      ),
  };
};
