import {
  automationBoundary,
  automationEnvironment,
} from "../../infrastructure/automation-boundary.js";
import { inspectGit } from "../../infrastructure/git-inspection.js";
import type { CommandOutputRef } from "../../contracts/operation-schema.js";
import { Workspace } from "../storage/workspace.js";
import { runProcess } from "../../infrastructure/process.js";
import type { ExecutionEnvironment } from "../../sdk/tool-sdk.js";
import type { FileJournal } from "../storage/recovery.js";
import type { ProtectedPaths } from "./protected-paths.js";

export interface EnvironmentOptions {
  project: string;
  signal: AbortSignal;
  journal?: FileJournal;
  protect?: ProtectedPaths;
  isolated?: boolean;
  onOutput?: (text: string) => void;
  outputDirectory?: string;
  /** Ephemeral resolved environment; integrations must not persist credential values. */
  environment?: NodeJS.ProcessEnv;
  onCapture?: (ref: CommandOutputRef) => void;
}
export type ExecutionEnvironmentFactory = (
  options: EnvironmentOptions,
) => Promise<ExecutionEnvironment>;

export const localExecutionEnvironment: ExecutionEnvironmentFactory = async (options) => {
  const boundary = automationBoundary.getStore();
  const workspace = await Workspace.create(options.project, {
    signal: options.signal,
    journal: options.journal,
    protect: options.protect,
    absoluteJournalPaths: options.isolated,
    writeRootOnly: options.isolated,
    readRootOnly: !!boundary,
  });
  return {
    id: `local:${workspace.root}`,
    readText: (filename) => workspace.read(filename),
    listFiles: (pattern) => workspace.list(pattern),
    editText: (filename, oldText, newText) => workspace.edit(filename, oldText, newText),
    inspectGit: (input) => inspectGit(workspace, input, options.signal),
    writeText: (filename, content) => workspace.write(filename, content),
    exec: (command, settings) => {
      const execute = () =>
        runProcess(
          workspace.root,
          ["bash", "-e", "-o", "pipefail", "-c", command],
          settings?.signal ? AbortSignal.any([options.signal, settings.signal]) : options.signal,
          settings?.timeoutMs ?? 120_000,
          { ...process.env, ...settings?.env },
          {
            onOutput: settings?.onOutput ?? options.onOutput,
            captureDirectory: options.outputDirectory,
            onCapture: settings?.onCapture ?? options.onCapture,
          },
        );
      const active = automationBoundary.getStore();
      return boundary
        ? automationBoundary.run(
            active && active.consume === boundary.consume ? active : boundary,
            execute,
          )
        : execute();
    },
  };
};

/** Bind policy across injected environments and worker/event callbacks. */
export async function createExecutionEnvironment(
  factory: ExecutionEnvironmentFactory,
  options: EnvironmentOptions,
) {
  const boundary = automationBoundary.getStore();
  const environment = await factory({ ...options, environment: automationEnvironment() });
  if (!boundary || factory === localExecutionEnvironment) return environment;
  return {
    ...environment,
    exec: async (...args: Parameters<typeof environment.exec>) => {
      await boundary.consume("commands");
      return automationBoundary.run({ ...boundary, commandReserved: true }, () =>
        environment.exec(...args),
      );
    },
  };
}
