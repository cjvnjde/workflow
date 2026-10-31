import assert from "node:assert/strict";
import { test } from "vitest";
import { stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./helpers.js";
import { acquireProjectLock } from "../src/infrastructure/project-lock.js";
import { LibraryProposals } from "../src/core/library/library-proposals.js";

// This previously crashed the process when the next server heartbeat ran:
// separate lockfilePath values still collided on the same config.json target.
test("applying library changes preserves the running server lease and heartbeat", async (t) => {
  const { project, library } = await fixture(t);
  let compromised: Error | undefined;
  const release = await acquireProjectLock(project, (error) => {
    compromised = error;
  });
  const lease = path.join(project, ".workflow", "server-lease");
  try {
    const before = (await stat(lease)).mtimeMs;
    const proposals = new LibraryProposals(project);
    const bundle = structuredClone(library.blocks.review!);
    bundle.prompt = "Review only the explicit acceptance criteria.";
    const proposal = await proposals.create(
      library,
      "manual",
      {
        summary: "Update review instructions while the server is running",
        blocks: [{ bundle, rationale: "Regression coverage for independent leases" }],
      },
      [],
    );
    await proposals.apply(proposal.id, []);
    await delay(1200);
    assert.equal(compromised, undefined);
    assert.ok(
      (await stat(lease)).mtimeMs > before,
      "server lease continues renewing after the library write lease releases",
    );
  } finally {
    await release();
  }
  await assert.rejects(stat(lease), { code: "ENOENT" });
});
