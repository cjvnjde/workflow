import { distributionUrl } from "../../infrastructure/package-paths.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  API,
  DiagnosticCategory,
  SymbolFlags,
  TypeFlags,
  type Diagnostic,
  type Project,
} from "typescript/unstable/async";
import vm from "node:vm";
import type { FlowStructure } from "../../sdk/composition-sdk.js";
import { bundleWorkflowCode, DefaultLogger } from "@temporalio/worker";
import { programSourceSchema, type ProgramSource } from "../../contracts/program-schema.js";
import type { Library } from "../../contracts/domain.js";
import type { WorkflowVersions } from "../../infrastructure/workflow-versions.js";
import { formatCode } from "../library/source-format.js";

const dist = fileURLToPath(distributionUrl(""));
const installRoot = path.dirname(dist);
const sdkTypes = path.join(dist, "workflow-sdk.d.ts");
const sdkModule = path.join(dist, "workflow-sdk.js");
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const apiModules = new Set(["workflow", "predictable-workflow/workflow"]);
// TypeScript emits these only for unused imports, bindings, properties and types.
// We inspect them selectively instead of imposing a general lint policy on
// generated workflows and their reusable imports.
const unusedLocalCodes = new Set([6133, 6138, 6192, 6196, 6198, 6199]);

async function unusedFlowDiagnostics(
  { program, checker }: Project,
  diagnostics: readonly Diagnostic[],
): Promise<Diagnostic[]> {
  const sdkFile = await program.getSourceFile(sdkTypes);
  const sdk = sdkFile && (await checker.getSymbolAtLocation(sdkFile));
  const flow =
    sdk && (await checker.getExportsOfModule(sdk)).find((symbol) => symbol.name === "FlowNode");
  if (!flow) return [];
  const flowType = await checker.getDeclaredTypeOfSymbol(flow);
  const reported = new Set<ts.Identifier>();
  const errors: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const { fileName, pos: start, end } = diagnostic;
    const file = fileName && (await program.getSourceFile(fileName));
    if (!file || start < 0) continue;
    const names: ts.Identifier[] = [];
    const binding = (name: ts.BindingName): void => {
      if (!ts.isIdentifier(name)) {
        for (const item of name.elements)
          if (ts.isBindingElement(item) && item.name) binding(item.name);
        return;
      }
      if (name.getStart(file) >= start && name.end <= end && !reported.has(name)) names.push(name);
    };
    const visit = (node: ts.Node): void => {
      if (node.end < start || node.getStart(file) > end) return;
      if (ts.isVariableDeclaration(node) && node.name) binding(node.name);
      node.forEachChild(visit);
    };
    visit(file);
    for (const name of names) {
      const inferred = await checker.getTypeAtLocation(name);
      const type = inferred && (await checker.getNonNullableType(inferred));
      if (
        !type ||
        type.flags & (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.Never) ||
        !(await checker.isTypeAssignableTo(type, flowType))
      )
        continue;
      reported.add(name);
      errors.push({
        category: DiagnosticCategory.Error,
        code: diagnostic.code,
        fileName: file.fileName,
        pos: name.getStart(file),
        end: name.end,
        text: `Workflow primitive "${name.text}" is declared but unused. Attach it to the exported workflow's flow (for example sequence(existingFlow, ${name.text})), or remove it if it is intentionally excluded. Declaring a step or group does not execute it.`,
      });
    }
  }
  return errors;
}

function programFiles(project: string, source: ProgramSource, catalog: Library["blocks"]) {
  const filename = path.resolve(project, source.filename);
  const files = new Map([[filename, source.source]]);
  const codes = Object.entries(catalog).filter(
    ([, bundle]) => bundle.definition.executor?.kind === "code",
  );
  const imports = codes.map(([id, bundle], index) => {
    const file = path.resolve(project, ".workflow", "blocks", id, "block.ts");
    if (file === filename) throw new Error("Workflow source cannot replace a library block module");
    files.set(
      file,
      bundle.definition.executor!.kind === "code" ? bundle.definition.executor!.source : "",
    );
    return { id, variable: `block${index}`, file };
  });
  const entry = `${filename}.entry.ts`;
  const header =
    `import definition from ${JSON.stringify(filename)};\n` +
    imports.map((item) => `import ${item.variable} from ${JSON.stringify(item.file)};`).join("\n");
  const registry = `{${imports.map((item) => `${JSON.stringify(item.id)}:${item.variable}`).join(",")}}`;
  files.set(
    entry,
    `${header}\nimport {describeFlow as describe, __workflowTools} from "workflow";\nexport const __tools = __workflowTools;\nexport const __structure = () => definition.flow ? describe(definition.flow,{evidence:true}) : undefined;\nexport default {...definition,blocks:${registry}};`,
  );
  const check = `${filename}.check.ts`;
  files.set(
    check,
    `${header}\nimport type { WorkflowDefinition, CodeBlock } from "workflow";\nconst checked: WorkflowDefinition<any> = definition;\nconst blocks: Record<string,CodeBlock<any,any>> = ${registry};\nexport { blocks }; export default checked;`,
  );
  return { filename, files, entry, check };
}

/** Typecheck without importing/evaluating the user's module or running its code. */
export async function checkProgram(
  project: string,
  value: unknown,
  catalog: Library["blocks"] = {},
  inspectDefinition?: (declarative: boolean) => void,
  excludedFiles?: ReadonlySet<string>,
): Promise<ProgramSource> {
  const source = programSourceSchema.parse(value);
  const { files: virtual, check: entry } = programFiles(project, source, catalog);
  const config = `${entry}.tsconfig.json`;
  virtual.set(
    config,
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noUnusedLocals: true,
        skipLibCheck: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        types: [],
        lib: ["ES2023"],
        paths: Object.fromEntries([...apiModules].map((name) => [name, [sdkTypes]])),
      },
      files: [entry],
    }),
  );
  const overlay = createVirtualFileSystem(Object.fromEntries(virtual));
  // Resolve installed dependencies only after the project's normal node_modules
  // search is exhausted, matching the bundler's installation-root fallback.
  const rootModules = path.join(path.parse(path.resolve(project)).root, "node_modules");
  const installed = (file: string): string | undefined =>
    file.startsWith(rootModules + path.sep) && !existsSync(file)
      ? path.join(installRoot, "node_modules", path.relative(rootModules, file))
      : file === rootModules && !existsSync(file)
        ? path.join(installRoot, "node_modules")
        : undefined;
  const api = new API({
    cwd: path.resolve(project),
    fs: {
      readFile(file) {
        if (excludedFiles?.has(path.resolve(file))) return null;
        const contents = overlay.readFile?.(file);
        if (contents !== undefined) return contents;
        const fallback = installed(file);
        return fallback && existsSync(fallback) ? readFileSync(fallback, "utf8") : undefined;
      },
      fileExists(file) {
        if (excludedFiles?.has(path.resolve(file))) return false;
        if (overlay.fileExists?.(file)) return true;
        const fallback = installed(file);
        return fallback && existsSync(fallback) ? true : undefined;
      },
      directoryExists(directory) {
        if (overlay.directoryExists?.(directory)) return true;
        const fallback = installed(directory);
        return fallback && existsSync(fallback) ? true : undefined;
      },
      realpath(file) {
        if (virtual.has(file)) return file;
        const fallback = installed(file);
        return fallback && existsSync(fallback) ? realpathSync(fallback) : undefined;
      },
    },
  });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });
    const checkedProject = snapshot.getProject(config);
    if (!checkedProject) throw new Error("Could not load the TypeScript workflow project");
    const { program, checker } = checkedProject;
    const file = await program.getSourceFile(path.resolve(project, source.filename));
    const module = file && (await checker.getSymbolAtLocation(file));
    const exported =
      module &&
      (await checker.getExportsOfModule(module)).find((symbol) => symbol.name === "default");
    const flow =
      exported &&
      file &&
      (await checker.getPropertyOfType(
        await checker.getTypeOfSymbolAtLocation(exported, file),
        "flow",
      ));
    const declarative = !!flow && !(flow.flags & SymbolFlags.Optional);
    inspectDefinition?.(declarative);
    for (const filename of await program.getSourceFileNames()) {
      const file = await program.getSourceFile(filename);
      if (!file || file.isDeclarationFile) continue;
      const fail = (node: ts.Node, message: string): never => {
        const at = file.getLineAndCharacterOfPosition(node.getStart(file));
        throw new Error(
          `TypeScript workflow needs correction:\n${path.relative(project, file.fileName)}:${at.line + 1}:${at.character + 1}: ${message}`,
        );
      };
      const visit = (node: ts.Node, inFunction = false): void => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          fail(
            node,
            'Use static imports (for example import {z} from "workflow"). Dynamic import() cannot be frozen in this durable bundle.',
          );
        }
        if (
          !inFunction &&
          (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier))
        ) {
          fail(
            node,
            "Top-level await is not supported. Move awaited operations into workflow.run or block.run and use static imports.",
          );
        }
        if (
          (ts.isImportDeclaration(node) &&
            node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) ||
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
        node.forEachChild((child) =>
          visit(child, inFunction || ts.isFunctionLikeDeclaration(node)),
        );
      };
      visit(file);
    }
    const checked = [
      ...(await program.getConfigFileParsingDiagnostics()),
      ...(await program.getProgramDiagnostics()),
      ...(await program.getSyntacticDiagnostics()),
      ...(await program.getBindDiagnostics()),
      ...(await program.getGlobalDiagnostics()),
      ...(await program.getSemanticDiagnostics()),
    ].filter((item) => item.category === DiagnosticCategory.Error);
    const diagnostics = [
      ...checked.filter((item) => !unusedLocalCodes.has(item.code)),
      ...(declarative
        ? await unusedFlowDiagnostics(
            checkedProject,
            checked.filter((item) => unusedLocalCodes.has(item.code)),
          )
        : []),
    ];
    const message = (item: Diagnostic): string =>
      [item.text, ...(item.messageChain?.map(message) ?? [])].join("\n");
    if (diagnostics.length)
      throw new Error(
        "TypeScript workflow needs correction:\n" +
          (
            await Promise.all(
              diagnostics.slice(0, 8).map(async (item) => {
                const file = item.fileName && (await program.getSourceFile(item.fileName));
                const location =
                  file && item.pos >= 0 ? file.getLineAndCharacterOfPosition(item.pos) : undefined;
                return `${item.fileName ? path.relative(project, item.fileName) : source.filename}${location ? `:${location.line + 1}:${location.character + 1}` : ""}: ${message(item)}`;
              }),
            )
          ).join("\n"),
      );
  } finally {
    await api.close();
  }
  return source;
}

export async function checkCodeBlocks(project: string, blocks: Library["blocks"]) {
  if (!Object.values(blocks).some((bundle) => bundle.definition.executor?.kind === "code")) return;
  await checkProgram(
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
  const source = await checkProgram(
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
              throw new Error(
                `Removed block module is unavailable: ${path.relative(project, filename)}`,
              );
            }
            const contents = files.get(filename);
            return contents === undefined ? undefined : { contents, loader: "ts" };
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
  if (!built.success) throw new Error(built.logs.map((log) => log.message).join("\n"));
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
    if (serialized.length > 500_000) throw new Error("Composition preview is too large");
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
  if (!Object.values(blocks).some((bundle) => bundle.definition.executor?.kind === "code")) return;
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
  const { source, compiled, structure } = await bundleProgram(project, value, catalog);
  // Temporal's in-memory entrypoint and webpack must use the same spelling of
  // this path (macOS exposes its temporary directory through /var -> /private/var).
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "workflow-compile-")));
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
          modules: [...(config.resolve?.modules ?? []), path.join(installRoot, "node_modules")],
        },
      }),
    });
    const bundle = path.join(directory, "workflow-bundle.js");
    await writeFile(bundle, bundled.code);
    return { source, structure, version: await versions.install(bundle, compiled) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
