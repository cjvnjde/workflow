import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Workspace } from "./workspace.js";

const execute = promisify(execFile);
const maxPatch = 60_000;

/** Fixed read-only operations. Never exposes a general Git command or raw metadata reader. */
export async function inspectGit(workspace: Workspace, input: { base?: string; path?: string } = {}, signal?: AbortSignal) {
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
  if (input.base && (!/^[a-zA-Z0-9][a-zA-Z0-9/_.~-]*$/.test(input.base) || input.base.length > 200)) {
    throw new Error("Base must be a local branch, tag, or commit ID, without options or revision expressions");
  }
  if (input.path && (input.path.startsWith("/") || input.path.split("/").some(part => part === "..") || input.path.includes("\0"))) {
    throw new Error("git_changes expects a repository-relative path; use bash for other Git operations");
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" });
  const prefix = ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "core.attributesFile=/dev/null", "-c", "diff.external=", "-c", "core.quotePath=false", "-c", "protocol.allow=never"];
  async function git(args: string[], optional = false) {
    signal?.throwIfAborted();
    try {
      const { stdout } = await execute("git", [...prefix, ...args], {
        cwd: workspace.root, env, encoding: "utf8", timeout: 8000, maxBuffer: 2_000_000, signal,
      });
      return stdout;
    } catch (error) {
      signal?.throwIfAborted();
      if (optional && error && typeof error === "object" && "code" in error && [1, 128].includes(error.code as number)) { return undefined; }
      // Git's stderr can contain config values or inaccessible paths.
      throw new Error("Read-only Git inspection failed or exceeded its output/time limit. Try a specific readable file path.");
    }
  }
  const root = (await git(["rev-parse", "--show-toplevel"], true))?.trim();
  if (!root || root !== workspace.root) {
    return { repository: false, reason: "The project root is not a Git working tree. No branch comparison is available." };
  }
  // Even a plain diff may invoke .gitattributes clean/process filters.
  // Override every configured filter before inspecting working-tree contents.
  const filterKeys = (await git(["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], true) ?? "").split("\0").filter(Boolean);
  for (const key of filterKeys) {
    prefix.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
  }
  const head = (await git(["rev-parse", "--verify", "HEAD"], true))?.trim() ?? null;
  const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], true))?.trim() ?? "(detached)";
  const notes: string[] = [];
  let base: string | null = null;
  let baseRef: string | null = null;
  if (input.base) {
    base = (await git(["rev-parse", "--verify", "--end-of-options", `${input.base}^{commit}`], true))?.trim() ?? null;
    if (!base) { throw new Error("The requested base is not an available local commit. No fetch was attempted."); }
    baseRef = input.base;
  } else if (head) {
    for (const ref of ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"]) {
      const name = (await git(["symbolic-ref", "--quiet", ref], true))?.trim() ?? ref;
      if (name === `refs/heads/${branch}` || name === `refs/remotes/origin/${branch}`) { continue; }
      const commit = (await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], true))?.trim();
      if (commit) { base = commit; baseRef = ref; break; }
    }
    if (base) notes.push(`Base inferred from ${baseRef}; supply base explicitly if the task intends another comparison.`);
  }
  const mergeBase = head && base ? (await git(["merge-base", head, base], true))?.trim() ?? null : null;
  if (!head) notes.push("This repository has no commits yet (unborn branch). There is no HEAD or branch/base diff. Review accessible working files only, or ask for a patch/base if branch-relative review is required.");
  else if (!mergeBase) notes.push("No branch comparison base is available. Working-tree changes are relative to HEAD; supply an explicit local base for branch-relative review.");
  const pathspec = input.path ? ["--", input.path] : [];
  const diffFlags = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--ignore-submodules=all"];
  let truncated = false;
  async function paths(args: string[]) {
    const names = (await git(args) ?? "").split("\0").filter(Boolean);
    if (names.length > 20_000) truncated = true;
    const allowed: string[] = [];
    for (const name of names.slice(0, 20_000)) {
      signal?.throwIfAborted();
      if (allowed.length < 200) allowed.push(name); else truncated = true;
    }
    return allowed;
  }
  const branchFiles = mergeBase && head ? await paths(["diff", ...diffFlags, "--name-only", "-z", mergeBase, head, ...pathspec]) : [];
  const workingFiles = head ? await paths(["diff", ...diffFlags, "--name-only", "-z", head, ...pathspec]) :
    await paths(["diff", "--cached", ...diffFlags, "--name-only", "-z", ...pathspec]);
  const untracked = await paths(["ls-files", "--others", "--exclude-standard", "-z", ...pathspec]);
  let remaining = maxPatch;
  async function patch(revisions: string[], files: string[]) {
    let output = "";
    for (const file of files) {
      if (remaining <= 0) { truncated = true; break; }
      const content = await git(["diff", ...diffFlags, "--src-prefix=a/", "--dst-prefix=b/", ...revisions, "--", file]) ?? "";
      output += content.slice(0, remaining);
      if (content.length > remaining) truncated = true;
      remaining = Math.max(0, remaining - content.length);
    }
    return output;
  }
  return {
    repository: true, branch, head, baseRef, base, mergeBase,
    changes: { branch: branchFiles, workingTree: workingFiles, untracked },
    branchPatch: mergeBase && head ? await patch([mergeBase, head], branchFiles) : "",
    workingTreePatch: await patch(head ? [head] : ["--cached"], workingFiles),
    notes, truncated,
    guidance: "Untracked file contents are not included; use read_file. If truncated, narrow the path or use bash. This summary does not run project hooks, filters or fetches. Use bash for Git configuration, staging, commits, remote inspection and pushes.",
  };
}
