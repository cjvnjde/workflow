import { realpath } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process.js";

/** Only explicitly created sibling Git worktrees belong to this project's execution. */
export async function executionWorkspace(
  project: string,
  requested: string | undefined,
  signal: AbortSignal,
) {
  const root = await realpath(project);
  if (requested === undefined) return root;
  const target = await realpath(path.resolve(root, requested));
  if (target === root) return root;
  const git = async (cwd: string, args: string[]) => {
    const result = await runProcess(
      cwd,
      ["git", "rev-parse", ...args],
      signal,
      10_000,
    );
    if (result.exitCode !== 0)
      throw new Error(
        "Execution workspace must be a Git worktree of this project",
      );
    return result.stdout.trim();
  };
  const [common, other, top] = await Promise.all([
    git(root, ["--path-format=absolute", "--git-common-dir"]),
    git(target, ["--path-format=absolute", "--git-common-dir"]),
    git(target, ["--show-toplevel"]),
  ]);
  if (
    (await realpath(common)) !== (await realpath(other)) ||
    (await realpath(top)) !== target
  )
    throw new Error(
      "Execution workspace must be the root of a Git worktree of this project",
    );
  return target;
}
