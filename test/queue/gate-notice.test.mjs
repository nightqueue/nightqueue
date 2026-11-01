import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeGateNotice } from "../../src/queue/gate-notice.mjs";

const PLAN = [
  "## Implementation plan",
  "Do it.",
  "",
  "```md",
  "## Requires user confirmation",
  "a quoted heading inside a fence",
  "```",
  "",
  "## Usage coverage",
  "- run start · changed=yes · source=pipeline",
  "",
  "## Requires user confirmation",
  "1. Approve C1?",
  "2. Approve C2?",
  "",
  "## Assumptions",
  "- none",
].join("\n");

const RUNTIME = ["## Round 1", "## Runtime verdict", "CONFIRMED", "", "## Round 2", "## Runtime verdict", "NEEDS-DEVICE", "1. open the app"].join("\n");

// A run directory holding the plan and a two-round runtime artifact, removed at the end of the test.
function makeRunDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "nightqueue-gate-notice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "03-plan.md"), PLAN);
  writeFileSync(join(dir, "07-runtime.md"), RUNTIME);
  return dir;
}

const ANSWER_LINE = 'Answer with: nightqueue queue retry J-7 --note "<your answer>"';

test("the confirmation section is carried verbatim, the fenced copy is ignored, and the answer line closes it", (t) => {
  const notice = composeGateNotice({
    runDir: makeRunDir(t),
    jobId: 7,
    fromArtifact: { file: "03-plan.md", section: "## Requires user confirmation" },
  });
  assert.equal(notice, `## Requires user confirmation\n1. Approve C1?\n2. Approve C2?\n\n${ANSWER_LINE}`);
});

test("another section is nested under the confirmation heading, followed by the question", (t) => {
  const notice = composeGateNotice({
    runDir: makeRunDir(t),
    jobId: 7,
    question: "GATE: usage-coverage-cond-1 — run start",
    fromArtifact: { file: "03-plan.md", section: "## Usage coverage" },
  });
  assert.equal(
    notice,
    `## Requires user confirmation\n\n## Usage coverage\n- run start · changed=yes · source=pipeline\n\nGATE: usage-coverage-cond-1 — run start\n\n${ANSWER_LINE}`,
  );
});

test("a round artifact is read on its last round", (t) => {
  const notice = composeGateNotice({ runDir: makeRunDir(t), jobId: 7, fromArtifact: { file: "07-runtime.md", section: "## Runtime verdict" } });
  assert.equal(notice, `## Requires user confirmation\n\n## Runtime verdict\nNEEDS-DEVICE\n1. open the app\n\n${ANSWER_LINE}`);
});

test("a question alone goes under the heading, and outside a job no answer line is added", (t) => {
  const notice = composeGateNotice({ runDir: makeRunDir(t), jobId: null, question: "  Is this a bug or a feature/refactor?  " });
  assert.equal(notice, "## Requires user confirmation\n\nIs this a bug or a feature/refactor?");
});

test("a section at another heading level is found by its title, and the exact level wins when both exist", (t) => {
  const runDir = makeRunDir(t);
  writeFileSync(join(runDir, "03-plan.md"), "## Implementation plan\nDo it.\n\n### Requires user confirmation\n1. Approve C1?\n\n## Assumptions\n- none\n");
  const confirm = composeGateNotice({ runDir, fromArtifact: { file: "03-plan.md", section: "## Requires user confirmation" } });
  assert.equal(confirm, "### Requires user confirmation\n1. Approve C1?");
  writeFileSync(join(runDir, "01-triage.md"), "## Notes\n#### Open items for later\n- deeper\n\n## Open items\n- exact\n");
  const exact = composeGateNotice({ runDir, fromArtifact: { file: "01-triage.md", section: "## Open items" } });
  assert.equal(exact, "## Requires user confirmation\n\n## Open items\n- exact");
  writeFileSync(join(runDir, "01-triage.md"), "## Notes\n#### Open items for later\n- deeper\n");
  const deeper = composeGateNotice({ runDir, fromArtifact: { file: "01-triage.md", section: "## Open items" } });
  assert.equal(deeper, "## Requires user confirmation\n\n#### Open items for later\n- deeper");
});

test("a confirmation heading in another letter case is found, the same rule the gate marker reads it by", (t) => {
  const runDir = makeRunDir(t);
  for (const heading of ["## Requires User Confirmation", "## requires user confirmation"]) {
    writeFileSync(join(runDir, "03-plan.md"), `## Implementation plan\nDo it.\n\n${heading}\n1. Approve C1?\n\n## Assumptions\n- none\n`);
    const notice = composeGateNotice({ runDir, fromArtifact: { file: "03-plan.md", section: "## Requires user confirmation" } });
    assert.equal(notice, `${heading}\n1. Approve C1?`);
  }
});

test("a path, a missing file, a missing section, a non-heading section and an empty call are refused", (t) => {
  const runDir = makeRunDir(t);
  const compose = (fromArtifact, question) => () => composeGateNotice({ runDir, jobId: 7, fromArtifact, question });
  assert.throws(compose({ file: "../03-plan.md", section: "## Usage coverage" }), /bare name of a run artifact/);
  assert.throws(compose({ file: "05-qa.md", section: "## Verdict" }), /`05-qa.md` does not exist in the run directory/);
  assert.throws(compose({ file: "03-plan.md", section: "## Nope" }), /03-plan.md has no `## Nope` section: nothing was recorded/);
  assert.throws(compose({ file: "03-plan.md", section: "Usage coverage" }), /must be a heading/);
  assert.throws(compose(null, "   "), /needs `question` or `from_artifact`/);
});
