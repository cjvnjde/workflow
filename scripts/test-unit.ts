import { fileURLToPath } from "node:url";

// Keep CI build-free: these suites use source imports, in-memory doubles and
// disposable files, without starting Temporal, HTTP services or browsers.
const suites = [
  "activity",
  "budget",
  "composition-ownership",
  "decision-evidence",
  "domain",
  "engine-approval",
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
  "usage-presentation",
  "web-state",
];

const child = Bun.spawn(
  [process.execPath, "test", "--timeout", "5000", ...suites.map((name) => `tests/${name}.test.ts`)],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);
