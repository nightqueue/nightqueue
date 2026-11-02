import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { deviceScript, isTestPath, readVerdict } from "../queue/check-contract.mjs";
import { recordedFiles } from "../queue/file-list.mjs";
import { canonicalPath } from "../queue/orchestrator-scope.mjs";
import { lastRound, PHASE_ARTIFACTS } from "../queue/phase-artifacts.mjs";
import { isStateObject } from "../queue/resume.mjs";
import { sectionOf, unfencedLines, withoutHtmlComments } from "../queue/stream.mjs";
import { readRunFile } from "./run-context.mjs";

export const FACTS_HEADING = "## Facts for the report";

const LINE_MAX = 220;
const BRIEF_MAX = 6;
const DIAGNOSIS_MAX = 6;
const SPAN_MAX = 3;
const LIST_MAX = 8;
const LEFT_MAX = 6;
const PREVENTION_MAX = 4;
const EVIDENCE_MAX = 2;
const FILES_MAX = 15;
const SCRIPT_MAX = 15;
const AREA_DEPTHS = [3, 2, 1];
const UNLISTED_LABEL = "Changed outside the list";
const UNLISTED_MAX = 30;
const UNLISTED_PATH_MAX = 512;
const UNLISTED_LINE_MAX = UNLISTED_LABEL.length + ": ".length + UNLISTED_PATH_MAX;
const GIT_STATUS = "`git status --short`";
const DEDICATED_TICKET = "dedicated ticket: yes";
const ROOT_CAUSE = "Confirmed root cause:";
const PLAN_FILES = "**Files to create/modify:**";
const PLAN_FIELD_RE = /^\*\*[^*]+:\*\*/;
const BULLET_RE = /^[-*]\s+/;
const TABLE_SEPARATOR_RE = /^\s*\|[\s:|-]*-[\s:|-]*\|?\s*$/;

// The lines of a section that say something: outside a fence, no bullet, no table head, no blank and no `None`.
function itemsOf(text, heading) {
  const section = sectionOf(text, heading);
  if (section === null) return [];
  const lines = unfencedLines(section).slice(1);
  return lines
    .filter((line, at) => !TABLE_SEPARATOR_RE.test(line) && !TABLE_SEPARATOR_RE.test(lines[at + 1] ?? ""))
    .map((line) => line.trim().replace(BULLET_RE, ""))
    .filter((line) => line !== "" && !/^(none|nothing)\b/i.test(line) && !/:\s*none\.?`?$/i.test(line));
}

// One labelled line per item, at most `max`, then one line saying how many were left out.
function labelled(label, items, max = items.length) {
  const kept = items.slice(0, max).map((item) => `${label}: ${item}`);
  return items.length > max ? [...kept, `${label}: +${items.length - max} more`] : kept;
}

// The value of one `**Label:** value` line of the Brief, or null.
function briefField(brief, label) {
  const line = unfencedLines(brief).find((candidate) => candidate.trim().startsWith(`**${label}:**`));
  return line === undefined ? null : line.trim().slice(label.length + 5).trim();
}

// What the Brief states about the target and the kind of commit.
function briefFacts(brief) {
  const fields = [["Expected outcome", briefField(brief, "Expected outcome")], ["Commit type", briefField(brief, "Commit type")]];
  return fields.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`);
}

// One long fact over a few lines instead of one clipped, the rest under `<label>, continued`.
function spanned(label, fact) {
  const points = [...fact];
  const width = LINE_MAX - label.length - ", continued: ".length;
  const chunks = Array.from({ length: Math.min(SPAN_MAX, Math.ceil(points.length / width)) }, (_, at) => points.slice(at * width, (at + 1) * width).join(""));
  return chunks.map((chunk, at) => `${at === 0 ? label : `${label}, continued`}: ${chunk}`);
}

// The triager's diagnosis on a bug: the root cause first, then the hypotheses and how each was validated.
function diagnosisFacts(triage) {
  const items = itemsOf(triage, "## Diagnosis");
  const rootCauses = items.filter((item) => item.startsWith(ROOT_CAUSE)).flatMap((item) => spanned(ROOT_CAUSE.slice(0, -1), item.slice(ROOT_CAUSE.length).trim()));
  const others = items.filter((item) => !item.startsWith(ROOT_CAUSE));
  const left = others.length > DIAGNOSIS_MAX ? [`Diagnosis: +${others.length - DIAGNOSIS_MAX} more`] : [];
  return [...rootCauses, ...others.slice(0, DIAGNOSIS_MAX).flatMap((item) => spanned("Diagnosis", item)), ...left];
}

// The validated brief and, on a bug, the diagnosis.
function triageFacts(triage) {
  return [...labelled("Validated brief", itemsOf(triage, "## Validated brief").slice(0, BRIEF_MAX)), ...diagnosisFacts(triage)];
}

// The plan's symptom vectors it does not cover, which make a delivery partial.
function coverageFacts(plan) {
  const rows = itemsOf(plan, "## Symptom coverage").filter((line) => line.startsWith("|") && line.includes("not-covered"));
  return labelled("Not covered", rows, LIST_MAX);
}

// The mode the QA triage recorded and why.
function qaModeFacts(state) {
  const qaMode = isStateObject(state?.qaMode) ? state.qaMode : null;
  return [`QA mode: ${qaMode === null ? "not recorded" : `${qaMode.mode} — ${qaMode.reason}`}`];
}

// The verdict of a round artifact, or the words saying it states none.
function verdictOf(round, check) {
  return readVerdict(round, PHASE_ARTIFACTS.get(check).verdict) ?? "not stated";
}

// The suggestions of a round that ask for a ticket of their own, a table row or a bullet alike.
function dedicatedItems(round) {
  return itemsOf(round, "## Suggestions").filter((line) => line.includes(DEDICATED_TICKET));
}

// The last QA round: its verdict, what stays broken, what held, its PoCs and its recommendations.
function qaFacts(qa) {
  const round = lastRound(qa);
  return [
    `QA verdict: ${verdictOf(round, "05")}`,
    ...labelled("Proven break", itemsOf(round, "## Proven breaks"), LIST_MAX),
    ...labelled("Validated risk", itemsOf(round, "## Validated risks"), LIST_MAX),
    ...labelled("Generated PoC", itemsOf(round, "## Generated PoCs"), LIST_MAX),
    ...labelled("Prevention", itemsOf(round, "## Prevention"), PREVENTION_MAX),
    ...labelled("Dedicated ticket", dedicatedItems(round), LIST_MAX),
  ];
}

// The last verification round: its verdict with what sustains it, the checks it ran, its failures, the ones the base shares and the diff-hygiene finding.
function verificationFacts(verification) {
  const round = lastRound(verification);
  const verdict = unfencedLines(round).find((line) => line.startsWith("## Verification"));
  const checks = itemsOf(round, "## Checks run");
  const isHygiene = (line) => /diff-hygiene/i.test(line);
  const hygiene = checks.find(isHygiene);
  return [
    verdict === undefined ? "Verification: not stated" : verdict.slice("## ".length),
    ...labelled("Verification evidence", itemsOf(round, "## Verification"), EVIDENCE_MAX),
    ...labelled("Check run", checks.filter((line) => !isHygiene(line)), LIST_MAX),
    ...labelled("Remaining failure", itemsOf(round, "## Failures"), LIST_MAX),
    ...labelled("Pre-existing failure", itemsOf(round, "## Pre-existing failures"), LIST_MAX),
    ...(hygiene ? [`Diff hygiene: ${hygiene}`] : []),
  ];
}

// The last runtime round: its verdict and every scenario it left unmet.
function runtimeFacts(runtime) {
  const round = lastRound(runtime);
  const rows = unfencedLines(round).filter((line) => line.trim().startsWith("|") && line.includes("NOT MET"));
  return [`Runtime verdict: ${verdictOf(round, "07")}`, ...labelled("Not met", rows.map((row) => row.trim()), LIST_MAX)];
}

// The device script of a run that stopped at a device, line by line.
function deviceFacts(runtime) {
  const round = lastRound(runtime);
  return verdictOf(round, "07") === "NEEDS-DEVICE" ? labelled("Device script", deviceScript(round).filter((line) => line !== ""), SCRIPT_MAX) : [];
}

// The non-empty files of the run's evidence directory, by name.
function evidenceFiles(runDir) {
  const dir = join(runDir, "evidence");
  try {
    return readdirSync(dir).filter((name) => statSync(join(dir, name)).size > 0).sort();
  } catch {
    return [];
  }
}

// A changed path as a fact: whole up to its limit, past it the file name and where the whole path is.
function unlistedPath(file) {
  const length = [...file].length;
  return length <= UNLISTED_PATH_MAX ? file : `…/${basename(file)} (a path of ${length} characters, whole in ${GIT_STATUS})`;
}

// The changed files with the test files first, so a resumed run can name a QA test for `--extra` before any limit applies.
function testsFirst(files, root) {
  const isTest = (file) => isTestPath(relative(root, file));
  return [...files.filter(isTest), ...files.filter((file) => !isTest(file))];
}

// The files the worktree changed that the implementation does not list, up to a limit past which one line says how many are held back and where they are, or the words saying git could not tell.
function unlistedFacts(implementation, worktree) {
  if (worktree === null) return [`${UNLISTED_LABEL}: unknown, git answered nothing`];
  const listed = new Set(recordedFiles(implementation).map((file) => canonicalPath(resolve(worktree.path, file))));
  const unlisted = testsFirst(worktree.changed.filter((file) => !listed.has(canonicalPath(file))), worktree.path);
  const held = unlisted.length - UNLISTED_MAX;
  return [...labelled(UNLISTED_LABEL, unlisted.slice(0, UNLISTED_MAX).map(unlistedPath)), ...(held > 0 ? [`${UNLISTED_LABEL}: +${held} more, shown by ${GIT_STATUS}`] : [])];
}

// A text with the worktree's own prefix dropped from its paths, so a clipped line loses words, never the description.
function withoutRoot(text, root) {
  return root === "" ? text : text.split(`${root}/`).join("");
}

// How many files each directory holds at one depth, keeping the order the list gave.
function filesPerArea(files, depth) {
  const counts = new Map();
  for (const file of files) {
    const area = file.split("/").slice(0, -1).slice(0, depth).join("/") || ".";
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts];
}

// The areas of a long list at the deepest level that fits, the ones past the limit folded into one, so every file stays counted.
function areasOf(files) {
  const fitting = AREA_DEPTHS.map((depth) => filesPerArea(files, depth)).find((areas) => areas.length <= FILES_MAX);
  if (fitting !== undefined) return fitting;
  const shallow = filesPerArea(files, AREA_DEPTHS.at(-1));
  const folded = shallow.slice(FILES_MAX - 1).reduce((sum, [, count]) => sum + count, 0);
  return [...shallow.slice(0, FILES_MAX - 1), ["other areas", folded]];
}

// The implementation's files: each by name while the list is short, by area with its count when it is long, never one dropped.
function modifiedFacts(implementation, root) {
  const files = recordedFiles(implementation);
  if (files.length <= FILES_MAX) return labelled("Modified file", files);
  return areasOf(files.map((file) => withoutRoot(file, root))).map(([area, count]) => `Modified files: ${area} (${count} files)`);
}

// The lines of the plan's file list, each saying what changes in one file.
function plannedLines(plan) {
  const lines = unfencedLines(plan).map((line) => line.trim());
  const start = lines.indexOf(PLAN_FILES);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => PLAN_FIELD_RE.test(line) || line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).filter((line) => BULLET_RE.test(line)).map((line) => line.replace(BULLET_RE, ""));
}

// What the plan says changes in each file and what the implementation left or deviated from, which describe the pull request's changes.
function changeFacts(plan, implementation, root) {
  return [
    ...labelled("Planned change", plannedLines(plan).map((line) => withoutRoot(line, root)), FILES_MAX),
    ...labelled("Implementation left", itemsOf(implementation, "## Left"), LEFT_MAX),
  ];
}

// The worktree the run recorded, or an empty text when it recorded none.
function recordedRoot(state) {
  return typeof state?.worktree === "string" ? state.worktree.trim() : "";
}

// The lines one artifact gives, or the one line saying the run has none.
function fromArtifact(texts, file, facts) {
  return texts[file] === "" ? [`${file}: missing`] : facts(texts[file]);
}

// Every fact of the run, each list bounded on its own, so no artifact can push another's facts out.
function allFacts({ runDir, state, worktree }, texts) {
  const plan = texts["03-plan.md"];
  const implementation = texts["04-implementation.md"];
  const root = recordedRoot(state);
  return [
    ...fromArtifact(texts, "00-brief.md", briefFacts),
    ...fromArtifact(texts, "01-triage.md", triageFacts),
    ...fromArtifact(texts, "03-plan.md", coverageFacts),
    ...qaModeFacts(state),
    ...fromArtifact(texts, "05-qa.md", qaFacts),
    ...fromArtifact(texts, "06-verification.md", verificationFacts),
    ...fromArtifact(texts, "07-runtime.md", runtimeFacts),
    ...labelled("Decision taken", itemsOf(plan, "## Decisions taken"), LIST_MAX),
    ...labelled("Evidence", evidenceFiles(runDir), LIST_MAX),
    ...unlistedFacts(implementation, worktree),
    ...fromArtifact(texts, "04-implementation.md", (text) => modifiedFacts(text, root)),
    ...changeFacts(plan, implementation, root),
    ...deviceFacts(texts["07-runtime.md"]),
  ];
}

// One fact as a list line on one line, clipped to its label's width, so no artifact text can open a heading of the report.
function factLine(fact) {
  const text = String(fact).replace(/\s+/g, " ").trim();
  const max = text.startsWith(`${UNLISTED_LABEL}: `) ? UNLISTED_LINE_MAX : LINE_MAX;
  const points = [...text];
  return `- ${points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`}`;
}

const FACT_FILES = ["00-brief.md", "01-triage.md", "03-plan.md", "04-implementation.md", "05-qa.md", "06-verification.md", "07-runtime.md"];

// The bounded lines of `## Facts for the report`, read from the run's artifacts; a failure is one line, never a failed report.
export function reportFacts({ runDir, state, worktree = null }) {
  try {
    const texts = Object.fromEntries(FACT_FILES.map((file) => [file, withoutHtmlComments(readRunFile(runDir, file))]));
    return allFacts({ runDir, state, worktree }, texts).map(factLine);
  } catch (error) {
    return [factLine(`the facts could not be read: ${error?.message ?? String(error)}`)];
  }
}
