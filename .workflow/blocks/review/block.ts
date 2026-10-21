import { block, z } from "workflow";

export default block({
  name: "Independent review",
  async run(ctx) {
    const result = await ctx.ai({
      instructions:
        "Independently inspect the relevant code, tests, and supplied artifacts. Do not modify files. For a branch review, inspect the comparison base first. If no commits or usable baseline exists, review accessible working files and state that findings are not branch-relative; do not treat the absent baseline alone as a blocker. Report concrete correctness defects with file locations and evidence in feedback. Return retry for actionable defects, fail for a blocker that prevents useful inspection, and pass only when the review scope is satisfied and checks pass. Do not invent issues to satisfy a quota.\nReturn outcome, summary and artifacts. Required artifacts on pass: feedback.",
      prompt: ctx.prompt + "\n\nInputs:\n" + JSON.stringify(ctx.input),
      output: z.object({
        outcome: z.enum(["pass", "retry", "fail"]),
        summary: z.string(),
        artifacts: z.object({ feedback: z.string() }).catchall(z.string()),
      }),
    });
    if (result.outcome !== "fail") {
      const check = await ctx.exec("'bun' 'run' 'test'", { timeoutMs: 120000 });
      const matched = !check.timedOut && check.exitCode !== null && check.exitCode === 0;
      result.artifacts["check-test"] = check.output;
      if (!matched) {
        result.outcome = "retry";
        result.summary += "\nVerification failed.\n" + check.output;
      }
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
