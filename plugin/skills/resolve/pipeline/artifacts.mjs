import { readFileSync } from "node:fs";

// The package's own manifest, the one source of each phase's file and verdicts.
export const MANIFEST = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

// The verdict only the runtime writes for a QA the triage skipped: it may be recorded, but no artifact states it.
export const QA_SKIP_VERDICT = "SKIPPED";

// The words a check answers by itself, which no artifact states as its verdict.
const CHECK_WORDS = new Set(["OK", "GENERATED", QA_SKIP_VERDICT]);

// The manifest entry of a check.
function phaseOf(check) {
  return MANIFEST.phases.find((phase) => phase.check === check);
}

// The verdict words an artifact may state, none when the step has no verdict.
function artifactVerdicts(words) {
  return (words ?? []).filter((word) => !CHECK_WORDS.has(word));
}

// The artifact of one manifest phase: its file, the canonical phase it completes, whether it has rounds or derives the file list, and its verdict words.
function artifactOf(phase) {
  return {
    file: phase.artifact,
    phase: phase.id,
    rounds: phase.rounds === true,
    derivesFileList: phase.derivesFileList === true,
    verdicts: artifactVerdicts(phase.verdicts),
  };
}

// The artifact of each phase, by check.
export const PHASE_ARTIFACTS = new Map(MANIFEST.phases.filter((phase) => phase.check !== null).map((phase) => [phase.check, artifactOf(phase)]));

const QA = phaseOf("05");

// The analyst stage of a full QA (`run check 05 --stage analyst`): its round of `05-qa.md`, which completes no phase.
export const QA_ANALYST_STAGE = { file: QA.artifact, phase: null, rounds: true, derivesFileList: false, verdicts: artifactVerdicts(QA.stages.analyst.verdicts) };

// The triage stage of the QA (`run check 05 --stage triage`): its own named round of `05-qa.md`, whose verdict is the QA mode.
export const QA_TRIAGE_STAGE = {
  file: QA.artifact,
  phase: null,
  rounds: true,
  derivesFileList: false,
  verdicts: artifactVerdicts(QA.stages.triage.verdicts),
  source: /^source:\s*qa-triage\s*$/i,
};

export const QA_STAGES = { analyst: QA_ANALYST_STAGE, triage: QA_TRIAGE_STAGE };
