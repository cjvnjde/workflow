import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Bun typechecking rejects Vue script, template and component prop errors", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "workflow-vue-types-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "tsconfig.json");
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "preserve",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
        paths: { vue: [path.join(root, "node_modules/vue")] },
      },
      vueCompilerOptions: { strictTemplates: true },
      include: ["*.vue"],
    }),
  );
  await writeFile(
    path.join(directory, "Child.vue"),
    '<script setup lang="ts">defineProps<{ count: number }>();</script><template><p>{{ count }}</p></template>',
  );
  const parent = path.join(directory, "Parent.vue");
  const check = async () => {
    const child = Bun.spawn(
      [process.execPath, path.join(root, "scripts/typecheck.ts"), config],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      code,
      output: `${stdout}${stderr}`.replace(/\x1b\[[0-9;]*m/g, ""),
    };
  };
  await writeFile(
    parent,
    `<script setup lang="ts">
import Child from './Child.vue';
const count: number = 'invalid';
</script>
<template><Child :count="'wrong prop'" /><p>{{ count.toUpperCase() }}</p></template>`,
  );
  const invalid = await check();
  assert.equal(invalid.code, 1, invalid.output);
  assert.match(
    invalid.output,
    /Type 'string' is not assignable to type 'number'/,
  );
  assert.match(invalid.output, /toUpperCase/);
  assert.match(invalid.output, /wrong prop/);
  await writeFile(
    parent,
    `<script setup lang="ts">
import Child from './Child.vue';
const count: number = 1;
</script>
<template><Child :count="count" /><p>{{ count.toFixed(0) }}</p></template>`,
  );
  const valid = await check();
  assert.equal(valid.code, 0, valid.output);
});
