import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCheck, readVerdict } from "../plugin/skills/resolve/pipeline/contract.mjs";

const VERIFICATION = ["PASSED", "PASSED-STATIC", "FAILED"];
const QA = ["APPROVED", "NEEDS FIX", "NEEDS DISCUSSION"];
const TRIAGE = ["PROCEED", "NO-CHANGE-NEEDED", "NOT-REPRODUCIBLE"];

test("the verdict is read from a verdict heading, a labelled line or the first line under a verdict heading", () => {
  assert.equal(readVerdict("## Verification: PASSED (stage 1)\n", VERIFICATION), "PASSED");
  assert.equal(readVerdict("Some prose.\n\n**Verdict:** NEEDS FIX\n", QA), "NEEDS FIX");
  assert.equal(readVerdict("- Verdict: needs discussion — two decisions are open\n", QA), "NEEDS DISCUSSION");
  assert.equal(readVerdict("## Verdict\n\nAPPROVED (no break proven)\n", QA), "APPROVED");
  assert.equal(readVerdict("## Runtime verdict\nCONFIRMED\n", ["CONFIRMED", "NOT-MET"]), "CONFIRMED");
  assert.equal(readVerdict("## PASSED-STATIC\n", VERIFICATION), "PASSED-STATIC");
});

test("the longest word wins over its prefix, and a word glued to more letters is no verdict", () => {
  assert.equal(readVerdict("## Verification: PASSED-STATIC\n", VERIFICATION), "PASSED-STATIC");
  assert.equal(readVerdict("## Verification: PASSEDX\n", VERIFICATION), null);
  assert.equal(readVerdict("## Confirmed root cause\nthe filter\n", ["CONFIRMED"]), null);
});

test("prose and check lines are never a verdict, and the last stated verdict wins", () => {
  const triage = "# Triage\n\nPROCEED was considered, but nothing is broken.\n\n## Verdict: NO-CHANGE-NEEDED\n";
  assert.equal(readVerdict(triage, TRIAGE), "NO-CHANGE-NEEDED");
  const failed = "## Checks run\n- test (npm test): PASSED\n- lint (npm run lint): FAILED\n\n## Verification: FAILED\n";
  assert.equal(readVerdict(failed, VERIFICATION), "FAILED");
  assert.equal(readVerdict("## Verdict: PROCEED\n\n## Verdict: NOT-REPRODUCIBLE\n", TRIAGE), "NOT-REPRODUCIBLE");
  assert.equal(readVerdict("```\n## Verdict: PROCEED\n```\n", TRIAGE), null);
  assert.equal(readVerdict("<!-- ## Verdict: PROCEED -->\n", TRIAGE), null);
});

test("a QA triage round states its mode as its verdict, with the fallback reason when it gives none", () => {
  const triage = (mode) => evaluateCheck({ check: "05", stage: "triage", texts: { "05-qa.md": `## Round 1\nsource: qa-triage\n\n${mode}\n` } }).lines;
  assert.deepEqual(triage("## QA mode\nlite"), ["OK", "QA-MODE: lite — stated by the QA triage"]);
  assert.deepEqual(triage("## QA mode: full — a migration changed"), ["OK", "QA-MODE: full — a migration changed"]);
  assert.deepEqual(triage("QA mode: skip: docs only"), ["OK", "QA-MODE: skip — docs only"]);
  assert.deepEqual(triage("## QA mode\nmaybe"), ["MISSING: verdict (one of: skip, lite, full)"]);
});

test("the analyst's round goes to the provers when it names a hypothesis, and straight to the consolidation otherwise", () => {
  const analyst = (body) => evaluateCheck({ check: "05", stage: "analyst", texts: { "05-qa.md": `## Round 1\n${body}\n\n## Verdict\nAPPROVED\n` } }).lines.at(-1);
  assert.equal(analyst("- **H1** · group: g1 — the filter drops a row"), "QA-STAGE: provers");
  assert.equal(analyst("## Break hypotheses\n- the filter drops a row"), "QA-STAGE: provers");
  assert.equal(analyst("No hypothesis survived the reading."), "QA-STAGE: skip");
  assert.equal(analyst("## Break hypotheses\n(none)"), "QA-STAGE: skip");
  assert.equal(analyst("## Validated risks\n- H1: HELD (REFUTED)\n\n## Break hypotheses\nn/a"), "QA-STAGE: skip");
});

test("a content heading carrying a verdict word never overrides the stated verdict, and a labelled line must stand alone", () => {
  assert.equal(readVerdict("## Verdict\nFAILED\n\n## Passed\n- lint: PASSED\n", VERIFICATION), "FAILED");
  assert.equal(readVerdict("## Verdict\nNEEDS FIX\n\n## Approved\n- the attacks held\n", QA), "NEEDS FIX");
  assert.equal(readVerdict("## Verdict\nFAILED\n\nVerification: PASSED on the staging host\n", VERIFICATION), "FAILED");
});

test("an unfilled option list states no verdict", () => {
  assert.equal(readVerdict("## Verdict: PROCEED | NO-CHANGE-NEEDED | NOT-REPRODUCIBLE\n", TRIAGE), null);
  assert.equal(readVerdict("## Verdict\nPASSED | PASSED-STATIC | FAILED\n", VERIFICATION), null);
  assert.equal(readVerdict("QA mode: skip | lite | full\n", ["skip", "lite", "full"]), null);
});
