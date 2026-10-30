import { block, parallel, sequence, step, workflow, z } from "workflow";

// These sample reports use ordinary TypeScript: running this example makes no
// model requests. Real report blocks can call ctx.ai and return the same shape.
const Report = z.object({ files: z.array(z.string()), tests: z.number() });
const frontend = step(
  "frontend",
  block({
    name: "Frontend report",
    output: Report,
    run() {
      return { files: ["ui.ts"], tests: 2 };
    },
  }),
);
const backend = step(
  "backend",
  block({
    name: "Backend report",
    output: Report,
    run() {
      return { files: ["api.ts"], tests: 3 };
    },
  }),
);
const combine = step(
  "combine",
  block({
    name: "Combine selected reports",
    input: z.object({ frontend: Report, backend: Report, title: z.string().trim() }),
    run(ctx) {
      const totalTests = ctx.input.frontend.tests + ctx.input.backend.tests;
      return {
        title: ctx.input.title,
        files: [...ctx.input.frontend.files, ...ctx.input.backend.files],
        totalTests,
      };
    },
  }),
  {
    // Each named input receives only the selected output, not the model's chat.
    inputs: (ctx) => ({
      frontend: ctx.output(frontend)!,
      backend: ctx.output(backend)!,
      title: "  Combined report  ",
    }),
  },
);

export default workflow({
  name: "Parallel reports with explicit handoffs",
  flow: sequence(parallel([frontend, backend]), combine),
});
