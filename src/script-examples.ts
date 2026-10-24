import type { ScriptExecutor } from "./script-schema.js";

// Starter source, copied into the user's editable block. There is no dispatch
// table or privileged operation: it runs through the same script runner.
export function pushScript(remote = ""): ScriptExecutor {
  return {
    kind: "script", language: "javascript", runtime: "bun", timeoutMs: 120_000, expect: "success",
    code: `import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const preferredRemote = ${JSON.stringify(remote)};
const context = JSON.parse(readFileSync(process.env.WORKFLOW_INPUT, "utf8"));
const transcript = [];
function git(args, allowMissing = false) {
  console.log("$ git " + args.join(" "));
  try {
    const output = execFileSync("git", args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
    transcript.push("$ git " + args.join(" ") + "\\n" + output);
    if (output) console.log(output);
    return output;
  } catch (error) {
    if (allowMissing && error.status === 1) return "";
    const detail = String(error.stderr || error.stdout || error.message).trim();
    transcript.push(detail);
    throw new Error(detail);
  }
}
let outcome = "pass";
let summary;
try {
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], true);
  if (!branch) throw new Error("HEAD is detached. Check out the branch to publish.");
  git(["rev-parse", "--verify", "refs/heads/" + branch]);
  const upstreamRemote = git(["config", "--get", "branch." + branch + ".remote"], true);
  const remotes = git(["remote"]).split("\\n").filter(Boolean);
  const remote = preferredRemote ||
    git(["config", "--get", "branch." + branch + ".pushRemote"], true) ||
    git(["config", "--get", "remote.pushDefault"], true) ||
    upstreamRemote || (remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : "");
  if (!remote || !remotes.includes(remote))
    throw new Error(remote ? 'Remote "' + remote + '" is not configured.' : "No unambiguous push remote. Configure origin or set preferredRemote in this script.");
  // A new feature branch can inherit origin/main as its fetch upstream.
  // Publish the current branch by name, never reinterpret that base as a target.
  const destination = "refs/heads/" + branch;
  git(["check-ref-format", destination]);
  git(["-c", "remote." + remote + ".mirror=false", "push", "--porcelain",
    "--no-force", "--no-follow-tags", "--no-mirror", "--set-upstream", "--",
    remote, "refs/heads/" + branch + ":" + destination]);
  const commit = git(["rev-parse", "--verify", "refs/heads/" + branch]);
  summary = "Pushed **" + branch + "** to **" + remote + "/" + destination.slice(11) +
    "**.\\n\\nUpstream configured. Commit: " + commit;
} catch (error) {
  outcome = "retry";
  summary = "Git push did not complete.\\n\\n" + error.message;
}
const artifact = summary + "\\n\\n## Git activity\\n\\n" + transcript.join("\\n\\n").slice(-24000);
writeFileSync(process.env.WORKFLOW_RESULT, JSON.stringify({
  outcome, summary,
  artifacts: Object.fromEntries(context.outputs.map(name => [name, artifact])),
}));
if (outcome !== "pass") process.exitCode = 1;
`,
  };
}
