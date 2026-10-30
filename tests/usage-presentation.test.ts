import assert from "node:assert/strict";
import test from "node:test";
import { usageCost, usageTokens } from "../web/usage-presentation.js";

test("unpriced or incomplete usage is never presented as free", () => {
  assert.equal(usageCost({ costUsd: 0, unpricedRequests: 2 }), "Unknown");
  assert.equal(usageCost({ costUsd: 0, unpricedRequests: 0 }, true), "Unknown");
  assert.equal(
    usageCost({ costUsd: 0.0123, unpricedRequests: 1 }),
    "At least $0.0123",
  );
  assert.equal(
    usageCost({ costUsd: 0.0123, unpricedRequests: 0 }, true),
    "At least $0.0123",
  );
  assert.equal(usageCost({ costUsd: 0, unpricedRequests: 0 }), "$0.0000");
  assert.equal(
    usageCost({ costUsd: 0.000001, unpricedRequests: 0 }),
    "less than $0.0001",
  );
  assert.doesNotMatch(
    usageCost({ costUsd: 0.000001, unpricedRequests: 1 }),
    /\$0\.0000/,
  );
});

test("usage token count includes separately reported cached tokens", () => {
  assert.equal(
    usageTokens({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      costUsd: 0,
      requests: 1,
      unpricedRequests: 0,
    }),
    38,
  );
});
