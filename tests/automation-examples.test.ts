import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";
import { mkdir, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fixture, passingRunner } from "./helpers.js";
import { WorkflowEngine } from "../src/core/engine.js";
import { automation, workSignal, discoveryResult } from "../src/sdk/automation-sdk.js";
import {
  boundedJSONSchema,
  discoveryResultSchema,
  workSignalSchema,
} from "../src/contracts/automation-signal-schema.js";
import { codeOperationSchema } from "../src/contracts/code-schema.js";
import type { ExecutionEnvironment } from "../src/sdk/tool-sdk.js";
import { Automations } from "../src/core/automations/automations.js";
import { waitForRun } from "../src/client/client.js";
import { runProcess } from "../src/infrastructure/process.js";
import type { BlockResult } from "../src/contracts/domain.js";

const instant = "2026-11-03T00:00:00Z";
const sha = "a".repeat(40);
const signal = () =>
  workSignal({
    sourceId: "fixture",
    resourceKey: "one",
    signalKind: "changed",
    revision: "1",
    fingerprint: "one:1",
    observedAt: instant,
  });
const commandResult = (value: unknown, exitCode = 0) => ({
  exitCode,
  timedOut: false,
  stdout: JSON.stringify(value),
  stderr: "",
  output: JSON.stringify(value),
});

/** Decode only the example's quoted nonsecret locals for a fake remote environment. */
function exampleExec(callback: ExecutionEnvironment["exec"]): ExecutionEnvironment["exec"] {
  return async (source, options) => {
    const parameters: Record<string, string> = {};
    let match: RegExpExecArray | null;
    while ((match = /^([A-Z_]+)='((?:[^']|'\\'')*)';\n/.exec(source))) {
      parameters[match[1]!] = match[2]!.replaceAll("'\\''", "'");
      source = source.slice(match[0].length);
    }
    return callback(source, { ...options, env: parameters });
  };
}

async function scheduledExample(
  engine: WorkflowEngine,
  target: string,
  cleanup: (action: () => Promise<unknown>) => void,
) {
  const scheduler = await Automations.open(engine);
  cleanup(() => scheduler.close());
  const definition = await scheduler.save({
    config: automation({
      name: "Executable SDK example",
      enabled: true,
      schedule: { kind: "manual" },
      target: { kind: "workflow", runId: target },
      execution: { workspace: "project", environment: [], maxCommands: 100 },
    }),
  });
  const job = await scheduler.action(definition.id, "run-now");
  assert.ok("runId" in job);
  const run = await waitForRun(() => engine.get(job.runId), {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(run.automation?.automationId, definition.id);
  assert.equal(run.automation?.workspace, "project");
  assert.equal(run.status, "completed", run.error ?? "");
  await scheduler.tick();
  return run;
}

test("authoring helpers validate and normalize generic definitions, signals and bounded durable JSON", () => {
  const definition = automation({
    name: "Saved nightly",
    schedule: { kind: "cron", expression: "0 2 * * *", timezone: "UTC" },
    target: { kind: "block", blockId: "verify" },
  });
  assert.equal(definition.enabled, false);
  assert.equal(definition.execution.workspace, "worktree");
  assert.equal(definition.policy.retry.safe, "never");
  assert.deepEqual(signal().payload, {});
  assert.deepEqual(discoveryResult({ signals: [signal()], checkpoint: { cursor: 2 } }).checkpoint, {
    cursor: 2,
  });
  assert.throws(() => workSignal({ ...signal(), revision: "" }));
  assert.throws(() => automation({ ...definition, mode: "discovery", routes: [] }));
  assert.throws(() => boundedJSONSchema.parse("x".repeat(256_001)));
  assert.throws(() => boundedJSONSchema.parse({ number: Infinity }));
  assert.equal(codeOperationSchema.parse({ kind: "signal", signal: signal() }).kind, "signal");
});

test("nightly and multi-candidate examples execute the shipped source without models", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const candidates = await readFile("examples/automations/candidates.json", "utf8");
  const files = new Map<string, string>();
  const commands: string[] = [];
  const engine = new WorkflowEngine(
    project,
    "live",
    async () => {
      throw new Error("No model expected");
    },
    {},
    async () => ({
      id: "fixture-world",
      readText: async () => candidates,
      writeText: async (name, value) => {
        files.set(name, value);
      },
      exec: async (command) => {
        commands.push(command);
        return commandResult("verified");
      },
    }),
  );
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const run = async (
    name: string,
    input: Record<string, z.infer<typeof boundedJSONSchema>> = {},
  ) => {
    const draft = await engine.createProgram(
      name,
      name,
      { source: await readFile(`examples/automations/${name}.ts`, "utf8"), input },
      library,
    );
    await engine.approve(draft.id);
    await engine.waitForIdle();
    const completed = engine.get(draft.id);
    assert.equal(completed.status, "completed", completed.error ?? "");
    return completed;
  };
  const nightly = await run("nightly", { command: "printf verified" });
  assert.deepEqual(nightly.outputValue, { passed: true, command: "printf verified" });
  assert.deepEqual(commands, ["printf verified"]);
  const discovery = discoveryResultSchema.parse((await run("fixture")).outputValue);
  assert.equal(discovery.signals.length, 3);
  assert.equal(new Set(discovery.signals.map((item) => item.resourceKey)).size, 3);
  const handled = await run("fixture", { operation: "handle", signal: discovery.signals[1]! });
  assert.deepEqual(handled.outputValue, { handled: "candidate-b", revision: "3" });
  assert.equal(JSON.parse(files.get("automation-result.json")!).resourceKey, "candidate-b");
});

test("GitHub user-code discovery maps fake external issues, current CI and review feedback into generic signals", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const commands: string[] = [];
  const pr = {
    number: 7,
    body: "<!-- workflow-case:issue:42 -->",
    headRefOid: sha,
    headRefName: "automation/42",
    updatedAt: instant,
    url: "https://github.com/acme/project/pull/7",
  };
  const engine = new WorkflowEngine(project, "live", passingRunner, {}, async () => ({
    id: "fake-github",
    readText: async () => {
      throw new Error("Unexpected file read");
    },
    writeText: async () => {
      throw new Error("Discovery must not write");
    },
    exec: exampleExec(async (command, options) => {
      commands.push(command);
      assert.equal(options?.env?.AUTOMATION_REPO, "acme/project");
      assert.ok(!command.includes("SECRET_TOKEN"));
      if (command.startsWith("gh issue list"))
        return commandResult([
          {
            number: 42,
            title: "Fix first",
            body: "Acceptance one",
            updatedAt: instant,
            url: "https://github.com/acme/project/issues/42",
          },
          {
            number: 43,
            title: "Fix second",
            body: "Acceptance two",
            updatedAt: instant,
            url: "https://github.com/acme/project/issues/43",
          },
        ]);
      if (command.startsWith("gh pr list")) return commandResult([pr]);
      if (command.includes("check-runs"))
        return commandResult({
          check_runs: [
            {
              id: 3,
              conclusion: "failure",
              completed_at: instant,
              html_url: "https://example.test/check/3",
              name: "tests",
            },
          ],
        });
      if (command.includes("reviews"))
        return commandResult([
          {
            id: 4,
            state: "CHANGES_REQUESTED",
            commit_id: sha,
            submitted_at: instant,
            body: "Handle empty input",
            html_url: "https://example.test/review/4",
          },
          {
            id: 5,
            state: "CHANGES_REQUESTED",
            commit_id: "b".repeat(40),
            submitted_at: instant,
            body: "Obsolete",
            html_url: "https://example.test/review/5",
          },
        ]);
      throw new Error(`Unexpected command ${command}`);
    }),
  }));
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const draft = await engine.createProgram(
    "GitHub discovery",
    "Poll external fixture",
    {
      source: await readFile("examples/automations/github.ts", "utf8"),
      input: { repo: "acme/project" },
    },
    library,
  );
  const run = await scheduledExample(engine, draft.id, cleanup);
  const output = discoveryResultSchema.parse(run.outputValue);
  assert.deepEqual(
    output.signals.map((item) => item.signalKind),
    ["issue-ready", "head-observed", "ci-failed", "review-changes"],
  );
  assert.equal(output.signals[0]!.resourceKey, "issue:43");
  assert.equal(output.signals[2]!.correlationKey, output.signals[1]!.correlationKey);
  assert.equal(output.signals[2]!.revision, sha);
  assert.equal(output.signals[3]!.fingerprint, "review:4");
  assert.equal(commands.length, 4);
});

test("publication reconciles the stable marker before any remote write and emits current case references", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await mkdir(path.join(project, "examples/automations"), { recursive: true });
  await copyFile(
    "examples/automations/github.ts",
    path.join(project, "examples/automations/github.ts"),
  );
  const key = "workflow-automation:11111111-1111-4111-8111-111111111111";
  const commands: string[] = [];
  const engine = new WorkflowEngine(project, "live", passingRunner, {}, async () => ({
    id: "existing-publication",
    readText: async () => {
      throw new Error("Unexpected read");
    },
    writeText: async () => {
      throw new Error("Unexpected write");
    },
    exec: exampleExec(async (command) => {
      commands.push(command);
      assert.ok(
        command.startsWith("gh pr list"),
        "Existing publication must not push or create again",
      );
      return commandResult([
        {
          number: 7,
          body: `<!-- workflow-case:issue:42 -->\n<!-- ${key} -->`,
          headRefOid: sha,
          headRefName: "automation/42",
          updatedAt: instant,
          url: "https://github.com/acme/project/pull/7",
        },
      ]);
    }),
  }));
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const draft = await engine.createProgram(
    "Reconcile publication",
    "Reconcile before publishing",
    {
      filename: "examples/automations/publish.ts",
      source: 'import {githubWorkflow} from "./github";export default githubWorkflow("publish");',
      input: {
        repo: "acme/project",
        automation: { publicationKey: key },
        result: { approved: true, issue: 42, commit: sha },
      },
    },
    library,
  );
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.equal(commands.length, 1);
  const output = z
    .object({ published: z.boolean(), signals: z.array(workSignalSchema) })
    .parse(run.outputValue);
  assert.equal(output.published, true);
  assert.equal(output.signals[0]!.revision, sha);
  assert.equal(output.signals[0]!.references.head, sha);
});

test("emitSignal uses the durable service hook and full workflow output is independent of Markdown previews", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const destination = "11111111-1111-4111-8111-111111111111";
  const seen: unknown[] = [];
  engine.setSignalHandler(async (id, observation) => {
    seen.push({ id, observation });
  });
  const draft = await engine.createProgram(
    "Signal",
    "Emit observation",
    {
      source: `
    import {workflow,block} from "workflow";
    const emit=block({async run(ctx){await ctx.emitSignal(${JSON.stringify(signal())},{automationId:${JSON.stringify(destination)}});return {ok:true};}});
    export default workflow({name:"Signal",async run(ctx){await ctx.step("emit",emit);return {text:"x".repeat(70000),count:7};}});
  `,
    },
    library,
  );
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.deepEqual(seen, [{ id: destination, observation: signal() }]);
  assert.equal(z.object({ text: z.string() }).parse(run.outputValue).text.length, 70_000);
  assert.equal(run.output!.length, 64_000);
});

test("GitHub implementation uses bounded repair, independent review and retains a commit without publishing", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await mkdir(path.join(project, "examples/automations"), { recursive: true });
  await copyFile(
    "examples/automations/github.ts",
    path.join(project, "examples/automations/github.ts"),
  );
  const prompts: string[] = [];
  const commands: string[] = [];
  let checks = 0;
  const engine = new WorkflowEngine(
    project,
    "live",
    async (execution): Promise<BlockResult> => {
      const prompt = execution.inputs["call-prompt"] ?? "";
      prompts.push(prompt);
      if (prompt.startsWith("Independently review")) {
        assert.deepEqual(execution.protectedPaths, ["**/*"]);
        assert.equal(execution.context, "none");
        return {
          outcome: "pass",
          summary: "Reviewed",
          artifacts: {
            data: JSON.stringify({ approved: true, feedback: "Focused regression passes" }),
          },
        };
      }
      if (prompt.startsWith("Write focused regression"))
        assert.deepEqual(execution.writablePaths, ["tests/**"]);
      if (prompt.startsWith("Repair production"))
        assert.deepEqual(execution.protectedPaths, ["tests/**"]);
      return { outcome: "pass", summary: "Completed selected work", artifacts: {} };
    },
    {},
    async () => ({
      id: "implementation-fixture",
      readText: async () => {
        throw new Error("Unexpected direct read");
      },
      writeText: async () => {
        throw new Error("Unexpected direct write");
      },
      exec: exampleExec(async (command) => {
        commands.push(command);
        assert.ok(!command.includes("git push") && !command.includes("gh pr create"));
        if (command.startsWith("gh issue view"))
          return commandResult({
            title: "Handle empty input",
            body: "Return an empty list",
            url: "https://example.test/42",
          });
        if (command === "fixture-tests")
          return commandResult(
            checks++ === 0 ? "Expected empty list" : "Passed",
            checks === 1 ? 1 : 0,
          );
        if (command.startsWith("git add"))
          return { ...commandResult(null), stdout: sha, output: sha };
        throw new Error(`Unexpected command ${command}`);
      }),
    }),
  );
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const draft = await engine.createProgram(
    "Implement issue",
    "Bounded work",
    {
      filename: "examples/automations/work.ts",
      source: 'import {githubWorkflow} from "./github";export default githubWorkflow("work");',
      input: {
        repo: "acme/project",
        testCommand: "fixture-tests",
        signal: { ...signal(), payload: { issue: 42 } },
      },
    },
    library,
  );
  const run = await scheduledExample(engine, draft.id, cleanup);
  assert.deepEqual(run.outputValue, {
    approved: true,
    issue: 42,
    commit: sha,
    baseRevision: null,
    feedback: "Focused regression passes",
  });
  assert.equal(checks, 2);
  assert.equal(prompts.length, 4);
  assert.ok(prompts[2]!.startsWith("Repair production"));
  assert.ok(prompts[3]!.startsWith("Independently review"));
  assert.equal(commands.length, 4);
});

test("structured composition retains final typed discovery output independently of its summary", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const engine = new WorkflowEngine(project, "live", passingRunner);
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const expected = { signals: [signal()], checkpoint: { cursor: "next" } };
  const draft = await engine.createProgram(
    "Structured discovery",
    "Discover",
    {
      source: `import {workflow,block,step,sequence} from "workflow";
      const scan=block({run(ctx){ctx.summary("Human summary, not machine JSON");return ${JSON.stringify(expected)};}});
      export default workflow({name:"Structured discovery",flow:sequence(step("scan",scan))});`,
    },
    library,
  );
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.equal(run.output, "Human summary, not machine JSON");
  assert.deepEqual(run.outputValue, expected);
});

test("new publication pushes only the verified commit then creates a marked PR, never a merge", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await mkdir(path.join(project, "examples/automations"), { recursive: true });
  await copyFile(
    "examples/automations/github.ts",
    path.join(project, "examples/automations/github.ts"),
  );
  const key = "workflow-automation:11111111-1111-4111-8111-111111111111";
  const commands: string[] = [];
  let body = "";
  let branch = "";
  const engine = new WorkflowEngine(project, "live", passingRunner, {}, async () => ({
    id: "new-publication",
    readText: async () => {
      throw new Error("Unexpected read");
    },
    writeText: async () => {
      throw new Error("Unexpected write");
    },
    exec: exampleExec(async (command, options) => {
      commands.push(command);
      assert.ok(!command.includes("merge") && !command.includes("--force "));
      if (command.startsWith("gh pr list")) {
        branch = options?.env?.AUTOMATION_BRANCH ?? "";
        return commandResult([]);
      }
      assert.equal(commands[0]!.startsWith("gh pr list"), true);
      if (command.startsWith("git push")) {
        assert.equal(options?.env?.AUTOMATION_COMMIT, sha);
        assert.equal(options?.env?.AUTOMATION_BRANCH, branch);
        assert.equal(options?.env?.AUTOMATION_EXPECTED_HEAD, "");
        assert.ok(
          command.includes(
            '--force-with-lease="refs/heads/$AUTOMATION_BRANCH:$AUTOMATION_EXPECTED_HEAD"',
          ),
        );
        return commandResult("pushed");
      }
      if (command.startsWith("gh pr create")) {
        body = options?.env?.AUTOMATION_BODY ?? "";
        assert.ok(body.includes(`<!-- ${key} -->`));
        assert.ok(body.includes("<!-- workflow-case:issue:42 -->"));
        return commandResult("https://github.com/acme/project/pull/7");
      }
      if (command.startsWith("gh pr view"))
        return commandResult({
          number: 7,
          body,
          headRefOid: sha,
          headRefName: branch,
          updatedAt: instant,
          url: "https://github.com/acme/project/pull/7",
        });
      throw new Error(`Unexpected command ${command}`);
    }),
  }));
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const draft = await engine.createProgram(
    "Publish verified commit",
    "Separate approved publication",
    {
      filename: "examples/automations/publish.ts",
      source: 'import {githubWorkflow} from "./github";export default githubWorkflow("publish");',
      input: {
        repo: "acme/project",
        automation: { publicationKey: key },
        result: { approved: true, issue: 42, commit: sha },
      },
    },
    library,
  );
  await engine.approve(draft.id);
  await engine.waitForIdle();
  const run = engine.get(draft.id);
  assert.equal(run.status, "completed", run.error ?? "");
  assert.equal(commands.length, 4);
  assert.equal(z.object({ published: z.boolean() }).parse(run.outputValue).published, true);
});

test("feedback work restores the exact observed SHA instead of stale retained case references", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await mkdir(path.join(project, "examples/automations"), { recursive: true });
  await copyFile(
    "examples/automations/github.ts",
    path.join(project, "examples/automations/github.ts"),
  );
  const current = "b".repeat(40),
    committed = "c".repeat(40);
  let restored = false;
  const engine = new WorkflowEngine(
    project,
    "live",
    async (execution): Promise<BlockResult> => {
      assert.ok(restored, "Restore the observed revision before any model works");
      return execution.inputs["call-prompt"]?.startsWith("Independently review")
        ? {
            outcome: "pass",
            summary: "Reviewed",
            artifacts: {
              data: JSON.stringify({
                approved: true,
                feedback: "Accepted current revision repair",
              }),
            },
          }
        : { outcome: "pass", summary: "Implemented", artifacts: {} };
    },
    {},
    async (options) => ({
      id: "current-revision-world",
      readText: async () => {
        throw new Error("Unexpected read");
      },
      writeText: async () => {
        throw new Error("Unexpected write");
      },
      exec: exampleExec(async (command, settings) => {
        assert.equal(options.project, project);
        if (command.startsWith("gh issue view"))
          return commandResult({ title: "Issue", body: "Repair", url: "https://example.test/42" });
        if (command.startsWith("test -z")) {
          assert.equal(settings?.env?.AUTOMATION_HEAD, current);
          assert.ok(command.includes('test "$(git rev-parse FETCH_HEAD)" = "$AUTOMATION_HEAD"'));
          assert.ok(command.includes('git reset --hard "$AUTOMATION_HEAD"'));
          assert.ok(!command.includes("worktree") && !command.includes("git -C"));
          restored = true;
          return commandResult("restored");
        }
        if (command === "fixture-tests") return commandResult("passed");
        if (command.startsWith("git add"))
          return { ...commandResult(null), stdout: committed, output: committed };
        throw new Error(`Unexpected command ${command}`);
      }),
    }),
  );
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const draft = await engine.createProgram(
    "Current feedback",
    "Repair current PR revision",
    {
      filename: "examples/automations/work.ts",
      source: 'import {githubWorkflow} from "./github";export default githubWorkflow("work");',
      input: {
        repo: "acme/project",
        testCommand: "fixture-tests",
        signal: { ...signal(), signalKind: "ci-failed", revision: current, payload: { issue: 42 } },
        case: { currentRevision: current, references: { head: sha } },
      },
    },
    library,
  );
  const run = await scheduledExample(engine, draft.id, cleanup);
  assert.equal(z.object({ baseRevision: z.string() }).parse(run.outputValue).baseRevision, current);
});

test("scheduler separately approves example publication and reconciles an uncertain remote acceptance without replay", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await mkdir(path.join(project, "examples/automations"), { recursive: true });
  await copyFile(
    "examples/automations/github.ts",
    path.join(project, "examples/automations/github.ts"),
  );
  let published:
    | {
        number: number;
        body: string;
        headRefOid: string;
        headRefName: string;
        updatedAt: string;
        url: string;
      }
    | undefined;
  let pushes = 0,
    creates = 0;
  const engine = new WorkflowEngine(project, "live", passingRunner, {}, async () => ({
    id: "uncertain-remote-publication",
    readText: async () => {
      throw new Error("Unexpected file read");
    },
    writeText: async () => {
      throw new Error("Unexpected file write");
    },
    exec: exampleExec(async (command, options) => {
      if (command.startsWith("gh pr list")) return commandResult(published ? [published] : []);
      if (command.startsWith("git push")) {
        pushes++;
        assert.equal(options?.env?.AUTOMATION_EXPECTED_HEAD, "");
        return commandResult("pushed");
      }
      if (command.startsWith("gh pr create")) {
        creates++;
        published = {
          number: 7,
          body: options?.env?.AUTOMATION_BODY ?? "",
          headRefOid: sha,
          headRefName: options?.env?.AUTOMATION_BRANCH ?? "",
          updatedAt: instant,
          url: "https://github.com/acme/project/pull/7",
        };
        // Remote acceptance happened, but the command's connection failed before confirmation.
        return commandResult("Connection lost after remote accepted publication", 1);
      }
      throw new Error(`Unexpected command ${command}`);
    }),
  }));
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const work = await engine.createProgram(
    "Verified work",
    "Retain verified result",
    {
      source: `import {workflow,block} from "workflow";const result=block({run(){return {approved:true,issue:42,commit:${JSON.stringify(sha)}};}});export default workflow({name:"Verified",async run(ctx){return ctx.step("result",result);}});`,
    },
    library,
  );
  const output = await engine.createProgram(
    "Output",
    "Publish separately",
    {
      filename: "examples/automations/publish.ts",
      source: 'import {githubWorkflow} from "./github";export default githubWorkflow("publish");',
      input: { repo: "acme/project" },
    },
    library,
  );
  const reconcile = await engine.createProgram(
    "Reconcile",
    "Inspect remote only",
    {
      filename: "examples/automations/reconcile.ts",
      source: 'import {githubWorkflow} from "./github";export default githubWorkflow("reconcile");',
      input: { repo: "acme/project" },
    },
    library,
  );
  const scheduler = await Automations.open(engine);
  cleanup(() => scheduler.close());
  const definition = await scheduler.save({
    config: automation({
      name: "Uncertain example publication",
      enabled: true,
      schedule: { kind: "manual" },
      target: { kind: "workflow", runId: work.id },
      inputs: { repo: "acme/project" },
      execution: { workspace: "project", environment: [], maxModelCalls: 0, maxCommands: 10 },
      output: {
        target: { kind: "workflow", runId: output.id },
        reconcile: { kind: "workflow", runId: reconcile.id },
        approval: "required",
      },
      routes: [{ id: "published", signalKind: "published", revisionPolicy: "advance" }],
    }),
  });
  const job = await scheduler.action(definition.id, "run-now");
  assert.ok("runId" in job);
  await waitForRun(() => engine.get(job.runId), { signal: AbortSignal.timeout(20_000) });
  await scheduler.tick();
  const publication = scheduler.state().jobs.find((candidate) => candidate.phase === "output")!;
  assert.ok(publication);
  assert.equal(publication.approval, "required");
  assert.equal(creates, 0);
  await scheduler.jobAction(publication.id, "approve");
  await scheduler.tick();
  const failed = await waitForRun(() => engine.get(publication.runId), {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(failed.status, "failed", failed.error ?? "");
  assert.equal(failed.automation?.automationId, definition.id);
  await scheduler.tick();
  assert.equal(
    scheduler.state().jobs.find((candidate) => candidate.id === publication.id)!.status,
    "needs_attention",
  );
  await scheduler.jobAction(publication.id, "reconcile");
  await scheduler.tick();
  const inspection = scheduler.state().jobs.find((candidate) => candidate.phase === "reconcile")!;
  const inspected = await waitForRun(() => engine.get(inspection.runId), {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(inspected.status, "completed", inspected.error ?? "");
  assert.equal(inspected.automation?.automationId, definition.id);
  assert.equal(inspection.publicationKey, publication.publicationKey);
  await scheduler.tick();
  assert.equal(
    scheduler.state().jobs.find((candidate) => candidate.id === publication.id)!.status,
    "completed",
  );
  assert.equal(pushes, 1);
  assert.equal(creates, 1);
});

test("automated GitHub shell parameters preserve quotes and metacharacters without executing them", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  const label = "owner's label; touch escaped; #\n$(touch escaped2)";
  const engine = new WorkflowEngine(project, "live", passingRunner, {}, async () => ({
    id: "real-shell-fake-gh",
    readText: async () => {
      throw new Error("Unexpected read");
    },
    writeText: async () => {
      throw new Error("Unexpected write");
    },
    exec: async (command) =>
      runProcess(
        project,
        [
          "bash",
          "-e",
          "-o",
          "pipefail",
          "-c",
          'gh(){ if [ "$1" = issue ]; then printf "%s" "$6" > received-label; fi; printf "[]"; };\n' +
            command,
        ],
        AbortSignal.timeout(10_000),
        10_000,
      ),
  }));
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const draft = await engine.createProgram(
    "Quoted GitHub arguments",
    "Preserve shell literals",
    {
      source: await readFile("examples/automations/github.ts", "utf8"),
      input: { repo: "acme/project", label },
    },
    library,
  );
  await scheduledExample(engine, draft.id, cleanup);
  assert.equal(await readFile(path.join(project, "received-label"), "utf8"), label);
  await assert.rejects(readFile(path.join(project, "escaped")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(project, "escaped2")), { code: "ENOENT" });
});

test("successful checks route to deterministic reporting and a separately approved configured alert", async (t) => {
  const { project, library, cleanup } = await fixture(t);
  await mkdir(path.join(project, "examples/automations"), { recursive: true });
  await copyFile(
    "examples/automations/github.ts",
    path.join(project, "examples/automations/github.ts"),
  );
  const pr = {
    number: 7,
    body: "<!-- workflow-case:issue:42 -->",
    headRefOid: sha,
    headRefName: "automation/42",
    updatedAt: instant,
    url: "https://github.com/acme/project/pull/7",
  };
  const alertURL = "https://github.com/acme/project/issues/99#issuecomment-1";
  let alerts = 0;
  const commands: string[] = [];
  const engine = new WorkflowEngine(
    project,
    "live",
    async () => {
      throw new Error("Reporting must not invoke implementation or models");
    },
    {},
    async () => ({
      id: "successful-checks-world",
      readText: async () => {
        throw new Error("Reporting must not inspect project files");
      },
      writeText: async () => {
        throw new Error("Reporting must not change project files");
      },
      exec: exampleExec(async (command, options) => {
        commands.push(command);
        assert.ok(!command.includes("git ") && !command.includes("merge"));
        if (command.startsWith("gh issue list")) return commandResult([]);
        if (command.startsWith("gh pr list")) return commandResult([pr]);
        if (command.includes("check-runs"))
          return commandResult({
            check_runs: [
              {
                id: 9,
                conclusion: "success",
                completed_at: instant,
                html_url: "https://example.test/check/9",
                name: "tests",
              },
              {
                id: 10,
                conclusion: "success",
                completed_at: instant,
                html_url: "https://example.test/check/10",
                name: "types",
              },
            ],
          });
        if (command.includes("/reviews")) return commandResult([]);
        if (command.includes("/comments")) {
          assert.equal(options?.env?.AUTOMATION_DESTINATION, "99");
          if (command.includes("--method POST")) {
            alerts++;
            const body = options?.env?.AUTOMATION_BODY ?? "";
            assert.ok(body.includes(`All 2 checks passed for ${sha}`));
            assert.ok(body.includes("<!-- workflow-automation:"));
            return commandResult({ body, html_url: alertURL, created_at: instant });
          }
          return commandResult([[]]);
        }
        throw new Error(`Unexpected command ${command}`);
      }),
    }),
  );
  cleanup(() => engine.shutdown());
  await engine.initialize();
  const template = async (operation: string) =>
    engine.createProgram(
      operation,
      operation,
      {
        filename: `examples/automations/${operation}.ts`,
        source: `import {githubWorkflow} from "./github";export default githubWorkflow(${JSON.stringify(operation)});`,
        input: { repo: "acme/project" },
      },
      library,
    );
  const discovery = await template("discover"),
    report = await template("report"),
    output = await template("publish"),
    reconcile = await template("reconcile");
  const scheduler = await Automations.open(engine);
  cleanup(() => scheduler.close());
  const definition = await scheduler.save({
    config: automation({
      name: "Successful checks report",
      enabled: true,
      schedule: { kind: "manual" },
      mode: "discovery",
      target: { kind: "workflow", runId: discovery.id },
      inputs: { repo: "acme/project", alert: { kind: "issue", number: 99 } },
      execution: { workspace: "project", maxCommands: 10, maxModelCalls: 0 },
      routes: [
        { id: "head", signalKind: "head-observed", revisionPolicy: "advance" },
        {
          id: "passed",
          signalKind: "checks-passed",
          revisionPolicy: "current",
          target: { kind: "workflow", runId: report.id },
          execution: { workspace: "project", maxCommands: 0, maxModelCalls: 0 },
        },
        { id: "reported", signalKind: "checks-reported", revisionPolicy: "current" },
      ],
      output: {
        target: { kind: "workflow", runId: output.id },
        reconcile: { kind: "workflow", runId: reconcile.id },
        approval: "required",
      },
    }),
  });
  const scan = await scheduler.action(definition.id, "run-now");
  assert.ok("runId" in scan);
  const discovered = await waitForRun(() => engine.get(scan.runId), {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(discovered.status, "completed", discovered.error ?? "");
  assert.deepEqual(
    discoveryResultSchema.parse(discovered.outputValue).signals.map((value) => value.signalKind),
    ["head-observed", "checks-passed"],
  );
  await scheduler.tick();
  const reaction = scheduler.state().jobs.find((job) => job.phase === "reaction")!;
  assert.equal(reaction.targetKey, "route:passed");
  const reported = await waitForRun(() => engine.get(reaction.runId), {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(reported.status, "completed", reported.error ?? "");
  assert.equal(z.object({ kind: z.string() }).parse(reported.outputValue).kind, "check-report");
  assert.equal(commands.length, 4, "Report target itself performs no commands");
  await scheduler.tick();
  const publication = scheduler.state().jobs.find((job) => job.phase === "output")!;
  assert.equal(publication.approval, "required");
  assert.equal(alerts, 0);
  await scheduler.jobAction(publication.id, "approve");
  await scheduler.tick();
  const published = await waitForRun(() => engine.get(publication.runId), {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(published.status, "completed", published.error ?? "");
  await scheduler.tick();
  const workCase = scheduler.state().cases[0]!;
  assert.equal(workCase.currentRevision, sha);
  assert.equal(workCase.lastSignalKind, "checks-reported");
  assert.equal(workCase.references.report, alertURL);
  assert.equal(alerts, 1);
});
