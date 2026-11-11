import { PHASE_ARTIFACTS } from "./artifacts.mjs";
import { CHECK_CONTEXT_FILES, deviceScript, evaluateCheck, isTestPath, readVerdict } from "./contract.mjs";

// The pure reads the package's report.mjs takes from the check contract.

export { CHECK_CONTEXT_FILES, deviceScript, isTestPath };

// The artifact file of a check.
export function fileOf(check) {
  return PHASE_ARTIFACTS.get(check).file;
}

// The verdict a round's text states for a check, or null.
export function readVerdictOf(check, text) {
  return readVerdict(text, PHASE_ARTIFACTS.get(check).verdicts);
}

// The text of each `OPEN:` line one check answers for its artifact.
export function openLinesOf(check, texts, state) {
  return evaluateCheck({ check, texts, state })
    .lines.filter((line) => line.startsWith("OPEN: "))
    .map((line) => line.slice("OPEN: ".length));
}
