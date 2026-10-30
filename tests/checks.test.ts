import assert from "node:assert/strict";
import test from "node:test";
import { runCheck } from "../src/core/execution/checks.js";
import { fixture } from "./helpers.js";

test("checks use actual exit status rather than an agent claim", async (t) => {
  const { project, library } = await fixture(t);
  library.config.commands.test = {
    argv: [process.execPath, "-e", "console.log('regression failed'); process.exit(3)"],
    timeoutMs: 2000,
  };
  const failure = await runCheck(
    project,
    library.config,
    { command: "test", expect: "failure" },
    new AbortController().signal,
  );
  assert.equal(failure.matched, true);
  assert.equal(failure.exitCode, 3);
  assert.match(failure.output, /regression failed/);
  const success = await runCheck(
    project,
    library.config,
    { command: "test", expect: "success" },
    new AbortController().signal,
  );
  assert.equal(success.matched, false);
});

test("timeouts cannot satisfy an expected-failure reproduction gate", async (t) => {
  const { project, library } = await fixture(t);
  library.config.commands.test = {
    argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 100,
  };
  const result = await runCheck(
    project,
    library.config,
    { command: "test", expect: "failure" },
    new AbortController().signal,
  );
  assert.equal(result.matched, false);
  assert.match(result.output, /timed out/);
});

test("unknown and pre-cancelled commands never execute", async (t) => {
  const { project, library } = await fixture(t);
  await assert.rejects(
    runCheck(
      project,
      library.config,
      { command: "missing", expect: "success" },
      new AbortController().signal,
    ),
    /Unknown check/,
  );
  library.config.commands.test = {
    argv: [process.execPath, "-e", "process.exit(0)"],
    timeoutMs: 2000,
  };
  await assert.rejects(
    runCheck(
      project,
      library.config,
      { command: "test", expect: "success" },
      AbortSignal.abort(new Error("Stop")),
    ),
    /Stop/,
  );
});
