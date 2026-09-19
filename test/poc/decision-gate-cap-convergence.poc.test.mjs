import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { saveDecision, saveReviewedDecision } from "../../src/memory/decisions.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// Group A: overlapCandidates caps the raw union to GATE_CANDIDATE_LIMIT (10) BEFORE
// reviewAndInsert filters out numbers the caller already named. With 12 real
// lexical overlaps and a stable top-10 ordering, naming the first 10 candidates
// makes the retry's re-computed top-10 identical (already all reviewed), so
// candidates #11 and #12 - real overlapping accepted decisions of the same owner -
// are never shown to the caller, yet the save silently succeeds.

// Saves a decision straight through the ungated primitive, the way a fixture seeds one.
function seed(env, { title }) {
  return saveDecision({ project: "alpha", title, context: "the context", decision: "the decision", status: "accepted" }, env);
}

// How many decision rows the home holds.
function rowCount(env) {
  return openDb(env).prepare("SELECT COUNT(*) AS total FROM decisions").get().total;
}

test("naming every candidate of the first needs_review answer must not let overlap beyond the cap go unreviewed", async (t) => {
  const env = makeHome(t, "gate-cap-convergence");
  makeProject(t, env, "alpha");

  // 12 accepted rows sharing 3 tokens ("runner", "claims", "job") with the new title below.
  const seeded = [];
  for (let i = 1; i <= 12; i++) {
    seeded.push(seed(env, { title: `runner claims job lease variant${i}` }));
  }
  assert.equal(seeded.length, 12);

  const newTitle = "runner claims job overlap check";

  const first = await saveReviewedDecision(
    { project: "alpha", title: newTitle, context: "the context", decision: "the decision", status: "accepted" },
    env,
  );
  assert.equal(first.needsReview, true, `expected the first save to need review, got ${JSON.stringify(first)}`);
  assert.equal(first.candidates.length, 10, "the gate must not silently drop the fact that more than 10 rows overlap");
  const firstNumbers = first.candidates.map((row) => row.number);

  // The caller names every candidate the FIRST answer showed - exactly what an honest operator does.
  const retry = await saveReviewedDecision(
    {
      project: "alpha",
      title: newTitle,
      context: "the context",
      decision: "the decision",
      status: "accepted",
      unrelated: firstNumbers,
    },
    env,
  );

  // Correct behavior: 2 real overlapping accepted rows (ranked 11 and 12) were never
  // reviewed, so the retry must still ask for review - naming them - not silently save.
  assert.equal(
    retry.needsReview,
    true,
    `the retry silently saved after naming only the top ${firstNumbers.length} candidates, ` +
      `but ${seeded.length - firstNumbers.length} more real overlapping accepted rows of the same owner ` +
      `were never shown to the caller and never reviewed: ${JSON.stringify(retry)}`,
  );
  assert.equal(rowCount(env), 12, "an unreviewed overlap must never be written");
});
