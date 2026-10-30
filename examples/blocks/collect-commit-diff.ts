import { block, z } from "workflow";

export default block({
  name: "Collect commit diff",
  input: z.object({ source: z.enum(["staged", "unstaged"]).default("staged") }),
  output: z.object({ diff: z.string(), context: z.string() }),
  async run(ctx) {
    const staged = ctx.input.source === "staged" ? " --cached" : "";
    const result = await ctx.exec(
      "git --no-pager diff --no-ext-diff --no-textconv --no-color" + staged,
      { timeoutMs: 15000 },
    );
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error("Could not collect the selected Git diff: " + result.output);
    if (!result.stdout.trim())
      throw new Error(
        "The selected " +
          ctx.input.source +
          " diff is empty. Nothing was staged or changed by this block.",
      );
    if (result.stdout.length > 24000)
      throw new Error(
        "The diff is too large for one focused commit message. Select a smaller change; the diff was not truncated.",
      );
    ctx.disposition("work-completed");
    ctx.summary(
      "Collected " + ctx.input.source + " tracked changes; untracked files are excluded.",
    );
    return {
      diff: result.stdout,
      context:
        "Source: " +
        ctx.input.source +
        " tracked Git diff. Untracked files are excluded. No test execution is implied.",
    };
  },
});
