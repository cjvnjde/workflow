import { block, z } from "workflow";

export default block({
  name: "Implement feature",
  async run(ctx) {
    const result = await ctx.ai({
      instructions:
        "Implement the agreed requirements. Read verification/review feedback and correct it. Preserve independent test expectations; put new verification into the test step. Update source, dependencies and configuration when the task requires it. Use the smallest coherent change and run relevant checks. Publish implementation with what changed and how each acceptance criterion is met. Return retry if unfinished.\nReturn outcome, summary and artifacts. Required artifacts on pass: implementation.",
      prompt: ctx.prompt + "\n\nInputs:\n" + JSON.stringify(ctx.input),
      output: z.object({
        outcome: z.enum(["pass", "retry", "fail"]),
        summary: z.string(),
        artifacts: z.object({ implementation: z.string() }).catchall(z.string()),
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
