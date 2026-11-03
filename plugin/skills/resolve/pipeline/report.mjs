import { basename, relative, resolve } from "node:path";
import { recordedFiles } from "../../../../src/queue/file-list.mjs";
import { canonicalPath } from "../../../../src/queue/orchestrator-scope.mjs";
import { verdictWord } from "../../../../src/queue/pipeline-record.mjs";
import { isStateObject } from "../../../../src/queue/resume.mjs";
import { lastRound } from "../../../../src/queue/rounds.mjs";
import { sectionOf, unfencedLines } from "../../../../src/queue/stream.mjs";
import { CHECK_CONTEXT_FILES, deviceScript, fileOf, isTestPath, openLinesOf as openItemsOf, readVerdictOf } from "./reader.mjs";

const OPEN_CHECKS = ["03", "05", "06", "07"];
const DEDICATED_TICKET = "dedicated ticket: yes";

export const FACT_FILES = ["00-brief.md", "01-triage.md", "03-plan.md", "04-implementation.md", "05-qa.md", "06-verification.md", "07-runtime.md"];

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
const ROOT_CAUSE = "Confirmed root cause:";
const PLAN_FILES = "**Files to create/modify:**";
const PLAN_FIELD_RE = /^\*\*[^*]+:\*\*/;
const BULLET_RE = /^[-*]\s+/;
const TABLE_SEPARATOR_RE = /^\s*\|[\s:|-]*-[\s:|-]*\|?\s*$/;

// The recorded entries of one phase in state.json, in the order they were recorded.
function entriesOf(state, phase) {
  const phases = Array.isArray(state.phases) ? state.phases : [];
  return phases.filter((entry) => entry?.phase === phase);
}

// True when the verification passed with a real run of the checks, which is what lets a change skip 7 as purely static.
function passedWithoutRuntimeDebt(state) {
  const last = entriesOf(state, "verification").at(-1);
  return last !== undefined && verdictWord(last.verdict) === "PASSED";
}

// The note of an entry alone, trimmed; empty when it recorded none.
function trimmedNote(entry) {
  return typeof entry.note === "string" ? entry.note.trim() : "";
}

// The row of a phase the run recorded, when resolve reads it its own way: a skip the QA mode decided reads its why, and a commit entry reads the delivery.
function recordedRowOf({ phase, entry, state, delivery, note }) {
  const word = verdictWord(entry.verdict);
  if (phase === "qa" && word === "SKIPPED" && state.qaMode?.mode === "skip") return { icon: "⏭️", word: "", note: `no new risk: ${trimmedNote(entry)}` };
  if (phase === "commit") return { icon: "✅", word, note: delivery ?? (note || "committed, no pull request recorded") };
  return null;
}

// The row of a phase the run never recorded, when resolve reads it from what was recorded around it.
function missingRowOf({ phase, state, delivery }) {
  if (phase === "commit") return delivery === null ? { icon: "⚠️", word: "", note: "no pull request recorded" } : { icon: "✅", word: "", note: delivery };
  if (phase === "runtime" && passedWithoutRuntimeDebt(state)) return { icon: "⏭️", word: "", note: "purely static change" };
  return null;
}

// The icon, word and note of one report row resolve reads its own way, or null for the runtime's default.
export function rowOf(row) {
  return row.entry === null ? missingRowOf(row) : recordedRowOf(row);
}

// A text collapsed onto one line.
function flatLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// The bullets of a markdown section, each flattened onto one line with its indented continuation lines.
function sectionBullets(section) {
  const bullets = [];
  for (const line of String(section ?? "").split("\n")) {
    if (/^\s*[-*]\s+/.test(line)) bullets.push(line.replace(/^\s*[-*]\s+/, ""));
    else if (bullets.length > 0 && /^\s+\S/.test(line)) bullets[bullets.length - 1] += ` ${line}`;
  }
  return bullets.map(flatLine).filter((bullet) => bullet !== "");
}

// The suggestions of the QA's last round that ask for a ticket of their own.
function dedicatedTickets(read) {
  const qa = lastRound(read(fileOf("05")));
  return sectionBullets(sectionOf(qa, "## Suggestions"))
    .filter((bullet) => bullet.includes(DEDICATED_TICKET))
    .map((bullet) => `dedicated ticket: ${bullet}`);
}

// The `OPEN:` lines one check answers for its artifact, named by the check; a check that cannot be evaluated is an open item itself.
function openLinesOf(check, read, state) {
  const file = fileOf(check);
  if (read(file) === "") return [];
  const texts = Object.fromEntries([...CHECK_CONTEXT_FILES, file].map((name) => [name, read(name)]));
  try {
    return openItemsOf(check, texts, state).map((item) => `${check} open: ${item}`);
  } catch {
    return [`the open items of check ${check} could not be read`];
  }
}

// The items resolve's artifacts leave open: the QA's dedicated tickets, then the `OPEN:` lines of the plan, QA, verification and runtime checks.
export function openItems({ read, state }) {
  return [...dedicatedTickets(read), ...OPEN_CHECKS.flatMap((check) => openLinesOf(check, read, state))];
}

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
  return readVerdictOf(check, round) ?? "not stated";
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

// The lines of the files the worktree changed that the implementation does not list, or the words saying git could not tell.
function unlistedLines(implementation, worktree) {
  if (worktree === null) return [`${UNLISTED_LABEL}: unknown, git answered nothing`];
  const listed = new Set(recordedFiles(implementation).map((file) => canonicalPath(resolve(worktree.path, file))));
  const unlisted = testsFirst(worktree.changed.filter((file) => !listed.has(canonicalPath(file))), worktree.path);
  const held = unlisted.length - UNLISTED_MAX;
  return [...labelled(UNLISTED_LABEL, unlisted.slice(0, UNLISTED_MAX).map(unlistedPath)), ...(held > 0 ? [`${UNLISTED_LABEL}: +${held} more, shown by ${GIT_STATUS}`] : [])];
}

// The unlisted changes as facts clipped at the wider width a whole path needs.
function unlistedFacts(implementation, worktree) {
  return unlistedLines(implementation, worktree).map((text) => ({ text, max: UNLISTED_LINE_MAX }));
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

// The lines one artifact gives, or the one line saying the run has none.
function fromArtifact(texts, file, facts) {
  return texts[file] === "" ? [`${file}: missing`] : facts(texts[file]);
}

// Every fact of the run, each list bounded on its own, so no artifact can push another's facts out.
export function facts({ texts, state, root, evidence, worktree }) {
  const plan = texts["03-plan.md"];
  const implementation = texts["04-implementation.md"];
  return [
    ...fromArtifact(texts, "00-brief.md", briefFacts),
    ...fromArtifact(texts, "01-triage.md", triageFacts),
    ...fromArtifact(texts, "03-plan.md", coverageFacts),
    ...qaModeFacts(state),
    ...fromArtifact(texts, "05-qa.md", qaFacts),
    ...fromArtifact(texts, "06-verification.md", verificationFacts),
    ...fromArtifact(texts, "07-runtime.md", runtimeFacts),
    ...labelled("Decision taken", itemsOf(plan, "## Decisions taken"), LIST_MAX),
    ...labelled("Evidence", evidence, LIST_MAX),
    ...unlistedFacts(implementation, worktree),
    ...fromArtifact(texts, "04-implementation.md", (text) => modifiedFacts(text, root)),
    ...changeFacts(plan, implementation, root),
    ...deviceFacts(texts["07-runtime.md"]),
  ];
}
