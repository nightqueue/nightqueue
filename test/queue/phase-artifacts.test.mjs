import assert from "node:assert/strict";
import { test } from "node:test";
import { MANIFEST, PHASE_ARTIFACTS, QA_ANALYST_STAGE, QA_STAGES, QA_TRIAGE_STAGE } from "../../plugin/skills/resolve/pipeline/artifacts.mjs";
import { lastRound, lastRoundWithSource, nextRound } from "../../src/queue/rounds.mjs";
import { phaseNamesOf } from "../../src/queue/pipeline-package.mjs";

test("no artifact gates on its sections: every manifest phase lists none, and only the implementation derives a file list", () => {
  for (const phase of MANIFEST.phases) assert.deepEqual(phase.sections, [], String(phase.id));
  const deriving = [...PHASE_ARTIFACTS].filter(([, artifact]) => artifact.derivesFileList).map(([check]) => check);
  assert.deepEqual(deriving, ["04"]);
});

test("the phases are whole numbers: the check ids run 00 to 07, and the analyst stage is no key of its own", () => {
  assert.deepEqual([...PHASE_ARTIFACTS.keys()], ["00", "01", "02", "03", "04", "05", "06", "07"]);
  assert.equal(PHASE_ARTIFACTS.get("07").file, "07-runtime.md");
  assert.equal(QA_ANALYST_STAGE.file, PHASE_ARTIFACTS.get("05").file);
});

test("the verifier, runtime and QA artifacts are round artifacts; the others are not", () => {
  const rounds = [...PHASE_ARTIFACTS].filter(([, artifact]) => artifact.rounds).map(([phase]) => phase);
  assert.deepEqual(rounds, ["05", "06", "07"]);
  assert.equal(QA_ANALYST_STAGE.rounds, true);
});

test("each artifact names the canonical phase it completes, and only the brief and the QA stage A complete none", () => {
  const phases = Object.fromEntries([...PHASE_ARTIFACTS].map(([check, artifact]) => [check, artifact.phase]));
  assert.deepEqual(phases, { "00": null, "01": "triage", "02": "explore", "03": "architecture", "04": "implementation", "05": "qa", "06": "verification", "07": "runtime" });
  assert.equal(QA_ANALYST_STAGE.phase, null);
  for (const phase of Object.values(phases).filter(Boolean)) assert.ok(phaseNamesOf(null).includes(phase), phase);
});

test("the triage, QA, verification and runtime artifacts take the manifest's verdict words, never a word the check answers by itself", () => {
  const verdicts = [...PHASE_ARTIFACTS].filter(([, artifact]) => artifact.verdicts.length > 0).map(([check, artifact]) => [check, artifact.verdicts]);
  assert.deepEqual(verdicts, [
    ["01", ["PROCEED", "NO-CHANGE-NEEDED", "NOT-REPRODUCIBLE"]],
    ["05", ["APPROVED", "NEEDS FIX", "NEEDS DISCUSSION"]],
    ["06", ["PASSED", "PASSED-STATIC", "FAILED"]],
    ["07", ["CONFIRMED", "NOT-MET", "SYMPTOM-PERSISTS", "NEEDS-DEVICE", "UNAVAILABLE"]],
  ]);
  assert.deepEqual(QA_ANALYST_STAGE.verdicts, ["APPROVED", "NEEDS FIX", "NEEDS DISCUSSION"]);
});

test("the QA triage stage is a round of the QA's artifact that completes no phase, and its verdict is the QA mode", () => {
  assert.deepEqual(Object.keys(QA_STAGES), ["analyst", "triage"]);
  assert.equal(QA_TRIAGE_STAGE.file, PHASE_ARTIFACTS.get("05").file);
  assert.deepEqual([QA_TRIAGE_STAGE.phase, QA_TRIAGE_STAGE.rounds], [null, true]);
  assert.deepEqual(QA_TRIAGE_STAGE.verdicts, ["skip", "lite", "full"]);
});

test("`lastRoundWithSource` is the last round of that source, wherever it sits, or null", () => {
  const text = "## Round 1\nsource: qa-triage\nfirst\n## Round 2\n**source: `qa-triage`**\nsecond\n## Round 3\nsource: prover · group: g\nthird\n";
  assert.deepEqual(lastRoundWithSource(text, QA_TRIAGE_STAGE.source), { number: 2, text: "## Round 2\n**source: `qa-triage`**\nsecond" });
  assert.equal(lastRoundWithSource("source: qa-triage\n", QA_TRIAGE_STAGE.source), null, "a text with no round has no such round");
  assert.equal(lastRoundWithSource("## Round 1\nno source\nsource: qa-triage\n", QA_TRIAGE_STAGE.source), null, "the source is the round's first line");
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
