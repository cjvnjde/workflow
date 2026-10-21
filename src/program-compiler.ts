import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import vm from "node:vm";
import type { FlowStructure } from "./composition-sdk.js";
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
// TypeScript emits these only for unused imports, bindings, properties and types.
// We inspect them selectively instead of imposing a general lint policy on
// generated workflows and their reusable imports.
const unusedLocalCodes = new Set([6133, 6138, 6192, 6196, 6198, 6199]);

function unusedFlowDiagnostics(
  program: ts.Program,
  diagnostics: readonly ts.Diagnostic[],
): ts.Diagnostic[] {
  const checker = program.getTypeChecker();
  const sdkFile = program.getSourceFile(sdkTypes);
  const sdk = sdkFile && checker.getSymbolAtLocation(sdkFile);
  const flow =
    sdk &&
    checker
      .getExportsOfModule(sdk)
      .find((symbol) => symbol.name === "FlowNode");
  if (!flow) return [];
  const flowType = checker.getDeclaredTypeOfSymbol(flow);
  const reported = new Set<ts.Identifier>();
  const errors: ts.Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const { file, start, length } = diagnostic;
    if (!file || start === undefined || length === undefined) continue;
    const end = start + length;
    const binding = (name: ts.BindingName): void => {
      if (!ts.isIdentifier(name)) {
        for (const item of name.elements)
          if (ts.isBindingElement(item)) binding(item.name);
        return;
      }
      if (name.getStart(file) < start || name.end > end || reported.has(name))
        return;
      const type = checker.getNonNullableType(checker.getTypeAtLocation(name));
      if (
        type.flags &
          (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never) ||
        !checker.isTypeAssignableTo(type, flowType)
      )
        return;
      reported.add(name);
      errors.push({
        category: ts.DiagnosticCategory.Error,
        code: diagnostic.code,
        file,
        start: name.getStart(file),
        length: name.getWidth(file),
        messageText: `Workflow primitive "${name.text}" is declared but unused. Attach it to the exported workflow's flow (for example sequence(existingFlow, ${name.text})), or remove it if it is intentionally excluded. Declaring a step or group does not execute it.`,
      });
    };
    const visit = (node: ts.Node): void => {
      if (node.end < start || node.getStart(file) > end) return;
      if (ts.isVariableDeclaration(node)) binding(node.name);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return errors;
}

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
    `${header}\nimport {describeFlow as describe} from "workflow";\nexport const __structure = () => definition.flow ? describe(definition.flow) : undefined;\nexport default {...definition,blocks:${registry}};`,
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
  inspectDefinition?: (declarative: boolean) => void,
  excludedFiles?: ReadonlySet<string>,
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
    noUnusedLocals: true,
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
  host.readFile = (file) => excludedFiles?.has(path.resolve(file))
    ? undefined : virtual.get(path.resolve(file)) ?? read(file);
  host.fileExists = (file) => !excludedFiles?.has(path.resolve(file)) && (virtual.has(path.resolve(file)) || exists(file));
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
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(path.resolve(project, source.filename));
  const module = file && checker.getSymbolAtLocation(file);
  const exported =
    module &&
    checker
      .getExportsOfModule(module)
      .find((symbol) => symbol.name === "default");
  const flow =
    exported &&
    file &&
    checker.getTypeOfSymbolAtLocation(exported, file).getProperty("flow");
  const declarative = !!flow && !(flow.flags & ts.SymbolFlags.Optional);
  inspectDefinition?.(declarative);
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
  const checked = ts
    .getPreEmitDiagnostics(program)
    .filter((item) => item.category === ts.DiagnosticCategory.Error);
  const diagnostics = [
    ...checked.filter((item) => !unusedLocalCodes.has(item.code)),
    ...(declarative
      ? unusedFlowDiagnostics(
          program,
          checked.filter((item) => unusedLocalCodes.has(item.code)),
        )
      : []),
  ];
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
  excludedFiles?: ReadonlySet<string>,
) {
  const parsed = programSourceSchema.parse(value);
  let declarative = false;
  const source = checkProgram(
    project,
    { ...parsed, source: (await formatCode(parsed.source)).formatted },
    catalog,
    (flag) => {
      declarative = flag;
    },
    excludedFiles,
  );
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
            const filename = path.resolve(args.path);
            if (excludedFiles?.has(filename)) {
              throw new Error(`Removed block module is unavailable: ${path.relative(project, filename)}`);
            }
            const contents = files.get(filename);
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
  const compiled = await built.outputs[0]!.text();
  let structure: FlowStructure | undefined;
  // Only declarative workflows need preview evaluation. The context has no host
  // APIs; blocks, deferred inputs and predicates are never called. Ordinary
  // imperative programs retain their execution-only module initialization.
  if (declarative) {
    const sandbox = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: "afterEvaluate",
    });
    const serialized = vm.runInContext(
      `const module={exports:{}};const exports=module.exports;\n${compiled}\nJSON.stringify(module.exports.__structure());`,
      sandbox,
      { timeout: 1000 },
    );
    if (typeof serialized !== "string")
      throw new Error("Export a workflow with a declared flow tree");
    if (serialized.length > 500_000)
      throw new Error("Composition preview is too large");
    structure = JSON.parse(serialized);
  }
  return { source, compiled, structure };
}

/** Catch source/bundle errors while the coordinator can still correct its submission. */
export async function validateProgram(
  project: string,
  value: unknown,
  catalog: Library["blocks"] = {},
  excludedFiles?: ReadonlySet<string>,
): Promise<ProgramSource> {
  return (await bundleProgram(project, value, catalog, excludedFiles)).source;
}

export async function validateComposition(
  project: string,
  value: unknown,
  catalog: Library["blocks"],
) {
  const { source, structure } = await bundleProgram(project, value, catalog);
  if (!structure)
    throw new Error(
      "Use workflow({name, flow: ...}) with step, sequence, parallel, when and repeatUntil to provide a graph before execution",
    );
  return { source, structure };
}

export async function validateCodeBlocks(
  project: string,
  blocks: Library["blocks"],
  excludedFiles?: ReadonlySet<string>,
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
    excludedFiles,
  );
}

export async function compileProgram(
  project: string,
  value: unknown,
  versions: WorkflowVersions,
  catalog: Library["blocks"] = {},
) {
  const { source, compiled, structure } = await bundleProgram(
    project,
    value,
    catalog,
  );
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
    return { source, structure, version: await versions.install(bundle) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
