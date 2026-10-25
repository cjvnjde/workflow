import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";

// An integrity check, not an OS sandbox. Runtime/dependency trees are excluded.
const excluded = new Set([
  ".git",
  ".workflow",
  "node_modules",
  "dist",
  "test-results",
  "playwright-report",
]);
export class ProtectedPathsChangedError extends Error {}

export class ProtectedPaths {
  private before = new Map<string, string>();
  private constructor(
    readonly root: string,
    readonly patterns: string[],
  ) {}
  static async capture(root: string, patterns: string[]) {
    if (
      patterns.some(
        (pattern) =>
          !pattern ||
          pattern.startsWith("/") ||
          pattern.startsWith("!") ||
          pattern.includes("\\") ||
          pattern.split("/").includes(".."),
      )
    ) {
      throw new Error(
        "protectedPaths must contain project-relative positive globs without parent traversal",
      );
    }
    const guard = new ProtectedPaths(await realpath(root), patterns);
    guard.before = await guard.snapshot();
    return guard;
  }
  assertWritable(filename: string) {
    const relative = path
      .relative(this.root, filename)
      .split(path.sep)
      .join("/");
    if (this.matches(relative))
      throw new Error(
        `File belongs to another step: ${relative}. Return diagnostics to its owner instead of editing it.`,
      );
  }
  private matches(relative: string) {
    return this.patterns.some((pattern) =>
      minimatch(relative, pattern, { dot: true, nonegate: true }),
    );
  }
  private async snapshot() {
    const files = new Map<string, string>();
    let inspected = 0,
      bytes = 0;
    const walk = async (directory: string, prefix = "") => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++inspected > 100_000)
          throw new Error(
            "Protected-file scan exceeds 100000 entries; narrow the workspace before running.",
          );
        const relative = prefix + entry.name,
          absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!excluded.has(entry.name)) await walk(absolute, relative + "/");
        } else if (this.matches(relative)) {
          const info = await lstat(absolute);
          if (info.isSymbolicLink())
            files.set(relative, "link:" + (await readlink(absolute)));
          else if (info.isFile()) {
            bytes += info.size;
            if (bytes > 64_000_000)
              throw new Error("Protected-file scan exceeds 64 MB.");
            files.set(
              relative,
              `${info.mode}:` +
                createHash("sha256")
                  .update(await readFile(absolute))
                  .digest("hex"),
            );
          } else
            throw new Error(
              `Protected path is not a regular file: ${relative}`,
            );
        }
      }
    };
    await walk(this.root);
    return files;
  }
  async assertUnchanged() {
    const after = await this.snapshot();
    const changed = [...new Set([...this.before.keys(), ...after.keys()])]
      .filter((file) => this.before.get(file) !== after.get(file))
      .sort();
    if (changed.length)
      throw new ProtectedPathsChangedError(
        `Protected files changed: ${changed.join(", ")}. This step cannot pass. Shell/MCP changes were not automatically restored; review them and route corrections to the owning step.`,
      );
  }
}
