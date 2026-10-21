import { workflow, block, z } from "workflow";

const processMessage = block({
  input: z.object({ message: z.string(), runtime: z.enum(["bun", "node"]) }),
  output: z.object({ message: z.string(), runtime: z.string() }),
  async run(ctx) {
    // Pass data through an environment variable, not shell interpolation.
    const result = await ctx.exec(`${ctx.input.runtime} -e 'console.log(process.env.MESSAGE.toUpperCase())'`, {
      env: { MESSAGE: ctx.input.message },
    });
    if (result.exitCode !== 0 || result.timedOut) throw new Error(result.output);
    ctx.summary("Message processed without an AI request.");
    return { message: result.stdout.trim(), runtime: ctx.input.runtime };
  },
});

export default workflow({
  name: "Typed code result",
  input: z.object({ message: z.string(), runtime: z.enum(["bun", "node"]).default("bun") }),
  async run(ctx) {
    return await ctx.step("process", processMessage, { inputs: ctx.input });
  },
});
