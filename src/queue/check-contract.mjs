import { PIPELINE_TASK_TYPES } from "../memory/runs.mjs";
import { consolidatedRoundsOf, lastRound, nextRound, PHASE_ARTIFACTS, QA_ANALYST_STAGE, roundDefects, roundsOf } from "./phase-artifacts.mjs";
import { backtickRunAt, codeSpanEnd, hasGateMarker, sectionOf, unfencedLines, withoutHtmlComments } from "./stream.mjs";
import { briefGates, briefType } from "./triage-brief.mjs";

// The contract of `nightqueue run check`: one fact per line, in this order, each with a stable prefix.
// OK | MISSING: <sections> | GENERATED, then VERDICT:, GATE:, OPEN:, TYPE-MISMATCH:, CONFIRM:, QA:, QA-STAGE:, INVALIDATED:, DIFF-APPLIES:,
// NEEDS-DEVICE, and last of all SCRIPT: with the device script verbatim. A MISSING first line prints nothing else.

const BUG = "bug/error";
const FEATURE = "feature/refactor";
const EVIDENCE_MAX = 160;
// A re-runnable method: a backtick-quoted span or one of these command words.
const METHOD_RE = /`[^`]+`|\b(?:grep|rg|glob|ast-grep)\b|\b(?:git|find|ls|sed|awk|node|npm)\s/i;
const GENERIC_METHOD_RE = /\b(?:reviewed|read|analy[sz]ed) the plan\b/i;
const INTENT_RE = /unimplemented intent:\s*(.+?)\s*·\s*governs\s+`?([A-Za-z0-9/_-]+)/i;
// The shapes of a code identifier, tried on each word: a path, dotted, camelCase, PascalCase with an inner capital, snake_case, a call.
const CODE_TOKEN_RES = [
  /[\w$.-]*\/[\w$./-]*[\w$]/,
  /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/,
  /[a-z][a-z0-9]*[A-Z][\w$]*/,
  /[A-Z][a-z0-9]+[A-Z][\w$]*/,
  /[A-Za-z][A-Za-z0-9]*_[\w$]+/,
  /[\w$]+\(\)/,
];
const SEPARATOR_CELL_RE = /^:?-+:?$/;
const BLANK_REASONS = new Set(["", "-", "n/a", "not applicable"]);
const BLANK_EVIDENCE = new Set(["", "-", "none", "not run"]);
const CONFIRM_LINE = "CONFIRM: requires-user-confirmation";
const ALWAYS_GATE_YES = "**Always-gate class:** yes";
const HIGH_RISK = "🔴";
const LIST_ITEM_RE = /^(?:[-*+]|\d+[.)])\s/;
const RISK_ID_RE = /^(?:\*\*)?(?:\[R\d+\]|\(R\d+\))/;
const SEVERITY_RE = /🔴|🟡|🟢/u;
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

// The text after a line's label, the label matched at the line's start (a bullet allowed), or null when no line opens with it.
function labelledValue(lines, label) {
  const prefix = label.toLowerCase();
  for (const line of lines ?? []) {
    const plain = line.trim().replace(/^[-*]\s+/, "");
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

// The verdict of the artifact, read where its phase writes it; null when it is none of the accepted values.
export function readVerdict(text, spec) {
  if (spec.from === "first-line") return verdictIn(firstLineUnder(text, spec.heading) ?? "", spec.values);
  const line = unfencedLines(text).find((candidate) => candidate.trimEnd().startsWith(spec.heading));
  return line === undefined ? null : verdictIn(line.slice(spec.heading.length).replace(/^\s*:/, ""), spec.values);
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

// The `**How I enumerated:**` value when it names no re-runnable method, `line absent` without one, or null when it holds.
function enumerationGap(plan) {
  const label = "**How I enumerated:**";
  const line = (bodyLines(plan, "## Symptom coverage") ?? []).find((candidate) => candidate.includes(label));
  if (line === undefined) return "line absent";
  const value = line.slice(line.indexOf(label) + label.length).trim();
  return METHOD_RE.test(value) ? null : value || "(empty)";
}

// The three symptom-coverage gates of a bug plan, in their contract order.
function coverageGates(ctx) {
  if (!needsCoverage(ctx)) return [];
  const rows = coverageRows(ctx.plan);
  const enumeration = enumerationGap(ctx.plan);
  const unconfirmed = hasGateMarker(ctx.plan) ? [] : rows.filter((row) => row.status === "not-covered");
  return [
    ...rows.map(vectorGap).filter(Boolean).map((evidence) => gate("coverage-vector-no-reason", evidence)),
    ...(enumeration === null ? [] : [gate("coverage-enumeration-no-method", enumeration)]),
    ...unconfirmed.map((row) => gate("coverage-not-covered-without-confirmation", row.id)),
  ];
}

// The first word of the plan's `**Diff axis:**` value, lowercased, or null without one.
function diffAxis(plan) {
  const label = "**Diff axis:**";
  const line = unfencedLines(plan).find((candidate) => candidate.includes(label));
  const word = line === undefined ? null : /^[\s`*]*([A-Za-z0-9/_-]+)/.exec(line.slice(line.indexOf(label) + label.length));
  return word ? word[1].toLowerCase() : null;
}

// The code token of an unimplemented-intent parameter: its first backtick span, else its first code-shaped identifier, else null (prose).
function codeTokenOf(param) {
  const quoted = /`([^`]+)`/.exec(param)?.[1];
  if (quoted !== undefined) return quoted;
  const words = param.split(/\s+/).filter(Boolean);
  return words.map((word) => CODE_TOKEN_RES.map((re) => re.exec(word)?.[0]).find(Boolean)).find(Boolean) ?? null;
}

// Whether the text names the token whole: not preceded by `[\w$.]`, not followed by `[\w$]`, case-sensitive.
function namesWholeToken(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`).test(text);
}

// Whether an unimplemented-intent parameter is the ticket's own deliverable: its code token is named whole in the validated brief or the objective.
function isOwnDeliverable(param, ctx) {
  const token = codeTokenOf(param);
  if (token === null) return false;
  const validated = sectionOf(ctx.triage, "## Validated brief") ?? "";
  const objective = unfencedLines(ctx.brief).find((line) => line.includes("**Objective:**")) ?? "";
  return namesWholeToken(validated, token) || namesWholeToken(objective, token);
}

// Condition 3: an explore `unimplemented intent` line that governs the plan's own diff axis and is not the ticket's deliverable.
function intentLines(ctx) {
  const axis = diffAxis(ctx.plan);
  if (axis === null) return [];
  return unfencedLines(ctx.explore)
    .map((line) => ({ line: line.trim(), match: INTENT_RE.exec(line) }))
    .filter(({ match }) => match !== null && match[2].toLowerCase() === axis && !isOwnDeliverable(match[1], ctx))
    .map(({ line }) => line);
}

// Condition 4: a scenario line of the request whose value is exactly `to confirm`.
function toConfirmLines(ctx) {
  return [ctx.brief, ctx.triage]
    .flatMap((text) => unfencedLines(text))
    .filter((line) => line.startsWith("- ") && line.includes(" · "))
    .filter((line) => line.slice(2).split(" · ").some((field) => field.trim() === "to confirm"))
    .map((line) => line.trim());
}

// The four usage-coverage conditions of the plan, evaluated only while the plan asks the user nothing.
function usageCoverageGates(ctx) {
  if (hasGateMarker(ctx.plan)) return [];
  const lines = bodyLines(ctx.plan, "## Usage coverage") ?? [];
  const scenarios = lines.filter((line) => line.startsWith("- ") && line.includes("changed=yes · source=pipeline"));
  const alwaysGate = lines.filter((line) => line.trim().startsWith("**Always-gate class:** yes"));
  return [
    ...scenarios.map((line) => gate("usage-coverage-cond-1", line)),
    ...alwaysGate.map((line) => gate("usage-coverage-cond-2", line)),
    ...intentLines(ctx).map((line) => gate("usage-coverage-cond-3", line)),
    ...toConfirmLines(ctx).map((line) => gate("usage-coverage-cond-4", line)),
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

// The facts of the plan: its gates, its Type mismatch, its pause for confirmation and its QA mode.
function planFacts(ctx) {
  const mismatch = typeMismatchOf(ctx.plan);
  const triage = diagnosisFilled(ctx.triage) ? `${BUG} (## Diagnosis filled)` : `${FEATURE} (## Diagnosis absent or empty)`;
  return {
    gates: [...coverageGates(ctx), ...usageCoverageGates(ctx)],
    typeMismatch: mismatch === null ? null : `${evidenceLine(mismatch)} — triage: ${triage}`,
    confirm: hasGateMarker(ctx.plan),
    qaMode: qaModeOf(ctx.plan),
  };
}

// Whether the plan declares the always-gate class: an unfenced line opening with `**Always-gate class:** yes`.
function declaresAlwaysGate(plan) {
  return unfencedLines(plan).some((line) => line.trim().startsWith(ALWAYS_GATE_YES));
}

// Whether a line opens a risk item: a top-level list item or a line starting with a risk id.
function opensRiskItem(line) {
  const indent = line.length - line.trimStart().length;
  const trimmed = line.trim();
  return indent < 2 && (LIST_ITEM_RE.test(trimmed) || RISK_ID_RE.test(trimmed));
}

// Whether a line continues the open item: an indented line, or a non-blank line right after the item's last line.
function continuesRiskItem(line, previous) {
  if (line.trim() === "") return false;
  return /^\s{2,}/.test(line) || (previous !== undefined && previous.trim() !== "");
}

// The list-style risk items of the lines, each the text of its opener with its continuation and nested lines.
function riskListItems(lines) {
  const items = [];
  let current = null;
  lines.forEach((line, at) => {
    if (line.trim().startsWith("|")) current = null;
    else if (opensRiskItem(line)) items.push((current = [line]));
    else if (current !== null && continuesRiskItem(line, lines[at - 1])) current.push(line);
    else if (line.trim() !== "") current = null;
  });
  return items.map((item) => item.join("\n"));
}

// The severity of a risk item: the first 🔴/🟡/🟢 marker in its text, or null when it carries none.
function severityOf(text) {
  return text.match(SEVERITY_RE)?.[0] ?? null;
}

// The risk items of `## Identified risks` whose severity is 🔴: list items and table body rows, fenced code left out.
function highRisks(plan) {
  const lines = bodyLines(plan, "## Identified risks") ?? [];
  const items = riskListItems(lines).filter((item) => severityOf(item) === HIGH_RISK);
  const rows = tablesOf(lines).flatMap(({ rows: body }) => body.filter((cells) => severityOf(cells.join("\n")) === HIGH_RISK));
  return [...items, ...rows];
}

// The QA mode a plan asks: `full` with an always-gate class or two or more 🔴 risks, else `lite`.
export function qaModeOf(plan) {
  const text = normalize(plan);
  return declaresAlwaysGate(text) || highRisks(text).length >= 2 ? "full" : "lite";
}

// The three gates of the QA's `Symptom coverage:` line against the plan's table.
function symptomCoverageGates(ctx, risks) {
  if (!needsCoverage(ctx)) return [];
  const value = labelledValue(risks, "Symptom coverage:");
  if (value === null) return [gate("symptom-coverage-n-mismatch", "line absent")];
  const fields = value.split(" · ").map((field) => field.trim());
  const planRows = coverageRows(ctx.plan).length;
  const omitted = fields.find((field) => /^omitted:/i.test(field));
  const method = fields.slice(1).find((field) => !/^omitted:/i.test(field)) ?? "";
  return [
    ...(/^\d+$/.test(fields[0]) && Number(fields[0]) === planRows ? [] : [gate("symptom-coverage-n-mismatch", `N=${fields[0] || "(empty)"} plan=${planRows}`)]),
    ...(omitted && omitted.slice("omitted:".length).trim() !== "" ? [] : [gate("symptom-coverage-omitted-empty", omitted ? "omitted: (empty)" : "omitted: field absent")]),
    ...(METHOD_RE.test(method) && !GENERIC_METHOD_RE.test(method) ? [] : [gate("symptom-coverage-method-generic", method || "(empty)")]),
  ];
}

// The entry points the QA mapped itself: `- ` lines of `## Access map (QA)` other than `partial:` and `unimplemented intent:`.
function accessMapCount(text) {
  const lines = bodyLines(text, "## Access map (QA)");
  if (lines === null) return null;
  return lines.filter((line) => line.startsWith("- ") && !/^(?:partial:|unimplemented intent:)/.test(line.slice(2).trim())).length;
}

// The N/M gate of the QA's `Usage coverage:` line against the plan's scenarios and its own access map.
function usageCountGates(ctx, { value, scenarios }) {
  if (value === null) return [gate("usage-coverage-nm-mismatch", "line absent")];
  const mapped = accessMapCount(ctx.text);
  if (mapped === null) return [gate("usage-coverage-nm-mismatch", "## Access map (QA) absent")];
  const [n = "", m = ""] = value.split(" · ").map((field) => field.trim());
  const holds = /^\d+$/.test(n) && /^\d+$/.test(m) && Number(n) === scenarios.length && Number(m) === mapped;
  return holds ? [] : [gate("usage-coverage-nm-mismatch", `N=${n || "(empty)"}/${scenarios.length} M=${m || "(empty)"}/${mapped}`)];
}

// The value of one `<label> <value>` field of the `Usage coverage:` line, or null when the field is absent.
function usageField(value, label) {
  const field = (value ?? "").split(" · ").find((candidate) => candidate.trim().toLowerCase().startsWith(label));
  return field === undefined ? null : field.trim().slice(label.length).trim();
}

// The `divergences:` and `unconfirmed decisions:` fields the QA left absent or empty.
function usageFieldGates(value) {
  if (value === null) return [];
  return ["divergences:", "unconfirmed decisions:"]
    .map((label) => ({ label, field: usageField(value, label) }))
    .filter(({ field }) => field === null || field === "")
    .map(({ label, field }) => gate("usage-coverage-divergences-empty", `${label} ${field === null ? "field absent" : "(empty)"}`));
}

// The bullets of the plan's `**What to avoid:**` block and `## What to avoid` section.
function avoidItems(plan) {
  const lines = unfencedLines(plan);
  const start = lines.findIndex((line) => line.trim().startsWith("**What to avoid:**"));
  const block = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith("- ")) break;
    block.push(line);
  }
  return [...block, ...(bodyLines(plan, "## What to avoid") ?? [])]
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

// A `HELD` risk line of the QA that names a pipeline-sourced scenario or a forbidden item of the plan.
function heldOnPipelineGates(ctx, { risks, scenarios }) {
  const names = scenarios.filter((line) => line.includes("source=pipeline")).map((line) => line.slice(2).split(" · ")[0].trim());
  const markers = ["source=pipeline", "what to avoid", ...names, ...avoidItems(ctx.plan)].map((marker) => marker.toLowerCase()).filter(Boolean);
  return risks
    .filter((line) => /\bHELD\b/.test(line) && markers.some((marker) => line.toLowerCase().includes(marker)))
    .map((line) => gate("usage-coverage-held-on-pipeline", line.trim()));
}

// Whether the plan asks the usage coverage audit: a `## Usage coverage` section or an always-gate class.
function auditsUsage(plan) {
  return sectionOf(plan, "## Usage coverage") !== null || declaresAlwaysGate(plan);
}

// The usage-coverage gates of the QA and its open unconfirmed decisions; the held-on-pipeline gate reads only the analyst's risk lines.
function usageAudit(ctx, risks) {
  if (!auditsUsage(ctx.plan)) return { gates: [], open: [] };
  const scenarios = (bodyLines(ctx.plan, "## Usage coverage") ?? []).filter((line) => line.startsWith("- "));
  const value = labelledValue(risks, "Usage coverage:");
  const unconfirmed = usageField(value, "unconfirmed decisions:");
  const analystRisks = bodyLines(ctx.analystText, "## Validated risks") ?? [];
  return {
    gates: [...usageCountGates(ctx, { value, scenarios }), ...usageFieldGates(value), ...heldOnPipelineGates(ctx, { risks: analystRisks, scenarios })],
    open: unconfirmed && !/^none$/i.test(unconfirmed) ? [`unconfirmed decisions — ${unconfirmed}`] : [],
  };
}

// Every item of `## Invalidated assumptions` other than `None`.
function invalidatedItems(text) {
  const lines = (bodyLines(text, "## Invalidated assumptions") ?? []).map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => /^[-*]\s+/.test(line));
  return (bullets.length > 0 ? bullets : lines).map((line) => line.replace(/^[-*]\s+/, "").trim()).filter((item) => !/^none\b/i.test(plainValue(item)));
}

// The facts of the QA report: its coverage gates, its open decisions and its invalidated assumptions.
function qaFacts(ctx) {
  const risks = bodyLines(ctx.text, "## Validated risks") ?? [];
  const usage = usageAudit(ctx, risks);
  return {
    gates: [...symptomCoverageGates(ctx, risks), ...usage.gates],
    open: usage.open,
    invalidated: invalidatedItems(ctx.text),
  };
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
  const coverage = ctx.check === "03" ? coverageMissing(ctx) : [];
  if (absent.length + coverage.length > 0) return [...absent, ...coverage];
  if (text.trim() === "") return [`${artifact.file} (not written)`];
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
    ...(facts.confirm ? [CONFIRM_LINE] : []),
    ...(facts.qaMode ? [`QA: ${facts.qaMode}`] : []),
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
  const pause = lines.find((line) => line.startsWith("TYPE-MISMATCH: ") || line === CONFIRM_LINE);
  const failing = FAILING[check]?.includes(verdict) ? `VERDICT: ${verdict}` : null;
  return gateLine ?? pause ?? failing ?? first;
}

// The whole answer of a check from its first line and the facts its phase found.
function resultOf({ check, first, facts = {}, type = null, evaluated = "" }) {
  const lines = contractLines(first, facts);
  const verdict = facts.verdict ?? null;
  const passed = (first === "OK" || first === "GENERATED") && (facts.gates ?? []).length === 0;
  return {
    first,
    lines,
    verdict,
    type,
    evaluated,
    completes: passed && !(LOOP_BACK[check] ?? []).includes(verdict),
    memoLine: memoLineOf(check, lines, verdict),
    script: facts.script ?? [],
  };
}

// The answer of the implementation check, whose first line the caller derived from the worktree; `evaluated` is the artifact it ended with.
export function fileListResult(first, evaluated = "") {
  return resultOf({ check: "04", first, evaluated: normalize(evaluated) });
}

// The artifact spec a check evaluates: the phase's own, or the analyst stage of the QA; an unknown check or stage throws.
function checkedArtifact(check, stage) {
  if (stage !== null && !(stage === "analyst" && check === "05")) throw new Error(`unknown stage \`${stage}\` of check \`${check}\`; the only stage is \`05 --stage analyst\``);
  const artifact = stage === "analyst" ? QA_ANALYST_STAGE : PHASE_ARTIFACTS.get(check);
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

// The text the held-on-pipeline gate reads: the analyst's round a consolidation lists first, else the round read.
function analystTextOf(raw, text) {
  const numbers = consolidatedRoundsOf(lastRound(raw));
  if (numbers === null) return text;
  const analyst = roundsOf(raw).find((round) => round.number === numbers[0]);
  return analyst === undefined ? text : normalize(analyst.text);
}

// The facts of the QA analyst stage: its verdict and whether stage B has provers to launch.
function analystFacts(ctx) {
  return { verdict: ctx.verdict, qaStage: firstItem(ctx.text, "## Break hypotheses") === null ? "skip" : "provers" };
}

// Evaluates the artifact of one phase (or the analyst stage of check 05) against the check contract; `texts` maps each run file name to its content, `state` is the run's state.json.
export function evaluateCheck({ check, stage = null, texts = {}, state = null, gaps = [] }) {
  const artifact = checkedArtifact(check, stage);
  const read = (file) => normalize(texts[file]);
  const raw = texts[artifact.file] ?? "";
  const text = artifact.rounds ? normalize(lastRound(raw)) : read(artifact.file);
  const triage = read("01-triage.md");
  const type = (check === "01" ? briefType(text) : null) ?? runType(state, triage);
  const base = { check, artifact, text, triage, brief: read("00-brief.md"), explore: read("02-explore.md"), plan: read("03-plan.md"), type };
  const ctx = { ...base, analystText: artifact.rounds ? analystTextOf(raw, text) : text, verdict: artifact.verdict ? readVerdict(text, artifact.verdict) : null };
  const common = { check: stage === null ? check : `${check}-${stage}`, type: ctx.type, evaluated: text };
  const defects = artifact.rounds ? [...new Set([...gaps, ...roundDefectParts(artifact.file, raw)])] : gaps;
  if (defects.length > 0) return resultOf({ ...common, first: `MISSING: ${defects.join("; ")}` });
  const missing = missingParts(ctx);
  if (missing.length > 0) return resultOf({ ...common, first: `MISSING: ${missing.join(", ")}` });
  const facts = stage === "analyst" ? analystFacts(ctx) : { verdict: ctx.verdict, ...(PHASE_FACTS[check]?.(ctx) ?? {}) };
  return resultOf({ ...common, first: "OK", facts });
}
