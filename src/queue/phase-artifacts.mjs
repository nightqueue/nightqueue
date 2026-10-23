import { FILE_LIST } from "./file-list.mjs";

// The line the triage verdict must open with: the evidence level, 1 to 4, bold or plain.
const EVIDENCE_FIRST_LINE = {
  heading: "## Verdict",
  pattern: /^(\*\*)?Evidence level:(\*\*)?\s*[1-4](\*\*)?\s*$/,
  label: "Evidence level: <1|2|3|4> as the first line under ## Verdict",
};

// Where a phase's verdict is read: the suffix of its heading or the first line under it, and the values it may take.
function verdictSpec({ heading, from, values }) {
  const suffix = from === "heading-suffix" ? "" : " as the first line";
  return { heading, from, values, label: `${heading}: <${values.join("|")}>${suffix}` };
}

const TRIAGE_VERDICT = verdictSpec({ heading: "## Verdict", from: "heading-suffix", values: ["PROCEED", "NO-CHANGE-NEEDED", "NOT-REPRODUCIBLE", "NEEDS-CLARIFICATION", "PROPOSE-ALTERNATIVE"] });
const QA_VERDICT = verdictSpec({ heading: "## Verdict", from: "first-line", values: ["APPROVED", "NEEDS FIX", "NEEDS DISCUSSION"] });
const VERIFICATION_VERDICT = verdictSpec({ heading: "## Verification", from: "heading-suffix", values: ["PASSED", "PASSED-STATIC", "FAILED"] });
const RUNTIME_VERDICT = verdictSpec({ heading: "## Runtime verdict", from: "first-line", values: ["CONFIRMED", "NOT-MET", "SYMPTOM-PERSISTS", "NEEDS-DEVICE", "UNAVAILABLE"] });

// The sections a triage verdict's next step reads, so the check requires them filled on that verdict alone.
const TRIAGE_SECTIONS_BY_VERDICT = { "NEEDS-CLARIFICATION": ["## Open items"], "NOT-REPRODUCIBLE": ["## Open items"], "PROPOSE-ALTERNATIVE": ["## Open items"] };

// The artifact of each phase, the canonical phase it completes, the sections its gate requires (some only on a verdict) and where its verdict is read; a phase with no required section is checked for existence alone.
export const PHASE_ARTIFACTS = new Map([
  ["00", { file: "00-brief.md", phase: null, sections: ["## Brief"] }],
  ["01", { file: "01-triage.md", phase: "triage", sections: ["## Verdict", "## Validated brief", "## Out of scope", "## Request gaps"], sectionsByVerdict: TRIAGE_SECTIONS_BY_VERDICT, firstLineUnder: EVIDENCE_FIRST_LINE, verdict: TRIAGE_VERDICT }],
  ["02", { file: "02-explore.md", phase: "explore", sections: ["## File map", "## Access map", "## Third-party libraries"] }],
  ["03", { file: "03-plan.md", phase: "architecture", sections: ["## Implementation plan", "## Assumptions", "## Pre-mortem", "## Identified risks"] }],
  ["04", { file: "04-implementation.md", phase: "implementation", sections: [FILE_LIST] }],
  ["05a", { file: "05a-qa-analyst.md", phase: null, sections: ["## Proven breaks", "## Break hypotheses", "## Test recipe", "## Validated risks", "## Invalidated assumptions", "## Verdict"], rounds: true, verdict: QA_VERDICT }],
  ["05", { file: "05-qa.md", phase: "qa", sections: ["## Proven breaks", "## Validated risks", "## Invalidated assumptions", "## Generated PoCs", "## Verdict"], rounds: true, verdict: QA_VERDICT }],
  ["06", { file: "06-verification.md", phase: "verification", sections: ["## Checks run", "## Verification"], rounds: true, verdict: VERIFICATION_VERDICT }],
  ["06.5", { file: "06-runtime.md", phase: "runtime", sections: ["## Runtime verdict"], rounds: true, verdict: RUNTIME_VERDICT }],
]);

export const ROUND_HEADING = /^## Round (\d+)\b/i;
export const FIX_LOOP_HEADING = /^### Fix loop (\d+)\b/;

// The numbers of every line of the text that matches the heading pattern.
function headingNumbers(text, pattern) {
  return String(text ?? "")
    .split("\n")
    .map((line) => pattern.exec(line.trimEnd()))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

// The highest heading number of the text plus one, or 1 when it has none.
function nextNumber(text, pattern) {
  return Math.max(0, ...headingNumbers(text, pattern)) + 1;
}

// The last `## Round <n>` heading (anything after the number is decoration) of a round artifact up to its end, or the whole text when it has no round (a legacy artifact).
export function lastRound(text) {
  const lines = String(text ?? "").split("\n");
  const start = lines.findLastIndex((line) => ROUND_HEADING.test(line.trimEnd()));
  return start === -1 ? lines.join("\n") : lines.slice(start).join("\n");
}

// The number the next `## Round` of a round artifact takes.
export function nextRound(text) {
  return nextNumber(text, ROUND_HEADING);
}

// The number the next `### Fix loop` block of the implementation artifact takes.
export function nextFixLoop(text) {
  return nextNumber(text, FIX_LOOP_HEADING);
}
