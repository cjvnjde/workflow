// Run: bun examples/automations/bootstrap.ts http://127.0.0.1:3000 /absolute/project [owner/repository]
// The server must own that project. Definitions start disabled; enable deliberately in Scheduler.
// For GitHub, set GH_TOKEN in the server environment; only the name is stored in definitions.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowClient } from "../../src/client/client.js";
import { automation } from "../../src/sdk/automation-sdk.js";

const [baseUrl, project, repo] = process.argv.slice(2);
if (!baseUrl || !project)
  throw new Error(
    "Usage: bun examples/automations/bootstrap.ts <server-url> <project-path> [owner/repository]",
  );
const client = new WorkflowClient({ baseUrl });
const here = path.dirname(fileURLToPath(import.meta.url));
const destination = path.resolve(project, "examples/automations");
await mkdir(destination, { recursive: true });
for (const name of ["nightly.ts", "fixture.ts", "github.ts", "candidates.json"]) {
  const content = await readFile(path.join(here, name), "utf8");
  if (path.join(here, name) !== path.join(destination, name))
    await writeFile(path.join(destination, name), content);
}
async function template(name: string, source: string, input: Record<string, string> = {}) {
  const run = await client.createProgram({
    title: name,
    task: name,
    source,
    filename: `examples/automations/${name}.ts`,
    input,
  });
  return { kind: "workflow" as const, runId: run.id };
}
const nightly = await template("nightly", await readFile(path.join(here, "nightly.ts"), "utf8"));
const verification = await client.saveAutomation(
  automation({
    name: "Nightly verification",
    schedule: { kind: "cron", expression: "0 2 * * *", timezone: "UTC" },
    target: nightly,
    inputs: { command: "bun install --frozen-lockfile && bun run test" },
    execution: { maxModelCalls: 0 },
  }),
);
const fixture = await template("fixture", await readFile(path.join(here, "fixture.ts"), "utf8"));
const local = await client.saveAutomation(
  automation({
    name: "Local fixture candidates",
    schedule: { kind: "manual" },
    mode: "discovery",
    target: fixture,
    inputs: { candidates: JSON.parse(await readFile(path.join(here, "candidates.json"), "utf8")) },
    routes: [
      {
        id: "candidate",
        signalKind: "candidate",
        revisionPolicy: "advance",
        target: fixture,
        inputs: { operation: "handle" },
      },
    ],
    execution: { maxModelCalls: 0 },
  }),
);
const ids = [verification.id, local.id];
if (repo) {
  const target = async (operation: string) =>
    template(
      `github-${operation}`,
      `import {githubWorkflow} from "./github"; export default githubWorkflow(${JSON.stringify(operation)});`,
      { repo },
    );
  const discovery = await target("discover"),
    work = await target("work"),
    report = await target("report"),
    output = await target("publish"),
    reconcile = await target("reconcile");
  const github = await client.saveAutomation(
    automation({
      name: "GitHub issue and feedback example",
      schedule: { kind: "interval", seconds: 300 },
      mode: "discovery",
      target: discovery,
      inputs: {
        repo,
        label: "workflow-ready",
        testCommand: "bun install --frozen-lockfile && bun run test",
        testPaths: ["tests/**"],
        alert: { kind: "pull-request" },
      },
      execution: { environment: ["GH_TOKEN"], maxModelCalls: 0, maxCommands: 100, maxCostUsd: 1 },
      routes: [
        {
          id: "issues",
          signalKind: "issue-ready",
          revisionPolicy: "advance",
          target: work,
          execution: {
            environment: ["GH_TOKEN"],
            maxModelCalls: 10,
            maxCommands: 30,
            maxCostUsd: 5,
          },
        },
        {
          id: "ci",
          signalKind: "ci-failed",
          revisionPolicy: "current",
          target: work,
          execution: {
            environment: ["GH_TOKEN"],
            maxModelCalls: 10,
            maxCommands: 30,
            maxCostUsd: 5,
          },
        },
        {
          id: "review",
          signalKind: "review-changes",
          revisionPolicy: "current",
          target: work,
          execution: {
            environment: ["GH_TOKEN"],
            maxModelCalls: 10,
            maxCommands: 30,
            maxCostUsd: 5,
          },
        },
        {
          id: "checks-passed",
          signalKind: "checks-passed",
          revisionPolicy: "current",
          target: report,
          execution: { maxModelCalls: 0, maxCommands: 0, maxCostUsd: 1 },
        },
        { id: "checks-reported", signalKind: "checks-reported", revisionPolicy: "current" },
        { id: "published", signalKind: "published", revisionPolicy: "advance" },
        { id: "head", signalKind: "head-observed", revisionPolicy: "advance" },
      ],
      output: {
        target: output,
        reconcile,
        approval: "required",
        execution: { environment: ["GH_TOKEN"], maxModelCalls: 0, maxCommands: 10, maxCostUsd: 1 },
      },
      policy: {
        concurrency: 2,
        maxQueued: 20,
        maxCostUsd: 50,
        retry: { safe: "never", maxAttempts: 1, backoffSeconds: 30 },
      },
    }),
  );
  ids.push(github.id);
}
console.log(
  JSON.stringify(
    {
      automations: ids,
      enabled: false,
      next: "Inspect frozen targets, then enable or test in Scheduler. Approve publication jobs separately. Nothing merges automatically.",
    },
    null,
    2,
  ),
);
