import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STRAY_PR_PREFIX, classifyJobResult } from "../../src/queue/classify.mjs";
import { codeChangePublishedEvent, GATE_NOTICE, gateStream, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const REPO = "maykonVinicius/nightshift";
const QA_PR = "https://github.com/maykonVinicius/nightshift/pull/71";
const OWN_PR = "https://github.com/maykonVinicius/nightshift/pull/72";
const QA_BRANCH = "scratch/close-qa-20260921201325";
const RUN_BRANCH = "worktree-feat+queue-close";
const FINAL_TEXT = "Phase 7 done.";

// The job 57 publication: the runtime QA's own scratch pull request, opened in the run's repository; `branch: null` is a host that names none.
function qaPublication({ branch = QA_BRANCH, url = QA_PR } = {}) {
  return codeChangePublishedEvent({ url, repo: REPO, identifier: url.split("/").at(-1), branch: branch ?? undefined });
}

// A clean run whose only host publication is the given one.
function logWith(publication) {
  return toNdjson([systemInitEvent(), publication, resultEvent({ text: FINAL_TEXT })]);
}

// A state.json of a run on the given branch, with the pull request `run pr` recorded (or none), or no outcome at all.
function runState({ branch = RUN_BRANCH, prUrl = OWN_PR, recorded = true } = {}) {
  const base = { schemaVersion: 1, slug: "queue-close", type: "feature/refactor", branch, phases: [] };
  if (!recorded) return base;
  return { ...base, outcome: prUrl ? { status: "done", prUrl } : { status: "done" } };
}

// The flag line the notice must end with.
function strayLine({ url = QA_PR, branch = QA_BRANCH, recorded = OWN_PR } = {}) {
  const on = branch ? ` on branch \`${branch}\`` : "";
  const instead = recorded ? `; recorded instead: ${recorded}` : "; no pull request of this run's own branch was found";
  return `${STRAY_PR_PREFIX}${url}${on}${instead}`;
}

test("job 57: a QA publication on another branch of the same repository never replaces the run's own recorded pull request", () => {
  const outcome = classifyJobResult({ log: logWith(qaPublication()), exitCode: 0, state: runState() });

  assert.equal(outcome.prUrl, OWN_PR, "the QA scratch pull request was recorded as the job's delivery");
  assert.equal(outcome.status, "done");
  assert.ok(outcome.noticeMd.endsWith(strayLine()), outcome.noticeMd);
});

test("a publication naming no branch still loses to the runtime record, and is flagged", () => {
  const outcome = classifyJobResult({ log: logWith(qaPublication({ branch: null })), exitCode: 0, state: runState() });

  assert.equal(outcome.prUrl, OWN_PR);
  assert.ok(outcome.noticeMd.endsWith(strayLine({ branch: null })), outcome.noticeMd);
});

test("a publication on the run's own branch, under its published name, still wins over the record without a flag", () => {
  const published = "https://github.com/maykonVinicius/nightshift/pull/73";
  const outcome = classifyJobResult({ log: logWith(qaPublication({ branch: "feat/queue-close", url: published })), exitCode: 0, state: runState() });

  assert.equal(outcome.prUrl, published, "the host's word about the run's own delivery lost to the record");
  assert.equal(outcome.noticeMd.includes(STRAY_PR_PREFIX), false, outcome.noticeMd);
});

test("a publication equal to the record leaves the notice as it was", () => {
  const plain = classifyJobResult({ log: toNdjson([systemInitEvent(), resultEvent({ text: FINAL_TEXT })]), exitCode: 0, state: runState() });
  const published = classifyJobResult({ log: logWith(qaPublication({ branch: null, url: OWN_PR })), exitCode: 0, state: runState() });

  assert.equal(published.prUrl, OWN_PR);
  assert.equal(published.noticeMd, plain.noticeMd);
});

test("a foreign-branch publication with no record is never the run's pull request, and is flagged", () => {
  const outcome = classifyJobResult({ log: logWith(qaPublication()), exitCode: 0, state: runState({ prUrl: null }) });

  assert.equal(outcome.prUrl, null, "a pull request of another branch was recorded for lack of a better one");
  assert.equal(outcome.status, "failed");
  assert.ok(outcome.noticeMd.endsWith(strayLine({ recorded: null })), outcome.noticeMd);
});

test("a foreign-branch publication the final text also cites is still not the run's pull request", () => {
  const log = toNdjson([systemInitEvent(), qaPublication(), resultEvent({ text: `Done. Pull request: ${QA_PR}` })]);
  const outcome = classifyJobResult({ log, exitCode: 0, state: runState({ prUrl: null }) });

  assert.equal(outcome.prUrl, null, "the text heuristic brought back the pull request of another branch");
});

test("a publication naming no branch, with no record, is still the run's pull request (older hosts)", () => {
  const outcome = classifyJobResult({ log: logWith(qaPublication({ branch: null })), exitCode: 0, state: runState({ prUrl: null }) });

  assert.equal(outcome.prUrl, QA_PR);
  assert.equal(outcome.status, "done");
  assert.equal(outcome.noticeMd.includes(STRAY_PR_PREFIX), false, outcome.noticeMd);
});

test("a gate run with a stray publication stays a gate, keeps its question and carries the flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-qa-branch-"));
  try {
    const planPath = join(dir, "03-plan.md");
    writeFileSync(planPath, `# Plan\n\n${GATE_NOTICE}\n`);
    const [init, ...rest] = gateStream().trimEnd().split("\n");
    const log = [init, JSON.stringify(qaPublication()), ...rest].join("\n");
    const outcome = classifyJobResult({ log, exitCode: 0, state: runState({ recorded: false }), planPath });

    assert.equal(outcome.status, "gate");
    assert.ok(outcome.noticeMd.startsWith(GATE_NOTICE), outcome.noticeMd);
    assert.ok(outcome.noticeMd.endsWith(strayLine({ recorded: null })), outcome.noticeMd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
