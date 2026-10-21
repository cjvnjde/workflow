import { block, z } from "workflow";

export default block({
  name: "Push current branch",
  async run(ctx) {
    const process = await ctx.exec(
      'bun --eval \'import { execFileSync } from "node:child_process";\nimport { readFileSync, writeFileSync } from "node:fs";\n\nconst preferredRemote = "";\nconst context = JSON.parse(readFileSync(process.env.WORKFLOW_INPUT, "utf8"));\nconst transcript = [];\nfunction git(args, allowMissing = false) {\n  console.log("$ git " + args.join(" "));\n  try {\n    const output = execFileSync("git", args, {\n      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],\n      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },\n    }).trim();\n    transcript.push("$ git " + args.join(" ") + "\\n" + output);\n    if (output) console.log(output);\n    return output;\n  } catch (error) {\n    if (allowMissing && error.status === 1) return "";\n    const detail = String(error.stderr || error.stdout || error.message).trim();\n    transcript.push(detail);\n    throw new Error(detail);\n  }\n}\nlet outcome = "pass";\nlet summary;\ntry {\n  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], true);\n  if (!branch) throw new Error("HEAD is detached. Check out the branch to publish.");\n  git(["rev-parse", "--verify", "refs/heads/" + branch]);\n  const upstreamRemote = git(["config", "--get", "branch." + branch + ".remote"], true);\n  const upstreamRef = git(["config", "--get", "branch." + branch + ".merge"], true);\n  const remotes = git(["remote"]).split("\\n").filter(Boolean);\n  const remote = preferredRemote ||\n    git(["config", "--get", "branch." + branch + ".pushRemote"], true) ||\n    git(["config", "--get", "remote.pushDefault"], true) ||\n    upstreamRemote || (remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : "");\n  if (!remote || !remotes.includes(remote))\n    throw new Error(remote ? \'\\\'\'Remote "\'\\\'\' + remote + \'\\\'\'" is not configured.\'\\\'\' : "No unambiguous push remote. Configure origin or set preferredRemote in this script.");\n  const destination = remote === upstreamRemote && upstreamRef ? upstreamRef : "refs/heads/" + branch;\n  if (!destination.startsWith("refs/heads/")) throw new Error("The upstream is not a branch.");\n  git(["check-ref-format", destination]);\n  git(["-c", "remote." + remote + ".mirror=false", "push", "--porcelain",\n    "--no-force", "--no-follow-tags", "--no-mirror", "--set-upstream", "--",\n    remote, "refs/heads/" + branch + ":" + destination]);\n  const commit = git(["rev-parse", "--verify", "refs/heads/" + branch]);\n  summary = "Pushed **" + branch + "** to **" + remote + "/" + destination.slice(11) +\n    "**.\\n\\nUpstream configured. Commit: " + commit;\n} catch (error) {\n  outcome = "retry";\n  summary = "Git push did not complete.\\n\\n" + error.message;\n}\nconst artifact = summary + "\\n\\n## Git activity\\n\\n" + transcript.join("\\n\\n").slice(-24000);\nwriteFileSync(process.env.WORKFLOW_RESULT, JSON.stringify({\n  outcome, summary,\n  artifacts: Object.fromEntries(context.outputs.map(name => [name, artifact])),\n}));\nif (outcome !== "pass") process.exitCode = 1;\n\'',
      { timeoutMs: 120000 },
    );
    const matched =
      !process.timedOut && process.exitCode !== null && process.exitCode === 0;
    const result = process.result ?? {
      outcome: matched ? ("pass" as const) : ("retry" as const),
      summary: process.output || "Command completed.",
      artifacts: Object.fromEntries(
        ["publication"].map((name) => [name, process.output]),
      ),
    };
    if (!matched && result.outcome === "pass") {
      result.outcome = "retry";
      result.summary += "\nCommand did not meet its exit condition.\n" + process.output;
    }
    ctx.outcome(result.outcome);
    ctx.summary(result.summary.slice(0, 16000));
    for (const [name, content] of Object.entries(result.artifacts)) {
      if (name !== "data" && name !== "summary")
        ctx.artifact(name, content.slice(0, 64000));
    }
    return result;
  },
});
