import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobRef } from "../memory/refs.mjs";
import { lastRound, PHASE_ARTIFACTS } from "./phase-artifacts.mjs";
import { hasGateMarker, sectionOf, sectionOfAnyLevel } from "./stream.mjs";

// The heading every gate notice opens with, the one the classifier looks for.
const GATE_HEADING = "## Requires user confirmation";

// A run artifact named by its bare file name: no directory, no traversal.
const ARTIFACT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

// The artifacts whose evaluated text is their last `## Round`.
const ROUND_FILES = new Set([...PHASE_ARTIFACTS.values()].filter((entry) => entry.rounds).map((entry) => entry.file));

// The text of a sent value, or null when it is absent or blank.
function sentText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Reads one artifact of the run directory, refusing a path or a file that is not there.
function readRunArtifact(runDir, file) {
  if (!ARTIFACT_FILE_RE.test(file)) {
    throw new UserError(`\`from_artifact.file\` must be the bare name of a run artifact (e.g. \`03-plan.md\`), not \`${file}\`: nothing was recorded`);
  }
  try {
    const text = readFileSync(join(runDir, file), "utf8");
    return ROUND_FILES.has(file) ? lastRound(text) : text;
  } catch (err) {
    if (err?.code === "ENOENT") throw new UserError(`\`${file}\` does not exist in the run directory ${runDir}: nothing was recorded`);
    throw new UserError(`\`${file}\` could not be read (${err?.message ?? err}): nothing was recorded`);
  }
}

// The named section of a run artifact, exact level first then any level, so every section `run check` requires or announces is found here; refused when absent.
function artifactSection(runDir, fromArtifact) {
  const file = sentText(fromArtifact?.file) ?? "";
  const section = sentText(fromArtifact?.section) ?? "";
  if (!section.startsWith("#")) {
    throw new UserError(`\`from_artifact.section\` must be a heading such as \`## Requires user confirmation\`, not \`${section}\`: nothing was recorded`);
  }
  const text = readRunArtifact(runDir, file);
  const body = sectionOf(text, section) ?? sectionOfAnyLevel(text, section);
  if (body === null) throw new UserError(`${file} has no \`${section}\` section: nothing was recorded`);
  return body;
}

// The section under the gate heading: verbatim when it already is the confirmation section, else nested under it.
function underGateHeading(section) {
  const firstLine = section.split("\n")[0];
  return hasGateMarker(firstLine) ? section : `${GATE_HEADING}\n\n${section}`;
}

// The whole `## Notice` body of a gate, composed from an artifact section and/or a question, ending with how to answer it.
export function composeGateNotice({ runDir, jobId = null, question, fromArtifact } = {}) {
  const asked = sentText(question);
  if (!fromArtifact && asked === null) throw new UserError("a composed gate notice needs `question` or `from_artifact`");
  const parts = fromArtifact ? [underGateHeading(artifactSection(runDir, fromArtifact))] : [GATE_HEADING];
  if (asked !== null) parts.push(asked);
  if (jobId !== null) parts.push(`Answer with: nightqueue queue retry ${jobRef(jobId)} --note "<your answer>"`);
  return parts.join("\n\n");
}
