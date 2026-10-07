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
  ["01", { file: "01-triage.md", sections: ["## Verdict"], firstLineUnder: EVIDENCE_FIRST_LINE }],
  ["02", { file: "02-explore.md", sections: [] }],
  ["03", { file: "03-plan.md", sections: ["## Implementation plan", "## Assumptions", "## Pre-mortem", "## Identified risks"] }],
  ["04", { file: "04-implementation.md", sections: [FILE_LIST] }],
  ["05a", { file: "05a-qa-analyst.md", sections: ["## Break hypotheses", "## Test recipe"] }],
  ["05", { file: "05-qa.md", sections: ["## Validated risks"] }],
  ["06", { file: "06-verification.md", sections: ["## Verification"] }],
  ["06.5", { file: "06-runtime.md", sections: ["## Runtime verdict"] }],
]);
