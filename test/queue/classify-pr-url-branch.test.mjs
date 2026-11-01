import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyJobResult } from "../../src/queue/classify.mjs";
import { codeChangePublishedEvent, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const REPO = "nightqueue/nightqueue";
const QA_PR = "https://github.com/nightqueue/nightqueue/pull/71";
const OWN_PR = "https://github.com/nightqueue/nightqueue/pull/72";
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

test("job 57: a QA publication on another branch of the same repository never replaces the run's own recorded pull request", () => {
  const outcome = classifyJobResult({ log: logWith(qaPublication()), exitCode: 0, state: runState() });

  assert.equal(outcome.prUrl, OWN_PR, "the QA scratch pull request was recorded as the job's delivery");
  assert.equal(outcome.status, "done");
  assert.equal(outcome.noticeMd, null, "the stray pull request line is no longer written");
});

test("a publication naming no branch still loses to the runtime record", () => {
  const outcome = classifyJobResult({ log: logWith(qaPublication({ branch: null })), exitCode: 0, state: runState() });

  assert.equal(outcome.prUrl, OWN_PR);
});

test("a publication on the run's own branch, under its published name, still loses to the record: the record leads", () => {
  const published = "https://github.com/nightqueue/nightqueue/pull/73";
  const outcome = classifyJobResult({ log: logWith(qaPublication({ branch: "feat/queue-close", url: published })), exitCode: 0, state: runState() });

  assert.equal(outcome.prUrl, OWN_PR);
});

test("a publication on the run's own branch is the pull request when nothing recorded one", () => {
  const published = "https://github.com/nightqueue/nightqueue/pull/73";
  const outcome = classifyJobResult({ log: logWith(qaPublication({ branch: "feat/queue-close", url: published })), exitCode: 0, state: runState({ prUrl: null }) });

  assert.equal(outcome.prUrl, published);
  assert.equal(outcome.status, "done");
});

test("a publication equal to the record leaves the notice as it was", () => {
  const plain = classifyJobResult({ log: toNdjson([systemInitEvent(), resultEvent({ text: FINAL_TEXT })]), exitCode: 0, state: runState() });
  const published = classifyJobResult({ log: logWith(qaPublication({ branch: null, url: OWN_PR })), exitCode: 0, state: runState() });

  assert.equal(published.prUrl, OWN_PR);
  assert.equal(published.noticeMd, plain.noticeMd);
});

test("a foreign-branch publication with no record is never the run's pull request", () => {
  const outcome = classifyJobResult({ log: logWith(qaPublication()), exitCode: 0, state: runState({ prUrl: null }) });

  assert.equal(outcome.prUrl, null, "a pull request of another branch was recorded for lack of a better one");
  assert.equal(outcome.status, "failed");
});

test("a foreign-branch publication the final text also cites is still not the run's pull request", () => {
  const log = toNdjson([systemInitEvent(), qaPublication(), resultEvent({ text: `Done. Pull request: ${QA_PR}` })]);
  const outcome = classifyJobResult({ log, exitCode: 0, state: runState({ prUrl: null }) });

  assert.equal(outcome.prUrl, null, "the text brought back the pull request of another branch");
});

test("a publication naming no branch, with no record, is still the run's pull request (older hosts)", () => {
  const outcome = classifyJobResult({ log: logWith(qaPublication({ branch: null })), exitCode: 0, state: runState({ prUrl: null }) });

  assert.equal(outcome.prUrl, QA_PR);
  assert.equal(outcome.status, "done");
});

test("a recorded gate with a stray publication stays a gate and keeps its question whole", () => {
  const state = { ...runState({ recorded: false }), outcome: { status: "gate", notice: "Decide between A and B." } };
  const outcome = classifyJobResult({ log: logWith(qaPublication()), exitCode: 0, state });

  assert.equal(outcome.status, "gate");
  assert.equal(outcome.noticeMd, "Decide between A and B.");
  assert.equal(outcome.prUrl, null);
});
