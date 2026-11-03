import { workflow, block, z } from "workflow";

const verify = block({
  input: z.object({ command: z.string().default("bun install --frozen-lockfile && bun run test") }),
  async run(ctx) {
    const result = await ctx.exec(ctx.input.command, { timeoutMs: 600_000 });
    ctx.artifact("verification", result.output.slice(-60_000));
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error("Nightly verification failed; inspect verification artifact");
    return { passed: true, command: ctx.input.command };
  },
});
export default workflow({
  name: "Nightly saved verification",
  input: z.object({ command: z.string().default("bun install --frozen-lockfile && bun run test") }),
  async run(ctx) {
    return ctx.step("verify", verify, { inputs: ctx.input });
  },
});
