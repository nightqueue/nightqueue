import { PIPELINE_TASK_TYPES } from "../memory/runs.mjs";
import { lastRound, lastRoundWithSource, nextRound, PHASE_ARTIFACTS, QA_STAGES, QA_TRIAGE_STAGE, roundDefects } from "./phase-artifacts.mjs";
import { gateQuestion, labelBlock, questionDigest, unreadableQuestion } from "./gate-question.mjs";
import { backtickRunAt, codeSpanEnd, hasGateMarker, sectionOf, unfencedLines, withoutHtmlComments } from "./stream.mjs";
import { briefGates, briefType } from "./triage-brief.mjs";

// The contract of `nightqueue run check`: one fact per line, in this order, each with a stable prefix.
// OK | MISSING: <sections> | GENERATED, then VERDICT:, GATE:, OPEN:, TYPE-MISMATCH:, CONFIRM:, QA-MODE:, QA-STAGE:, INVALIDATED:, DIFF-APPLIES:,
// NEEDS-DEVICE, and last of all SCRIPT: with the device script verbatim. A MISSING first line prints nothing else.

const BUG = "bug/error";
const FEATURE = "feature/refactor";
const EVIDENCE_MAX = 160;
// A re-runnable method: a backtick-quoted span or one of these command words.
const METHOD_RE = /`[^`]+`|\b(?:grep|rg|glob|ast-grep)\b|\b(?:git|find|ls|sed|awk|node|npm)\s/i;
const SEPARATOR_CELL_RE = /^:?-+:?$/;
const BLANK_REASONS = new Set(["", "-", "n/a", "not applicable"]);
const BLANK_EVIDENCE = new Set(["", "-", "none", "not run"]);
const CONFIRM_LINE = "CONFIRM: requires-user-confirmation";
const CONFIRM_ANSWERED = "CONFIRM: answered";
const UNREADABLE_QUESTION = "## Requires user confirmation (no **Question:** line with a ?: write the question with its ?, or drop the section when nothing is asked)";
const QA_MODE_LINE_RE = /^(skip|lite|full)(?:\s+[—–-]|:)\s+(\S.*)$/;
const QA_MODE_LABEL = "## QA mode: <skip|lite|full> — <one sentence> as the first line";
const CLASSIFICATION_LINE_RE = /^([^:]+):(.*)$/;
// A path under a test directory, or a file named as a test; a word that merely contains `test` or `spec` is neither.
const TEST_PATH_RE = /(?<![\w./-])(?:[\w.-]+\/)*(?:(?:tests?|specs?|__tests__)\/[\w./-]*\.\w+|(?:test_[\w.-]*|[\w.-]*(?:[._-](?:tests?|specs?)|Tests?|Spec))\.\w+)/;
const TEST_PATHS_RE = new RegExp(TEST_PATH_RE, "g");
// The classification kinds a QA triage may answer only with `full`.
const FULL_QA_KINDS = new Set(["data/migration", "route/endpoint", "auth/permission", "payment", "concurrency", "external-input parsing", "personal data"]);
// The classification kinds that do not ask `full` by themselves; a label off both lists is read as a danger, never as harmless.
const OTHER_QA_KINDS = ["copy/docs", "config", "test-only", "rename", "logic"];
const QA_KINDS = new Set([...OTHER_QA_KINDS, ...FULL_QA_KINDS]);
// The lines of a QA report that carry what stays open.
const QA_OPEN_LABELS = ["omitted", "divergences", "unconfirmed decisions"];
const NONE_VALUE_RE = /^none\.?$/i;
// The verdicts that send the pipeline back instead of completing the phase.
const LOOP_BACK = { "06": ["FAILED"], "07":["NOT-MET", "SYMPTOM-PERSISTS"] };
// The verdicts a check memo keeps as its notable line when nothing else fired.
const FAILING = { ...LOOP_BACK, "05": ["NEEDS FIX"] };

// The text as the gates read it: one kind of line break and no HTML comment, so a commented-out heading never counts.
function normalize(text) {
  return withoutHtmlComments(text);
}

// One trimmed line of evidence, at most 160 code points.
function evidenceLine(text) {
  const flat = flatLine(text);
  const points = [...flat];
  return points.length <= EVIDENCE_MAX ? flat : `${points.slice(0, EVIDENCE_MAX - 1).join("")}…`;
}

// A text folded into one trimmed line.
function flatLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// A value without its markdown decoration (bold, backticks).
function plainValue(text) {
  return String(text ?? "")
    .replace(/[*`]/g, "")
    .trim();
}

// The lines under a section's heading, outside a fence; null when the section is absent.
function bodyLines(text, heading) {
  const section = sectionOf(text, heading);
  return section === null ? null : unfencedLines(section).slice(1).map((line) => line.trimEnd());
}

// The first item of a section (a bullet or a prose line, a `None` item skipped), or null when the section is absent or has none.
export function firstItem(text, heading) {
  const lines = bodyLines(text, heading);
  if (lines === null) return null;
  const items = lines.map((line) => line.replace(/^\s*[-*]\s+/, "").trim());
  return items.find((item) => item !== "" && !/^none\b/i.test(item)) ?? null;
}

// The first non-blank line under a section's heading, fenced lines included; null when absent or empty.
function firstLineUnder(text, heading) {
  const section = sectionOf(text, heading);
  if (section === null) return null;
  return section.split("\n").slice(1).map((line) => line.trim()).find((line) => line !== "") ?? null;
}

// The value of a `<label>: <value>` line among the lines (a bullet or bold label allowed), or null when no line carries the label.
function fieldValue(lines, label) {
  const prefix = `${label.toLowerCase()}:`;
  for (const line of lines ?? []) {
    const plain = line.trim().replace(/^[-*]\s+/, "").replace(/\*\*/g, "");
    if (plain.toLowerCase().startsWith(prefix)) return plain.slice(prefix.length).trim();
  }
  return null;
}

// Whether a field carries a real value: not empty, not a `<…>` placeholder, not `n/a`.
function isFilled(value) {
  const plain = plainValue(value);
  return plain !== "" && !/^<.*>$/.test(plain) && !/^(?:n\/a|not applicable)$/i.test(plain);
}

// The row without its one leading and one trailing unescaped `|`.
function rowBody(line) {
  const trimmed = line.trim();
  const start = trimmed.startsWith("|") ? 1 : 0;
  const end = trimmed.endsWith("|") && !trimmed.endsWith("\\|") && trimmed.length > start ? trimmed.length - 1 : trimmed.length;
  return trimmed.slice(start, end);
}

// The piece of a row at a position: an escaped pipe, a whole code span, a cell break or one character.
function rowPieceAt(body, at) {
  if (body[at] === "\\" && body[at + 1] === "|") return { text: "|", next: at + 2 };
  if (body[at] === "|") return { text: null, next: at + 1 };
  if (body[at] !== "`") return { text: body[at], next: at + 1 };
  const run = backtickRunAt(body, at);
  const end = codeSpanEnd(body, at, run);
  const next = end < 0 ? at + run : end;
  return { text: body.slice(at, next), next };
}

// The cells of a markdown table row, split the GFM way: `\|` is a literal pipe and a pipe inside a code span is cell text.
function cellsOf(line) {
  const body = rowBody(line);
  const cells = [""];
  for (let at = 0; at < body.length; ) {
    const piece = rowPieceAt(body, at);
    if (piece.text === null) cells.push("");
    else cells[cells.length - 1] += piece.text;
    at = piece.next;
  }
  return cells.map((cell) => cell.trim());
}

// Every markdown table among the lines: its header cells and its rows, the `|---|` separator left out.
function tablesOf(lines) {
  const tables = [];
  let current = null;
  for (const line of lines ?? []) {
    if (!line.trim().startsWith("|")) {
      current = null;
      continue;
    }
    if (current === null) {
      current = { header: cellsOf(line), rows: [] };
      tables.push(current);
    } else if (!cellsOf(line).every((cell) => SEPARATOR_CELL_RE.test(cell))) current.rows.push(cellsOf(line));
  }
  return tables;
}

// The index of the header cell that opens with the name, or the fallback when no cell does.
function columnOf(header, name, fallback) {
  const index = header.findIndex((cell) => plainValue(cell).toLowerCase().startsWith(name));
  return index < 0 ? fallback : index;
}

// One firing gate item.
function gate(code, evidence) {
  return { code, evidence };
}

// The value one of the verdicts starts the text with (decoration after it allowed), or null.
function verdictIn(text, values) {
  const plain = plainValue(text).replace(/^-\s*/, "").toUpperCase();
  const longestFirst = [...values].sort((a, b) => b.length - a.length);
  return longestFirst.find((value) => plain.startsWith(value) && !/^[A-Z0-9-]/.test(plain.slice(value.length))) ?? null;
}

// The accepted verdict the text states: its value, or the value a retired word reads as; null when it is neither.
function statedVerdict(text, spec) {
  const verdict = verdictIn(text, [...spec.values, ...Object.keys(spec.legacy)]);
  return spec.legacy[verdict] ?? verdict;
}

// The verdict of the artifact, read where its phase writes it; null when it is none of the accepted values.
export function readVerdict(text, spec) {
  if (spec.from === "first-line") return statedVerdict(firstLineUnder(text, spec.heading) ?? "", spec);
  const line = unfencedLines(text).find((candidate) => candidate.trimEnd().startsWith(spec.heading));
  return line === undefined ? null : statedVerdict(line.slice(spec.heading.length).replace(/^\s*:/, ""), spec);
}

// Whether the triage's `## Diagnosis` carries a confirmed cause or a symptom proof.
function diagnosisFilled(triage) {
  const lines = bodyLines(triage, "## Diagnosis");
  return lines !== null && ["Confirmed root cause", "Symptom proof"].some((label) => isFilled(fieldValue(lines, label) ?? ""));
}

// The Type the triage implies: bug/error with a filled `## Diagnosis`, feature/refactor without one, null with no triage at all.
export function derivedType(triage) {
  const text = normalize(triage);
  if (text.trim() === "") return null;
  return diagnosisFilled(text) ? BUG : FEATURE;
}

// The Type every rule reads: the recorded one, else the triage's, else bug/error (the fail-safe that requires coverage).
function runType(state, triage) {
  if (PIPELINE_TASK_TYPES.includes(state?.type)) return state.type;
  return derivedType(triage) ?? BUG;
}

// The cited evidence of the plan's `**Type mismatch:**` line, or null when the line is absent or says nothing.
function typeMismatchOf(plan) {
  const label = "**Type mismatch:**";
  const line = unfencedLines(plan).find((candidate) => candidate.includes(label));
  if (line === undefined) return null;
  const evidence = line.slice(line.indexOf(label) + label.length).trim();
  return isFilled(evidence) ? evidence : null;
}

// The vectors of a plan's `## Symptom coverage` table: id, status and reason.
function coverageRows(plan) {
  const table = tablesOf(bodyLines(plan, "## Symptom coverage"))[0];
  if (!table) return [];
  const status = columnOf(table.header, "status", 2);
  const reason = columnOf(table.header, "reason", 3);
  return table.rows.map((cells) => ({
    id: cells[0] ?? "",
    rawStatus: cells[status] ?? "",
    status: plainValue(cells[status]).toLowerCase(),
    reason: plainValue(cells[reason]),
  }));
}

// Whether the plan must carry the symptom coverage: a bug/error run whose plan does not declare a Type mismatch.
function needsCoverage(ctx) {
  return ctx.type === BUG && typeMismatchOf(ctx.plan) === null;
}

// The coverage part of the plan the gate finds absent: the section itself, or a section with no vector.
function coverageMissing(ctx) {
  if (!needsCoverage(ctx)) return [];
  const lines = bodyLines(ctx.plan, "## Symptom coverage");
  if (lines === null) return ["## Symptom coverage"];
  const declaresMismatch = lines.some((line) => line.includes("**Type mismatch:**"));
  return coverageRows(ctx.plan).length === 0 && !declaresMismatch ? ["## Symptom coverage (empty)"] : [];
}

// What a coverage vector lacks: an accepted status or a reason; null when it has both.
function vectorGap(row) {
  if (row.status !== "covered" && row.status !== "not-covered") return `${row.id} · Status: ${row.rawStatus || "(empty)"}`;
  return BLANK_REASONS.has(row.reason.toLowerCase()) ? `${row.id} · Reason: ${row.reason || "(empty)"}` : null;
}

// The `**How I enumerated:**` block, fenced commands and bullets included, when it names no re-runnable method, `line absent` without the label, or null when it holds.
function enumerationGap(plan) {
  const lines = (sectionOf(plan, "## Symptom coverage") ?? "").split("\n");
  const block = labelBlock(lines, "**How I enumerated:**");
  if (block === null) return "line absent";
  const tableAt = block.findIndex((line) => line.trim().startsWith("|"));
  const value = flatLine((tableAt < 0 ? block : block.slice(0, tableAt)).join(" "));
  return METHOD_RE.test(value) ? null : value || "(empty)";
}

// The open items of a bug plan's coverage, informative and never a relaunch: each vector with no status or reason, then an enumeration with no method.
function coverageOpen(ctx) {
  if (!needsCoverage(ctx)) return [];
  const enumeration = enumerationGap(ctx.plan);
  return [
    ...coverageRows(ctx.plan).map(vectorGap).filter(Boolean).map((evidence) => `coverage-vector-no-reason — ${evidenceLine(evidence)}`),
    ...(enumeration === null ? [] : [`coverage-enumeration-no-method — ${evidenceLine(enumeration)}`]),
  ];
}

// The symptom-proof gate of the triage: a PROCEED on a bug needs a filled `Symptom proof:`.
function symptomProofGates(ctx) {
  if (ctx.verdict !== "PROCEED" || ctx.type !== BUG) return [];
  const lines = bodyLines(ctx.text, "## Diagnosis");
  const value = lines === null ? null : fieldValue(lines, "Symptom proof");
  let evidence = null;
  if (lines === null) evidence = "## Diagnosis absent";
  else if (value === null) evidence = "Symptom proof: line absent";
  else if (!isFilled(value)) evidence = `Symptom proof: ${value || "(empty)"}`;
  return evidence === null ? [] : [gate("symptom-proof-missing", evidence)];
}

// The facts of the triage: the gates of its `## Brief` first, then the symptom proof of a bug.
function triageFacts(ctx) {
  return { gates: [...briefGates(ctx.text, ctx.verdict), ...symptomProofGates(ctx)] };
}

// The `CONFIRM:` line of a filled question: answered once a note exists and the recorded digest is this question's, else the pause; null without a question.
function confirmLine(ctx, question) {
  if (question === null) return null;
  const hasNote = typeof ctx.operatorNote === "string" && ctx.operatorNote.trim() !== "";
  if (hasNote && ctx.state?.gateQuestionDigest === questionDigest(question)) return CONFIRM_ANSWERED;
  return `${CONFIRM_LINE} — ${evidenceLine(question)}`;
}

// The open items of the plan: its coverage, a confirmation section that asks nothing, and a Type mismatch with the Type the run keeps.
function planOpen(ctx, question) {
  const mismatch = typeMismatchOf(ctx.plan);
  const kept = diagnosisFilled(ctx.triage) ? BUG : FEATURE;
  return [
    ...coverageOpen(ctx),
    ...(question === null && hasGateMarker(ctx.plan) ? ["## Requires user confirmation has no filled **Question:**"] : []),
    ...(mismatch === null ? [] : [`type mismatch — ${evidenceLine(mismatch)} — kept ${kept}`]),
  ];
}

// The facts of the plan, none of which gates it: its open items, its Type mismatch and its pause for a filled question.
function planFacts(ctx) {
  const mismatch = typeMismatchOf(ctx.plan);
  const question = gateQuestion(ctx.plan);
  const triage = diagnosisFilled(ctx.triage) ? `${BUG} (## Diagnosis filled)` : `${FEATURE} (## Diagnosis absent or empty)`;
  return {
    gates: [],
    open: planOpen(ctx, question),
    typeMismatch: mismatch === null ? null : `${evidenceLine(mismatch)} — triage: ${triage}`,
    confirm: confirmLine(ctx, question),
  };
}

// Every item of `## Invalidated assumptions` other than `None`.
function invalidatedItems(text) {
  const lines = (bodyLines(text, "## Invalidated assumptions") ?? []).map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => /^[-*]\s+/.test(line));
  return (bullets.length > 0 ? bullets : lines).map((line) => line.replace(/^[-*]\s+/, "").trim()).filter((item) => !/^none\b/i.test(plainValue(item)));
}

// Whether a field states something: filled, and other than `none`.
function statesSomething(value) {
  return isFilled(value) && !NONE_VALUE_RE.test(plainValue(value));
}

// One `<label> — <value>` per filled `omitted:`, `divergences:` or `unconfirmed decisions:` line of `## Validated risks` other than `none`.
function qaOpenItems(text) {
  const risks = bodyLines(text, "## Validated risks") ?? [];
  return QA_OPEN_LABELS.flatMap((label) => {
    const value = fieldValue(risks, label);
    return statesSomething(value) ? [`${label} — ${value}`] : [];
  });
}

// The facts of the QA report: its open lines and its invalidated assumptions.
function qaFacts(ctx) {
  return { gates: [], open: qaOpenItems(ctx.text), invalidated: invalidatedItems(ctx.text) };
}

// The rows of the runtime's acceptance table: scenario, result and evidence.
function runtimeRows(text) {
  const table = tablesOf(unfencedLines(text)).find(({ header }) => header.some((cell) => plainValue(cell).toLowerCase() === "result"));
  if (!table) return [];
  const result = columnOf(table.header, "result", -1);
  const evidence = columnOf(table.header, "evidence", -1);
  return table.rows.map((cells) => ({
    scenario: cells[1] ?? cells[0] ?? "",
    result: plainValue(cells[result]).toUpperCase(),
    evidence: evidence < 0 ? null : plainValue(cells[evidence]).toLowerCase(),
  }));
}

// Whether a runtime row records no real attempt: no accepted result or no evidence.
function noAttempt(row) {
  const accepted = /^(?:NOT )?MET\b/.test(row.result);
  return !accepted || (row.evidence !== null && BLANK_EVIDENCE.has(row.evidence));
}

// The `Diff applies plan:` answer, `yes` or `no`, or null when absent or `n/a`.
function diffApplies(text) {
  const value = fieldValue(unfencedLines(text), "Diff applies plan");
  const word = plainValue(value ?? "").split(/\s+/)[0].toLowerCase();
  return word === "yes" || word === "no" ? word : null;
}

// The device script of a NEEDS-DEVICE verdict: the lines after the verdict line up to `Diff applies plan:`, verbatim.
function deviceScript(text) {
  const lines = (sectionOf(text, "## Runtime verdict") ?? "").split("\n").slice(1);
  const verdictAt = lines.findIndex((line) => line.trim() !== "");
  const rest = lines.slice(verdictAt + 1);
  const end = rest.findIndex((line) => /^\s*(?:[-*]\s+)?(?:\*\*)?Diff applies plan:/i.test(line));
  const script = (end < 0 ? rest : rest.slice(0, end)).map((line) => line.trimEnd());
  const first = script.findIndex((line) => line !== "");
  const last = script.findLastIndex((line) => line !== "");
  return first < 0 ? [] : script.slice(first, last + 1);
}

// The facts of the runtime lane: its acceptance-table gates, its open scenarios, the diff answer and the device script.
function runtimeFacts(ctx) {
  const rows = runtimeRows(ctx.text);
  const notMet = rows.filter((row) => /^NOT MET/.test(row.result) && !row.result.includes("TO CONFIRM"));
  const toConfirm = rows.filter((row) => /^NOT MET/.test(row.result) && row.result.includes("TO CONFIRM"));
  const needsDevice = ctx.verdict === "NEEDS-DEVICE";
  return {
    gates: [...notMet.map((row) => gate("runtime-not-met", row.scenario)), ...rows.filter(noAttempt).map((row) => gate("runtime-no-attempt", row.scenario))],
    open: toConfirm.map((row) => `${flatLine(row.scenario)} — to confirm`),
    diffApplies: diffApplies(ctx.text),
    needsDevice,
    script: needsDevice ? deviceScript(ctx.text) : [],
  };
}

const PHASE_FACTS = { "01": triageFacts, "03": planFacts, "05": qaFacts, "07": runtimeFacts };

// The sections the verdict's next step reads that the artifact lacks or leaves without an item.
function verdictSectionGaps(ctx) {
  const required = ctx.artifact.sectionsByVerdict?.[ctx.verdict] ?? [];
  return required.flatMap((heading) => {
    if (sectionOf(ctx.text, heading) === null) return [heading];
    return firstItem(ctx.text, heading) === null ? [`${heading} (empty)`] : [];
  });
}

// What the gate finds absent: the sections, the artifact itself, the line a section must open with or the verdict.
function missingParts(ctx) {
  const { artifact, text } = ctx;
  const absent = [...artifact.sections.filter((heading) => sectionOf(text, heading) === null), ...verdictSectionGaps(ctx)];
  const coverage = ctx.check === "03" ? [...coverageMissing(ctx), ...(unreadableQuestion(ctx.plan) ? [UNREADABLE_QUESTION] : [])] : [];
  if (absent.length + coverage.length > 0) return [...absent, ...coverage];
  if (text.trim() === "") return [`${artifact.file} (not written)`];
  if (ctx.stage === "triage") return qaTriageGaps(text);
  const under = artifact.firstLineUnder;
  const firstLineGap = under && !under.pattern.test(firstLineUnder(text, under.heading) ?? "") ? [under.label] : [];
  const verdictGap = artifact.verdict && ctx.verdict === null ? [artifact.verdict.label] : [];
  return [...firstLineGap, ...verdictGap];
}

// The lines of a check result, in the contract order, up to (excluding) the device script.
function contractLines(first, facts) {
  return [
    first,
    ...(facts.verdict ? [`VERDICT: ${facts.verdict}`] : []),
    ...(facts.gates ?? []).map(({ code, evidence }) => `GATE: ${code} — ${evidenceLine(evidence)}`),
    ...(facts.open ?? []).map((text) => `OPEN: ${flatLine(text)}`),
    ...(facts.typeMismatch ? [`TYPE-MISMATCH: ${facts.typeMismatch}`] : []),
    ...(facts.confirm ? [facts.confirm] : []),
    ...(facts.qaMode ? [`QA-MODE: ${facts.qaMode.mode} — ${facts.qaMode.why}`] : []),
    ...(facts.qaStage ? [`QA-STAGE: ${facts.qaStage}`] : []),
    ...(facts.invalidated ?? []).map((text) => `INVALIDATED: ${flatLine(text)}`),
    ...(facts.diffApplies ? [`DIFF-APPLIES: ${facts.diffApplies}`] : []),
    ...(facts.needsDevice ? ["NEEDS-DEVICE"] : []),
  ];
}

// The one line that stands for the check: the failure, else the first gate, else the pause, else a failing verdict, else the first line.
function memoLineOf(check, lines, verdict) {
  const [first] = lines;
  if (first !== "OK" && first !== "GENERATED") return first;
  const gateLine = lines.find((line) => line.startsWith("GATE: "));
  const pause = lines.find((line) => line.startsWith("TYPE-MISMATCH: ") || line.startsWith(CONFIRM_LINE) || line.startsWith("INVALIDATED: "));
  const failing = FAILING[check]?.includes(verdict) ? `VERDICT: ${verdict}` : null;
  return gateLine ?? pause ?? failing ?? first;
}

// The whole answer of a check from its first line and the facts its phase found.
function resultOf({ check, first, facts = {}, type = null, evaluated = "" }) {
  const lines = contractLines(first, facts);
  const verdict = facts.verdict ?? null;
  const passed = (first === "OK" || first === "GENERATED") && (facts.gates ?? []).length === 0 && (facts.invalidated ?? []).length === 0;
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

// The facts of the QA analyst stage: its verdict and whether stage B has provers to launch.
function analystFacts(ctx) {
  return { verdict: ctx.verdict, qaStage: firstItem(ctx.text, "## Break hypotheses") === null ? "skip" : "provers" };
}

// The mode and the reason the first line of a triage's `## QA mode` states, or null when it states no accepted mode with a real reason.
function statedQaMode(text) {
  const first = (bodyLines(text, "## QA mode") ?? []).find((line) => line.trim() !== "");
  const match = QA_MODE_LINE_RE.exec(plainValue(first));
  return match !== null && isFilled(match[2]) ? { mode: match[1], why: match[2] } : null;
}

// The kinds of a triage's `## Diff classification` that list something, in lower case; a line with no `kind:` counts whole, so it reads as a kind off the list.
function classifiedKinds(text) {
  return (bodyLines(text, "## Diff classification") ?? []).flatMap((line) => {
    const item = plainValue(line).replace(/^[-+]\s+/, "");
    if (!statesSomething(item)) return [];
    const match = CLASSIFICATION_LINE_RE.exec(item);
    if (match === null) return [item.toLowerCase()];
    return statesSomething(match[2]) ? [match[1].trim().toLowerCase()] : [];
  });
}

// The triage's sections with no line at all under their heading.
function emptyTriageSections(text) {
  return QA_TRIAGE_STAGE.sections.filter((heading) => bodyLines(text, heading).every((line) => line.trim() === "")).map((heading) => `${heading} (empty)`);
}

// What the mode a triage states contradicts in its own round: a listed new risk, a kind that asks `full`, a kind off the list while not `full`, or a logic skip that names no test.
function qaModeContradictions({ mode, why }, text) {
  const kinds = classifiedKinds(text);
  const fullKinds = kinds.filter((kind) => FULL_QA_KINDS.has(kind));
  const unknownKinds = kinds.filter((kind) => !QA_KINDS.has(kind));
  const skip = mode === "skip";
  return [
    ...(skip && firstItem(text, "## New risk") !== null ? ["## QA mode (skip with a listed ## New risk)"] : []),
    ...(mode !== "full" && fullKinds.length > 0 ? [`## QA mode (${mode} with ${fullKinds.join(" and ")}: that kind answers full)`] : []),
    ...(mode !== "full" && unknownKinds.length > 0 ? [`## Diff classification (${unknownKinds.join(" and ")} is off the list: write ${[...QA_KINDS].join(", ")}, or answer full)`] : []),
    ...(skip && kinds.includes("logic") && !TEST_PATH_RE.test(why) ? ["## QA mode (skip with a logic line: the sentence must name the test's path)"] : []),
  ];
}

// What makes a QA triage's round unreadable as a decision: an empty section, no accepted first line of `## QA mode`, or a mode its own round contradicts.
function qaTriageGaps(text) {
  const empty = emptyTriageSections(text);
  if (empty.length > 0) return empty;
  const stated = statedQaMode(text);
  return stated === null ? [QA_MODE_LABEL] : qaModeContradictions(stated, text);
}

// Whether a path is under a test directory or a file named as a test.
export function isTestPath(path) {
  return TEST_PATH_RE.test(path);
}

// The test paths the logic skip of the last triage round cites, for the caller to hold against the worktree; empty for any other round.
export function citedTestPaths(raw) {
  const text = normalize(readRound(QA_TRIAGE_STAGE, raw).text);
  const stated = statedQaMode(text);
  if (stated?.mode !== "skip" || !classifiedKinds(text).includes("logic")) return [];
  return [...new Set(stated.why.match(TEST_PATHS_RE) ?? [])];
}

// The facts of the QA triage: the mode it decided and why.
function qaTriageFacts(ctx) {
  return { qaMode: statedQaMode(ctx.text) };
}

const STAGE_FACTS = { analyst: analystFacts, triage: qaTriageFacts };

// The round a gate reads and the numbers its defects are read for: the last round, or the last one of the source the stage names (none yields an empty text).
function readRound(artifact, raw) {
  if (!artifact.source) return { text: lastRound(raw), numbers: null };
  const round = lastRoundWithSource(raw, artifact.source);
  return round === null ? { text: "", numbers: [] } : { text: round.text, numbers: [round.number] };
}

// The run files a check may read besides its own artifact: the triage and the plan.
export const CHECK_CONTEXT_FILES = Object.freeze(["01-triage.md", "03-plan.md"]);

// Evaluates the artifact of one phase (or a stage of check 05) against the check contract; `texts` maps each run file name to its content, `state` is the run's state.json, `operatorNote` the job's current answer.
export function evaluateCheck({ check, stage = null, texts = {}, state = null, gaps = [], operatorNote = null }) {
  const artifact = checkedArtifact(check, stage);
  const read = (file) => normalize(texts[file]);
  const raw = texts[artifact.file] ?? "";
  const round = artifact.rounds ? readRound(artifact, raw) : null;
  const text = round === null ? read(artifact.file) : normalize(round.text);
  const triage = read("01-triage.md");
  const type = (check === "01" ? briefType(text) : null) ?? runType(state, triage);
  const base = { check, stage, artifact, text, triage, plan: read("03-plan.md"), type, state, operatorNote };
  const ctx = { ...base, verdict: artifact.verdict ? readVerdict(text, artifact.verdict) : null };
  const common = { check: stage === null ? check : `${check}-${stage}`, type: ctx.type, evaluated: text };
  const defects = artifact.rounds ? [...new Set([...gaps, ...roundDefectParts(artifact.file, raw, round.numbers)])] : gaps;
  if (defects.length > 0) return resultOf({ ...common, first: `MISSING: ${defects.join("; ")}` });
  const missing = missingParts(ctx);
  if (missing.length > 0) return resultOf({ ...common, first: `MISSING: ${missing.join(", ")}` });
  const facts = stage !== null ? STAGE_FACTS[stage](ctx) : { verdict: ctx.verdict, ...(PHASE_FACTS[check]?.(ctx) ?? {}) };
  return resultOf({ ...common, first: "OK", facts });
}
