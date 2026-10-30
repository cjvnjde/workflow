import { workflow, block, z } from "workflow";

const model = z.object({
  provider: z.string().optional(),
  model: z.string(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
});
const implementation = block({
  input: z.object({ request: z.string(), feedback: z.string(), model: model.optional() }),
  async run(ctx) {
    const summary = await ctx.ai({
      model: ctx.input.model ?? ctx.model,
      instructions:
        "Implement the requested change. Address feedback and preserve unrelated work. Leave publication to later steps.",
      prompt: `${ctx.input.request}\n\nFeedback: ${ctx.input.feedback}`,
    });
    ctx.summary(summary);
    return summary;
  },
});
const tests = block({
  async run(ctx) {
    const result = await ctx.exec("bun test");
    const passed = result.exitCode === 0 && !result.timedOut;
    ctx.outcome(passed ? "pass" : "retry");
    ctx.summary(
      passed ? "Tests passed." : "Tests failed; returning diagnostics to implementation.",
    );
    ctx.artifact("test-output", result.output);
    return { passed, feedback: result.output };
  },
});
const review = block({
  input: z.object({ request: z.string(), tests: z.string(), model: model.optional() }),
  async run(ctx) {
    const result = await ctx.ai({
      model: ctx.input.model ?? ctx.model,
      instructions:
        "Review independently. Inspect code and test evidence, report actionable defects, and do not edit files.",
      prompt: `${ctx.input.request}\n\nTest evidence: ${ctx.input.tests}`,
      output: z.object({ approved: z.boolean(), feedback: z.string() }),
    });
    ctx.outcome(result.approved ? "pass" : "retry");
    ctx.summary(result.feedback);
    return result;
  },
});

export default workflow({
  name: "Implement, test and review",
  input: z.object({ request: z.string(), coder: model.optional(), reviewer: model.optional() }),
  async run(ctx) {
    let feedback = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      await ctx.step("implement", implementation, {
        inputs: { request: ctx.input.request, feedback, model: ctx.input.coder },
        maxVisits: 3,
      });
      const checked = await ctx.step("test", tests, { maxVisits: 3 });
      if (!checked.passed) {
        feedback = checked.feedback;
        continue;
      }
      const reviewed = await ctx.step("review", review, {
        inputs: { request: ctx.input.request, tests: checked.feedback, model: ctx.input.reviewer },
        maxVisits: 3,
      });
      if (reviewed.approved) return reviewed.feedback;
      feedback = reviewed.feedback;
    }
    throw new Error(`Verification did not pass after three attempts: ${feedback}`);
  },
});
