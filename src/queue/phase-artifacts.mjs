import { UserError } from "../config/errors.mjs";
import { FILE_LIST } from "./file-list.mjs";
import { createMarkdownScanner, isMarkerCandidate } from "./stream.mjs";

// The line the triage verdict must open with: the evidence level, 1 to 4, bold or plain.
const EVIDENCE_FIRST_LINE = {
  heading: "## Verdict",
  pattern: /^(\*\*)?Evidence level:(\*\*)?\s*[1-4](\*\*)?\s*$/,
  label: "Evidence level: <1|2|3|4> as the first line under ## Verdict",
};

// Where a phase's verdict is read: the suffix of its heading or the first line under it, and the values it may take.
function verdictSpec({ heading, from, values }) {
  const suffix = from === "heading-suffix" ? "" : " as the first line";
  return { heading, from, values, label: `${heading}: <${values.join("|")}>${suffix}` };
}

const TRIAGE_VERDICT = verdictSpec({ heading: "## Verdict", from: "heading-suffix", values: ["PROCEED", "NO-CHANGE-NEEDED", "NOT-REPRODUCIBLE", "NEEDS-CLARIFICATION", "PROPOSE-ALTERNATIVE"] });
export const QA_VERDICT = verdictSpec({ heading: "## Verdict", from: "first-line", values: ["APPROVED", "NEEDS FIX", "NEEDS DISCUSSION"] });
const VERIFICATION_VERDICT = verdictSpec({ heading: "## Verification", from: "heading-suffix", values: ["PASSED", "PASSED-STATIC", "FAILED"] });
const RUNTIME_VERDICT = verdictSpec({ heading: "## Runtime verdict", from: "first-line", values: ["CONFIRMED", "NOT-MET", "SYMPTOM-PERSISTS", "NEEDS-DEVICE", "UNAVAILABLE"] });

// The sections a triage verdict's next step reads, so the check requires them filled on that verdict alone.
const TRIAGE_SECTIONS_BY_VERDICT = { "NEEDS-CLARIFICATION": ["## Open items"], "NOT-REPRODUCIBLE": ["## Open items"], "PROPOSE-ALTERNATIVE": ["## Open items"] };

// The artifact of each phase, the canonical phase it completes, the sections its gate requires (some only on a verdict) and where its verdict is read; a phase with no required section is checked for existence alone.
export const PHASE_ARTIFACTS = new Map([
  ["00", { file: "00-brief.md", phase: null, sections: ["## Brief"] }],
  ["01", { file: "01-triage.md", phase: "triage", sections: ["## Verdict", "## Validated brief", "## Out of scope", "## Request gaps"], sectionsByVerdict: TRIAGE_SECTIONS_BY_VERDICT, firstLineUnder: EVIDENCE_FIRST_LINE, verdict: TRIAGE_VERDICT }],
  ["02", { file: "02-explore.md", phase: "explore", sections: ["## File map", "## Access map", "## Third-party libraries"] }],
  ["03", { file: "03-plan.md", phase: "architecture", sections: ["## Implementation plan", "## Assumptions", "## Pre-mortem", "## Identified risks"] }],
  ["04", { file: "04-implementation.md", phase: "implementation", sections: [FILE_LIST] }],
  ["05", { file: "05-qa.md", phase: "qa", sections: ["## Proven breaks", "## Validated risks", "## Invalidated assumptions", "## Generated PoCs", "## Verdict"], rounds: true, verdict: QA_VERDICT }],
  ["06", { file: "06-verification.md", phase: "verification", sections: ["## Checks run", "## Verification"], rounds: true, verdict: VERIFICATION_VERDICT }],
  ["07", { file: "07-runtime.md", phase: "runtime", sections: ["## Runtime verdict"], rounds: true, verdict: RUNTIME_VERDICT }],
]);

// The analyst stage of a full QA (`run check 05 --stage analyst`): its round of `05-qa.md`, which completes no phase and requires every section check 05 reads.
export const QA_ANALYST_STAGE = {
  file: "05-qa.md",
  phase: null,
  sections: [...new Set(["## Proven breaks", "## Break hypotheses", "## Test recipe", ...PHASE_ARTIFACTS.get("05").sections])],
  rounds: true,
  verdict: QA_VERDICT,
};

export const ROUND_HEADING = /^## Round (\d+)\b/i;
export const FIX_LOOP_HEADING = /^### Fix loop (\d+)\b/;

// The numbers of every line of the text that matches the heading pattern.
function headingNumbers(text, pattern) {
  return String(text ?? "")
    .split("\n")
    .map((line) => pattern.exec(line.trimEnd()))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

// The highest heading number of the text plus one, or 1 when it has none.
function nextNumber(text, pattern) {
  return Math.max(0, ...headingNumbers(text, pattern)) + 1;
}

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

// The round numbers a consolidated round lists on its `source: runtime consolidation · rounds …` line, or null when the round is no consolidation.
export function consolidatedRoundsOf(roundText) {
  const match = /^source:\s*runtime consolidation\s*·\s*rounds\s+(\d+(?:\s*,\s*\d+)*)\s*$/i.exec(roundSourceLine(roundText));
  return match === null ? null : match[1].split(",").map((number) => Number(number.trim()));
}

// The number the next `### Fix loop` block of the implementation artifact takes.
export function nextFixLoop(text) {
  return nextNumber(text, FIX_LOOP_HEADING);
}
