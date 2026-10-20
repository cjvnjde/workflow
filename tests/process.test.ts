import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../src/process.js";
import { fixture } from "./helpers.js";

for (const reason of ["cancellation", "timeout"] as const) {
  test(`${reason} stops a child that ignores SIGTERM after its parent exits`, async (t) => {
    if (process.platform === "win32") {
      t.skip("Unix process groups");
      return;
    }
    const { project } = await fixture(t);
    await writeFile(
      path.join(project, "child.cjs"),
      `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    fs.writeFileSync("child-ready", String(process.pid));
    setTimeout(() => fs.writeFileSync("late-effect", "must not happen"), 2200);
    setInterval(() => {}, 1000);
  `,
    );
    const controller = new AbortController();
    const operation = runProcess(
      project,
      [
        "sh",
        "-c",
        '"$1" child.cjs </dev/null >/dev/null 2>&1 & wait',
        "workflow-process-test",
        process.execPath,
      ],
      controller.signal,
      reason === "timeout" ? 500 : 10_000,
    );
    const stopped =
      reason === "cancellation"
        ? assert.rejects(operation, /Cancelled check/)
        : operation;
    let childPid: number | undefined;
    t.after(() => {
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
    });
    for (let i = 0; i < 100; i++) {
      childPid = await readFile(path.join(project, "child-ready"), "utf8").then(
        Number,
        () => undefined,
      );
      if (childPid) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (reason === "cancellation")
      controller.abort(new Error("Cancelled check"));
    await stopped;
    if (reason === "timeout") assert.equal((await operation).timedOut, true);
    assert.ok(childPid, "Child must be running before cancellation");
    await new Promise((resolve) => setTimeout(resolve, 2400));
    await assert.rejects(stat(path.join(project, "late-effect")), /ENOENT/);
  });
}

test("command output preserves Unicode characters split across output chunks", async (t) => {
  const { project } = await fixture(t);
  const result = await runProcess(
    project,
    [
      process.execPath,
      "-e",
      `
    process.stdout.write(Buffer.from([0xe2, 0x9c]));
    process.stderr.write(Buffer.from([0xf0, 0x9f]));
    setTimeout(() => {
      process.stdout.write(Buffer.from([0x93, 0x0a]));
      process.stderr.write(Buffer.from([0x98, 0x80, 0x0a]));
    }, 50);
  `,
    ],
    new AbortController().signal,
    2000,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "✓\n");
  assert.equal(result.stderr, "😀\n");
  assert.ok(result.output.includes("✓") && result.output.includes("😀"));
  assert.ok(!result.output.includes("\uFFFD"));
});
