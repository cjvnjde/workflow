import config from "./stryker.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...config,
  // Explicit opt-in: every mutant runs the complete integration suite. The Bun
  // command runner cannot select tests by coverage, so this can take days.
  commandRunner: { command: "bun test --bail --timeout 30000 ./tests/*.test.ts" },
  buildCommand: "bun run build",
  mutate: ["src/**/*.ts", "web/**/*.ts", "!src/**/*.d.ts", "!src/legacy/**"],
  concurrency: 1,
  timeoutMS: 10000,
  dryRunTimeoutMinutes: 20,
  htmlReporter: { fileName: "reports/mutation/full/index.html" },
  jsonReporter: { fileName: "reports/mutation/full/mutation.json" },
};
