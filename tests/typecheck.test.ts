import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Bun typechecking rejects React source, JSX and component prop errors", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-react-types-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "tsconfig.json");
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
        paths: {
          react: [path.join(root, "node_modules/@types/react")],
          "react/*": [path.join(root, "node_modules/@types/react/*")],
        },
      },
      include: ["*.tsx"],
    }),
  );
  await writeFile(
    path.join(directory, "Child.tsx"),
    "export default function Child({ count }: { count: number }) { return <p>{count}</p>; }",
  );
  const parent = path.join(directory, "Parent.tsx");
  const check = async () => {
    const child = Bun.spawn([process.execPath, path.join(root, "scripts/typecheck.ts"), config], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output: `${stdout}${stderr}` };
  };
  await writeFile(
    parent,
    `import Child from './Child';
const count: number = 'invalid';
export default function Parent() {
  return <><Child count="wrong prop" /><p>{count.toUpperCase()}</p><unknownFixtureElement /></>;
}`,
  );
  const invalid = await check();
  assert.notEqual(invalid.code, 0, invalid.output);
  assert.equal(invalid.output.match(/TS2322/g)?.length, 2, invalid.output);
  assert.match(invalid.output, /toUpperCase/);
  assert.match(invalid.output, /unknownFixtureElement/);
  await writeFile(
    parent,
    `import Child from './Child';
const count: number = 1;
export default function Parent() {
  return <><Child count={count} /><p>{count.toFixed(0)}</p></>;
}`,
  );
  const valid = await check();
  assert.equal(valid.code, 0, valid.output);
});
