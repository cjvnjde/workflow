import { inspectGit } from "./git-inspection.js";
import type { CommandOutputRef } from "./operation-schema.js";
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
  outputDirectory?: string;
  onCapture?: (ref: CommandOutputRef) => void;
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
    listFiles: pattern => workspace.list(pattern),
    editText: (filename, oldText, newText) => workspace.edit(filename, oldText, newText),
    inspectGit: input => inspectGit(workspace, input, options.signal),
    writeText: (filename, content) => workspace.write(filename, content),
    exec: (command, settings) =>
      runProcess(
        workspace.root,
        ["bash", "-e", "-o", "pipefail", "-c", command],
        settings?.signal ? AbortSignal.any([options.signal, settings.signal]) : options.signal,
        settings?.timeoutMs ?? 120_000,
        { ...process.env, ...settings?.env },
        { onOutput: settings?.onOutput ?? options.onOutput, captureDirectory: options.outputDirectory, onCapture: settings?.onCapture ?? options.onCapture },
      ),
  };
};
