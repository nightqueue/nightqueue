import assert from "node:assert/strict";
import { test } from "node:test";
import { decorateSnapshot } from "../../src/studio/rows.mjs";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const STORE = { issues: { issueRefOfJob: async () => null } };

// The studio cells decorateSnapshot derives for one done job with the given close fields.
async function cellsOf(fields) {
  const job = { id: 7, status: "done", close_status: null, close_lease_until: null, close: null, ...fields };
  const answer = await decorateSnapshot({ jobs: [job], runners: [] }, { env: {}, store: STORE, itemRefs: new Map(), nowMs: NOW });
  return answer.jobs[0].studio;
}

test("a done job whose close failed carries close_state failed and the short `close failed` label", async () => {
  const cells = await cellsOf({ close_status: "failed" });
  assert.equal(cells.close_state, "failed");
  assert.equal(cells.status_label, "close failed");
  assert.equal(cells.closing, false);
});

test("a closing job whose lease died carries close_state stalled and the `close stalled` label", async () => {
  const cells = await cellsOf({ close_status: "closing", close_lease_until: "2026-01-01T11:00:00Z" });
  assert.equal(cells.close_state, "stalled");
  assert.equal(cells.status_label, "close stalled");
});

test("a done job never closed carries a null close_state and its own status", async () => {
  const cells = await cellsOf({});
  assert.equal(cells.close_state, null);
  assert.equal(cells.status_label, "done");
});
