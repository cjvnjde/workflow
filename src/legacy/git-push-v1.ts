import type { BlockRunner } from "../block-runner.js";
import { runProcess } from "../process.js";

/** Compatibility for approved snapshots created before editable script blocks. */
export const runFunctionBlock: BlockRunner = async (execution) => {
  const executor = execution.bundle.definition.executor;
  if (executor?.kind !== "function") throw new Error("Function block has no function executor");
  const transcript: string[] = [];
  const deadline = Date.now() + 120_000;
  async function git(args: string[], allowMissing = false) {
    execution.signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Git push timed out.");
    const command = `git ${args.join(" ")}`;
    execution.emit("tool_start", command);
    const result = await runProcess(execution.project, ["git", ...args], execution.signal, remaining, {
      ...process.env, GIT_TERMINAL_PROMPT: "0",
    });
    transcript.push(`${command}\n${result.output.trim()}`);
    execution.emit("tool_end", `${command}: exit ${result.exitCode ?? "unknown"}\n${result.output}`);
    if (result.timedOut) throw new Error(`Git push timed out.\n${result.output}`);
    if (result.exitCode !== 0 && !(allowMissing && result.exitCode === 1))
      throw new Error(result.output.trim() || `${command} failed (exit ${result.exitCode}).`);
    return result.stdout.trim();
  }
  let summary: string;
  let outcome: "pass" | "retry" = "pass";
  try {
    execution.emit("function_start", "Push current branch · no model call");
    const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], true);
    if (!branch) throw new Error("HEAD is detached. Check out the branch to publish, then retry.");
    await git(["rev-parse", "--verify", `refs/heads/${branch}`]);
    const upstreamRemote = await git(["config", "--get", `branch.${branch}.remote`], true);
    const upstreamRef = await git(["config", "--get", `branch.${branch}.merge`], true);
    const remotes = (await git(["remote"])).split("\n").filter(Boolean);
    const remote = executor.remote ||
      await git(["config", "--get", `branch.${branch}.pushRemote`], true) ||
      await git(["config", "--get", "remote.pushDefault"], true) ||
      upstreamRemote || (remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined);
    if (!remote || !remotes.includes(remote))
      throw new Error(remote
        ? `Remote "${remote}" is not configured. Configure it or select an existing remote in this block.`
        : "No unambiguous push remote. Configure origin or select a configured remote in this block.");
    const destination = remote === upstreamRemote && upstreamRef ? upstreamRef : `refs/heads/${branch}`;
    if (!destination.startsWith("refs/heads/"))
      throw new Error("The upstream is not a branch. Select a remote for publishing the current branch.");
    await git(["check-ref-format", destination]);
    const output = await git([
      "-c", `remote.${remote}.mirror=false`, "push", "--porcelain", "--no-force", "--no-follow-tags", "--no-mirror",
      "--set-upstream", "--", remote, `refs/heads/${branch}:${destination}`,
    ]);
    const commit = await git(["rev-parse", "--verify", `refs/heads/${branch}`]);
    summary = `Pushed **${branch}** to **${remote}/${destination.slice("refs/heads/".length)}**.\n\n` +
      `Upstream configured. Commit: \`${commit}\`.\n\n${output ? `\`\`\`text\n${output}\n\`\`\`` : "Remote branch is up to date."}`;
  } catch (error) {
    execution.signal.throwIfAborted();
    outcome = "retry";
    summary = `Git push did not complete.\n\n${error instanceof Error ? error.message : String(error)}\n\nNo force push was attempted.`;
  }
  execution.emit("function_end", summary);
  const artifact = `${summary}\n\n## Git activity\n\n\`\`\`text\n${transcript.join("\n\n").slice(-24_000)}\n\`\`\``;
  return { outcome, summary: summary.slice(0, 16_000), artifacts: Object.fromEntries(
    execution.bundle.definition.outputs.map((name) => [name, artifact]),
  ) };
};
