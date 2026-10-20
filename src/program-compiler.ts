import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { bundleWorkflowCode, DefaultLogger } from "@temporalio/worker";
import { programSourceSchema, type ProgramSource } from "./program-schema.js";
import type { WorkflowVersions } from "./workflow-versions.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const installRoot = path.dirname(dist);
const sdkTypes = path.join(dist, "workflow-sdk.d.ts");
const sdkModule = path.join(dist, "workflow-sdk.js");
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
const apiModules = new Set(["workflow", "predictable-workflow/workflow"]);

/** Typecheck without importing/evaluating the user's module or running its code. */
export function checkProgram(project: string, value: unknown): ProgramSource {
  const source = programSourceSchema.parse(value);
  const filename = path.resolve(project, source.filename);
  const entry = `${filename}.check.ts`;
  const virtual = new Map([
    [filename, source.source],
    [entry, `import definition from ${JSON.stringify(`./${path.basename(filename)}`)};\nimport type { WorkflowDefinition } from "workflow";\nconst checked: WorkflowDefinition<any> = definition;\nexport default checked;\n`],
  ]);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true,
    types: [], lib: ["lib.es2023.d.ts"], esModuleInterop: true,
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host), exists = host.fileExists.bind(host);
  host.readFile = file => virtual.get(path.resolve(file)) ?? read(file);
  host.fileExists = file => virtual.has(path.resolve(file)) || exists(file);
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    if (apiModules.has(name)) return { resolvedFileName: sdkTypes, extension: ts.Extension.Dts };
    return ts.resolveModuleName(name, containingFile, options, host).resolvedModule ??
      ts.resolveModuleName(name, path.join(installRoot, "__workflow_types.ts"), options, host).resolvedModule;
  });
  const program = ts.createProgram([entry], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length) throw new Error("TypeScript workflow needs correction:\n" + diagnostics.slice(0, 8).map(item => {
    const location = item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start) : undefined;
    return `${item.file ? path.relative(project, item.file.fileName) : source.filename}${location ? `:${location.line + 1}:${location.character + 1}` : ""}: ${ts.flattenDiagnosticMessageText(item.messageText, "\n")}`;
  }).join("\n"));
  return source;
}

export async function compileProgram(project: string, value: unknown, versions: WorkflowVersions) {
  const source = checkProgram(project, value);
  const filename = path.resolve(project, source.filename);
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-compile-"));
  try {
    const built = await Bun.build({
      entrypoints: [filename], target: "browser", format: "cjs",
      plugins: [{
        name: "workflow-source",
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (apiModules.has(args.path)) return { path: sdkModule };
            if (args.path.startsWith("node:") || builtins.has(args.path)) {
              throw new Error(`Host module "${args.path}" belongs inside an agent or script step. Orchestration must be replayable.`);
            }
            if (path.resolve(args.resolveDir || project, args.path) === filename) return { path: filename };
            return undefined;
          });
          build.onLoad({ filter: /.*/ }, args => path.resolve(args.path) === filename
            ? { contents: source.source, loader: "ts" } : undefined);
        },
      }],
    });
    if (!built.success) throw new Error(built.logs.map(log => log.message).join("\n"));
    const compiled = await built.outputs[0]!.text();
    const entry = path.join(directory, "entry.js");
    await writeFile(entry, [
      `import { executeProgram } from ${JSON.stringify(path.join(dist, "program-runtime.js"))};`,
      // Evaluate module initializers inside the durable workflow's error
      // boundary. A thrown helper/definition error becomes a visible failed
      // run instead of an endlessly failing Temporal module activation.
      `function loadProgram() { const module = { exports: {} }; const exports = module.exports;\n${compiled}\nreturn module.exports.default; }`,
      `export async function executeWorkflow(input) { return await executeProgram(input, loadProgram); }`,
    ].join("\n"));
    const bundled = await bundleWorkflowCode({
      workflowsPath: entry, logger: new DefaultLogger("ERROR"),
      webpackConfigHook: config => ({
        ...config,
        resolve: { ...config.resolve, modules: [...(config.resolve?.modules ?? []), path.join(installRoot, "node_modules")] },
      }),
    });
    const bundle = path.join(directory, "workflow-bundle.js");
    await writeFile(bundle, bundled.code);
    return { source, version: await versions.install(bundle) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
