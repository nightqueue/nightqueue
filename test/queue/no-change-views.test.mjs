import assert from "node:assert/strict";
import { test } from "node:test";
import { isNoChangeJob, jobView, VIEW_TEXT_LIMIT } from "../../src/memory/jobs.mjs";
import { ABANDONED_COMMAND_PREFIX, NO_CHANGE_NEXT_STEP_LINE, NOTHING_TO_CLOSE_LINE, STRAY_PR_PREFIX } from "../../src/queue/classify.mjs";
import { POST_CLOSE_PREFIX, resolvedLine } from "../../src/queue/close-view.mjs";
import { lastCell, stoppedReason } from "../../src/queue/last-cell.mjs";
import { DISABLED_BACKGROUND_ESCAPE_LINE, runOwnNotice, withoutRuntimeAppendedLines } from "../../src/queue/run-notice.mjs";
import { KEPT_PREFIX } from "../../src/queue/worktree.mjs";
import { decorateSnapshot } from "../../src/studio/rows.mjs";

const PR_URL = "https://github.com/acme/api/pull/7";
const CONCLUSION = "✅ Resolved — no code change needed\n\nThe cause is a CDN rule.";
const MARKED = JSON.stringify({ status: "done", resolution: "no-change" });
const RESOLVED_CLOSE = JSON.stringify({ data: { resolvedWithoutChange: true } });
const STRAY_LINE = `${STRAY_PR_PREFIX}https://github.com/acme/web/pull/9; no pull request of this run's own branch was found`;

test("resolvedLine names the day the job was resolved without change", () => {
  assert.equal(resolvedLine({ at: "2026-10-14T23:59:00.000Z" }), "Closed: resolved without change on 2026-10-14");
});

test("only a done job carrying the no-change marker or a closed one whose checklist records it is the no-change kind; a missing pull request alone never is", () => {
  const cases = [
    [{ status: "done", pr_url: null, result: MARKED }, true],
    [{ status: "done", pr_url: "  ", result: MARKED }, true],
    [{ status: "done", pr_url: null, result: { resolution: "no-change" } }, true],
    [{ status: "closed", pr_url: null, close: RESOLVED_CLOSE }, true],
    [{ status: "closed", pr_url: null, close: { data: { resolvedWithoutChange: true } } }, true],
    [{ status: "done", pr_url: null }, false],
    [{ status: "done", pr_url: null, result: null }, false],
    [{ status: "done", pr_url: null, result: JSON.stringify({ status: "done" }) }, false],
    [{ status: "done", pr_url: null, result: "{not json" }, false],
    [{ status: "closed", pr_url: null }, false],
    [{ status: "closed", pr_url: null, close: JSON.stringify({ data: { resolvedWithoutChange: false } }) }, false],
    [{ status: "done", pr_url: PR_URL, result: MARKED }, false],
    [{ status: "closed", pr_url: PR_URL, close: RESOLVED_CLOSE }, false],
    [{ status: "cancelled", pr_url: null, result: MARKED }, false],
    [{ status: "failed", pr_url: null, result: MARKED }, false],
    [{ status: "pending", pr_url: null }, false],
    [null, false],
  ];
  for (const [row, expected] of cases) {
    assert.equal(isNoChangeJob(row), expected, JSON.stringify(row));
    if (row && typeof row.result !== "object" && typeof row.close !== "object") {
      assert.equal(jobView({ id: 1, ...row }).resolution, expected ? "no-change" : null, JSON.stringify(row));
    }
  }
});

test("the run's own notice drops every line the runtime appended, the next-step line and a stray pull request in any trailing order, and keeps the headline", () => {
  const appended = [
    `${KEPT_PREFIX}/tmp/wt - dirty.`,
    STRAY_LINE,
    NO_CHANGE_NEXT_STEP_LINE,
    DISABLED_BACKGROUND_ESCAPE_LINE,
    `${ABANDONED_COMMAND_PREFIX}npm test`,
    `${POST_CLOSE_PREFIX}log warning - x`,
    NOTHING_TO_CLOSE_LINE,
  ];
  for (const order of [appended, [...appended].reverse()]) {
    assert.equal(runOwnNotice(`${CONCLUSION}\n\n${order.join("\n\n")}`), CONCLUSION);
  }
  assert.ok(runOwnNotice(`${CONCLUSION}\n\n${NO_CHANGE_NEXT_STEP_LINE}`).startsWith("✅ Resolved — no code change needed"));
  assert.equal(withoutRuntimeAppendedLines(`${CONCLUSION}\n\n${appended[0]}`), CONCLUSION);
  assert.equal(withoutRuntimeAppendedLines(`${CONCLUSION}\n\n${NO_CHANGE_NEXT_STEP_LINE}`), CONCLUSION);
  assert.equal(withoutRuntimeAppendedLines(`${CONCLUSION}\n\n${STRAY_LINE}`), `${CONCLUSION}\n\n${STRAY_LINE}`, "the view set a stray pull request line aside");
  assert.equal(runOwnNotice(appended[0]), null);
  assert.equal(runOwnNotice(null), null);
});

test("LAST tells how to close a done job resolved without change and says a closed one closed without change", () => {
  const done = { id: 12, status: "done", pr_url: null, result: MARKED, notice_md: CONCLUSION, title: "fix the loop" };
  assert.equal(stoppedReason(done), "resolved without change - close it with nightqueue queue close J-12");
  assert.equal(lastCell(done), "fix the loop — resolved without change - close it with nightqueue queue close J-12");
  assert.equal(stoppedReason({ ...done, status: "closed", close: RESOLVED_CLOSE }), "closed without change");
  assert.equal(stoppedReason({ ...done, pr_url: PR_URL }), null, "a done job with a pull request got the no-change reason");
  assert.equal(stoppedReason({ ...done, result: null }), null, "a done job with no pull request and no marker got the no-change reason");
});

test("LAST of a job view keeps the no-change reason when the view truncated the result that carries the marker", () => {
  const files = Array.from({ length: 60 }, (_, index) => `src/module-${index}.mjs`);
  const result = JSON.stringify({ status: "done", files, resolution: "no-change" });
  assert.ok(result.length > VIEW_TEXT_LIMIT, "the fixture result is not long enough to be truncated");
  const view = jobView({ id: 13, status: "done", pr_url: null, result, notice_md: CONCLUSION });
  assert.equal(view.result_truncated, true);
  assert.equal(stoppedReason(view), "resolved without change - close it with nightqueue queue close J-13");
});

test("the studio rows carry the no-change reason and the resolution of the job", async () => {
  const jobs = [
    jobView({ id: 3, status: "done", pr_url: null, result: MARKED, notice_md: CONCLUSION }),
    jobView({ id: 4, status: "closed", pr_url: null, close: RESOLVED_CLOSE }),
    jobView({ id: 5, status: "done", pr_url: null, notice_md: CONCLUSION }),
  ];
  const snapshot = await decorateSnapshot({ jobs, runners: [] }, { env: { NIGHTQUEUE_HOME: "/nonexistent-nightqueue-home" } });
  assert.deepEqual(
    snapshot.jobs.map((job) => [job.resolution, job.studio.reason]),
    [
      ["no-change", "resolved without change - close it with nightqueue queue close J-3"],
      ["no-change", "closed without change"],
      [null, null],
    ],
  );
});
