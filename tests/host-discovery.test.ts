import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { announceProjectServer, discoverProjectServer } from "../src/host-discovery.js";
import { fixture } from "./helpers.js";

test("host discovery keeps only loopback endpoints for the same project and respects ownership", async t => {
  const { project } = await fixture(t);
  const removeFirst = await announceProjectServer(project, "http://127.0.0.1:46001");
  assert.equal(await discoverProjectServer(project), "http://127.0.0.1:46001");
  const removeSecond = await announceProjectServer(project, "http://127.0.0.1:46002");
  await removeFirst();
  assert.equal(await discoverProjectServer(project), "http://127.0.0.1:46002");
  await removeSecond();
  assert.equal(await discoverProjectServer(project), undefined);

  await announceProjectServer(project, "https://untrusted.example");
  assert.equal(await discoverProjectServer(project), undefined);
  const filename = path.join(project, ".workflow", "server.json");
  const endpoint = JSON.parse(await readFile(filename, "utf8"));
  for (const url of ["http://user:password@localhost:1234", "http://localhost:1234/proxy", "http://localhost:1234?token=secret"]) {
    await writeFile(filename, JSON.stringify({ ...endpoint, url }));
    assert.equal(await discoverProjectServer(project), undefined);
  }
  await writeFile(filename, JSON.stringify({ ...endpoint, url: "http://127.0.0.1:46001", project: "/tmp" }));
  assert.equal(await discoverProjectServer(project), undefined);
});
