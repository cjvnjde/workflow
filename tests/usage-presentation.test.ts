import assert from "node:assert/strict";
import test from "node:test";
import { usageCost, usageTokens } from "../web/features/usage/usage-presentation.js";

test("unpriced or incomplete usage is never presented as free", () => {
  assert.equal(usageCost({ costUsd: 0, unpricedRequests: 2 }), "Unknown");
  assert.equal(usageCost({ costUsd: 0, unpricedRequests: 0 }, true), "Unknown");
  assert.equal(usageCost({ costUsd: 0.0123, unpricedRequests: 1 }), "At least $0.0123");
  assert.equal(usageCost({ costUsd: 0.0123, unpricedRequests: 0 }, true), "At least $0.0123");
  assert.equal(usageCost({ costUsd: 0, unpricedRequests: 0 }), "$0.0000");
  assert.equal(usageCost({ costUsd: 0.000001, unpricedRequests: 0 }), "less than $0.0001");
  assert.doesNotMatch(usageCost({ costUsd: 0.000001, unpricedRequests: 1 }), /\$0\.0000/);
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

test("each token category is counted once, including when all other counts are zero", () => {
  const empty = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    requests: 0,
    unpricedRequests: 0,
  };
  assert.equal(usageTokens(empty), 0);
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    assert.equal(usageTokens({ ...empty, [key]: 7 }), 7, key);
  }
});

test("usage cost preserves the display threshold and discloses partial pricing", () => {
  for (const costUsd of [0.000001, 0.00009999]) {
    assert.equal(usageCost({ costUsd, unpricedRequests: 0 }), "less than $0.0001");
    assert.equal(usageCost({ costUsd, unpricedRequests: 1 }), "Partial amount recorded");
    assert.equal(usageCost({ costUsd, unpricedRequests: 0 }, true), "Partial amount recorded");
  }
  assert.equal(usageCost({ costUsd: 0.0001, unpricedRequests: 0 }), "$0.0001");
  assert.equal(usageCost({ costUsd: 0.0001, unpricedRequests: 1 }), "At least $0.0001");
  assert.equal(usageCost({ costUsd: 0.0001, unpricedRequests: 0 }, true), "At least $0.0001");
  assert.equal(usageCost({ costUsd: 12.34567, unpricedRequests: 0 }), "$12.3457");
  assert.equal(usageCost({ costUsd: 12.34567, unpricedRequests: 2 }), "At least $12.3457");
});
