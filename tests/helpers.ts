import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { initializeProject } from "../src/library.js";
import type { BlockExecution, BlockRunner } from "../src/block-runner.js";

export async function fixture(t: TestContext) {
  const project = await mkdtemp(path.join(os.tmpdir(), "workflow-test-"));
  const cleanups: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    try {
      for (const cleanup of cleanups.toReversed()) {
        await cleanup();
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
  const library = await initializeProject(project);

  return { project, library, cleanup: (action: () => Promise<unknown>) => { cleanups.push(action); } };
}

export function passingResult(execution: BlockExecution) {
  return {
    outcome: "pass" as const,
    summary: `Finished ${execution.node.id}`,
    artifacts: Object.fromEntries(
      execution.bundle.definition.outputs.map((name) => [
        name,
        `${execution.node.id}:${name}`,
      ]),
    ),
  };
}

export const passingRunner: BlockRunner = async (execution) =>
  passingResult(execution);
