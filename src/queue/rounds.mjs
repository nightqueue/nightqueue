import { UserError } from "../config/errors.mjs";
import { createMarkdownScanner, isMarkerCandidate } from "./stream.mjs";

// What a round artifact is on disk, whichever pipeline writes one: its `## Round <n>` headings, its open fences and comments, the text of each defect and how one more round is appended.

export const ROUND_HEADING = /^## Round (\d+)\b/i;

// The number of a column-0 `## Round <n>` line that is no `cat -n` quotation, or null.
function headingNumberOf(line) {
  if (!isMarkerCandidate({ line, inFence: false })) return null;
  const match = ROUND_HEADING.exec(line.trimEnd());
  const number = match ? Number(match[1]) : NaN;
  return Number.isFinite(number) ? number : null;
}

// Whether a column-0 round heading of the number opens a round: never inside a fence; inside an HTML comment only as the next number in sequence.
function opensRound(number, step, highest) {
  if (number === null || step.inFence) return false;
  return number === highest + 1 || !step.inComment;
}

// A new segment of a round artifact: the text before the first round (number null) or one round, from its 1-based start line.
function segmentAt(number, startLine, cutComment) {
  return { number, startLine, lines: [], cutComment, endsInComment: null };
}

// The segments of a round artifact (the text before the first round, then each round with its raw lines, the comment its heading cut and the `<!--` it leaves open), the fence still open at its end and every fenced `## Round <next>` line.
function scanRounds(text) {
  const scanner = createMarkdownScanner();
  const segments = [segmentAt(null, 1, null)];
  const fencedHeadings = [];
  let highest = 0;
  let openFence = null;
  let comment = null;
  String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line) => {
      const step = scanner.step(line);
      const number = headingNumberOf(line);
      const commentBefore = comment;
      if (step.openedAt >= 0) comment = step.line;
      else if (!step.endsInComment) comment = null;
      if (number !== null && step.inFence && number === highest + 1) {
        fencedHeadings.push({ line: step.line, number, fenceLine: openFence?.line ?? null, round: segments.at(-1).number, segment: segments.length - 1 });
      }
      if (opensRound(number, step, highest)) {
        const cut = step.inComment ? commentBefore : null;
        segments.at(-1).endsInComment = cut;
        if (number === highest + 1) {
          scanner.resetComment();
          comment = null;
        }
        segments.push(segmentAt(number, step.line, cut));
        highest = Math.max(highest, number);
      }
      segments.at(-1).lines.push(line);
      if (step.fence === null) openFence = null;
      else openFence ??= { marker: step.fence, line: step.line, round: segments.at(-1).number };
    });
  segments.at(-1).endsInComment = comment;
  return { segments: segments.map(({ lines, ...segment }) => ({ ...segment, text: lines.join("\n") })), openFence, fencedHeadings };
}

// Every `## Round <n>` of a round artifact with its raw text up to the next one: a heading inside a code fence is never a round, one inside an HTML comment only as the next number (which closes the comment).
export function roundsOf(text) {
  return scanRounds(text)
    .segments.slice(1)
    .map(({ number, text: roundText }) => ({ number, text: roundText }));
}

// The segments a gate reads: the last one (the text itself when it has no round), or the rounds of the given numbers.
function readSegments(segments, numbers) {
  if (numbers === null) return [segments.length - 1];
  const wanted = new Set(numbers);
  return segments.map((segment, at) => (segment.number !== null && wanted.has(segment.number) ? at : -1)).filter((at) => at >= 0);
}

// The 1-based line where a segment, read with a comment already open, closes it, or null when it never does.
function commentCloseLine(segment) {
  const scanner = createMarkdownScanner({ inComment: true });
  const closing = segment.text
    .split("\n")
    .map((line) => scanner.step(line))
    .find((step) => step.inComment && (!step.endsInComment || step.openedAt >= 0));
  return closing === undefined ? null : segment.startLine + closing.line - 1;
}

// The heading of the first read round that sits inside a comment the round itself closes (a commented `## Round <next>`), or none.
function commentedHeadingDefects(segment) {
  if (segment === undefined || segment.cutComment === null) return [];
  const closedAt = commentCloseLine(segment);
  if (closedAt === null) return [];
  return [{ kind: "commented-heading", line: segment.startLine, openedAt: segment.cutComment, closedAt, round: segment.number }];
}

// What makes the rounds a gate reads ill-formed, earliest line first: a fence open at the end, a fenced `## Round <next>`, a `<!--` a read round leaves open and a read heading inside a comment the round closes.
export function roundDefects(text, numbers = null) {
  const { segments, openFence, fencedHeadings } = scanRounds(text);
  const read = readSegments(segments, numbers);
  const defects = [
    ...(openFence === null ? [] : [{ kind: "open-fence", ...openFence }]),
    ...fencedHeadings.filter((heading) => read.includes(heading.segment)).map(({ segment: _segment, ...heading }) => ({ kind: "fenced-heading", ...heading })),
    ...read.filter((at) => segments[at].endsInComment !== null).map((at) => ({ kind: "open-comment", line: segments[at].endsInComment, round: segments[at].number })),
    ...commentedHeadingDefects(segments[read[0]]),
  ];
  return defects.sort((a, b) => a.line - b.line);
}

// The artifact with the code fence it leaves open closed by its own marker on a new last line, and what was closed (null when every fence was closed already).
export function withClosedFence(text) {
  const source = String(text ?? "");
  const fence = unclosedFenceOf(source);
  if (fence === null) return { text: source, closed: null };
  const head = source.endsWith("\n") ? source : `${source}\n`;
  const closedText = `${head}${fence.marker}\n`;
  const sameRounds = roundsOf(closedText).map((round) => round.number).join(",") === roundsOf(source).map((round) => round.number).join(",");
  if (unclosedFenceOf(closedText) !== null || !sameRounds) throw new UserError(`closing the code fence opened at line ${fence.line} would change the rounds of the artifact; nothing was written`);
  return { text: closedText, closed: { ...fence, at: head.split("\n").length } };
}

// The code fence a round artifact leaves open at its end (its marker, the line it opens at and the round holding it, null before the first round), or null.
export function unclosedFenceOf(text) {
  return scanRounds(text).openFence;
}

// The last `## Round <n>` (anything after the number is decoration) of a round artifact up to its end, or the whole text when it has no round (a legacy artifact).
export function lastRound(text) {
  const last = roundsOf(text).at(-1);
  return last === undefined ? String(text ?? "") : last.text;
}

// The number the next `## Round` of a round artifact takes.
export function nextRound(text) {
  return Math.max(0, ...roundsOf(text).map((round) => round.number)) + 1;
}

export const CONSOLIDATION_SOURCE = "source: runtime consolidation";

// The first non-blank line of a round after its heading, without its markdown decoration.
export function roundSourceLine(roundText) {
  const line = String(roundText ?? "")
    .split("\n")
    .slice(1)
    .find((candidate) => candidate.trim() !== "");
  return (line ?? "").replace(/[*`]/g, "").trim();
}

// The last round whose source line matches the pattern, as its number and text, or null when no round does.
export function lastRoundWithSource(text, pattern) {
  return roundsOf(text).findLast((round) => pattern.test(roundSourceLine(round.text))) ?? null;
}

// The round numbers a consolidated round lists on its `source: runtime consolidation · rounds …` line, or null when the round is no consolidation.
export function consolidatedRoundsOf(roundText) {
  const match = /^source:\s*runtime consolidation\s*·\s*rounds\s+(\d+(?:\s*,\s*\d+)*)\s*$/i.exec(roundSourceLine(roundText));
  return match === null ? null : match[1].split(",").map((number) => Number(number.trim()));
}

// How a defect or a repair names the round holding it.
function roundName(round) {
  return round === null ? "the text before the first round" : `round ${round}`;
}

const INDENT_QUOTES = "indent by one space any `## Round` line you quote";

// What every defect asks the lane to do: append a whole new round, never edit an earlier one.
function appendARound(next) {
  return `append a new \`## Round ${next}\` with your whole round`;
}

// The text of one defect of a round artifact: where it is and what the lane appends to fix it.
function defectPart(file, defect, next) {
  if (defect.kind === "open-fence") return `the code fence of ${roundName(defect.round)} opened at line ${defect.line} of ${file} never closes (append \`${defect.marker}\` on its own line at the end of the file)`;
  if (defect.kind === "fenced-heading") return `line ${defect.line} of ${file} is a column-0 \`## Round ${defect.number}\` inside the code fence opened at line ${defect.fenceLine} (${roundName(defect.round)}): ${appendARound(next)}, and ${INDENT_QUOTES}`;
  if (defect.kind === "open-comment") return `${roundName(defect.round)} of ${file} leaves the HTML comment opened at line ${defect.line} open: ${appendARound(next)}, closing every \`<!--\` with \`-->\` or writing a literal \`<!--\` in backticks`;
  return `line ${defect.line} of ${file} (\`## Round ${defect.round}\`) sits inside the HTML comment opened at line ${defect.openedAt} and closed at line ${defect.closedAt}: ${appendARound(next)}, and ${INDENT_QUOTES}`;
}

// The `MISSING:` parts of the rounds a gate reads (the last one, or the given numbers): one text per defect, earliest line first.
export function roundDefectParts(file, raw, numbers = null) {
  const next = nextRound(raw ?? "");
  return roundDefects(raw ?? "", numbers).map((defect) => defectPart(file, defect, next));
}

// The `REPAIRED:` line of a code fence the runtime closed at the end of a round artifact.
export function repairedLine(file, closed) {
  return `REPAIRED: the code fence of ${roundName(closed.round)} opened at line ${closed.line} of ${file} never closed; the runtime appended \`${closed.marker}\` at line ${closed.at}`;
}

// The artifact with one more round appended: its text trimmed at the end, a blank line, `## Round <n>`, the body and a final newline.
export function appendRoundText(existing, number, body) {
  const head = String(existing ?? "").trimEnd();
  return `${head === "" ? "" : `${head}\n\n`}## Round ${number}\n${String(body ?? "").trim()}\n`;
}

// The artifact with the round appended after the runtime closes a code fence an earlier round left open (and what it closed), refused when the new heading would not read as the last round.
export function appendedText(existing, number, round) {
  const { text, closed } = withClosedFence(existing);
  const next = appendRoundText(text, number, round);
  if (roundsOf(next).at(-1)?.number !== number) throw new UserError(`round ${number} would not read as the last round of the artifact; nothing was written`);
  return { text: next, closed };
}
