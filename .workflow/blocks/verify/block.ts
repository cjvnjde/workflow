import { block, z } from "workflow";

export default block({
  name: "Write independent tests",
  async run(ctx) {
    const result = await ctx.ai({
      instructions:
        "Write focused tests proving the acceptance criteria. Do not change production code. If valid tests expose an implementation defect, publish feedback with the violated criterion and failure evidence and return retry to implementation. Do not weaken tests to pass. Return pass only when the criteria and checks pass.\nReturn outcome, summary and artifacts. Required artifacts on pass: feedback.",
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
