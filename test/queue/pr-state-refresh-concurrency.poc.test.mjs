import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrStateCache } from "../../src/queue/pr-state.mjs";

// A viewImpl that holds every call open briefly and records the historical max of concurrent calls.
function trackedViewImpl(delayMs) {
  let current = 0;
  let max = 0;
  const resolvedUrls = new Set();
  const impl = async (url) => {
    current += 1;
    max = Math.max(max, current);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      resolvedUrls.add(url);
      return { ok: true, state: "OPEN", mergedAt: null, mergeable: "MERGEABLE", isDraft: false };
    } finally {
      current -= 1;
    }
  };
  impl.maxConcurrent = () => max;
  impl.resolvedCount = () => resolvedUrls.size;
  return impl;
}

test("refresh() caps concurrent gh spawns and still resolves every distinct pull request", async () => {
  const urlCount = 30;
  const urls = Array.from({ length: urlCount }, (_, index) => `https://github.com/acme/api/pull/${index + 1}`);
  const view = trackedViewImpl(20);
  const cache = createPrStateCache({ viewImpl: view });

  await cache.refresh(urls, {});

  assert.ok(view.maxConcurrent() <= 8, `historical max concurrency was ${view.maxConcurrent()}, expected <= 8`);
  assert.equal(view.resolvedCount(), urlCount, "not every distinct pull request was resolved");
});
