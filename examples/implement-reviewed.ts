import { workflow, agent, script, z } from "workflow";

const model = z.object({
  provider: z.string().optional(),
  model: z.string(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
});
const coder = agent({ instructions: "Implement the requested change. Use feedback and preserve unrelated work. Leave publication to later steps." });
const reviewer = agent({
  instructions: "Review the working-tree changes independently. Inspect code and test evidence. Report actionable defects; do not edit files.",
  output: z.object({ approved: z.boolean(), feedback: z.string() }),
});

export default workflow({
  name: "Implement, test and review",
  input: z.object({
    request: z.string(),
    coder: model.optional(),
    reviewer: model.optional(),
    check: z.string().default("bun test"),
  }),
  async run(ctx) {
    let feedback = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const implemented = await ctx.step("implement", coder, {
        prompt: ctx.input.request, model: ctx.input.coder, inputs: { feedback }, maxVisits: 3,
      });
      if (implemented.outcome !== "pass") { feedback = implemented.summary; continue; }
      const tests = await ctx.step("test", script({
        language: "bash", code: ctx.input.check, timeoutMs: 120_000,
      }), { prompt: "Verify the change without fixing it.", maxVisits: 3 });
      if (tests.outcome !== "pass") { feedback = tests.summary; continue; }
      const review = await ctx.step("review", reviewer, {
        prompt: ctx.input.request, model: ctx.input.reviewer,
        inputs: { implementation: implemented.summary, tests: tests.summary }, maxVisits: 3,
      });
      if (review.outcome === "pass" && review.data?.approved) return review.data.feedback;
      feedback = review.data?.feedback ?? review.summary;
    }
    throw new Error(`The change did not pass verification and review after three attempts.\n${feedback}`);
  },
});
