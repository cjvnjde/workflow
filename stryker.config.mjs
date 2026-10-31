/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "command",
  commandRunner: {
    // Approval tests import the Bun application runtime; retain both unit projects.
    command:
      "bun node_modules/vitest/vitest.mjs run --project unit --project runtime-unit --bail 1 tests/budget.test.ts tests/engine-approval.test.ts tests/usage-presentation.test.ts",
  },
  coverageAnalysis: "off",
  // Match the source scope to the focused tests above. These tests need no build,
  // browser or Temporal service; the optional full sweep has its own config.
  mutate: [
    "src/core/execution/budget.ts",
    "src/core/engine.ts:544-569",
    "src/core/engine.ts:643-655",
    "web/features/usage/usage-presentation.ts:13-30",
  ],
  concurrency: 2,
  timeoutMS: 3000,
  dryRunTimeoutMinutes: 1,
  ignorePatterns: [
    ".workflow",
    ".agents",
    ".codex",
    ".aws",
    "dist",
    "coverage",
    "reports",
    "test-results",
    "playwright-report",
    ".vitest",
  ],
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // Guard the focused scope against new survivors. Equivalent budget mutants
  // have narrowly scoped source comments and remain visible as ignored.
  thresholds: { high: 100, low: 100, break: 100 },
};
