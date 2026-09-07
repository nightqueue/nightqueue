import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUsage } from "../../src/queue/stream.mjs";
import { modelUsageBlock, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

// H2: a result event whose snake_case aggregate reports only ONE field (input_tokens), with
// every other field absent, while the SAME event carries a complete camelCase modelUsage
// breakdown. resultUsage() picks the aggregate as soon as it sums above zero, so a truncated
// aggregate wins over a complete modelUsage block and the total loses the output/cache tokens
// modelUsage actually had. Built by hand (not via resultEvent/usageBlock) because both helpers
// always fill in all four fields, and this vector needs a partial block to exist at all.
test("a partial aggregate usage block must not shadow a complete modelUsage breakdown", () => {
  const partialAggregateResult = {
    type: "result",
    subtype: "success",
    session_id: "sess-partial01",
    result: "done",
    total_cost_usd: 0.3,
    usage: { input_tokens: 5 },
    modelUsage: modelUsageBlock({ tokensIn: 900, tokensOut: 120, cacheRead: 40, cacheCreation: 15 }),
  };
  const stream = toNdjson([systemInitEvent({ sessionId: "sess-partial01" }), partialAggregateResult]);

  const usage = extractUsage(stream);
  assert.deepEqual(
    usage,
    {
      tokensIn: 900,
      tokensOut: 120,
      cacheRead: 40,
      cacheCreation: 15,
      costUsd: 0.3,
      sessions: 1,
      estimated: false,
    },
    "the truncated aggregate (input_tokens only) won over the complete modelUsage breakdown, losing tokensOut/cacheRead/cacheCreation",
  );
});
