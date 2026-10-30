import assert from "node:assert/strict";
import test from "node:test";
import { bundleSchema } from "../src/contracts/domain.js";
import { codeBundle } from "../src/core/library/code-migration.js";
import { validateComposition } from "../src/core/planning/program-compiler.js";
import { fixture } from "./helpers.js";

test("converted blocks retain command and check timeouts when reused or imported", async (t) => {
  const { project } = await fixture(t);
  const commands = {
    build: { argv: ["bun", "run", "build"], timeoutMs: 600_000 },
    check: { argv: ["bun", "run", "test"], timeoutMs: 120_000 },
  };
  const cases = [
    { executor: { kind: "command", command: "build", expect: "success" }, timeout: 724_000 },
    {
      executor: {
        kind: "script",
        language: "bash",
        runtime: "bash",
        code: "true",
        timeoutMs: 5000,
      },
      timeout: 129_000,
    },
    { executor: undefined, timeout: 123_000 },
  ];
  for (const { executor, timeout } of cases) {
    const original = bundleSchema.parse({
      definition: {
        id: "converted",
        name: "Converted",
        description: "Preserve execution limits",
        agent: { timeoutMs: 1000 },
        executor,
        checks: [{ command: "check", expect: "success" }],
      },
      prompt: "Complete the task",
      skills: [],
    });
    const converted = codeBundle(original, commands);
    assert.ok(converted.definition.executor?.kind === "code");
    assert.equal(converted.definition.executor.timeoutMs, timeout);
    const { structure } = await validateComposition(
      project,
      {
        source: `import {workflow,step} from "workflow";
import converted from "./.workflow/blocks/converted/block.ts";
export default workflow({name:"Converted limits",flow:step("work",converted)});`,
      },
      { converted },
    );
    const reference = structure.step!.reference;
    assert.notEqual(typeof reference, "string");
    if (typeof reference !== "string") assert.equal(reference.timeoutMs, timeout);
    assert.equal(original.definition.agent?.timeoutMs, 1000);
  }
});
