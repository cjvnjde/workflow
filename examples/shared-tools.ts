import { workflow, block, defineTool, step, z } from "workflow";

const inspectFile = defineTool({
  name: "inspect_file",
  version: 1,
  description: "Read a project text file and count its lines.",
  replay: "safe",
  input: z.object({ path: z.string() }),
  output: z.object({ text: z.string(), lines: z.number().int() }),
  async execute({ path }, ctx) {
    const text = await ctx.env.readText(path);
    const lines = text.split("\n").length;
    ctx.details({ path, lines });
    return { text, lines };
  },
});

const reviewReadme = block({
  name: "Understand the project",
  async run(ctx) {
    const source = await ctx.call(inspectFile, { path: "README.md" });
    const review = await ctx.ai({
      role: "review",
      tools: [inspectFile],
      prompt: `Read README.md (${source.lines} lines). Summarize the project's purpose and report unclear setup instructions.`,
      output: z.object({
        summary: z.string(),
        unclearInstructions: z.array(z.string()),
      }),
    });
    ctx.summary(review.summary);
    return review;
  },
});

export default workflow({
  name: "Review README with shared tools",
  flow: step("review-readme", reviewReadme),
});
