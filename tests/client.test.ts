import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { WorkflowClient, WorkflowApiError, waitForRun } from "../src/client/client.js";
import type { WorkflowRun } from "../src/contracts/index.js";

function fetcher(handler: (url: string, options?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(
    (url: Parameters<typeof fetch>[0], options?: RequestInit) => handler(String(url), options),
    { preconnect: fetch.preconnect },
  );
}

test("shared requests preserve prefix, mutation/revision headers, cancellation, and API errors", async () => {
  const controller = new AbortController();
  const client = new WorkflowClient({
    baseUrl: "https://example.test/workflow/",
    headers: { authorization: "Bearer test" },
    fetch: fetcher(async (url, options) => {
      assert.equal(url, "https://example.test/workflow/api/runs/id/approve");
      assert.equal(options?.signal, controller.signal);
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("x-workflow-client"), "1");
      assert.equal(headers.get("if-match"), '"4"');
      assert.equal(headers.get("authorization"), "Bearer test");
      assert.equal(headers.get("content-type"), "application/json");
      return Response.json({ error: "Draft changed" }, { status: 409 });
    }),
  });
  await assert.rejects(
    client.action("id", "approve", 4, controller.signal),
    (error) =>
      error instanceof WorkflowApiError &&
      error.status === 409 &&
      error.message === "Draft changed",
  );
  assert.equal(
    client.url("/api/attachments/id"),
    "https://example.test/workflow/api/attachments/id",
  );
  assert.throws(() => client.url("https://other.test"), /API route/);
});

test("SSE parsing handles fragmented UTF-8, CRLF, heartbeats, and cancellation without a DOM", async () => {
  const event = {
    id: "event",
    runId: "run",
    time: "2026-01-01",
    kind: "text_delta",
    message: "Привіт",
  };
  const bytes = new TextEncoder().encode(
    `: connected\r\n\r\ndata: ${JSON.stringify(event)}\r\n\r\n: heartbeat\n\n`,
  );
  let cancelled = false;
  const client = new WorkflowClient({
    fetch: fetcher(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    ),
  });
  const stream = client.stream();
  assert.deepEqual((await stream.next()).value, event);
  await stream.return(undefined);
  assert.equal(cancelled, true);
});

test("request validation catches incompatible responses and non-JSON failures", async () => {
  const malformed = new WorkflowClient({
    fetch: fetcher(async () => Response.json({ result: 42 })),
  });
  await assert.rejects(
    malformed.request("/api/test", z.object({ result: z.string() })),
    z.ZodError,
  );
  const unavailable = new WorkflowClient({
    fetch: fetcher(async () => new Response("bad gateway", { status: 502 })),
  });
  await assert.rejects(unavailable.runs(), /Request failed \(502\)/);
});

test("waiting stops on completed/failed/paused/interrupted and respects cancellation", async () => {
  for (const status of ["completed", "failed", "paused", "interrupted"] as const) {
    let reads = 0;
    const run = await waitForRun(
      () => ({ revision: ++reads, status: reads === 1 ? "running" : status }) as WorkflowRun,
      { intervalMs: 1 },
    );
    assert.equal(run.status, status);
    assert.equal(reads, 2);
  }
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(
    waitForRun(
      () => {
        throw new Error("must not read");
      },
      { signal: controller.signal },
    ),
    /stop/,
  );
});
