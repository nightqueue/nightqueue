import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import {
  decisionProbe,
  getDecision,
  saveDecision,
  saveReviewedDecision,
  setDecisionEmbedding,
  updateDecision,
} from "../../src/memory/decisions.mjs";
import { fakeEmbedder, makeHome, makeProject } from "../../test-support/memory.mjs";

const FAKE_MODEL = "fake-embedder@v1";
const CHAIN_TITLE = "one runner per job; runners claim jobs of the same project in parallel";

// Saves a decision straight through the ungated primitive, the way a fixture seeds one.
function seed(env, { project = "alpha", org, title, decision = "the decision", status = "accepted" }) {
  return saveDecision({ project: org ? undefined : project, org, title, context: "the context", decision, status }, env);
}

// A home whose project carries a synthetic runner chain of three overlapping rules plus one unrelated rule.
function makeChainHome(t, name, options = {}) {
  const env = makeHome(t, name, options);
  makeProject(t, env, "alpha", { org: "acme" });
  makeProject(t, env, "beta");
  seed(env, { title: "one runner claims one job at a time" });
  seed(env, { title: "runners register in a shared registry and claim jobs in parallel" });
  seed(env, { title: "jobs of the same project run in parallel across runners" });
  seed(env, { title: "the heartbeat lease is renewed by its owner" });
  return env;
}

// A reviewed save of a project decision with the fields every test would otherwise repeat.
function review(env, spec) {
  return saveReviewedDecision(
    { project: "alpha", context: "the context", decision: "the decision", status: "accepted", ...spec },
    env,
  );
}

// How many decision rows the home holds.
function rowCount(env) {
  return openDb(env).prepare("SELECT COUNT(*) AS total FROM decisions").get().total;
}

// Numbers of the candidates of a needs_review answer, in the order the gate listed them.
function candidateNumbers(result) {
  assert.equal(result.needsReview, true, `expected needs_review, got ${JSON.stringify(result)}`);
  return result.candidates.map((row) => row.number);
}

test("a title overlapping three rules of its owner is held back naming exactly those, and nothing is written", async (t) => {
  const env = makeChainHome(t, "gate-overlap");
  const result = await review(env, { title: CHAIN_TITLE });
  assert.deepEqual(candidateNumbers(result), [3, 2, 1]);
  assert.deepEqual(
    result.candidates.map((row) => [row.label, row.status, row.via]),
    [
      ["#3", "accepted", "lexical"],
      ["#2", "accepted", "lexical"],
      ["#1", "accepted", "lexical"],
    ],
  );
  assert.deepEqual(Object.keys(result.candidates[0]).sort(), ["id", "label", "number", "status", "title", "via"]);
  assert.equal(rowCount(env), 4);
});

test("naming every candidate saves, and the superseded ones point at the new row", async (t) => {
  const env = makeChainHome(t, "gate-named");
  const saved = await review(env, { title: CHAIN_TITLE, supersedes: [3], unrelated: [1, 2] });
  assert.equal(saved.needsReview, undefined);
  assert.equal(saved.number, 5);
  assert.deepEqual(saved.superseded, [3]);
  assert.equal(saved.jobId, null);
  const replaced = getDecision(3, env);
  assert.equal(replaced.status, "superseded");
  assert.equal(replaced.superseded_by, saved.id);
  assert.equal(getDecision(1, env).status, "accepted");
  assert.equal(getDecision(2, env).status, "accepted");
});

test("naming all candidates but one is refused again, naming only the one left out", async (t) => {
  const env = makeChainHome(t, "gate-one-left");
  const result = await review(env, { title: CHAIN_TITLE, unrelated: [2, 3] });
  assert.deepEqual(candidateNumbers(result), [1]);
  assert.equal(rowCount(env), 4);
});

test("a failure after the insert rolls back the new row and every superseded status in one transaction", async (t) => {
  const env = makeChainHome(t, "gate-atomic");
  openDb(env).exec(
    "CREATE TRIGGER fail_supersede BEFORE UPDATE OF status ON decisions WHEN NEW.status = 'superseded' BEGIN SELECT RAISE(ABORT, 'forced failure'); END;",
  );
  await assert.rejects(review(env, { title: CHAIN_TITLE, supersedes: [2, 3], unrelated: [1] }), /forced failure/);
  assert.equal(rowCount(env), 4, "the insert survived the failed supersede");
  assert.equal(getDecision(2, env).status, "accepted");
  assert.equal(getDecision(3, env).superseded_by, null);
});

test("a proposed row is a candidate; a rejected, a superseded, another project's and an org row are not", async (t) => {
  const env = makeHome(t, "gate-eligible");
  makeProject(t, env, "alpha", { org: "acme" });
  makeProject(t, env, "beta");
  const proposed = seed(env, { title: "runners claim one job each", status: "proposed" });
  seed(env, { title: "one runner per job forever", status: "rejected" });
  seed(env, { title: "one runner per job at most", status: "superseded" });
  seed(env, { project: "beta", title: "one runner per job in beta" });
  seed(env, { org: "acme", title: "one runner per job in the org" });

  const result = await review(env, { title: "one runner per job" });
  assert.deepEqual(candidateNumbers(result), [proposed.number]);
  assert.equal(result.candidates[0].status, "proposed");
});

test("an unrelated title has no candidate and saves at once", async (t) => {
  const env = makeChainHome(t, "gate-unrelated");
  const saved = await review(env, { title: "logs are rotated daily" });
  assert.equal(saved.number, 5);
  assert.deepEqual(saved.superseded, []);
});

test("two back-to-back saves of one title: the second is held back naming the first", async (t) => {
  const env = makeChainHome(t, "gate-back-to-back");
  const first = await review(env, { title: "logs are rotated daily by the collector" });
  const second = await review(env, { title: "logs are rotated daily by the collector" });
  assert.deepEqual(candidateNumbers(second), [first.number]);
});

test("a job proposes at most one decision while the first is still proposed, and its rows carry the job id", async (t) => {
  const env = makeChainHome(t, "gate-job-proposal");
  const first = await review(env, { title: "logs are rotated daily", status: "proposed", jobId: 7 });
  assert.equal(first.jobId, 7);
  assert.equal(getDecision(first.id, env).job_id, 7);

  await assert.rejects(
    review(env, { title: "embeddings stay optional", status: "proposed", jobId: 7 }),
    /job 7 already proposed decision #5; a job proposes at most one decision/,
  );
  assert.equal(rowCount(env), 5);

  updateDecision(first.id, { status: "rejected" }, env);
  const again = await review(env, { title: "embeddings stay optional", status: "proposed", jobId: 7 });
  assert.equal(again.number, 6);
  assert.equal(getDecision(again.id, env).job_id, 7);
});

test("inside a job supersedes is refused before anything is read or written", async (t) => {
  const env = makeChainHome(t, "gate-job-supersedes");
  await assert.rejects(
    review(env, { title: CHAIN_TITLE, supersedes: [3], unrelated: [1, 2], jobId: 7 }),
    /inside job 7 `supersedes` is refused: superseding a decision is the operator's call/,
  );
  assert.equal(getDecision(3, env).status, "accepted");
  assert.equal(rowCount(env), 4);
});

test("a rejected decision skips the gate: it binds nothing", async (t) => {
  const env = makeChainHome(t, "gate-rejected");
  const saved = await review(env, { title: CHAIN_TITLE, status: "rejected" });
  assert.equal(saved.number, 5);
  assert.equal(getDecision(saved.id, env).status, "rejected");
});

test("the named numbers are validated: both lists, an unknown number and a row that binds nothing are refused", async (t) => {
  const env = makeChainHome(t, "gate-validation");
  seed(env, { title: "an old rule", status: "superseded" });
  await assert.rejects(review(env, { title: CHAIN_TITLE, supersedes: [1], unrelated: [1] }), /named in both/);
  await assert.rejects(review(env, { title: CHAIN_TITLE, unrelated: [1, 2, 3, 99] }), /project `alpha` has no decision number 99/);
  await assert.rejects(review(env, { title: CHAIN_TITLE, supersedes: [5], unrelated: [1, 2, 3] }), /#5 is `superseded`/);
  await assert.rejects(review(env, { title: CHAIN_TITLE, unrelated: [0] }), /positive integer decision numbers/);
  await assert.rejects(review(env, { title: CHAIN_TITLE, unrelated: "1" }), /positive integer decision numbers/);
  assert.equal(rowCount(env), 5);
});

test("an imported row keeps its date and points at its successor", async (t) => {
  const env = makeChainHome(t, "gate-import-shape");
  const saved = await review(env, {
    title: "one runner per job, historical",
    status: "superseded",
    supersededBy: 1,
    createdAt: "2025-03-04",
  });
  const row = getDecision(saved.id, env);
  assert.equal(row.superseded_by, 1);
  assert.equal(row.created_at, "2025-03-04 00:00:00");
  await assert.rejects(review(env, { title: "x", status: "rejected", createdAt: "2025-02-30" }), /calendar date/);
});

test("the probe of a decision is its title plus the decision itself", () => {
  assert.equal(decisionProbe({ title: "a", decision: "b" }), "a b");
  assert.equal(decisionProbe({ title: "a" }), "a");
});

test("a duplicate with a different title but the same rule is caught by meaning, through the shared probe", async (t) => {
  const env = makeHome(t, "gate-semantic", { embed: true });
  makeProject(t, env, "alpha");
  const rule = "only the process holding the lease may renew it";
  const existing = seed(env, { title: "leases are renewed by their owner", decision: `${rule}, every ten seconds` });
  setDecisionEmbedding({ id: existing.id, vector: [1, 0, 0, 0], model: FAKE_MODEL }, env);
  const embedder = fakeEmbedder((text) => (text.includes(rule) ? [1, 0, 0, 0] : [0, 1, 0, 0]), { model: FAKE_MODEL });
  const title = "heartbeat writes belong to the process that took the job";
  const decision = `${rule}; nobody else touches the heartbeat`;

  const result = await review(env, { title, decision, embedder });
  assert.deepEqual(candidateNumbers(result), [existing.number]);
  assert.equal(result.candidates[0].via, "semantic");
  assert.equal(embedder.calls[0], decisionProbe({ title, decision }));

  const unrelated = await review(env, { title, decision: "the heartbeat is written every ten seconds", embedder });
  assert.equal(unrelated.needsReview, undefined);
  assert.equal(unrelated.number, 2);
});
