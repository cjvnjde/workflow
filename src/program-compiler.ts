import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { bundleWorkflowCode, DefaultLogger } from "@temporalio/worker";
import { programSourceSchema, type ProgramSource } from "./program-schema.js";
import type { Library } from "./domain.js";
import type { WorkflowVersions } from "./workflow-versions.js";
import { formatCode } from "./source-format.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const installRoot = path.dirname(dist);
const sdkTypes = path.join(dist, "workflow-sdk.d.ts");
const sdkModule = path.join(dist, "workflow-sdk.js");
const builtins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
);
const apiModules = new Set(["workflow", "predictable-workflow/workflow"]);

function programFiles(
  project: string,
  source: ProgramSource,
  catalog: Library["blocks"],
) {
  const filename = path.resolve(project, source.filename);
  const files = new Map([[filename, source.source]]);
  const codes = Object.entries(catalog).filter(
    ([, bundle]) => bundle.definition.executor?.kind === "code",
  );
  const imports = codes.map(([id, bundle], index) => {
    const file = path.resolve(project, ".workflow", "blocks", id, "block.ts");
    if (file === filename)
      throw new Error("Workflow source cannot replace a library block module");
    files.set(
      file,
      bundle.definition.executor!.kind === "code"
        ? bundle.definition.executor!.source
        : "",
    );
    return { id, variable: `block${index}`, file };
  });
  const entry = `${filename}.entry.ts`;
  const header =
    `import definition from ${JSON.stringify(filename)};\n` +
    imports
      .map(
        (item) => `import ${item.variable} from ${JSON.stringify(item.file)};`,
      )
      .join("\n");
  const registry = `{${imports.map((item) => `${JSON.stringify(item.id)}:${item.variable}`).join(",")}}`;
  files.set(
    entry,
    `${header}\nexport default {...definition,blocks:${registry}};`,
  );
  const check = `${filename}.check.ts`;
  files.set(
    check,
    `${header}\nimport type { WorkflowDefinition, CodeBlock } from "workflow";\nconst checked: WorkflowDefinition<any> = definition;\nconst blocks: Record<string,CodeBlock<any,any>> = ${registry};\nexport { blocks }; export default checked;`,
  );
  return { filename, files, entry, check };
}

/** Typecheck without importing/evaluating the user's module or running its code. */
export function checkProgram(
  project: string,
  value: unknown,
  catalog: Library["blocks"] = {},
): ProgramSource {
  const source = programSourceSchema.parse(value);
  const { files: virtual, check: entry } = programFiles(
    project,
    source,
    catalog,
  );
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    types: [],
    lib: ["lib.es2023.d.ts"],
    esModuleInterop: true,
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host),
    exists = host.fileExists.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (directory) =>
    [...virtual.keys()].some((file) =>
      file.startsWith(path.resolve(directory) + path.sep),
    ) || !!directoryExists?.(directory);
  host.readFile = (file) => virtual.get(path.resolve(file)) ?? read(file);
  host.fileExists = (file) => virtual.has(path.resolve(file)) || exists(file);
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => {
      if (apiModules.has(name))
        return { resolvedFileName: sdkTypes, extension: ts.Extension.Dts };
      return (
        ts.resolveModuleName(name, containingFile, options, host)
          .resolvedModule ??
        ts.resolveModuleName(
          name,
          path.join(installRoot, "__workflow_types.ts"),
          options,
          host,
        ).resolvedModule
      );
    });
  const program = ts.createProgram([entry], options, host);
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue;
    const fail = (node: ts.Node, message: string): never => {
      const at = file.getLineAndCharacterOfPosition(node.getStart(file));
      throw new Error(
        `TypeScript workflow needs correction:\n${path.relative(project, file.fileName)}:${at.line + 1}:${at.character + 1}: ${message}`,
      );
    };
    const visit = (node: ts.Node, inFunction = false): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        fail(
          node,
          'Use static imports (for example import {z} from "workflow"). Dynamic import() cannot be frozen in this durable bundle.',
        );
      }
      if (
        !inFunction &&
        (ts.isAwaitExpression(node) ||
          (ts.isForOfStatement(node) && node.awaitModifier))
      ) {
        fail(
          node,
          "Top-level await is not supported. Move awaited operations into workflow.run or block.run and use static imports.",
        );
      }
      if (
        (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
        ts.isExportDeclaration(node)
      ) {
        const target = node.moduleSpecifier;
        if (
          target &&
          ts.isStringLiteral(target) &&
          (target.text.startsWith("node:") || builtins.has(target.text))
        ) {
          fail(
            node,
            `Host module "${target.text}" must run through a block context operation (ctx.exec/readFile/writeFile).`,
          );
        }
      }
      ts.forEachChild(node, (child) =>
        visit(child, inFunction || ts.isFunctionLike(node)),
      );
    };
    visit(file);
  }
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length)
    throw new Error(
      "TypeScript workflow needs correction:\n" +
        diagnostics
          .slice(0, 8)
          .map((item) => {
            const location =
              item.file && item.start !== undefined
                ? item.file.getLineAndCharacterOfPosition(item.start)
                : undefined;
            return `${item.file ? path.relative(project, item.file.fileName) : source.filename}${location ? `:${location.line + 1}:${location.character + 1}` : ""}: ${ts.flattenDiagnosticMessageText(item.messageText, "\n")}`;
          })
          .join("\n"),
    );
  return source;
}

export function checkCodeBlocks(project: string, blocks: Library["blocks"]) {
  if (
    !Object.values(blocks).some(
      (bundle) => bundle.definition.executor?.kind === "code",
    )
  )
    return;
  checkProgram(
    project,
    {
      filename: ".workflow/library-check.ts",
      source:
        'import {workflow} from "workflow"; export default workflow({name:"Library typecheck", async run(){}});',
    },
    blocks,
  );
}

async function bundleProgram(
  project: string,
  value: unknown,
  catalog: Library["blocks"],
) {
  const parsed = programSourceSchema.parse(value);
  const source = checkProgram(project, { ...parsed, source: (await formatCode(parsed.source)).formatted }, catalog);
  const { files, entry: programEntry } = programFiles(project, source, catalog);
  const built = await Bun.build({
    entrypoints: [programEntry],
    target: "browser",
    format: "cjs",
    plugins: [
      {
        name: "workflow-source",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (apiModules.has(args.path)) return { path: sdkModule };
            if (args.path.startsWith("node:") || builtins.has(args.path)) {
              throw new Error(
                `Host module "${args.path}" must run through a block context effect (ctx.exec/readFile/writeFile). TypeScript orchestration must be replayable.`,
              );
            }
            const file = path.resolve(args.resolveDir || project, args.path);
            if (files.has(file)) return { path: file };
            if (!args.path.startsWith(".") && !path.isAbsolute(args.path)) {
              try {
                return {
                  path: Bun.resolveSync(args.path, args.resolveDir || project),
                };
              } catch {
                return { path: Bun.resolveSync(args.path, installRoot) };
              }
            }
            return undefined;
          });
          build.onLoad({ filter: /.*/ }, (args) => {
            const contents = files.get(path.resolve(args.path));
            return contents === undefined
              ? undefined
              : { contents, loader: "ts" };
          });
        },
      },
    ],
  }).catch((error: unknown) => {
    const details =
      error instanceof AggregateError
        ? error.errors.map((item) => item?.message ?? String(item)).join("\n")
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Workflow source could not be bundled:\n${details}`, {
      cause: error,
    });
  });
  if (!built.success)
    throw new Error(built.logs.map((log) => log.message).join("\n"));
  return { source, compiled: await built.outputs[0]!.text() };
}

/** Catch source/bundle errors while the coordinator can still correct its submission. */
export async function validateProgram(
  project: string,
  value: unknown,
  catalog: Library["blocks"] = {},
): Promise<ProgramSource> {
  return (await bundleProgram(project, value, catalog)).source;
}

export async function validateCodeBlocks(
  project: string,
  blocks: Library["blocks"],
) {
  if (
    !Object.values(blocks).some(
      (bundle) => bundle.definition.executor?.kind === "code",
    )
  )
    return;
  await validateProgram(
    project,
    {
      filename: ".workflow/library-check.ts",
      source:
        'import {workflow} from "workflow"; export default workflow({name:"Library validation",async run(){}});',
    },
    blocks,
  );
}

export async function compileProgram(
  project: string,
  value: unknown,
  versions: WorkflowVersions,
  catalog: Library["blocks"] = {},
) {
  const { source, compiled } = await bundleProgram(project, value, catalog);
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-compile-"));
  try {
    const entry = path.join(directory, "entry.js");
    await writeFile(
      entry,
      [
        `import { executeProgram } from ${JSON.stringify(path.join(dist, "program-runtime.js"))};`,
        // Evaluate module initializers inside the durable workflow's error
        // boundary. A thrown helper/definition error becomes a visible failed
        // run instead of an endlessly failing Temporal module activation.
        `function loadProgram() { const module = { exports: {} }; const exports = module.exports;\n${compiled}\nreturn module.exports.default; }`,
        `export async function executeWorkflow(input) { return await executeProgram(input, loadProgram); }`,
      ].join("\n"),
    );
    const bundled = await bundleWorkflowCode({
      workflowsPath: entry,
      logger: new DefaultLogger("ERROR"),
      webpackConfigHook: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          modules: [
            ...(config.resolve?.modules ?? []),
            path.join(installRoot, "node_modules"),
          ],
        },
      }),
    });
    const bundle = path.join(directory, "workflow-bundle.js");
    await writeFile(bundle, bundled.code);
    return { source, version: await versions.install(bundle) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
