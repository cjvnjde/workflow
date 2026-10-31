import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API, type Program } from "typescript/unstable/async";
import type { FlowStructure } from "../../sdk/composition-sdk.js";
import type { Library } from "../../contracts/domain.js";

type Access = { step: string; write: boolean };
/** Reject statically known conflicting guards. Dynamic workspaces are checked at execution. */
export async function validateCompositionOwnership(root: FlowStructure, blocks: Library["blocks"]) {
  let api: API | undefined;
  let program: Program | undefined;
  const filenames = new Map<string, string>();
  async function accesses(node: FlowStructure): Promise<Access[]> {
    if (node.kind !== "step") {
      const found: Access[] = [];
      for (const child of node.children) found.push(...(await accesses(child)));
      return found;
    }
    const executor = blocks[node.id]?.definition.executor;
    if (executor?.kind !== "code") return [];
    const found: Access[] = [];
    if (!program) {
      const directory = path.resolve(".workflow", "__ownership__");
      const config = path.join(directory, "tsconfig.json");
      const files: Record<string, string> = {};
      for (const [id, bundle] of Object.entries(blocks)) {
        if (bundle.definition.executor?.kind !== "code") continue;
        const filename = path.join(directory, `block-${filenames.size}.ts`);
        filenames.set(id, filename);
        files[filename] = bundle.definition.executor.source;
      }
      files[config] = JSON.stringify({
        compilerOptions: { noEmit: true, noResolve: true, noLib: true, types: [] },
        files: [...filenames.values()],
      });
      api = new API({ fs: createVirtualFileSystem(files) });
      program = (await api.updateSnapshot({ openProjects: [config] })).getProject(config)?.program;
      if (!program) throw new Error("Could not load the TypeScript ownership project");
    }
    const source = await program.getSourceFile(filenames.get(node.id)!);
    if (!source) throw new Error(`Could not parse ownership guards in block "${node.id}"`);
    function visit(value: ts.Node) {
      if (
        ts.isCallExpression(value) &&
        ts.isPropertyAccessExpression(value.expression) &&
        value.expression.name.text === "ai"
      ) {
        const options = value.arguments[0];
        if (options && ts.isObjectLiteralExpression(options)) {
          const fields = new Map(
            options.properties
              .filter(ts.isPropertyAssignment)
              .map((property) => [
                property.name.getText(source).replace(/^["']|["']$/g, ""),
                property.initializer,
              ]),
          );
          if (
            !fields.has("workspace") &&
            (fields.has("writablePaths") || fields.has("protectedPaths"))
          ) {
            const writable = fields.get("writablePaths"),
              protectedPaths = fields.get("protectedPaths");
            const readOnly =
              !!(
                writable &&
                ts.isArrayLiteralExpression(writable) &&
                writable.elements.length === 0
              ) ||
              !!(
                protectedPaths &&
                ts.isArrayLiteralExpression(protectedPaths) &&
                protectedPaths.elements.some(
                  (item) => ts.isStringLiteral(item) && item.text === "**/*",
                )
              );
            found.push({ step: node.id, write: !readOnly });
          }
        }
      }
      value.forEachChild(visit);
    }
    visit(source);
    return found;
  }
  async function check(node: FlowStructure) {
    if (node.kind === "parallel" && node.concurrency !== 1) {
      const branches: Access[][] = [];
      for (const child of node.children) branches.push(await accesses(child));
      for (let i = 0; i < branches.length; i++)
        for (let j = i + 1; j < branches.length; j++) {
          for (const a of branches[i]!)
            for (const b of branches[j]!)
              if (a.write || b.write) {
                throw new Error(
                  `Parallel steps ${a.step} and ${b.step} use conflicting ownership guards in the shared project. A writablePaths allowlist protects every other path, including sibling edits. Use separate execution worktrees with explicit integration, or serialize these steps. Conditional branches may both execute.`,
                );
              }
        }
    }
    for (const child of node.children) await check(child);
  }
  try {
    await check(root);
  } finally {
    await api?.close();
  }
}
