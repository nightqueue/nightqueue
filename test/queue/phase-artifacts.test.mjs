import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExploreArtifact } from "../../src/cli/explore-artifact.mjs";
import { lastRound, nextFixLoop, nextRound, PHASE_ARTIFACTS } from "../../src/queue/phase-artifacts.mjs";

const EXPLORE_HEADINGS = ["## File map", "## Access map", "## Third-party libraries"];

test("the explore gate requires the headings the index-save parser reads", () => {
  assert.deepEqual(PHASE_ARTIFACTS.get("02").sections, EXPLORE_HEADINGS);
  const artifact = `${EXPLORE_HEADINGS[0]}\n- /a.mjs — a\n\n${EXPLORE_HEADINGS[1]}\n- **No entry point:** text · grep\n\n${EXPLORE_HEADINGS[2]}\n- None\n`;
  assert.equal(parseExploreArtifact(artifact).files.length, 1);
});

test("the plan, implementation, QA and verification gates require the mandatory sections of their ## Deliver blocks", () => {
  const sections = (phase) => PHASE_ARTIFACTS.get(phase).sections;
  assert.deepEqual(sections("03"), ["## Implementation plan", "## Assumptions", "## Pre-mortem", "## Identified risks"]);
  assert.deepEqual(sections("04"), ["## Modified files"]);
  assert.deepEqual(sections("05a"), ["## Proven breaks", "## Break hypotheses", "## Test recipe", "## Validated risks", "## Invalidated assumptions", "## Verdict"]);
  assert.deepEqual(sections("05"), ["## Proven breaks", "## Validated risks", "## Invalidated assumptions", "## Generated PoCs", "## Verdict"]);
  assert.deepEqual(sections("06"), ["## Checks run", "## Verification"]);
  assert.deepEqual(sections("06.5"), ["## Runtime verdict"]);
});

test("the verifier, runtime and QA artifacts are round artifacts; the others are not", () => {
  const rounds = [...PHASE_ARTIFACTS].filter(([, artifact]) => artifact.rounds).map(([phase]) => phase);
  assert.deepEqual(rounds, ["05a", "05", "06", "06.5"]);
});

test("`lastRound` is the last `## Round` up to the end, or the whole text with no round", () => {
  assert.equal(lastRound("## Verification: PASSED\n"), "## Verification: PASSED\n");
  assert.equal(lastRound(""), "");
  assert.equal(lastRound("## Round 1\nfirst\n"), "## Round 1\nfirst\n");
  assert.equal(lastRound("## Round 1\nfirst\n## Round 2\nsecond\n## Round 3\nthird\n"), "## Round 3\nthird\n");
  assert.equal(lastRound("## Round 1\na\n## Round 3  \nc\n"), "## Round 3  \nc\n");
  assert.equal(lastRound("## Round 1\na\n## Roundabout\nb\n"), "## Round 1\na\n## Roundabout\nb\n");
});

test("`nextRound` is the highest round plus one, or 1", () => {
  assert.equal(nextRound(""), 1);
  assert.equal(nextRound("# legacy\n## Verification: FAILED\n"), 1);
  assert.equal(nextRound("## Round 1\n"), 2);
  assert.equal(nextRound("## Round 1\n## Round 2\n## Round 3\n"), 4);
  assert.equal(nextRound("## Round 1\n## Round 3\n"), 4);
  assert.equal(nextRound(null), 1);
});

const DECORATED_ROUND_HEADINGS = ["## Round 2 — retry", "## Round 2: verification", "## Round 2 (after fix)", "## round 2"];

for (const heading of DECORATED_ROUND_HEADINGS) {
  test(`a decorated round heading "${heading}" is a round for \`lastRound\` and \`nextRound\``, () => {
    const text = `## Round 1\n\n## Verification: PASSED\n\n${heading}\n\nno verdict\n`;
    assert.ok(lastRound(text).startsWith(heading), lastRound(text));
    assert.equal(lastRound(text).includes("## Verification"), false, "the last round carried round 1's verdict");
    assert.equal(nextRound(text), 3);
  });
}

test("a decorated two-digit round counts, and a heading with no number boundary is not a round", () => {
  assert.equal(nextRound("## Round 12 — retry\n"), 13);
  for (const notRound of ["## Roundabout", "## Rounds 2", "## Round 2x"]) {
    assert.equal(nextRound(`${notRound}\n`), 1, notRound);
    assert.equal(lastRound(`## Round 1\na\n${notRound}\nb\n`), `## Round 1\na\n${notRound}\nb\n`, notRound);
  }
});

test("`nextFixLoop` is the highest `### Fix loop` plus one, or 1", () => {
  assert.equal(nextFixLoop("## Modified files\n/a.mjs\n"), 1);
  assert.equal(nextFixLoop("### Fix loop 1 — what was wrong / what changed\n"), 2);
  assert.equal(nextFixLoop("### Fix loop 1 — x\n### Fix loop 2 — y\n### Fix loop 3 — z\n"), 4);
  assert.equal(nextFixLoop("### Fix loop 1 — x\n### Fix loop 3 — z\n"), 4);
  assert.equal(nextFixLoop("### Fix loops ahead\n"), 1);
});
