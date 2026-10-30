import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

test("published package entry points retain runtime exports and resolvable declarations", async (t) => {
  const exports = {
    core: "WorkflowEngine",
    application: "createApplication",
    "http-server": "createHttpServer",
    web: "registerWebGui",
    terminal: "TerminalController",
    client: "WorkflowClient",
    contracts: "runSchema",
    "workflow-sdk": "workflow",
  };
  for (const [entry, symbol] of Object.entries(exports)) {
    const api = await import(path.join(root, "dist", `${entry}.js`));
    assert.equal(typeof api[symbol], entry === "contracts" ? "object" : "function", entry);
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-public-types-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const consumer = path.join(directory, "consumer.ts");
  await writeFile(
    consumer,
    Object.entries(exports)
      .map(([entry, symbol], index) => {
        const module = JSON.stringify(path.join(root, "dist", `${entry}.js`));
        return `import { ${symbol} as value${index} } from ${module}; void value${index};`;
      })
      .join("\n"),
  );
  const program = ts.createProgram([consumer], {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ["bun", "node"],
    typeRoots: [path.join(root, "node_modules/@types")],
  });
  assert.deepEqual(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    [],
  );
});
