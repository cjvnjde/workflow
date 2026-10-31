import { defineConfig } from "vitest/config";

// Build-free suites: no Temporal service, HTTP listener, browser, or dist imports.
const unitSuites = [
  "activity",
  "budget",
  "chat-visibility",
  "composition-ownership",
  "decision-evidence",
  "domain",
  "execution-evidence",
  "execution-presentation",
  "graph-layout",
  "protected-paths",
  "run-report",
  "runtime-evidence",
  "session-location",
  "session-timing",
  "source-format",
  "task-draft",
  "typecheck",
  "usage-presentation",
  "web-state",
].map((name) => `tests/${name}.test.ts`);

// Also build-free, but the engine imports Bun-native runtime dependencies.
const runtimeUnitSuites = ["tests/engine-approval.test.ts"];

const runtime = {
  environment: "node" as const,
  pool: "forks" as const,
  fileParallelism: false,
  hookTimeout: 30_000,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...runtime,
          name: "unit",
          include: unitSuites,
          testTimeout: 5_000,
        },
      },
      {
        test: {
          ...runtime,
          name: "runtime-unit",
          include: runtimeUnitSuites,
          testTimeout: 5_000,
        },
      },
      {
        test: {
          ...runtime,
          name: "integration",
          include: ["tests/*.test.ts"],
          exclude: [...unitSuites, ...runtimeUnitSuites],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
