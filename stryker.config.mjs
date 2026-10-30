/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "command",
  commandRunner: {
    command: "bun test --timeout 30000 tests/*.test.ts",
  },
  // Build the instrumented sources once so CLI, worker and package tests use them too.
  buildCommand: "bun run build",
  coverageAnalysis: "off",
  mutate: ["src/**/*.ts", "web/**/*.ts", "!src/**/*.d.ts", "!src/legacy/**"],
  // Each runner executes integration tests with real local Temporal services.
  concurrency: 1,
  timeoutMS: 10000,
  dryRunTimeoutMinutes: 10,
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
  ],
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // Establish a baseline before introducing a score gate.
  thresholds: { high: 80, low: 60, break: 0 },
};
