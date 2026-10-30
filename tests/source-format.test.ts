import assert from "node:assert/strict";
import test from "node:test";
import { formatCode, formatBlock } from "../src/core/library/source-format.js";
import { bundleSchema } from "../src/contracts/domain.js";

test("Prettier formats source and JSON without evaluating it and maps the cursor", async () => {
  const source = 'throw new Error("never run");export const answer={value:42};';
  const result = await formatCode(source, "typescript", source.indexOf("42"));
  assert.match(result.formatted, /export const answer = \{ value: 42 \};\n$/);
  assert.equal(result.formatted.slice(result.cursorOffset, result.cursorOffset + 2), "42");
  assert.equal((await formatCode('{"value":[1,2]}', "json")).formatted, '{ "value": [1, 2] }\n');
  await assert.rejects(formatCode("export const ="), /expected|Unexpected/i);
  const bundle = bundleSchema.parse({
    definition: {
      id: "format",
      name: "Format",
      description: "Format sample",
      executor: {
        kind: "code",
        source: 'import {block} from "workflow";export default block({async run(){return 42;}});',
      },
    },
    skills: [],
  });
  const formatted = await formatBlock(bundle);
  assert.notEqual(formatted.definition.executor, bundle.definition.executor);
  assert.equal(formatted.definition.executor?.kind, "code");
  if (formatted.definition.executor?.kind === "code")
    assert.match(formatted.definition.executor.source, /async run\(\) \{\n {4}return 42;/);
});
