import { createHash } from "node:crypto";
import { FILE_LIST } from "../../../../src/queue/file-list.mjs";
import { repairedLine, withClosedFence } from "../../../../src/queue/rounds.mjs";
import { MANIFEST, PHASE_ARTIFACTS } from "./artifacts.mjs";
import { consolidatedText, consolidationOf } from "./consolidation.mjs";
import { CHECK_CONTEXT_FILES, evaluateCheck, fileListResult } from "./contract.mjs";
import { answerParts } from "./effects.mjs";
import { nextOf } from "./next.mjs";

// One write the runtime applies before anything else of the answer, under the run lock when the phase has rounds.
function lockedWrite(name, text, what) {
  return { kind: "writeRunFile", name, text, what, locked: true };
}

// Whether the implementation artifact already lists at least one file, which is what its section exists for.
function listsFiles(text) {
  const after = text.split(FILE_LIST).slice(1).join(FILE_LIST);
  const body = after.split("\n## ")[0] ?? "";
  return body.split("\n").some((line) => line.trim() !== "");
}

// The gate of the implementation artifact, the only one with a fallback: no file list means deriving it from the worktree's changes into its own file, never over the artifact.
function checkFileList(artifact, files) {
  const text = files.read(artifact.file);
  if (listsFiles(text)) return { result: fileListResult("OK", text), repaired: null, writes: [] };
  const changed = files.changed;
  if (changed.length === 0) return { result: fileListResult(`MISSING: ${FILE_LIST} (no changed files)`, text), repaired: null, writes: [] };
  const body = ["# Implementation (derived from git)", "", FILE_LIST, ...changed, ""].join("\n");
  return { result: fileListResult("GENERATED", body), repaired: null, writes: [lockedWrite(MANIFEST.fileListFallback, body, "the derived file list")] };
}

// A round artifact with the code fence it leaves open closed, the `REPAIRED:` line of that and its write.
function withFenceRepair(file, raw) {
  const { text, closed } = raw === "" ? { text: raw, closed: null } : withClosedFence(raw);
  if (closed === null) return { raw, repaired: null, writes: [] };
  return { raw: text, repaired: repairedLine(file, closed), writes: [lockedWrite(file, text, "the closing code fence")] };
}

// A full QA's artifact with the consolidated round it still lacks, and its write; with nothing to consolidate the last round is read as is.
function withConsolidation(file, raw) {
  const consolidation = raw === "" ? null : consolidationOf(raw);
  if (consolidation === null) return { raw, writes: [] };
  const text = consolidatedText(raw, consolidation);
  return { raw: text, writes: [lockedWrite(file, text, "the QA consolidation")] };
}

// The answer of a round artifact's check over its repaired and consolidated text, held in memory, and the writes that make the disk match it.
function roundsResult({ phase, stage, state, files, artifact }) {
  const fence = withFenceRepair(artifact.file, files.read(artifact.file));
  const merged = phase === "05" && stage === null ? withConsolidation(artifact.file, fence.raw) : { raw: fence.raw, writes: [] };
  const texts = { ...contextTexts(files), [artifact.file]: merged.raw };
  return { result: evaluateCheck({ check: phase, stage, texts, state }), repaired: fence.repaired, writes: [...fence.writes, ...merged.writes] };
}

// The run files a check's rules read besides its own artifact.
function contextTexts(files) {
  return Object.fromEntries(CHECK_CONTEXT_FILES.map((file) => [file, files.read(file)]));
}

// The answer of one phase, evaluated against the check contract on the artifact and the run files it reads.
function evaluated({ phase, stage, state, files }) {
  const artifact = PHASE_ARTIFACTS.get(phase);
  if (artifact.derivesFileList) return checkFileList(artifact, files);
  if (artifact.rounds) return roundsResult({ phase, stage, state, files, artifact });
  const texts = { ...contextTexts(files), [artifact.file]: files.read(artifact.file) };
  return { result: evaluateCheck({ check: phase, stage, texts, state }), repaired: null, writes: [] };
}

// The write of the loops a check changed, with the decision record in the same write when there is one, placed before the effects so a renamed run dir cannot lose it.
function loopEffects(loops, state, decision) {
  if (decision !== null) return [{ kind: "recordDecision", decision, loops }];
  return JSON.stringify(loops) === JSON.stringify(state?.pipelineLoops ?? null) ? [] : [{ kind: "recordFields", fields: { pipelineLoops: loops } }];
}

// The sha256 of the implementation as the run holds it: its artifact, else the derived file list, including one this check is about to write.
function implDigestOf(files, writes) {
  const implementation = files.read(PHASE_ARTIFACTS.get("04").file);
  const derived = writes.find((write) => write.name === MANIFEST.fileListFallback)?.text ?? files.read(MANIFEST.fileListFallback);
  return createHash("sha256")
    .update(implementation !== "" ? implementation : derived)
    .digest("hex");
}

// Answers `run check` for one phase of `resolve`: the contract lines, the phase record, the memo, the effects with every artifact write first, and the next action.
export function check({ phase, stage, state, files, run }) {
  const { result, repaired, writes } = evaluated({ phase, stage, state, files });
  const [first, ...rest] = result.lines;
  const { record, memo, effects } = answerParts({ check: phase, stage, result, state, run });
  const raw = files.read(PHASE_ARTIFACTS.get(phase).file);
  const { action, loops, decision } = nextOf({ result, repaired, state, memo, plan: files.read(MANIFEST.gateArtifact), implDigest: implDigestOf(files, writes), raw });
  return { lines: [first, ...(repaired ? [repaired] : []), ...rest], script: result.script, record, memo, effects: [...writes, ...loopEffects(loops, state, decision), ...effects], next: action };
}
