import { FILE_LIST } from "./file-list.mjs";

// The line the triage verdict must open with: the evidence level, 1 to 4, bold or plain.
const EVIDENCE_FIRST_LINE = {
  heading: "## Verdict",
  pattern: /^(\*\*)?Evidence level:(\*\*)?\s*[1-4](\*\*)?\s*$/,
  label: "Evidence level: <1|2|3|4> as the first line under ## Verdict",
};

// The artifact of each phase and the sections its gate requires; a phase with no required section is checked for existence alone.
export const PHASE_ARTIFACTS = new Map([
  ["00", { file: "00-brief.md", sections: ["## Brief"] }],
  ["01", { file: "01-triage.md", sections: ["## Verdict", "## Validated brief", "## Out of scope", "## Request gaps"], firstLineUnder: EVIDENCE_FIRST_LINE }],
  ["02", { file: "02-explore.md", sections: [] }],
  ["03", { file: "03-plan.md", sections: ["## Implementation plan", "## Assumptions", "## Pre-mortem", "## Identified risks"] }],
  ["04", { file: "04-implementation.md", sections: [FILE_LIST] }],
  ["05a", { file: "05a-qa-analyst.md", sections: ["## Break hypotheses", "## Test recipe"], rounds: true }],
  ["05", { file: "05-qa.md", sections: ["## Validated risks"], rounds: true }],
  ["06", { file: "06-verification.md", sections: ["## Verification"], rounds: true }],
  ["06.5", { file: "06-runtime.md", sections: ["## Runtime verdict"], rounds: true }],
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
