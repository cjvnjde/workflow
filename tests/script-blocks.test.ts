import assert from "node:assert/strict";
import { test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundleSchema, nodeSchema, executionTimeoutMs } from "../src/contracts/domain.js";
import { scriptExecutorSchema } from "../src/contracts/script-schema.js";
import { runScriptBlock } from "../src/core/execution/script-runner.js";
import type { BlockExecution } from "../src/core/execution/block-runner.js";
import { fixture } from "./helpers.js";
import { loadLibrary } from "../src/core/library/library.js";
import { scriptBundle } from "../src/core/library/script-migration.js";

function execution(
  project: string,
  library: Awaited<ReturnType<typeof fixture>>["library"],
  code: string,
  extra = {},
): BlockExecution {
  return {
    project,
    config: library.config,
    settings: library.config.agent,
    bundle: bundleSchema.parse({
      definition: {
        id: "script",
        name: "Script",
        description: "Process the inputs",
        executor: { kind: "script", language: "bash", runtime: "bash", code, ...extra },
        outputs: ["evidence"],
      },
      prompt: "Run the script.",
      skills: [],
    }),
    node: nodeSchema.parse({
      id: "script",
      block: "script",
      label: "Script",
      goal: "Use the selected context",
      on: { pass: "$complete", retry: "$failed", fail: "$failed" },
    }),
    inputs: { feedback: "Try an empty value" },
    task: "Check input handling",
    visit: 2,
    signal: new AbortController().signal,
    emit: () => {},
  };
}

test("Bash scripts run from the project, stream output, preserve quoting and return diagnostics", async (t) => {
  const { project, library } = await fixture(t);
  const events: { kind: string; message: string }[] = [];
  const result = await runScriptBlock({
    ...execution(
      project,
      library,
      "printf '%s\\n' \"$PWD\" \"$WORKFLOW_PROJECT\" '✓ multiline' 'literal $(not-a-command)'\nprintf 'stderr evidence\\n' >&2\nsleep 0.2\n",
    ),
    emit: (kind, message) => events.push({ kind, message }),
  });
  assert.equal(result.outcome, "pass");
  assert.match(result.summary, /exit 0 · condition met/);
  assert.ok(result.artifacts.evidence!.includes(project));
  assert.match(result.artifacts.evidence!, /literal \$\(not-a-command\)/);
  assert.ok(
    events.some(
      (event) => event.kind === "script_output" && event.message.includes("stderr evidence"),
    ),
  );
  assert.equal(events.at(-1)?.kind, "script_end");
});

for (const runtime of ["bun", "node"] as const) {
  for (const language of ["javascript", "typescript"] as const) {
    test(`${language} scripts on ${runtime} receive typed context and return selected artifacts`, async (t) => {
      const { project, library } = await fixture(t);
      await writeFile(path.join(project, "helper.mjs"), "export const answer = 42;\n");
      const step = execution(
        project,
        library,
        `
        import { readFileSync, writeFileSync } from "node:fs";
        import { answer } from "./helper.mjs";
        ${language === "typescript" ? "const value: number = answer;" : "const value = answer;"}
        const input = JSON.parse(readFileSync(process.env.WORKFLOW_INPUT, "utf8"));
        writeFileSync(process.env.WORKFLOW_RESULT, JSON.stringify({
          outcome: "pass", summary: "Processed " + value,
          artifacts: { evidence: JSON.stringify(input) }
        }));
      `,
        { language, runtime },
      );
      const result = await runScriptBlock(step);
      assert.equal(result.outcome, "pass", result.summary);
      assert.equal(result.summary, "Processed 42");
      const input = JSON.parse(result.artifacts.evidence!);
      assert.deepEqual(input.inputs, step.inputs);
      assert.equal(input.task, step.task);
      assert.equal(input.node.goal, step.node.goal);
      assert.equal(input.visit, 2);
      assert.deepEqual(input.outputs, ["evidence"]);
    });
  }
}

test("script exit status and timeout cannot be disguised by a passing result", async (t) => {
  const { project, library } = await fixture(t);
  const pass = `printf '%s' '{"outcome":"pass","summary":"Claimed success","artifacts":{"evidence":"claimed"}}' > "$WORKFLOW_RESULT"`;
  const mismatch = await runScriptBlock(execution(project, library, `${pass}\nexit 7\n`));
  assert.equal(mismatch.outcome, "retry");
  assert.match(mismatch.summary, /exit 7/);
  assert.equal(
    (await runScriptBlock(execution(project, library, "exit 3", { expect: "failure" }))).outcome,
    "pass",
  );
  const timed = await runScriptBlock(
    execution(project, library, `${pass}\nsleep 2\n`, { timeoutMs: 100, expect: "failure" }),
  );
  assert.equal(timed.outcome, "retry");
  assert.match(timed.summary, /timed out/);
  assert.equal(
    (await runScriptBlock(execution(project, library, "false | true"))).outcome,
    "retry",
    "Bash enables pipefail",
  );
});

test("scripts validate result files and explicit retry/fail routes", async (t) => {
  const { project, library } = await fixture(t);
  for (const outcome of ["retry", "fail"] as const) {
    const result = await runScriptBlock(
      execution(
        project,
        library,
        `printf '%s' '{"outcome":"${outcome}","summary":"Needs another step","artifacts":{"evidence":"feedback"}}' > "$WORKFLOW_RESULT"`,
      ),
    );
    assert.equal(result.outcome, outcome);
    assert.equal(result.artifacts.evidence, "feedback");
  }
  for (const code of [
    `printf '%s' 'not JSON' > "$WORKFLOW_RESULT"`,
    `printf '%s' '{"outcome":"pass","summary":"Missing evidence"}' > "$WORKFLOW_RESULT"`,
    `mkfifo "$WORKFLOW_RESULT"`,
  ])
    assert.equal((await runScriptBlock(execution(project, library, code))).outcome, "retry");
  const syntax = await runScriptBlock(
    execution(project, library, "const = ;", { language: "typescript", runtime: "node" }),
  );
  assert.equal(syntax.outcome, "retry");
  assert.match(syntax.summary, /Script could not complete/);
});

test("script cancellation stops execution and removes temporary context", async (t) => {
  const { project, library } = await fixture(t);
  const controller = new AbortController();
  const operation = runScriptBlock({
    ...execution(
      project,
      library,
      'printf "%s" "$WORKFLOW_INPUT" > context-path\nsleep 2\nprintf late > late-effect\n',
    ),
    signal: controller.signal,
  });
  const stopped = assert.rejects(operation, /Stop script/);
  let input = "";
  for (let i = 0; i < 100 && !input; i++) {
    input = await readFile(path.join(project, "context-path"), "utf8").catch(() => "");
    if (!input) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(input);
  controller.abort(new Error("Stop script"));
  await stopped;
  await assert.rejects(readFile(input), /ENOENT/);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await assert.rejects(readFile(path.join(project, "late-effect")), /ENOENT/);
});

test("script schema restricts runtimes and scripts use their own execution timeout", async (t) => {
  const { project, library } = await fixture(t);
  for (const value of [
    { language: "python", runtime: "node" },
    { language: "bash", runtime: "node" },
    { language: "typescript", runtime: "bash" },
    { language: "javascript", runtime: "deno" },
  ])
    assert.equal(
      scriptExecutorSchema.safeParse({ kind: "script", code: "true", ...value }).success,
      false,
    );
  const step = execution(project, library, "true", { timeoutMs: 2000 });
  step.config.agent.timeoutMs = 1000;
  assert.ok(executionTimeoutMs(step.config, step.bundle, step.node) > 2000);
});

test("existing library functions and named commands become editable scripts without altering snapshots", async (t) => {
  const { project, library } = await fixture(t);
  const legacy = structuredClone(library.blocks.push!);
  legacy.definition.executor = { kind: "function", function: "git-push", remote: "published" };
  await writeFile(
    path.join(project, ".workflow", "library.json"),
    JSON.stringify({ version: 1, blocks: { push: legacy } }),
  );
  const loaded = (await loadLibrary(project)).blocks.push!;
  assert.equal(loaded.definition.executor?.kind, "script");
  assert.match(
    loaded.definition.executor!.kind === "script" ? loaded.definition.executor.code : "",
    /preferredRemote = "published"/,
  );
  assert.equal(legacy.definition.executor.kind, "function");
  const named = structuredClone(library.blocks.review!);
  named.definition.executor = { kind: "command", command: "check", expect: "success" };
  const converted = scriptBundle(named, {
    check: {
      argv: [process.execPath, "-e", 'console.log("a\\nb \' quote $(literal)")'],
      timeoutMs: 2000,
    },
  });
  const result = await runScriptBlock({
    ...execution(project, library, "true"),
    bundle: converted,
  });
  assert.equal(result.outcome, "pass", result.summary);
  assert.match(result.summary, /b ' quote \$\(literal\)/);
  assert.equal(named.definition.executor.kind, "command");
});
