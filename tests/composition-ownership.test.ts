import assert from "node:assert/strict";
import test from "node:test";
import { validateCompositionOwnership } from "../src/composition-ownership.js";
import { bundleSchema, type Library } from "../src/domain.js";
import type { FlowStructure } from "../src/composition-sdk.js";
const step = (id: string): FlowStructure => ({
  kind: "step",
  id,
  label: id,
  children: [],
});
const group = (
  kind: FlowStructure["kind"],
  children: FlowStructure[],
): FlowStructure => ({ kind, id: "group", label: "Group", children });
const blocks = (a: string, b: string): Library["blocks"] =>
  Object.fromEntries(
    [a, b].map((options, index) => {
      const id = index === 0 ? "a" : "b";
      return [
        id,
        bundleSchema.parse({
          definition: {
            id,
            name: id,
            description: "Ownership fixture",
            executor: {
              kind: "code",
              source: `import {block} from "workflow";export default block({async run(ctx){return ctx.ai({prompt:"Work",${options}});}});`,
            },
          },
          skills: [],
        }),
      ];
    }),
  );
test("parallel disjoint allowlists are rejected because each protects the sibling's files", () => {
  const code = blocks(
    'writablePaths:["backend/**"]',
    'writablePaths:["frontend/**"]',
  );
  assert.throws(
    () =>
      validateCompositionOwnership(
        group("parallel", [step("a"), group("when", [step("b")])]),
        code,
      ),
    /conflicting ownership guards/,
  );
  assert.doesNotThrow(() =>
    validateCompositionOwnership(
      group("sequence", [step("a"), step("b")]),
      code,
    ),
  );
  assert.doesNotThrow(() =>
    validateCompositionOwnership(
      { ...group("parallel", [step("a"), step("b")]), concurrency: 1 },
      code,
    ),
  );
});
test("read-only calls can overlap, while an overlapping shared writer requires isolation", () => {
  const root = group("parallel", [step("a"), step("b")]);
  assert.doesNotThrow(() =>
    validateCompositionOwnership(
      root,
      blocks('protectedPaths:["**/*"]', "writablePaths:[]"),
    ),
  );
  assert.throws(
    () =>
      validateCompositionOwnership(
        root,
        blocks('protectedPaths:["**/*"]', 'writablePaths:["src/**"]'),
      ),
    /shared project/,
  );
  assert.doesNotThrow(() =>
    validateCompositionOwnership(
      root,
      blocks(
        'workspace:"../a",writablePaths:["src/**"]',
        'workspace:"../b",writablePaths:["src/**"]',
      ),
    ),
  );
});
