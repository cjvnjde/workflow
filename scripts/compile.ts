import { $ } from "bun";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep runtime module paths intact: Temporal's compiler, native libraries and
// workers load files dynamically and cannot all be flattened into a JS bundle.
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-compile-"));
try {
  const runtime = path.join(directory, "runtime");
  await cp(path.join(root, "dist"), path.join(runtime, "dist"), {
    recursive: true,
    filter: (source) => !["workflow", "workflow.exe"].includes(path.basename(source)),
  });
  const { name, version, type, dependencies, devDependencies } = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  await writeFile(
    path.join(runtime, "package.json"),
    JSON.stringify({ name, version, type, dependencies, devDependencies }),
  );
  await cp(path.join(root, "bun.lock"), path.join(runtime, "bun.lock"));
  await $`${process.execPath} install --production`.cwd(runtime);
  const archive = path.join(directory, "runtime.tgz");
  await $`tar -czf ${archive} -C ${runtime} package.json dist node_modules`;
  const id = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const entry = path.join(directory, "main.ts");
  await writeFile(
    entry,
    `import archive from "./runtime.tgz" with {type:"file"};
import {runStandalone} from ${JSON.stringify(path.join(root, "src/cli/standalone.ts"))};
await runStandalone(archive, ${JSON.stringify(id)});
`,
  );
  const outfile = path.join(
    root,
    "dist",
    process.platform === "win32" ? "workflow.exe" : "workflow",
  );
  const result = await Bun.build({
    entrypoints: [entry],
    compile: { outfile, autoloadPackageJson: true },
    minify: true,
  });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  console.log(
    `Built ${outfile} for ${process.platform}/${process.arch}. Move this file wherever you need it.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
