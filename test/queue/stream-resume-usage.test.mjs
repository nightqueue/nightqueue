import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUsage, sessionBaselines, sumUsage, unpricedSessions } from "../../src/queue/stream.mjs";

const SESSION = "3a01d8d5-c7f5-4dc0-ab80-4915674cf94e";
const MODEL = "claude-haiku-4-5-20251001";

// One `result` line as the CLI printed it in the sandbox replay: `usage` is this invocation's, `modelUsage` and `total_cost_usd` the session's cumulative ones.
function resultLine({ usage, cumulative, cost, session = SESSION }) {
  return JSON.stringify({
    type: "result",
    session_id: session,
    total_cost_usd: cost,
    usage: { input_tokens: usage[0], output_tokens: usage[1], cache_read_input_tokens: usage[2], cache_creation_input_tokens: usage[3] },
    modelUsage: { [MODEL]: { inputTokens: cumulative[0], outputTokens: cumulative[1], cacheReadInputTokens: cumulative[2], cacheCreationInputTokens: cumulative[3], costUSD: cost } },
  });
}

const FIRST = resultLine({ usage: [10, 585, 13203, 15103], cumulative: [10, 585, 13203, 15103], cost: 0.0344613 });
const RESUMED = resultLine({ usage: [10, 272, 28306, 1110], cumulative: [20, 857, 41509, 16213], cost: 0.0408819 });

test("a resumed session's attempt counts only its own invocation once the earlier result of that session is its baseline", () => {
  const usage = extractUsage(RESUMED, { baselines: sessionBaselines(FIRST) });
  assert.deepEqual([usage.tokensIn, usage.tokensOut, usage.cacheRead, usage.cacheCreation], [10, 272, 28306, 1110]);
  assert.ok(Math.abs(usage.costUsd - 0.0064206) < 1e-9, `cost ${usage.costUsd}`);
});

test("without a baseline the cumulative block still wins, as a fresh session's result always did", () => {
  const usage = extractUsage(RESUMED);
  assert.deepEqual([usage.tokensOut, usage.costUsd], [857, 0.0408819]);
  assert.deepEqual(extractUsage(FIRST, { baselines: sessionBaselines(RESUMED.replaceAll(SESSION, "another")) }).tokensOut, 585);
});

test("the baseline of a session is its last result in the log, and a log with no result has none", () => {
  const baselines = sessionBaselines(`noise\n${FIRST}\n{"type":"assistant"}\n${RESUMED}\n`);
  assert.deepEqual(baselines.get(SESSION), { models: { tokensIn: 20, tokensOut: 857, cacheRead: 41509, cacheCreation: 16213 }, costUsd: 0.0408819 });
  assert.equal(sessionBaselines("no events here").size, 0);
});

// One assistant turn of the session, as a spawn killed before its result leaves it in the log.
function assistantLine(id, usage) {
  return JSON.stringify({ type: "assistant", session_id: SESSION, message: { id, usage: { input_tokens: usage[0], output_tokens: usage[1], cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
}

test("a spawn killed before its result is netted out of the resumed session's cumulative block, so the session counts once", () => {
  const killed = `${assistantLine("m1", [5, 60])}\n${assistantLine("m2", [5, 40])}\n`;
  const resumed = resultLine({ usage: [7, 50, 0, 0], cumulative: [17, 150, 0, 0], cost: 0.01 });
  const total = sumUsage([extractUsage(killed), extractUsage(resumed, { baselines: sessionBaselines(killed) })]);
  assert.deepEqual([total.tokensIn, total.tokensOut, total.costUsd], [17, 150, 0.01]);
});

test("a resumed session with no earlier result in the log counts its own invocation and no cost, never the cumulative block", () => {
  const usage = extractUsage(RESUMED, { baselines: sessionBaselines("") });
  assert.deepEqual([usage.tokensOut, usage.costUsd], [272, null]);
  assert.deepEqual(unpricedSessions(usage), [SESSION]);
  assert.deepEqual(extractUsage(RESUMED, { baselines: sessionBaselines(FIRST.replaceAll(SESSION, "another")) }).tokensOut, 272);
});

test("an unpriced resumed attempt is netted against the earlier attempt of the same session in one sum", () => {
  const total = sumUsage([extractUsage(FIRST), extractUsage(RESUMED, { baselines: new Map() })]);
  assert.deepEqual([total.tokensOut], [857]);
  assert.ok(Math.abs(total.costUsd - 0.0408819) < 1e-9, `cost ${total.costUsd}`);
});

test("an earlier result without the per-model block or the cost leaves the resume on its own invocation's tokens and no cost", () => {
  const withoutModels = JSON.stringify({ ...JSON.parse(FIRST), modelUsage: undefined });
  const withoutCost = JSON.stringify({ ...JSON.parse(FIRST), total_cost_usd: undefined });
  assert.equal(extractUsage(RESUMED, { baselines: sessionBaselines(withoutModels) }).tokensOut, 272);
  const usage = extractUsage(RESUMED, { baselines: sessionBaselines(withoutCost) });
  assert.deepEqual([usage.tokensOut, usage.costUsd], [272, null]);
});
