import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedOf, formatTokens, lastCell, liveCell, stoppedReason } from "../../src/queue/last-cell.mjs";

test("the token cell counts the cache, marks an estimate and says `-` before any usage", () => {
  assert.equal(formatTokens({ status: "done", tokens_in: 400, tokens_out: 100, cache_read: 500, cache_creation: 0 }), "1k");
  assert.equal(formatTokens({ status: "done" }), "-");
  const running = { status: "running", live: { tokens: { in: 1_000_000, out: 200_000, cache_read: 0, cache_creation: 0 }, tokens_estimated: true } };
  assert.equal(formatTokens(running), "~1.2M");
});

test("the LAST cell of a running job is the glyph, the intent and the last action", () => {
  assert.equal(liveCell({ agent: "coder", intent: "implement", last: { text: "Edit app.mjs" } }), "⚙️ implement — Edit app.mjs");
  assert.equal(liveCell(null), "-");
  assert.equal(lastCell({ status: "running", live: { agent: "orchestrator", intent: "plan", last: null } }), "» plan");
});

test("a stopped job's LAST cell is its title and the reason it stopped", () => {
  const gate = { status: "gate", title: "fix the worker", notice_md: "\n## Requires user confirmation\nmore" };
  assert.equal(stoppedReason(gate), "## Requires user confirmation");
  assert.equal(lastCell(gate), "fix the worker — ## Requires user confirmation");
  const blocked = { status: "gate", blocked_code: "dirty-tree", result: JSON.stringify({ blocked: { code: "dirty-tree", message: "commit first" } }) };
  assert.deepEqual(blockedOf(blocked), { code: "dirty-tree", message: "commit first" });
  assert.equal(stoppedReason(blocked), "⛔ dirty-tree: commit first");
  assert.equal(lastCell({ status: "pending", title: null }), "-");
});
