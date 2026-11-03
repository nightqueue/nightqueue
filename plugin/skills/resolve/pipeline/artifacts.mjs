import { readFileSync } from "node:fs";

// The package's own manifest, the one source of each phase's file, sections and verdicts.
export const MANIFEST = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

// The verdict only the runtime writes for a QA the triage skipped: it may be recorded, but no artifact states it.
export const QA_SKIP_VERDICT = "SKIPPED";

// The manifest entry of a check.
function phaseOf(check) {
  return MANIFEST.phases.find((phase) => phase.check === check);
}

// The line the triage verdict must open with: the evidence level, 1 to 4, bold or plain.
const EVIDENCE_FIRST_LINE = {
  heading: "## Verdict",
  pattern: /^(\*\*)?Evidence level:(\*\*)?\s*[1-4](\*\*)?\s*$/,
  label: "Evidence level: <1|2|3|4> as the first line under ## Verdict",
};

// Where a check's verdict is read: the suffix of its heading or the first line under it, the values its artifact may state and the value each retired word reads as.
function verdictSpec({ check, heading, from, legacy = {} }) {
  const values = phaseOf(check).verdicts.filter((value) => value !== QA_SKIP_VERDICT);
  const suffix = from === "heading-suffix" ? "" : " as the first line";
  return { heading, from, values, legacy, label: `${heading}: <${values.join("|")}>${suffix}` };
}

const TRIAGE_VERDICT = verdictSpec({
  check: "01",
  heading: "## Verdict",
  from: "heading-suffix",
  legacy: { "NEEDS-CLARIFICATION": "PROCEED", "PROPOSE-ALTERNATIVE": "PROCEED" },
});
export const QA_VERDICT = verdictSpec({ check: "05", heading: "## Verdict", from: "first-line" });
const VERIFICATION_VERDICT = verdictSpec({ check: "06", heading: "## Verification", from: "heading-suffix" });
const RUNTIME_VERDICT = verdictSpec({ check: "07", heading: "## Runtime verdict", from: "first-line" });

// The sections a triage verdict's next step reads, so the check requires them filled on that verdict alone.
const TRIAGE_SECTIONS_BY_VERDICT = { "NOT-REPRODUCIBLE": ["## Open items"] };

// How each check reads its artifact beyond its sections: the verdict, the line a section must open with and the sections a verdict requires.
const READINGS = {
  "01": { sectionsByVerdict: TRIAGE_SECTIONS_BY_VERDICT, firstLineUnder: EVIDENCE_FIRST_LINE, verdict: TRIAGE_VERDICT },
  "05": { verdict: QA_VERDICT },
  "06": { verdict: VERIFICATION_VERDICT },
  "07": { verdict: RUNTIME_VERDICT },
};

// The artifact of one manifest phase: its file, the canonical phase it completes, the sections its gate requires and how it is read.
function artifactOf(phase) {
  return { file: phase.artifact, phase: phase.id, sections: phase.sections, ...(phase.rounds ? { rounds: true } : {}), ...READINGS[phase.check] };
}

// The artifact of each phase, by check; a phase with no required section is checked for existence alone.
export const PHASE_ARTIFACTS = new Map(MANIFEST.phases.filter((phase) => phase.check !== null).map((phase) => [phase.check, artifactOf(phase)]));

const QA = phaseOf("05");

// The analyst stage of a full QA (`run check 05 --stage analyst`): its round of `05-qa.md`, which completes no phase and requires every section check 05 reads.
export const QA_ANALYST_STAGE = {
  file: QA.artifact,
  phase: null,
  sections: QA.stages.analyst.sections,
  rounds: true,
  verdict: QA_VERDICT,
};

// The triage stage of the QA (`run check 05 --stage triage`): its own named round of `05-qa.md`, which decides the QA mode and carries no verdict.
export const QA_TRIAGE_STAGE = {
  file: QA.artifact,
  phase: null,
  sections: QA.stages.triage.sections,
  rounds: true,
  source: /^source:\s*qa-triage\s*$/i,
};

export const QA_STAGES = { analyst: QA_ANALYST_STAGE, triage: QA_TRIAGE_STAGE };
