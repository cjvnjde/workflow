import { workflow, script, z } from "workflow";

export default workflow({
  name: "Typed script result",
  input: z.object({ message: z.string(), runtime: z.enum(["bun", "node"]).default("bun") }),
  async run(ctx) {
    const result = await ctx.step("process", script({
      language: "typescript", runtime: ctx.input.runtime,
      output: z.object({ message: z.string(), runtime: z.string() }),
      code: `
import { readFileSync, writeFileSync } from "node:fs";
const context: { inputs: { message: string } } = JSON.parse(readFileSync(process.env.WORKFLOW_INPUT!, "utf8"));
const data = { message: context.inputs.message.toUpperCase(), runtime: process.versions.bun ? "Bun" : "Node" };
console.log(data);
writeFileSync(process.env.WORKFLOW_RESULT!, JSON.stringify({
  outcome: "pass", summary: "Message processed without an AI request",
  artifacts: { data: JSON.stringify(data) },
}));
`,
    }), { inputs: { message: ctx.input.message } });
    if (result.outcome !== "pass") throw new Error(result.summary);
    return result.data;
  },
});
