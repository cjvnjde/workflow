import config from "./stryker.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...config,
  // This source-only test needs no distribution build or Temporal service.
  buildCommand: undefined,
  commandRunner: { command: "bun test --timeout 30000 tests/usage-presentation.test.ts" },
  mutate: ["web/features/usage/usage-presentation.ts:13-14"],
  htmlReporter: { fileName: "reports/mutation-smoke/index.html" },
  jsonReporter: { fileName: "reports/mutation-smoke/mutation.json" },
  // A broken mutant activation path would leave these arithmetic mutants alive.
  thresholds: { high: 100, low: 100, break: 100 },
};
