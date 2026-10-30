import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { waitForBackend } from "../scripts/dev.js";
test("dev readiness waits for the owned backend and rejects cancelled startup", async (t) => {
  let polls = 0;
  const server = createServer((_request, response) => {
    polls++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ready", pid: polls >= 3 ? 42 : 99 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/health`;
  await waitForBackend(url, 42, AbortSignal.timeout(3000));
  assert.equal(polls, 3);
  await assert.rejects(waitForBackend(url, 100, AbortSignal.timeout(100)));
});
