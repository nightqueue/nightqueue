import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getDecision,
  listDecisions,
  recallDecisions,
  renderDecisionText,
  saveDecision,
  setDecisionEmbedding,
  updateDecision,
} from "../../src/memory/decisions.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { fakeEmbedder, makeHome, makeProject } from "../../test-support/memory.mjs";

const FAKE_MODEL = "fake-embedder@v1";

// Saves a decision of a project with the fields every test would otherwise repeat.
function addDecision(env, { project = "alpha", title, context = "the context", decision = "the decision", consequences, status }) {
  return saveDecision({ project, title, context, decision, consequences, status }, env);
}

// Rowids of a full text search over the decisions mirror.
function matchIds(db, expression) {
  return db.prepare("SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH ?").all(expression).map((row) => row.rowid);
}

// Ids of a recall result, in the order the recall returned them.
function idsOf(rows) {
  return rows.map((row) => row.id);
}

test("the number of a decision is max+1 inside its project and independent between projects", (t) => {
  const env = makeHome(t, "decisions-number");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  assert.equal(addDecision(env, { title: "first of alpha" }).number, 1);
  assert.equal(addDecision(env, { title: "second of alpha" }).number, 2);
  assert.equal(addDecision(env, { project: "beta", title: "first of beta" }).number, 1);
  assert.equal(addDecision(env, { title: "third of alpha" }).number, 3);

  const db = openDb(env);
  assert.throws(
    () => db.prepare("INSERT INTO decisions (project, number, title, context, decision) VALUES (?, 1, ?, ?, ?)").run("alpha", "t", "c", "d"),
    /UNIQUE constraint failed/,
  );
});

test("the decisions FTS mirror follows the insert, the update and the delete", (t) => {
  const env = makeHome(t, "decisions-fts");
  makeProject(t, env, "alpha");
  const { id } = addDecision(env, { title: "zebracrossing in the runner", context: "the lease expired", decision: "renew it" });
  assert.deepEqual(matchIds(openDb(env), '"zebracrossing"'), [id]);

  updateDecision(id, { title: "monorepo in the runner" }, env);
  assert.deepEqual(matchIds(openDb(env), '"zebracrossing"'), []);
  assert.deepEqual(matchIds(openDb(env), '"monorepo"'), [id]);

  openDb(env).prepare("DELETE FROM decisions WHERE id = ?").run(id);
  assert.deepEqual(matchIds(openDb(env), '"monorepo"'), []);
  openDb(env).exec("INSERT INTO decisions_fts(decisions_fts) VALUES('integrity-check')");
});

test("a decision defaults to proposed, is listed in number order and an invalid status falls back to proposed too", (t) => {
  const env = makeHome(t, "decisions-status");
  makeProject(t, env, "alpha");
  addDecision(env, { title: "first of alpha", status: "accepted" });
  const noStatus = addDecision(env, { title: "a proposal" });
  assert.equal(getDecision(1, env).status, "accepted");
  assert.equal(getDecision(noStatus.id, env).status, "proposed");
  assert.equal(noStatus.statusDefaulted, true);
  assert.deepEqual(listDecisions({ project: "alpha" }, env).map((row) => row.number), [1, 2]);
  assert.deepEqual(listDecisions({ project: "alpha", status: "proposed" }, env).map((row) => row.number), [2]);
  const bad = addDecision(env, { title: "bad", status: "maybe" });
  assert.equal(bad.statusDefaulted, true);
  assert.equal(getDecision(bad.id, env).status, "proposed");
  assert.throws(() => addDecision(env, { title: "" }), /decision field `title` is required/);
});

test("an update touches only the fields present in the patch and an explicit null changes nothing", (t) => {
  const env = makeHome(t, "decisions-update");
  makeProject(t, env, "alpha");
  const { id } = addDecision(env, { title: "the queue owns the worktree", consequences: "one worktree per job" });
  const updated = updateDecision(id, { decision: "one worktree per job, always", context: null, consequences: undefined }, env);
  assert.equal(updated.decision, "one worktree per job, always");
  assert.equal(updated.context, "the context");
  assert.equal(updated.consequences, "one worktree per job");
  assert.equal(updateDecision(id, {}, env).title, "the queue owns the worktree");
  assert.throws(() => updateDecision(9999, { title: "x" }, env), /unknown decision `9999`/);
});

test("superseded_by only accepts another existing decision of the same project", (t) => {
  const env = makeHome(t, "decisions-superseded");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const first = addDecision(env, { title: "first of alpha" });
  const second = addDecision(env, { title: "second of alpha" });
  const foreign = addDecision(env, { project: "beta", title: "first of beta" });

  assert.throws(() => updateDecision(first.id, { superseded_by: first.id }, env), /cannot supersede itself/);
  assert.throws(() => updateDecision(first.id, { superseded_by: 9999 }, env), /unknown decision `9999`/);
  assert.throws(() => updateDecision(first.id, { superseded_by: foreign.id }, env), /belongs to project `beta`/);
  const row = updateDecision(first.id, { superseded_by: second.id, status: "superseded" }, env);
  assert.equal(row.superseded_by, second.id);
  assert.equal(row.status, "superseded");
});

test("the recall without an embedder answers from BM25 and only ever returns accepted decisions", async (t) => {
  const env = makeHome(t, "decisions-recall-lexical");
  makeProject(t, env, "alpha");
  const hit = addDecision(env, {
    title: "the runner renews the lease of a long job",
    decision: "renew the lease every minute",
    status: "accepted",
  });
  addDecision(env, { title: "the queue caches nothing between runs", status: "accepted" });
  const proposed = addDecision(env, { title: "the runner renews the lease twice", status: "proposed" });
  const superseded = addDecision(env, { title: "the runner renews the lease by hand", status: "superseded" });
  const rejected = addDecision(env, { title: "the runner renews the lease never", status: "rejected" });

  const rows = await recallDecisions({ query: "how does the runner renew the lease", project: "alpha" }, env);
  assert.equal(rows[0].id, hit.id);
  assert.equal(rows[0].via, "lexical");
  for (const hidden of [proposed, superseded, rejected]) {
    assert.equal(idsOf(rows).includes(hidden.id), false, `decision ${hidden.id} leaked into the recall`);
  }
  assert.equal(idsOf(await recallDecisions({ project: "alpha" }, env)).includes(proposed.id), false);
});

test("the recall with an embedder keeps the BM25 top hit and adds the semantic ones", async (t) => {
  const env = makeHome(t, "decisions-recall-hybrid", { embed: true });
  makeProject(t, env, "alpha");
  const hit = addDecision(env, {
    title: "the runner renews the lease of a long job",
    decision: "renew the lease every minute",
    status: "accepted",
  });
  const near = addDecision(env, {
    title: "worktree ownership",
    context: "two processes wrote one tree",
    decision: "one tree per task",
    status: "accepted",
  });
  const far = addDecision(env, { title: "cache policy", context: "cold starts", decision: "cache nothing", status: "accepted" });
  setDecisionEmbedding({ id: near.id, vector: [1, 0, 0, 0], model: FAKE_MODEL }, env);
  setDecisionEmbedding({ id: far.id, vector: [0, 1, 0, 0], model: FAKE_MODEL }, env);

  const rows = await recallDecisions(
    { query: "runner renews lease long job", project: "alpha", embedder: fakeEmbedder([1, 0, 0, 0]) },
    env,
  );
  assert.equal(rows[0].id, hit.id);
  assert.equal(rows[0].via, "lexical");
  const semantic = rows.find((row) => row.id === near.id);
  assert.equal(semantic.via, "semantic");
  assert.ok(semantic.cosine > 0.9, `cosine of the semantic hit: ${semantic.cosine}`);
  assert.equal(idsOf(rows).includes(far.id), false);
});

test("a recall that matches nothing comes back as the recent accepted decisions, marked fallback", async (t) => {
  const env = makeHome(t, "decisions-recall-fallback");
  makeProject(t, env, "alpha");
  const recent = addDecision(env, { title: "the queue owns the worktree", status: "accepted" });
  const rows = await recallDecisions({ query: "zebracrossing monorepo telemetry", project: "alpha" }, env);
  assert.deepEqual(idsOf(rows), [recent.id]);
  assert.equal(rows[0].via, "fallback");
});

test("the plain text of a decision carries its number, status and fields, and drops empty consequences", (t) => {
  const env = makeHome(t, "decisions-render");
  makeProject(t, env, "alpha");
  const { id } = addDecision(env, {
    title: "the queue owns the worktree",
    context: "two runners raced",
    decision: "one worktree per job",
    consequences: "a job cannot resume another one's tree",
    status: "accepted",
  });
  assert.equal(
    renderDecisionText(getDecision(id, env)),
    [
      "#1 the queue owns the worktree (accepted)",
      "Context: two runners raced",
      "Decision: one worktree per job",
      "Consequences: a job cannot resume another one's tree",
    ].join("\n"),
  );
  const bare = addDecision(env, { title: "no consequences yet" });
  assert.equal(renderDecisionText(getDecision(bare.id, env)).includes("Consequences:"), false);
});
