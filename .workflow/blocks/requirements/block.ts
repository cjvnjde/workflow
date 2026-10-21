import { block, z } from "workflow";

export default block({
  name: "Define requirements",
  async run(ctx) {
    const result = await ctx.ai({
      instructions:
        "Read the project and task. Produce concise, testable acceptance criteria and relevant constraints. Do not modify files. Publish a requirements artifact. If the task cannot be specified safely, return fail with the questions that must be answered.\nReturn outcome, summary and artifacts. Required artifacts on pass: requirements.",
      prompt: ctx.prompt + "\n\nInputs:\n" + JSON.stringify(ctx.input),
      output: z.object({
        outcome: z.enum(["pass", "retry", "fail"]),
        summary: z.string(),
        artifacts: z.object({ requirements: z.string() }).catchall(z.string()),
      }),
    });
    ctx.outcome(result.outcome);
    ctx.summary(result.summary.slice(0, 16000));
    for (const [name, content] of Object.entries(result.artifacts)) {
      if (name !== "data" && name !== "summary")
        ctx.artifact(name, content.slice(0, 64000));
    }
    return result;
  },
});
