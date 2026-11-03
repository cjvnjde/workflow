import { workflow, block, z, workSignal, discoveryResult } from "workflow";

const candidate = z.object({
  key: z.string(),
  revision: z.string(),
  title: z.string(),
  observedAt: z.string(),
});
const discover = block({
  input: z.object({ fixturePath: z.string(), candidates: z.array(candidate).optional() }),
  async run(ctx) {
    const candidates =
      ctx.input.candidates ??
      z.array(candidate).parse(JSON.parse(await ctx.readFile(ctx.input.fixturePath)));
    return discoveryResult({
      signals: candidates.map((value) =>
        workSignal({
          sourceId: "local-fixture",
          resourceKey: value.key,
          correlationKey: value.key,
          signalKind: "candidate",
          revision: value.revision,
          fingerprint: value.revision,
          observedAt: value.observedAt,
          payload: { title: value.title },
        }),
      ),
      checkpoint: { revisions: candidates.map(({ key, revision }) => ({ key, revision })) },
    });
  },
});
const handle = block({
  async run(ctx) {
    const signal = z
      .object({
        resourceKey: z.string(),
        revision: z.string(),
        payload: z.object({ title: z.string() }),
      })
      .parse(ctx.input.signal);
    // A real deterministic host effect, isolated in the case's managed worktree.
    await ctx.writeFile("automation-result.json", JSON.stringify(signal, null, 2));
    return { handled: signal.resourceKey, revision: signal.revision };
  },
});
export default workflow({
  name: "Local multi-candidate fixture",
  input: z.object({
    operation: z.enum(["discover", "handle"]).default("discover"),
    fixturePath: z.string().default("examples/automations/candidates.json"),
    candidates: z.array(candidate).optional(),
    signal: z.json().optional(),
  }),
  async run(ctx) {
    if (ctx.input.operation === "discover")
      return ctx.step("discover", discover, { inputs: ctx.input });
    return ctx.step("handle", handle, { inputs: ctx.input });
  },
});
