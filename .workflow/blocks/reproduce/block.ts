import { block, z } from "workflow";

export default block({
  name: "Reproduce bug",
  async run(ctx) {
    const result = await ctx.ai({
      instructions:
        "Write a focused regression test that reproduces the reported bug. Do not edit production code. Run the configured check and confirm the failure is the reported behavior, not a syntax, setup, or unrelated failure. Publish reproduction with the test path and failure evidence. Return retry if you have not reproduced it. A nonzero exit alone is not proof of reproduction.\nReturn outcome, summary and artifacts. Required artifacts on pass: reproduction.",
      prompt: ctx.prompt + "\n\nInputs:\n" + JSON.stringify(ctx.input),
      output: z.object({
        outcome: z.enum(["pass", "retry", "fail"]),
        summary: z.string(),
        artifacts: z.object({ reproduction: z.string() }).catchall(z.string()),
      }),
    });
    if (result.outcome !== "fail") {
      const check = await ctx.exec("'bun' 'run' 'test'", { timeoutMs: 120000 });
      const matched = !check.timedOut && check.exitCode !== null && check.exitCode !== 0;
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
