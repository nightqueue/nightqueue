import { PIPELINE_TASK_TYPES } from "../../../../src/memory/runs.mjs";
import { answerSinceGate, gateQuestion, questionDigest, unreadableQuestion } from "../../../../src/queue/question-text.mjs";
import { lastRound, lastRoundWithSource, roundSourceLine, roundsOf } from "../../../../src/queue/rounds.mjs";
import { sectionOf, unfencedLines, withoutHtmlComments } from "../../../../src/queue/stream.mjs";
import { PHASE_ARTIFACTS, QA_STAGES, QA_TRIAGE_STAGE } from "./artifacts.mjs";
import { briefType } from "./brief.mjs";

// The contract of `nightqueue run check`: the artifact exists and, when its step has a verdict, states one of its words; one fact per line, in this order.
// OK | MISSING: <what> | GENERATED, then VERDICT:, CONFIRM:, QA-MODE:, QA-STAGE:, NEEDS-DEVICE, and last of all SCRIPT: with the device script verbatim.

const BUG = "bug/error";
const FEATURE = "feature/refactor";
const EVIDENCE_MAX = 160;
export const CONFIRM_LINE = "CONFIRM: requires-user-confirmation";
const CONFIRM_ANSWERED = "CONFIRM: answered";
const QA_MODE_FALLBACK_REASON = "stated by the QA triage";
const UNREADABLE_QUESTION = "## Requires user confirmation (no **Question:** line with a ?: write the question with its ?, or drop the section when nothing is asked)";
// An item that says there is nothing: `None`, `(none)`, `n/a`, `nothing`.
const NONE_ITEM_RE = /^\(?\s*(?:none|nothing|n\/a)\b/i;
// What may follow a verdict word: nothing, or a separator before its reason; never a `|` or `/` of an unfilled option list.
const AFTER_WORD_RE = /^(?![-\w])(?!\s*[|/])/;
// A label a verdict may follow on its own line: `Verdict:`, `Verification:`, `QA mode:`.
const VERDICT_LABEL_RE = /^(?:verdict|verification|qa mode)\s*:\s*/i;
// A heading title under which the first line is the verdict.
const VERDICT_TITLE_RE = /verdict|verification|qa mode/i;
const HEADING_RE = /^#{1,6}\s+/;
// The separator between a QA mode and its reason: a dash or a colon.
const REASON_RE = /^\s*(?:[—–-]+|:)\s*/;
// A line that opens with a hypothesis id, `H1`, `- **H2:**`, `### H3`.
const HYPOTHESIS_LINE_RE = /^[\s\-*+#>`_]*(?:\d+[.)]\s+)?[*_`]*H\d+\b/;
// A path under a test directory, or a file named as a test; a word that merely contains `test` or `spec` is neither.
const TEST_PATH_RE = /(?<![\w./-])(?:[\w.-]+\/)*(?:(?:tests?|specs?|__tests__)\/[\w./-]*\.\w+|(?:test_[\w.-]*|[\w.-]*(?:[._-](?:tests?|specs?)|Tests?|Spec))\.\w+)/;
// The verdicts that send the pipeline back instead of completing the phase.
const LOOP_BACK = { "06": ["FAILED"], "07": ["NOT-MET", "SYMPTOM-PERSISTS"] };
// The verdicts a check memo keeps as its notable line when nothing else fired.
const FAILING = { ...LOOP_BACK, "05": ["NEEDS FIX"] };
// A stage heading of a plan, `### Stage 2 — …`, or a bullet or bold line that titles one, `- Stage 2: …`, `**Stage 2**`; prose such as `- Stage 2 deploy may fail` is neither.
const PLAN_STAGE_RE = /^\s*(?:#{1,6}\s+(?:\*\*)?|(?:[-*]\s+)?(?:\*\*)?(?=Stage\s+\d+\b(?:\*\*)?\s*(?:$|[:.)—–-])))Stage\s+(\d+)\b/;
// A plan's QA line, `QA: attack`, `- **QA:** none`, `QA: \`none\``: the word after the label.
const PLAN_QA_LINE_RE = /^[\s\-*>`_]*QA[*`_]*\s*:\s*[*`_]*\s*([a-z]+)/i;
// A report's fix mark, `fix: design`, `- **fix:** code`, `` `fix: code` ``: the route after the label, alone or before a separator, so `fix: design is not needed` is no mark.
const FIX_MARK_RE = /^[\s\-*>`_]*fix[*`_]*\s*:\s*[*`_]*\s*(code|design)[*`_]*\s*(?:$|[—–:;,.(]|-\s)/i;

// The text as the checks read it: no HTML comment, so a commented-out line never counts.
function normalize(text) {
  return withoutHtmlComments(String(text ?? ""));
}

// A text folded into one trimmed line.
export function flatLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// One trimmed line of evidence, at most 160 code points.
function evidenceLine(text) {
  const points = [...flatLine(text)];
  return points.length <= EVIDENCE_MAX ? points.join("") : `${points.slice(0, EVIDENCE_MAX - 1).join("")}…`;
}

// A value without its markdown decoration (bold, italics, backticks).
function plainValue(text) {
  return String(text ?? "")
    .replace(/[*`_]/g, "")
    .trim();
}

// The lines under a section's heading, outside a fence; null when the section is absent.
function bodyLines(text, heading) {
  const section = sectionOf(text, heading);
  return section === null ? null : unfencedLines(section).slice(1).map((line) => line.trimEnd());
}

// Whether a line is a markdown bullet, at any indent.
function isBullet(line) {
  return /^\s*[-*]\s+/.test(line);
}

// The non-blank lines with each indented continuation joined to the top-level line above it.
function foldedLines(lines, fold) {
  const folded = [];
  for (const line of lines) {
    const continues = fold && folded.length > 0 && !isBullet(line) && line.search(/\S/) > 0;
    if (continues) folded[folded.length - 1] += ` ${line.trim()}`;
    else folded.push(line);
  }
  return folded;
}

// Whether an item says there is nothing.
function isNoneItem(item) {
  return NONE_ITEM_RE.test(plainValue(item));
}

// The items of a section other than `None`: its bullets, or its lines when it has none; none when the section is absent.
export function sectionItems(text, heading, { fold = false } = {}) {
  const present = (bodyLines(text, heading) ?? []).filter((line) => line.trim() !== "");
  const lines = foldedLines(present, fold).map((line) => line.trim());
  const bullets = lines.filter(isBullet);
  return (bullets.length > 0 ? bullets : lines).map((line) => line.replace(/^[-*]\s+/, "").trim()).filter((item) => !isNoneItem(item));
}

// The first item of a section (a bullet or a prose line, a `None` item skipped), or null when the section is absent or has none.
export function firstItem(text, heading) {
  const lines = bodyLines(text, heading);
  if (lines === null) return null;
  const items = lines.map((line) => line.replace(/^\s*[-*]\s+/, "").trim());
  return items.find((item) => item !== "" && !isNoneItem(item)) ?? null;
}

// The word of the list the text opens with, matched longest first and in any case, never as the prefix of a longer word nor as the first option of an unfilled list; null when none.
function leadingWord(text, words) {
  const upper = text.toUpperCase();
  const longestFirst = [...words].sort((a, b) => b.length - a.length);
  return longestFirst.find((word) => upper.startsWith(word.toUpperCase()) && AFTER_WORD_RE.test(upper.slice(word.length))) ?? null;
}

// A line without its list marker, decoration and heading marks.
function strippedLine(line) {
  return plainValue(line.replace(/^\s*(?:[-*+>]\s+)+/, "")).replace(HEADING_RE, "");
}

// The word a candidate text opens with and the text after it, or null; a bare one asks the word to stand alone, so `## Confirmed root cause` is no verdict.
function wordOf(candidate, words, { bare = false } = {}) {
  const word = leadingWord(candidate, words);
  if (word === null) return null;
  const rest = candidate.slice(word.length);
  return bare && /^\s*[a-z]/i.test(rest) ? null : { word, rest };
}

// The verdict a bare heading states, such as `## Passed`, marked weak since a content heading may carry the same word.
function bareHeadingVerdict(stripped, words) {
  const found = wordOf(stripped, words, { bare: true });
  return found === null ? null : { ...found, weak: true };
}

// The verdict one line states: its own text when it is a verdict heading or a labelled line standing alone, a bare heading's word, or the first line under a verdict heading.
function verdictAt(lines, at, words) {
  const line = lines[at];
  const stripped = strippedLine(line);
  if (!HEADING_RE.test(line.trim())) return VERDICT_LABEL_RE.test(stripped) ? wordOf(stripped.replace(VERDICT_LABEL_RE, ""), words, { bare: true }) : null;
  if (!VERDICT_TITLE_RE.test(stripped)) return bareHeadingVerdict(stripped, words);
  const own = wordOf(stripped.replace(VERDICT_LABEL_RE, ""), words);
  if (own !== null) return own;
  const below = lines.slice(at + 1).find((candidate) => candidate.trim() !== "");
  return below === undefined || HEADING_RE.test(below.trim()) ? null : wordOf(strippedLine(below), words);
}

// The verdict a round states among the words, with the text after it: the last line that states one, a bare heading only when no other line does; null when none does.
function statedVerdict(text, words) {
  const lines = unfencedLines(normalize(text));
  const found = lines.map((_line, at) => verdictAt(lines, at, words)).filter((verdict) => verdict !== null);
  return found.findLast((verdict) => verdict.weak !== true) ?? found.at(-1) ?? null;
}

// The verdict a round states among the words, or null when it states none of them.
export function readVerdict(text, words) {
  return statedVerdict(text, words)?.word ?? null;
}

// The Type the triage implies: bug/error with a confirmed cause or a symptom proof, feature/refactor without one, null with no triage at all.
export function derivedType(triage) {
  const text = normalize(triage);
  if (text.trim() === "") return null;
  const lines = (bodyLines(text, "## Diagnosis") ?? []).map(plainValue);
  const proven = lines.some((line) => /^(?:-\s*)?(?:Confirmed root cause|Symptom proof)\s*:\s*\S/i.test(line) && !/:\s*(?:<.*>|n\/a|not applicable)\s*$/i.test(line));
  return proven ? BUG : FEATURE;
}

// The Type of the run: the Brief's on the triage, else the recorded one, else the triage's, else bug/error.
function runType({ check, text, state, triage }) {
  if (check === "01" && briefType(text) !== null) return briefType(text);
  if (PIPELINE_TASK_TYPES.includes(state?.type)) return state.type;
  return derivedType(triage) ?? BUG;
}

// The `CONFIRM:` line of the plan's filled question: answered once an answer was recorded after the pause on this question, else the pause; null without a question.
function confirmLine(plan, state) {
  const question = gateQuestion(plan);
  if (question === null) return null;
  const answer = answerSinceGate(state);
  if (answer !== null && state?.gateQuestionDigest === questionDigest(question)) return `${CONFIRM_ANSWERED} (${answer.at})`;
  return `${CONFIRM_LINE} — ${evidenceLine(question)}`;
}

// The stage numbers a plan's `## Implementation plan` names, in ascending order and each once.
export function planStageNumbers(plan) {
  const planned = bodyLines(normalize(plan), "## Implementation plan") ?? [];
  const numbers = planned.map((line) => PLAN_STAGE_RE.exec(line)?.[1]).filter(Boolean).map(Number);
  return [...new Set(numbers)].sort((a, b) => a - b);
}

// The word of the first `QA: <word>` line of each stage of a plan's `## Implementation plan`, keyed by stage number, or by null for the lines before any stage.
export function planStageQa(plan) {
  const words = new Map();
  let stage = null;
  for (const line of bodyLines(normalize(plan), "## Implementation plan") ?? []) {
    const heading = PLAN_STAGE_RE.exec(line)?.[1];
    if (heading !== undefined) stage = Number(heading);
    const word = PLAN_QA_LINE_RE.exec(line)?.[1];
    if (word !== undefined && !words.has(stage)) words.set(stage, word.toLowerCase());
  }
  return words;
}

// Where a negative report sends its fix: `design` when any unfenced `fix: design` line says so, `code` for a `fix: code` line, null with no mark.
export function fixRoute(text) {
  const marks = unfencedLines(normalize(text)).map((line) => FIX_MARK_RE.exec(line)?.[1]?.toLowerCase()).filter(Boolean);
  if (marks.includes("design")) return "design";
  return marks.length > 0 ? "code" : null;
}

// The rounds of the QA after its last `source: qa-triage` round, as one text; the last round when no triage round is found.
export function qaWindow(raw) {
  const rounds = roundsOf(raw);
  const triageAt = rounds.findLastIndex((round) => QA_TRIAGE_STAGE.source.test(roundSourceLine(round.text)));
  if (triageAt < 0) return lastRound(raw);
  return rounds.slice(triageAt + 1).map((round) => round.text).join("\n");
}

// The device script of a NEEDS-DEVICE verdict: the lines after the verdict line up to `Diff applies plan:`, verbatim.
export function deviceScript(text) {
  const lines = (sectionOf(text, "## Runtime verdict") ?? "").split("\n").slice(1);
  const verdictAt = lines.findIndex((line) => line.trim() !== "");
  const rest = lines.slice(verdictAt + 1);
  const end = rest.findIndex((line) => /^\s*(?:[-*]\s+)?(?:\*\*)?Diff applies plan:/i.test(line));
  const script = (end < 0 ? rest : rest.slice(0, end)).map((line) => line.trimEnd());
  const first = script.findIndex((line) => line !== "");
  const last = script.findLastIndex((line) => line !== "");
  return first < 0 ? [] : script.slice(first, last + 1);
}

// Whether a path is under a test directory or a file named as a test.
export function isTestPath(path) {
  return TEST_PATH_RE.test(path);
}

// The QA mode a triage round states and its reason, the fallback reason when it gives none.
function qaModeOf(text, words) {
  const stated = statedVerdict(text, words);
  if (stated === null) return null;
  const why = flatLine(stated.rest.replace(REASON_RE, ""));
  return { mode: stated.word, why: why === "" ? QA_MODE_FALLBACK_REASON : why };
}

// Whether the analyst's round has hypotheses for provers: an item under `## Break hypotheses`, or an `H<n>` line when the round has no such section.
function hasHypotheses(text) {
  if (bodyLines(text, "## Break hypotheses") !== null) return firstItem(text, "## Break hypotheses") !== null;
  return unfencedLines(text).some((line) => HYPOTHESIS_LINE_RE.test(line));
}

// The routing facts of a passing check: its verdict, the QA mode, the analyst's next stage, the pause and the device script.
function factsOf({ check, stage, artifact, text, plan, state }) {
  if (stage === "triage") return { qaMode: qaModeOf(text, artifact.verdicts) };
  const verdict = artifact.verdicts.length > 0 ? readVerdict(text, artifact.verdicts) : null;
  if (stage === "analyst") return { verdict, qaStage: hasHypotheses(text) ? "provers" : "skip" };
  const needsDevice = check === "07" && verdict === "NEEDS-DEVICE";
  return {
    verdict,
    confirm: check === "03" ? confirmLine(plan, state) : null,
    needsDevice,
    script: needsDevice ? deviceScript(text) : [],
  };
}

// The lines of a check result, in the contract order, up to (excluding) the device script.
function contractLines(first, facts) {
  return [
    first,
    ...(facts.verdict ? [`VERDICT: ${facts.verdict}`] : []),
    ...(facts.confirm ? [facts.confirm] : []),
    ...(facts.qaMode ? [`QA-MODE: ${facts.qaMode.mode} — ${facts.qaMode.why}`] : []),
    ...(facts.qaStage ? [`QA-STAGE: ${facts.qaStage}`] : []),
    ...(facts.needsDevice ? ["NEEDS-DEVICE"] : []),
  ];
}

// The one line that stands for the check: the failure, else the pause, else a failing verdict, else the first line.
function memoLineOf(check, lines, verdict) {
  const [first] = lines;
  if (first !== "OK" && first !== "GENERATED") return first;
  const pause = lines.find((line) => line.startsWith(CONFIRM_LINE));
  const failing = FAILING[check]?.includes(verdict) ? `VERDICT: ${verdict}` : null;
  return pause ?? failing ?? first;
}

// The whole answer of a check from its first line and the facts its phase found.
function resultOf({ check, first, facts = {}, type = null, evaluated = "" }) {
  const lines = contractLines(first, facts);
  const verdict = facts.verdict ?? null;
  const passed = first === "OK" || first === "GENERATED";
  return {
    first,
    lines,
    verdict,
    type,
    evaluated,
    completes: passed && !(LOOP_BACK[check] ?? []).includes(verdict),
    memoLine: memoLineOf(check, lines, verdict),
    script: facts.script ?? [],
    qaMode: facts.qaMode ?? null,
  };
}

// The answer of the implementation check, whose first line the caller derived from the worktree; `evaluated` is the artifact it ended with.
export function fileListResult(first, evaluated = "") {
  return resultOf({ check: "04", first, evaluated: normalize(evaluated) });
}

// The artifact spec a check evaluates: the phase's own, or a stage of the QA; an unknown check or stage throws.
function checkedArtifact(check, stage) {
  if (stage !== null && !(Object.hasOwn(QA_STAGES, stage) && check === "05")) throw new Error(`unknown stage \`${stage}\` of check \`${check}\`; the stages are \`05 --stage ${Object.keys(QA_STAGES).join("|")}\``);
  const artifact = stage !== null ? QA_STAGES[stage] : PHASE_ARTIFACTS.get(check);
  if (!artifact) throw new Error(`unknown check \`${check}\`; the contract covers: ${[...PHASE_ARTIFACTS.keys()].join(", ")}`);
  return artifact;
}

// The text a check reads of its artifact: the last round, the last round of the source a stage names, or the whole file.
function readText(artifact, raw) {
  if (!artifact.rounds) return normalize(raw);
  if (!artifact.source) return normalize(lastRound(raw));
  return normalize(lastRoundWithSource(raw, artifact.source)?.text ?? "");
}

// What the check finds missing: the artifact itself, the verdict its step must state, or the plan's question in a form that can be asked; null when none.
function missingOf({ check, artifact, text }) {
  if (text.trim() === "") return `${artifact.file} (not written)`;
  if (check === "03" && unreadableQuestion(text)) return UNREADABLE_QUESTION;
  if (artifact.verdicts.length === 0 || readVerdict(text, artifact.verdicts) !== null) return null;
  return `verdict (one of: ${artifact.verdicts.join(", ")})`;
}

// The run files a check may read besides its own artifact: the triage and the plan.
export const CHECK_CONTEXT_FILES = Object.freeze(["01-triage.md", "03-plan.md"]);

// Evaluates the artifact of one phase (or a stage of check 05): it exists and states a verdict word when its step has one; `texts` maps each run file name to its content.
export function evaluateCheck({ check, stage = null, texts = {}, state = null }) {
  const artifact = checkedArtifact(check, stage);
  const text = readText(artifact, texts[artifact.file] ?? "");
  const triage = normalize(texts["01-triage.md"]);
  const common = { check: stage === null ? check : `${check}-${stage}`, type: runType({ check, text, state, triage }), evaluated: text };
  const missing = missingOf({ check: common.check, artifact, text });
  if (missing !== null) return resultOf({ ...common, first: `MISSING: ${missing}` });
  const facts = factsOf({ check, stage, artifact, text, plan: normalize(texts["03-plan.md"]), state });
  return resultOf({ ...common, first: "OK", facts });
}
