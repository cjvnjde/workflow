import path from "node:path";
import ts from "typescript";
import {
  createParsedCommandLine,
  createVueLanguagePlugin,
  getAllExtensions,
} from "@vue/language-core";
import { proxyCreateProgram } from "@volar/typescript/lib/node/proxyCreateProgram.js";

// vue-tsc's CLI patches Node's CommonJS file loader, which Bun does not use.
// Call the same Vue/TypeScript language engine directly so templates are checked
// on Bun too. No wildcard .vue shim: that would silently erase component types.
const configPath = path.resolve(process.argv[2] ?? "tsconfig.json");
const vue = createParsedCommandLine(ts, ts.sys, configPath);
const source = ts.readConfigFile(configPath, ts.sys.readFile);
const config = ts.parseJsonConfigFileContent(
  source.config,
  ts.sys,
  path.dirname(configPath),
  {},
  configPath,
  undefined,
  getAllExtensions(vue.vueOptions).map((extension) => ({
    extension,
    isMixedContent: true,
    scriptKind: ts.ScriptKind.Deferred,
  })),
);
const options: ts.CompilerOptions = {
  ...config.options,
  noEmit: true,
  allowNonTsExtensions: true,
};
const createProgram = proxyCreateProgram(ts, ts.createProgram, () => ({
  languagePlugins: [
    createVueLanguagePlugin(ts, options, vue.vueOptions, (id: string) => id),
  ],
}));
const program = createProgram({
  rootNames: config.fileNames,
  options,
  host: ts.createCompilerHost(options),
  projectReferences: config.projectReferences,
});
const diagnostics = [
  ...(source.error ? [source.error] : []),
  ...config.errors,
  ...ts.getPreEmitDiagnostics(program),
];
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getCanonicalFileName: (file) => file,
      getNewLine: () => ts.sys.newLine,
    }),
  );
}
process.exitCode = diagnostics.some(
  (item) => item.category === ts.DiagnosticCategory.Error,
)
  ? 1
  : 0;
