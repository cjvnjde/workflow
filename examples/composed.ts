import { workflow, block, step, sequence, parallel, when, repeatUntil, z } from "workflow";

const implement = step(
  "implement",
  block({
    input: z.object({ feedback: z.string() }),
    async run(ctx) {
      return ctx.ai({
        model: ctx.models.coder ?? ctx.model,
        prompt: `${ctx.request}\nAddress this feedback: ${ctx.input.feedback}`,
        instructions:
          "Implement the request, add focused tests, and leave publication to later steps.",
      });
    },
  }),
  {
    maxVisits: 3,
    inputs: (ctx) => ({
      feedback: [
        ctx.output<{ feedback: string }>("review")?.feedback,
        ctx.output<{ feedback: string }>("tests")?.feedback,
      ]
        .filter(Boolean)
        .join("\n\n"),
    }),
  },
);

const tests = step(
  "tests",
  block({
    async run(ctx) {
      const result = await ctx.exec("bun test");
      const passed = result.exitCode === 0 && !result.timedOut;
      ctx.outcome(passed ? "pass" : "retry");
      ctx.summary(
        passed ? "Tests passed." : "Tests failed; returning diagnostics to implementation.",
      );
      return { passed, feedback: result.output };
    },
  }),
  { maxVisits: 3, on: { retry: "repeat" } },
);

const review = step(
  "review",
  block({
    async run(ctx) {
      const result = await ctx.ai({
        model: ctx.models.reviewer ?? ctx.model,
        instructions:
          "Review independently without editing. Inspect the current code and report actionable defects.",
        prompt: ctx.request,
        output: z.object({ approved: z.boolean(), feedback: z.string() }),
      });
      ctx.outcome(result.approved ? "pass" : "retry");
      ctx.summary(result.feedback);
      return result;
    },
  }),
  { maxVisits: 3, on: { retry: "continue" } },
);

const diff = step(
  "diff",
  block({
    async run(ctx) {
      const result = await ctx.exec("git diff --stat");
      ctx.artifact("diff-stat", result.output);
      return result.output;
    },
  }),
  { maxVisits: 3 },
);

const report = step(
  "report",
  block({
    input: z.object({ feedback: z.string() }),
    run(ctx) {
      return `## Review approved\n\n${ctx.input.feedback}`;
    },
  }),
  { inputs: (ctx) => ({ feedback: ctx.output(review)?.feedback ?? "" }) },
);

export default workflow({
  name: "Implement, verify and review",
  flow: sequence(
    repeatUntil("revision", {
      body: sequence(
        implement,
        tests,
        parallel([review, diff], {
          concurrency: 2,
          label: "Independent inspection",
        }),
      ),
      until: (ctx) => ctx.output(review)?.approved === true,
      maxIterations: 3,
    }),
    when("report-approved", (ctx) => ctx.output(review)?.approved === true, report),
  ),
});
