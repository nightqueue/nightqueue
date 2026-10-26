import { firstItem, readVerdict } from "./check-contract.mjs";
import { CONSOLIDATION_SOURCE, nextRound, QA_VERDICT, roundSourceLine, roundsOf } from "./phase-artifacts.mjs";
import { isMarkerCandidate, scanMarkdown, withoutHtmlComments } from "./stream.mjs";

// The rounds of `05-qa.md` and the consolidation `run check 05` writes over a full QA: the analyst's round plus every prover round after it.

export { CONSOLIDATION_SOURCE };

// The only prover source line whose group the runtime trusts: the one `run append --group` stamps.
const STAMPED_PROVER_SOURCE = /^source:\s*prover\s*·\s*group:\s*([a-z0-9][a-z0-9-]{0,63})\s*$/;

// The sections a consolidated round carries, in order, and the ones only the analyst's round speaks for.
const MERGED_SECTIONS = [
  "## Mapped rules",
  "## Proven breaks",
  "## Suggestions (non-blocking)",
  "## Access map (QA)",
  "## Validated risks",
  "## Invalidated assumptions",
  "## Generated PoCs",
  "## Prevention",
];
const ANALYST_ONLY = new Set(["## Mapped rules", "## Access map (QA)"]);
const NEXT_SECTION = /^##\s+\S/;

// The level-2 sections of a round (headings read outside fences and HTML comments), each with its raw body lines.
function sectionsOf(roundText) {
  const { lines, steps } = scanMarkdown(roundText);
  const sections = [];
  lines.forEach((line, at) => {
    if (at === 0) return;
    const { inFence, inComment } = steps[at];
    const isHeading = !inFence && !inComment && isMarkerCandidate({ line, inFence }) && NEXT_SECTION.test(line);
    if (isHeading) sections.push({ heading: line.trimEnd(), lines: [] });
    else sections.at(-1)?.lines.push(line);
  });
  return sections;
}

// The raw body of a round's section under its heading, or null when the round does not carry it.
function sectionBody(roundText, heading) {
  const section = sectionsOf(roundText).find((candidate) => candidate.heading.startsWith(heading));
  return section === undefined ? null : section.lines.join("\n").trim();
}

// The lines of a section body read outside fences and HTML comments, each without bold or backticks.
function plainLines(body) {
  return scanMarkdown(body)
    .steps.filter((step) => !step.inFence)
    .map((step) => step.visible.replace(/[*`]/g, "").trim());
}

const HYPOTHESIS_ID = /^(?:#{3,6}\s+|[-+]\s+|\d+[.)]\s+)?H(\d+)\b/;
const REGRESSION_TYPE = /\btype\s*[:=]\s*regression\b/i;
const PROVER_LINE = /^(?:[-+]\s+|\d+[.)]\s+)?H(\d+)\s*:\s*(BROKE|HELD|INCONCLUSIVE|PROVEN|REFUTED)\b/i;
const UNCHECKED_COVERAGE = "the analyst's hypotheses carry no H<n> id; coverage not checked";

// The `H<n>` hypotheses the analyst's `## Break hypotheses` lists, once each, in order, with whether each is `type=regression`.
function analystHypotheses(analystRound) {
  const hypotheses = new Map();
  for (const line of plainLines(sectionBody(analystRound.text, "## Break hypotheses"))) {
    const id = HYPOTHESIS_ID.exec(line)?.[1];
    if (id !== undefined && !hypotheses.has(Number(id))) hypotheses.set(Number(id), REGRESSION_TYPE.test(line));
  }
  return hypotheses;
}

// The status a prover's word stands for: `REFUTED` is `HELD`, and `PROVEN` is `BROKE` except on a `type=regression` hypothesis, whose proof is a passing net (`HELD`).
function proverStatus(word, isRegression) {
  const status = word.toUpperCase();
  if (status === "REFUTED") return "HELD";
  if (status === "PROVEN") return isRegression ? "HELD" : "BROKE";
  return status;
}

// The `H<n>: BROKE|HELD|INCONCLUSIVE` lines of a prover round's `## Validated risks` (`PROVEN`/`REFUTED` read by the hypothesis type), as id and status.
function proverHypothesisLines(round, hypotheses) {
  return plainLines(sectionBody(round.text, "## Validated risks"))
    .map((line) => PROVER_LINE.exec(line))
    .filter(Boolean)
    .map((match) => ({ id: Number(match[1]), status: proverStatus(match[2], hypotheses.get(Number(match[1])) === true) }));
}

// The `H<a>, H<b>` list of ids, once each.
function idList(ids) {
  return [...new Set(ids)].map((id) => `H${id}`).join(", ");
}

// Whether every analyst hypothesis has a prover line: its verdict (null when the ids cannot be read) and its note lines.
function coverageOf(analyst, provers) {
  const hypotheses = analystHypotheses(analyst);
  const ids = [...hypotheses.keys()];
  if (ids.length === 0 && firstItem(withoutHtmlComments(analyst.text), "## Break hypotheses") !== null) return { verdict: null, notes: [UNCHECKED_COVERAGE] };
  const lines = provers.flatMap((round) => proverHypothesisLines(round, hypotheses));
  const withStatus = (status) => lines.filter((line) => line.status === status).map((line) => line.id);
  const answered = new Set(lines.map((line) => line.id));
  const [broke, inconclusive, unanswered] = [withStatus("BROKE"), withStatus("INCONCLUSIVE"), ids.filter((id) => !answered.has(id))];
  const notes = [
    ...(broke.length > 0 ? [`BROKE: ${idList(broke)}`] : []),
    ...(unanswered.length > 0 ? [`no prover line for ${idList(unanswered)}`] : []),
    ...(inconclusive.length > 0 ? [`INCONCLUSIVE: ${idList(inconclusive)}`] : []),
  ];
  if (broke.length > 0) return { verdict: "NEEDS FIX", notes };
  return { verdict: unanswered.length + inconclusive.length > 0 ? "NEEDS DISCUSSION" : "APPROVED", notes };
}

// Who wrote a round: the runtime's consolidation, a prover (with the group the runtime stamped, else null), the analyst (it carries `## Break hypotheses`) or a lite lane.
export function roundSource(roundText) {
  const line = roundSourceLine(roundText);
  if (/^source:\s*runtime consolidation\b/i.test(line)) return { kind: "consolidation", group: null };
  if (/^source:\s*prover\b/i.test(line)) return { kind: "prover", group: STAMPED_PROVER_SOURCE.exec(line)?.[1] ?? null };
  return { kind: sectionBody(roundText, "## Break hypotheses") === null ? "lite" : "analyst", group: null };
}

// The prover rounds after the analyst's, the later round of a stamped group replacing the earlier one; a round without a stamped group stands alone.
function latestProverRounds(rounds) {
  const keyOf = (round) => round.source.group ?? `round:${round.number}`;
  const provers = rounds.filter((round) => round.source.kind === "prover");
  return provers.filter((round, at) => !provers.slice(at + 1).some((later) => keyOf(later) === keyOf(round)));
}

// The rounds a consolidation merges, analyst first, or null when the artifact needs none.
function consolidationWindow(text) {
  const rounds = roundsOf(text).map((round) => ({ ...round, source: roundSource(round.text) }));
  const last = rounds.at(-1);
  if (last === undefined || last.source.kind === "lite" || last.source.kind === "consolidation") return null;
  const analystAt = rounds.findLastIndex((round) => round.source.kind === "analyst");
  if (analystAt < 0) return null;
  return [rounds[analystAt], ...latestProverRounds(rounds.slice(analystAt + 1))];
}

// The numbers of the rounds a pending consolidation would merge (analyst first), or null when the artifact needs none.
export function consolidationNumbersOf(text) {
  return consolidationWindow(text)?.map((round) => round.number) ?? null;
}

const NONE_SPELLING = /^\(?\s*(?:none|nothing|n\/a|na|no(?:\s+proven)?\s+breaks?)\s*\)?(?:$|\s*[:;,.!—–]|\s+-\s)/i;
const DASH_ONLY = /^[—–-]+$/;
const REGRESSION_MARK = /\btype\s*[:=]\s*regression\b|\(\s*regression\s*\)|\.regression\.|\bregression\s+(?:PoC|test|net)\b/i;
const PASS_MARK = /\bpass(?:e[sd])?\b/i;
const FAIL_MARK = /\bfail/i;
const ZERO_FAILURES = /\b0\s+fail(?:s|ed|ures?)?\b/gi;
const LIST_ITEM = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;
const OPENS_WITH_ID = /^[*_`]*H\d+\b/;
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/;

// A body line without its list marker, emphasis, backticks and trailing period.
function cleanLine(line) {
  return line
    .trim()
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/[*_`]/g, "")
    .trim()
    .replace(/\.$/, "");
}

// Whether a cleaned line says there is nothing: a none spelling or a dash.
function saysNothing(line) {
  return NONE_SPELLING.test(line) || DASH_ONLY.test(line);
}

// The plain cells of a table row.
function cellsOf(row) {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

// Whether a line (or a whole table row) reports a regression net that passed, in any wording: a regression mark, a pass and no failure.
function isRegressionPass(line) {
  if (!REGRESSION_MARK.test(line) || !PASS_MARK.test(line)) return false;
  return !FAIL_MARK.test(line.replace(ZERO_FAILURES, ""));
}

// What a table data row records: nothing (every cell empty, none or a dash), a regression that passed, or a break.
function rowKind(row) {
  if (cellsOf(row).every((cell) => cell === "" || saysNothing(cell))) return "none";
  return isRegressionPass(row) ? "regression" : "item";
}

// What one cleaned unfenced line records, given the line after it: blank, none, a table header or separator, a regression that passed, or an item.
function lineKind(line, nextLine) {
  if (line === "") return "blank";
  if (TABLE_SEPARATOR.test(line)) return "separator";
  if (line.includes("|") && TABLE_SEPARATOR.test(nextLine ?? "")) return "header";
  if (line.startsWith("|")) return rowKind(line);
  if (saysNothing(line)) return "none";
  return isRegressionPass(line) ? "regression" : "item";
}

// Whether a raw line is prose that explains a none spelling: no list item, no table row, no line opening with an `H<n>` id.
function isProse(raw) {
  const line = raw.trim();
  return !LIST_ITEM.test(line) && !line.startsWith("|") && !OPENS_WITH_ID.test(line);
}

// What each line of a section body records (a fenced line is evidence); next to a none spelling, a prose line is its explanation, never an item.
function lineKinds(body) {
  const raws = scanMarkdown(body).steps.map((step) => (step.inFence ? null : step.visible));
  const lines = raws.map((raw) => (raw === null ? null : cleanLine(raw)));
  const kinds = lines.map((line, at) => (line === null ? "fenced" : lineKind(line, lines[at + 1])));
  if (!kinds.includes("none")) return kinds;
  return kinds.map((kind, at) => (kind === "item" && isProse(raws[at]) ? "explanation" : kind));
}

// The break items of a `## Proven breaks` body: every unfenced line that records a break, never a none spelling, a table header or a regression that passed.
export function breakItems(body) {
  const kinds = lineKinds(body);
  return scanMarkdown(body).lines.filter((_line, at) => kinds[at] === "item");
}

// Whether a section body says only that there is nothing: every line blank, a none spelling with its explanation, a dash or a header-only table.
function saysNone(body) {
  return lineKinds(body).every((kind) => ["blank", "none", "explanation", "header", "separator"].includes(kind));
}

// One merged section: every source's real body, a blank line apart so two tables never fuse, else the first `None`; null when no source has it.
function mergedSection(heading, rounds) {
  const sources = ANALYST_ONLY.has(heading) ? rounds.slice(0, 1) : rounds;
  const bodies = sources.map((round) => sectionBody(round.text, heading)).filter((body) => body !== null);
  if (bodies.length === 0) return null;
  const real = bodies.filter((body) => !saysNone(body));
  return `${heading}\n${real.length > 0 ? real.join("\n\n") : bodies[0]}`;
}

// The aggregate of verdicts: any NEEDS FIX, else any NEEDS DISCUSSION or unreadable verdict, else APPROVED.
export function aggregateVerdict(verdicts) {
  if (verdicts.includes("NEEDS FIX")) return "NEEDS FIX";
  if (verdicts.some((verdict) => verdict === null || verdict === "NEEDS DISCUSSION")) return "NEEDS DISCUSSION";
  return "APPROVED";
}

// Whether a round carries a proven break: a `## Proven breaks` with at least one break item.
function provesABreak(round) {
  const body = sectionBody(round.text, "## Proven breaks");
  return body !== null && breakItems(body).length > 0;
}

// The verdict the proof supports and its note lines: a proven break anywhere, else the provers' verdicts with the coverage of the analyst's hypotheses, else the analyst's when it left no hypothesis open.
function provenVerdict([analyst, ...provers]) {
  const counted = provers.length > 0 ? provers : [analyst];
  const verdicts = counted.map((round) => readVerdict(withoutHtmlComments(round.text), QA_VERDICT));
  const unreadable = counted.filter((_round, at) => verdicts[at] === null).map((round) => round.number);
  const coverage = provers.length > 0 ? coverageOf(analyst, provers) : { verdict: null, notes: [] };
  const notes = [...(unreadable.length > 0 ? [`unreadable verdict in round ${unreadable.join(", ")}`] : []), ...coverage.notes];
  if ([analyst, ...provers].some(provesABreak)) return { verdict: "NEEDS FIX", notes };
  const openHypotheses = provers.length === 0 && firstItem(withoutHtmlComments(analyst.text), "## Break hypotheses") !== null;
  if (openHypotheses) return { verdict: "NEEDS DISCUSSION", notes: ["no prover round for the analyst's hypotheses"] };
  return { verdict: aggregateVerdict(coverage.verdict === null ? verdicts : [...verdicts, coverage.verdict]), notes };
}

// The `## Verdict` section of the consolidation, with its note lines.
function verdictSection(rounds) {
  const { verdict, notes } = provenVerdict(rounds);
  return ["## Verdict", verdict, ...notes].join("\n");
}

// The consolidated round a full QA's `05-qa.md` still lacks, as its number and body, or null when the last round needs none.
export function consolidationOf(text) {
  const rounds = consolidationWindow(text);
  if (rounds === null) return null;
  const source = `${CONSOLIDATION_SOURCE} · rounds ${rounds.map((round) => round.number).join(", ")}`;
  const sections = MERGED_SECTIONS.map((heading) => mergedSection(heading, rounds)).filter((section) => section !== null);
  return { number: nextRound(text), body: [source, ...sections, verdictSection(rounds)].join("\n\n") };
}

// The artifact with one more round appended: its text trimmed at the end, a blank line, `## Round <n>`, the body and a final newline.
export function appendRoundText(existing, number, body) {
  const head = String(existing ?? "").trimEnd();
  return `${head === "" ? "" : `${head}\n\n`}## Round ${number}\n${String(body ?? "").trim()}\n`;
}
