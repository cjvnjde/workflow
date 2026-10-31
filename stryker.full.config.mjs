import config from "./stryker.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...config,
  // Explicit opt-in: every mutant runs the complete runtime suite. The command
  // runner cannot select tests by coverage, so this can take days.
  commandRunner: {
    command: "bun run vitest run --project unit --project integration --bail 1",
  },
  buildCommand: "bun run build",
  mutate: ["src/**/*.ts", "web/**/*.ts", "!src/**/*.d.ts", "!src/legacy/**"],
  concurrency: 1,
  timeoutMS: 10000,
  dryRunTimeoutMinutes: 20,
  // The full repository still needs its own baseline before enforcing a score.
  thresholds: { high: 80, low: 60, break: 0 },
  htmlReporter: { fileName: "reports/mutation/full/index.html" },
  jsonReporter: { fileName: "reports/mutation/full/mutation.json" },
};
