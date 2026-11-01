import { createHash } from "node:crypto";
import { confirmationSection, unfencedLines, withoutHtmlComments } from "./stream.mjs";
import { PLACEHOLDER_WORDS } from "./triage-brief.mjs";

// The one reader of the plan's question: `run check 03`, the Phase 3 pause and `run report` all read it here, so they never disagree.

// The shapes of the question's label, matched case-insensitively: `**Question:**`, `**Question**:`, `**Question :**` or `__Question:__` anywhere in a line.
const BOLD_LABEL_RE = /(?:\*\*|__)\s*question\s*(?::\s*(?:\*\*|__)|(?:\*\*|__)\s*:)/i;
// `Question: …` or `- Question: …`, anchored at the line start.
const BARE_LABEL_RE = /^\s*(?:[-*+]\s+)?question\s*:/i;
// A heading whose whole title is that word.
const HEADING_LABEL_RE = /^\s*#{1,6}\s+question\s*:?\s*#*\s*$/i;
// A level-2 heading whose whole title is that word, which would end the confirmation section it belongs to.
const LEVEL2_QUESTION_HEADING_RE = /^##([ \t]+question[ \t]*:?[ \t]*#*[ \t]*)$/gim;
// A table row whose first cell is that word, the second cell captured.
const TABLE_LABEL_RE = /^\s*\|\s*(?:\*\*|__)?\s*question\s*:?\s*(?:\*\*|__)?\s*:?\s*\|([^|]*)/i;
// The line under a table's header row.
const TABLE_SEPARATOR_RE = /^\s*\|[\s:|-]*-[\s:|-]*\|?\s*$/;
const TABLE_FIRST_CELL_RE = /^\s*\|([^|]*)\|/;
// What ends a label's block: the next bold label (a list marker allowed) or a heading.
const BLOCK_END_RE = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?\*\*[^*]+(?::\*\*|\*\*:)|^#{1,6}\s/;
const LIST_MARKER_RE = /^\s*[-*+]\s+/;
// One single `<…>` or `[…]` hint, which two bracketed options are not.
const SINGLE_BRACKET_RE = /^(?:<[^<>]*>|\[[^[\]]*\])$/;
const NOTHING_WORDS = [...PLACEHOLDER_WORDS, "none", "no question", "no questions", "nothing"];
// What may follow a nothing word for the value to still say nothing: the end, a punctuation mark, a spaced dash or a word that keeps it empty.
const NOTHING_TAIL_RE = /^(?:$|[.,;:!]|\s[-–—]\s|\s(?:needed|required|asked|pending|to ask|to confirm)\b)/;
// An inline code span or a URL, whose `?` marks no question; a `?` closing the URL is left out of it.
const CODE_OR_URL_RE = /(`+).*?\1|\bhttps?:\/\/\S*[^\s?]/gi;
// A label that records an answer already given, which may quote the question it answers.
const ANSWER_TRACE_RE = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*|__)\s*(?:answered|answer|decision)\s*(?::\s*(?:\*\*|__)|(?:\*\*|__)\s*:)/i;

// The lines from a label's value down to the next bold label or heading.
function blockFrom(value, below) {
  const end = below.findIndex((line) => BLOCK_END_RE.test(line));
  return [value, ...(end < 0 ? below : below.slice(0, end))];
}

// The block of a `**Label:**` among the lines: the text after the label, then the lines below it up to the next bold label or heading; null without the label.
export function labelBlock(lines, label) {
  const at = lines.findIndex((line) => line.includes(label));
  if (at < 0) return null;
  return blockFrom(lines[at].slice(lines[at].indexOf(label) + label.length), lines.slice(at + 1));
}

// What a line holds as the question's label: the value, and whether the lines below belong to it; null when it is no label, as a table row with a blank cell is not.
function labelOf(line) {
  const row = TABLE_LABEL_RE.exec(line);
  if (row) return row[1].trim() === "" ? null : { value: row[1], runsBelow: false };
  const label = BOLD_LABEL_RE.exec(line) ?? BARE_LABEL_RE.exec(line) ?? HEADING_LABEL_RE.exec(line);
  return label ? { value: line.slice(label.index + label[0].length), runsBelow: true } : null;
}

// The first cell of the row under a table's header; null when the line below is no header separator.
function cellUnderHeader(below) {
  if (!TABLE_SEPARATOR_RE.test(below[0] ?? "")) return null;
  return TABLE_FIRST_CELL_RE.exec(below[1] ?? "")?.[1] ?? null;
}

// The block of the first line carrying a label of the question; null without one.
function questionBlock(lines) {
  const at = lines.findIndex((line) => labelOf(line) !== null);
  if (at < 0) return null;
  const { value, runsBelow } = labelOf(lines[at]);
  const below = lines.slice(at + 1);
  if (runsBelow) return blockFrom(value, below);
  return [asksSomething(value) ? value : (cellUnderHeader(below) ?? value)];
}

// A text's lines on one line without their list markers, with compatibility forms, invisible characters, decoration, letter case and spacing normalized.
export function plainQuestion(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(LIST_MARKER_RE, ""))
    .join(" ")
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[*`]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// A text reduced to its words, the one form two spellings of a question are compared in: only words tell one question from another.
export function comparableQuestion(text) {
  return plainQuestion(text)
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

// Whether a text asks: the question mark is the one signal the reader trusts, since no list of words can tell a statement from a question.
function asksSomething(text) {
  return plainQuestion(text).includes("?") && comparableQuestion(text) !== "";
}

// Whether a value opens with a word that stands for nothing and goes on to say nothing else.
function opensWithNothingWord(plain) {
  return NOTHING_WORDS.some((word) => plain.startsWith(word) && NOTHING_TAIL_RE.test(plain.slice(word.length)));
}

// A value in its plain form, out of the parentheses that wrap it whole.
function unwrappedPlain(value) {
  return plainQuestion(value).replace(/^\((.*)\)$/, "$1").trim();
}

// Whether a value is left unfilled: no words, one bracketed hint or a nothing word, unless it asks outside a code span or a URL.
export function saysNothing(value) {
  if (comparableQuestion(value) === "") return true;
  const plain = unwrappedPlain(value);
  if (!plain.includes("?")) return SINGLE_BRACKET_RE.test(plain) || opensWithNothingWord(plain);
  const statement = unwrappedPlain(String(value).replace(CODE_OR_URL_RE, " "));
  return !statement.includes("?") && opensWithNothingWord(statement);
}

// The label's own value: the first line of its block that holds text.
function ownValue(block) {
  return block.find((line) => line.trim() !== "") ?? "";
}

// The lines without the answer traces, each one running from its label to the next blank line, bold label or heading.
function withoutAnswerTraces(lines) {
  let inTrace = false;
  return lines.filter((line) => {
    if (line.trim() === "" || BLOCK_END_RE.test(line) || ANSWER_TRACE_RE.test(line)) inTrace = ANSWER_TRACE_RE.test(line);
    return !inTrace;
  });
}

// A text with its level-2 question headings one level down, so a question written right under the confirmation heading stays in that section.
export function nestQuestionHeading(text) {
  return String(text ?? "").replace(LEVEL2_QUESTION_HEADING_RE, "###$1");
}

// The unfenced lines of a plan's confirmation section, heading first; null when the section is absent.
function sectionLines(text) {
  const section = confirmationSection(nestQuestionHeading(withoutHtmlComments(String(text ?? ""))));
  return section === null ? null : unfencedLines(section);
}

// The question of a plan's confirmation section on one line; null when the section or its label is absent, the label's own value says nothing or the block asks nothing.
export function gateQuestion(text) {
  const lines = sectionLines(text);
  const block = lines === null ? null : questionBlock(lines);
  if (block === null || saysNothing(ownValue(block))) return null;
  const question = block
    .map((line) => line.replace(LIST_MARKER_RE, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return asksSomething(question) ? question : null;
}

// Whether only the section's author can settle it: a question no label or answer trace places, or a filled label that asks nothing.
export function unreadableQuestion(text) {
  const lines = sectionLines(text);
  if (lines === null) return false;
  const block = questionBlock(lines);
  if (block === null) return asksSomething(withoutAnswerTraces(lines.slice(1)).join("\n"));
  return !saysNothing(ownValue(block)) && !asksSomething(block.join("\n"));
}

// The sha256 of a question's words, so re-typing it never reads as a new question.
export function questionDigest(question) {
  return createHash("sha256").update(comparableQuestion(question)).digest("hex");
}

// Whether the plan holds a filled question the run never recorded a pause on.
export function openQuestion(planText, state) {
  const question = gateQuestion(planText);
  return question !== null && state?.gateQuestionDigest !== questionDigest(question);
}
