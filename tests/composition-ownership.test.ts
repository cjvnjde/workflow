import assert from "node:assert/strict";
import test from "node:test";
import { validateCompositionOwnership } from "../src/core/execution/composition-ownership.js";
import { bundleSchema, type Library } from "../src/contracts/domain.js";
import type { FlowStructure } from "../src/sdk/composition-sdk.js";
const step = (id: string): FlowStructure => ({
  kind: "step",
  id,
  label: id,
  children: [],
});
const group = (kind: FlowStructure["kind"], children: FlowStructure[]): FlowStructure => ({
  kind,
  id: "group",
  label: "Group",
  children,
});
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
test("parallel disjoint allowlists are rejected because each protects the sibling's files", async () => {
  const code = blocks('writablePaths:["backend/**"]', 'writablePaths:["frontend/**"]');
  await assert.rejects(
    () =>
      validateCompositionOwnership(
        group("parallel", [step("a"), group("when", [step("b")])]),
        code,
      ),
    /conflicting ownership guards/,
  );
  await assert.doesNotReject(() =>
    validateCompositionOwnership(group("sequence", [step("a"), step("b")]), code),
  );
  await assert.doesNotReject(() =>
    validateCompositionOwnership(
      { ...group("parallel", [step("a"), step("b")]), concurrency: 1 },
      code,
    ),
  );
});
test("read-only calls can overlap, while an overlapping shared writer requires isolation", async () => {
  const root = group("parallel", [step("a"), step("b")]);
  await assert.doesNotReject(() =>
    validateCompositionOwnership(root, blocks('protectedPaths:["**/*"]', "writablePaths:[]")),
  );
  await assert.rejects(
    () =>
      validateCompositionOwnership(
        root,
        blocks('protectedPaths:["**/*"]', 'writablePaths:["src/**"]'),
      ),
    /shared project/,
  );
  await assert.doesNotReject(() =>
    validateCompositionOwnership(
      root,
      blocks(
        'workspace:"../a",writablePaths:["src/**"]',
        'workspace:"../b",writablePaths:["src/**"]',
      ),
    ),
  );
});

test("native ownership parsing preserves quoted property names and nested calls", async () => {
  const root = group("parallel", [step("a"), step("b")]);
  const code = blocks('"writablePaths":["src/**"]', "'protectedPaths':['**/*']");
  code.a!.definition.executor = {
    kind: "code",
    timeoutMs: 600_000,
    maxOperations: 100,
    source: `import {block} from "workflow";
type Options<T>={value:T};
const metadata={value:"ownership"} satisfies Options<string>;
export default block({async run(ctx){
  async function work(){return ctx.ai({prompt:metadata.value,"writablePaths":["src/**"]});}
  return await work();
}});`,
  };
  await assert.rejects(
    () => validateCompositionOwnership(root, code),
    /conflicting ownership guards/,
  );
  await assert.doesNotReject(() =>
    validateCompositionOwnership(root, blocks('"writablePaths":[]', "'protectedPaths':['**/*']")),
  );
});
