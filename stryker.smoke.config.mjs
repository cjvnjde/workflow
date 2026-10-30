import config from "./stryker.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...config,
  commandRunner: {
    command:
      "bun test --bail --timeout 5000 ./tests/usage-presentation.test.ts ./tests/engine-approval.test.ts",
  },
  mutate: [
    "web/features/usage/usage-presentation.ts:13-30",
    "src/core/engine.ts:544-569",
    "src/core/engine.ts:643-655",
  ],
  htmlReporter: { fileName: "reports/mutation-smoke/index.html" },
  jsonReporter: { fileName: "reports/mutation-smoke/mutation.json" },
  // Verify that approval guards and usage arithmetic/formatting detect every scoped mutant.
  thresholds: { high: 100, low: 100, break: 100 },
};
