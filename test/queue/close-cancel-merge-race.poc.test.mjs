// QA PoC (Group B, job 66): a real merge racing `queue cancel` can vanish from the record.
//
// Scenario: worker A holds the close lease and has already squash-merged the PR on GitHub -
// it built a checklist with `data.merged=true`/`mergeSha` (exactly what `settleClose` would be
// given). Before A persists that checklist, its lease dies (simulated deterministically by
// forcing `close_lease_until` into the past with one raw UPDATE, standing in for the lease
// expiring while the `gh pr merge` call was in flight). An operator calls `queue cancel` in that
// window - `cancelJob`'s WHERE only reads whether the close lease is *currently* live, so it
// succeeds and wipes `close_status`/`close_worker`. Only then does A call `recordCloseStep` with
// the merge it already produced.
//
// From the operator's point of view: the PR really is merged on GitHub, but the row nightshift
// can show is `cancelled`, its `close` column never records the merge - a real, already-happened
// external state (merged) is invisible on `queue status`. That is the break: not "cancel fails",
// but "a done job vanishes from the merged-checklist record after nightshift itself already saw
// the merge succeed".
import assert from "node:assert/strict";
import test from "node:test";
import { makeHome, mergedChecklist, seedDoneJob } from "../../test-support/memory.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, cancelJob, getJob, recordCloseStep } from "../../src/memory/jobs.mjs";

const WORKER_A = "test:worker-a";

test("a merge A already produced is not silently lost when cancel races a dying close lease", (t) => {
  const env = makeHome(t, "close-cancel-merge-race");
  const id = seedDoneJob(env);

  // A takes the close lease for a real attempt.
  const leased = acquireClose(id, { worker: WORKER_A, leaseS: 60 }, env);
  assert.ok(leased, "setup: A must hold the close lease");
  assert.equal(leased.close_status, "closing");

  // A's merge step already succeeded against GitHub; this is exactly the checklist shape
  // `settleClose` is later given (data.merged / data.mergeSha / data.noticeLine), built directly
  // without running the real gh pipeline (per the brief: no fake gh call needed for this race).
  const mergedByA = mergedChecklist(7);
  assert.equal(mergedByA.data.merged, true, "setup: A's own checklist records the merge it already did");

  // The lease dies (e.g. the gh call took long enough to outlive it) - forced deterministically,
  // no wall-clock wait, via one raw UPDATE. This never touches close_status/close_worker, only
  // the lease timestamp, so it stands in purely for time passing.
  const db = openDb(env);
  db.prepare("UPDATE jobs SET close_lease_until = datetime('now', '-1 seconds') WHERE id = ?").run(id);
  const beforeCancel = getJob(id, env);
  assert.equal(beforeCancel.close_status, "closing", "setup: still marked closing, only the lease timestamp died");

  // An operator, seeing what looks like a stalled close, cancels the job.
  // Fix: an interrupted close is never cancelled blind - the cancel is refused and writes nothing.
  assert.throws(() => cancelJob(id, { reason: "operator: looked stalled" }, env), /has an interrupted close/);
  assert.deepEqual(getJob(id, env), beforeCancel, "the refused cancel must leave the row unchanged");

  // A, still the recorded closer, persists the merge it already did.
  const recorded = recordCloseStep(id, { worker: WORKER_A, close: mergedByA, leaseS: 60 }, env);
  assert.equal(recorded, true, "A is still the recorded closer, so its merge is recorded");

  // The break: the merge that genuinely happened on GitHub must still be visible on the job
  // nightshift can show - it must not silently vanish because the persist lost a race with cancel.
  const finalRow = getJob(id, env);
  const finalClose = JSON.parse(finalRow.close ?? "{}");
  assert.equal(
    finalClose?.data?.merged,
    true,
    `the operator's record must show the merge that already happened, but the job is left ` +
      `\`${finalRow.status}\` with close=${finalRow.close} - a real merge is invisible on \`queue status\``,
  );
});
