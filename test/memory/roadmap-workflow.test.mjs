import assert from "node:assert/strict";
import { test } from "node:test";
import {
  JOB_TO_ROADMAP,
  MANUAL_STATUSES,
  OPEN_STATUSES,
  ROADMAP_STATUSES,
  deriveOrgStatus,
  jobEvent,
  missedCloseSource,
  orgStatusAgrees,
  resultField,
  roadmapTransition,
} from "../../src/memory/roadmap-workflow.mjs";

test("an org item's status derives from its project rows, one assertion per rule", () => {
  assert.equal(deriveOrgStatus([]), null, "no rows keeps the item's own status");
  assert.equal(deriveOrgStatus(["done", "in_progress", "todo"]), "in_progress", "any row in progress");
  assert.equal(deriveOrgStatus(["done", "cancelled"]), "done", "every row done or cancelled");
  assert.equal(deriveOrgStatus(["cancelled", "cancelled"]), "done", "all cancelled derives done");
  assert.equal(deriveOrgStatus(["in_review", "todo", "done"]), "todo", "otherwise the lowest open status");
  assert.equal(deriveOrgStatus(["in_review", "backlog"]), "backlog");
  assert.equal(deriveOrgStatus(["in_review", "done"]), "in_review");
  assert.equal(deriveOrgStatus(["bogus"]), null, "an unknown status is ignored");
});

test("a persisted org status agrees with its derivation when equal or when both are closed", () => {
  assert.equal(orgStatusAgrees("todo", null), true);
  assert.equal(orgStatusAgrees("in_progress", "in_progress"), true);
  assert.equal(orgStatusAgrees("cancelled", "done"), true);
  assert.equal(orgStatusAgrees("todo", "in_progress"), false);
  assert.equal(orgStatusAgrees("done", "in_review"), false);
});

// Every row of the job -> roadmap table: the job row, the status the item last followed, and what the item becomes.
const ROWS = [
  { name: "linked by queue_add", event: "queued", expected: { status: "in_progress", kind: "queued" } },
  { name: "retry from failed", job: { status: "pending" }, seen: "failed", expected: { status: "in_progress", kind: "queued" } },
  { name: "retry from cancelled", job: { status: "pending" }, seen: "cancelled", expected: { status: "in_progress", kind: "queued" } },
  { name: "retry from gate", job: { status: "pending" }, seen: "gate", expected: { status: "in_progress", kind: "queued" } },
  { name: "release or park back to pending", job: { status: "pending" }, seen: "running", expected: { status: "in_progress", kind: null } },
  { name: "claimed", job: { status: "running" }, seen: "pending", expected: { status: "in_progress", kind: null } },
  { name: "gate", job: { status: "gate" }, seen: "running", expected: { status: "in_progress", kind: "gate" } },
  { name: "done", job: { status: "done" }, seen: "running", expected: { status: "in_review", kind: "pr" } },
  { name: "failed", job: { status: "failed" }, seen: "running", expected: { status: "todo", kind: "failed" } },
  { name: "cancelled", job: { status: "cancelled" }, seen: "pending", expected: { status: "todo", kind: "failed" } },
  { name: "closed (its pull request merged)", job: { status: "closed" }, seen: "done", expected: { status: "done", kind: "closed" } },
  { name: "closed, never followed before", job: { status: "closed" }, seen: null, expected: { status: "done", kind: "closed" } },
];

for (const row of ROWS) {
  test(`job -> roadmap: ${row.name}`, () => {
    const actual = row.event ? JOB_TO_ROADMAP[row.event] : roadmapTransition(row.job, row.seen);
    assert.deepEqual({ status: actual.status, kind: actual.kind }, row.expected);
  });
}

test("a close whose `done` the follow never saw replays it, and only then", () => {
  const cancelledFromDone = JSON.stringify({ cancelledFrom: "done" });
  const cancelledFromRunning = JSON.stringify({ cancelledFrom: "running" });
  for (const [job, seen, expected] of [
    [{ status: "closed" }, "running", "done"],
    [{ status: "closed" }, "pending", "done"],
    [{ status: "cancelled", result: cancelledFromDone }, "running", "done"],
    [{ status: "closed" }, "done", null],
    [{ status: "closed" }, "closed", null],
    [{ status: "closed" }, null, null],
    [{ status: "cancelled", result: cancelledFromRunning }, "running", null],
    [{ status: "cancelled", result: "not json" }, "running", null],
    [{ status: "failed" }, "running", null],
  ]) {
    assert.equal(missedCloseSource(job, seen), expected, `${job.status} seen ${seen}`);
  }
});

test("a job status the table does not know moves nothing", () => {
  assert.equal(jobEvent({ status: "merged" }), null);
  assert.equal(jobEvent(null), null);
  assert.deepEqual(roadmapTransition({ status: "bogus" }), { status: null, kind: null });
});

test("every status the table lands on is a roadmap status, and in_progress is the only one kept from the operator", () => {
  for (const { status } of Object.values(JOB_TO_ROADMAP)) assert.ok(ROADMAP_STATUSES.includes(status), status);
  assert.deepEqual(MANUAL_STATUSES, ["backlog", "todo", "in_review", "done", "cancelled"]);
  assert.deepEqual(OPEN_STATUSES, ["backlog", "todo", "in_progress", "in_review"]);
});

test("resultField reads a JSON object field and never throws on a malformed result", () => {
  assert.equal(resultField('{"retriedFrom":7}', "retriedFrom"), 7);
  assert.equal(resultField("not json", "retriedFrom"), null);
  assert.equal(resultField("[1,2]", "retriedFrom"), null);
  assert.equal(resultField(null, "retriedFrom"), null);
});
