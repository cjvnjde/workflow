import ts from "typescript";
import type { FlowStructure } from "./composition-sdk.js";
import type { Library } from "./domain.js";

type Access = { step: string; write: boolean };
/** Reject statically known conflicting guards. Dynamic workspaces are checked at execution. */
export function validateCompositionOwnership(
  root: FlowStructure,
  blocks: Library["blocks"],
) {
  function accesses(node: FlowStructure): Access[] {
    if (node.kind !== "step") return node.children.flatMap(accesses);
    const executor = blocks[node.id]?.definition.executor;
    if (executor?.kind !== "code") return [];
    const found: Access[] = [];
    const source = ts.createSourceFile(
      "block.ts",
      executor.source,
      ts.ScriptTarget.Latest,
      true,
    );
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
      ts.forEachChild(value, visit);
    }
    visit(source);
    return found;
  }
  function check(node: FlowStructure) {
    if (node.kind === "parallel" && node.concurrency !== 1) {
      const branches = node.children.map(accesses);
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
    node.children.forEach(check);
  }
  check(root);
}
