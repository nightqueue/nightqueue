import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_CONTEXT_FILES, evaluateCheck } from "../queue/check-contract.mjs";
import { lastRound, PHASE_ARTIFACTS } from "../queue/phase-artifacts.mjs";
import { attemptSince, derivedGateStop, derivedOutcome, recordPipelineRun, statePipelinePhases, verdictIcon, verdictWord } from "../queue/pipeline-record.mjs";
import { isStateObject } from "../queue/resume.mjs";
import { renderSkillTemplate, skillReferencesDir } from "../queue/skill-template.mjs";
import { sectionOf } from "../queue/stream.mjs";
import { runDurationS } from "../queue/telemetry.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { durationCell, phaseRows, readJobLog, requireRunState, resolveRun, RUN_OPTIONS } from "./run-context.mjs";

export const REPORT_USAGE = "nightqueue run report [--json] [--project <name> --slug <slug>]";

const CONFIRMATION_HEADING = /^## Requires user confirmation\s*$/m;

// The steps of the report, in order: the canonical phase, the step label and the agent of the visual identity.
const STEPS = [
  { phase: "triage", step: "1 Triage", agent: "🔍 Triager" },
  { phase: "explore", step: "2 Exploration", agent: "🧭 Explore" },
  { phase: "architecture", step: "3 Architecture", agent: "📐 Architect" },
  { phase: "implementation", step: "4 Implementation", agent: "⚙️ Coder" },
  { phase: "qa", step: "5 QA", agent: "🛡️ QA-Guardian" },
  { phase: "verification", step: "6 Verification", agent: "✅ Verifier" },
  { phase: "runtime", step: "7 Runtime", agent: "📱 Runtime" },
  { phase: "commit", step: "8 Commit/PR", agent: "🚀 Commit/PR" },
  { phase: null, step: "9 Report", agent: "🗂️ Report" },
];

const OPEN_CHECKS = ["05", "07"];
const DEDICATED_TICKET = "dedicated ticket: yes";
const EMPTY = durationCell(null);

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

// The delivery fact the runtime recorded: the pull request, or the conclusion that none was needed; null when neither.
function deliveryNote(state) {
  const outcome = isStateObject(state.outcome) ? state.outcome : {};
  if (outcome.status === "done" && typeof outcome.prUrl === "string") return `PR ${outcome.prUrl}`;
  if (outcome.status === "no_change") return "no change needed - resolved without a pull request";
  return null;
}

// The reason and the note one entry recorded, on one cell; empty when it recorded neither.
function noteOf(entry) {
  return [entry.reason, entry.note]
    .map((text) => (typeof text === "string" ? text.trim() : ""))
    .filter((text) => text !== "")
    .join(" — ");
}

// The result and the note of one recorded execution; a commit entry exists only once the runtime committed, so it reads the delivery.
function resultOf(phase, entry, state) {
  const word = verdictWord(entry.verdict);
  if (phase !== "commit") return { icon: verdictIcon(entry.verdict), word, note: noteOf(entry) };
  return { icon: "✅", word, note: deliveryNote(state) ?? (noteOf(entry) || "committed, no pull request recorded") };
}

// The time the runtime measured for the n-th launch of a phase, or null when it measured none.
function measuredDuration(measured, phase, launch) {
  const lanes = Array.isArray(measured) ? measured : [];
  const lane = lanes.filter((row) => row?.phase === phase)[launch - 1];
  return lane?.durationS ?? null;
}

// One row per recorded execution, in the order state.json recorded them; an entry without a phase is skipped.
function recordedRows(state, measured) {
  const phases = Array.isArray(state.phases) ? state.phases : [];
  const launches = new Map();
  const rows = [];
  for (const entry of phases) {
    const phase = typeof entry?.phase === "string" ? entry.phase : "";
    if (phase.trim() === "") continue;
    const launch = (launches.get(phase) ?? 0) + 1;
    launches.set(phase, launch);
    const step = STEPS.find((candidate) => candidate.phase === phase);
    rows.push({ phase, step: step?.step ?? phase, agent: step?.agent ?? EMPTY, launch, ...resultOf(phase, entry, state), durationS: measuredDuration(measured, phase, launch) });
  }
  return rows;
}

// The icon and the note of a planned step the run never recorded, read from what it did record around it.
function missingStatus(step, state) {
  if (step.phase === null) return { icon: "⏳", note: "this report" };
  if (step.phase === "commit") {
    const note = deliveryNote(state);
    return note === null ? { icon: "⚠️", note: "no pull request recorded" } : { icon: "✅", note };
  }
  if (step.phase === "runtime" && passedWithoutRuntimeDebt(state)) return { icon: "⏭️", note: "purely static change" };
  return { icon: "⚠️", note: "not recorded" };
}

// The single row of a planned step with no record.
function missingRow(step, state) {
  const { icon, note } = missingStatus(step, state);
  return { phase: step.phase, step: step.step, agent: step.agent, launch: 0, icon, word: "", note, durationS: null };
}

// The rows of the report: every recorded execution in temporal order, each unrecorded step once at its nominal slot.
export function reportRows(state, measured) {
  const recorded = recordedRows(state, measured);
  const has = new Set(recorded.map((row) => row.phase));
  const rows = [];
  let next = 0;
  const fill = (upTo) => {
    for (; next < upTo; next++) if (!has.has(STEPS[next].phase)) rows.push(missingRow(STEPS[next], state));
  };
  for (const row of recorded) {
    const at = STEPS.findIndex((step) => step.phase === row.phase);
    if (at >= 0) {
      fill(at);
      next = Math.max(next, at + 1);
    }
    rows.push(row);
  }
  fill(STEPS.length);
  return rows;
}

// One file of the run directory, or an empty text when the run wrote none.
function readRunFile(runDir, file) {
  try {
    return readFileSync(join(runDir, file), "utf8");
  } catch {
    return "";
  }
}

// The Step cell of one row: its label, suffixed with the launch number of a re-run.
function stepCell(row) {
  return row.launch > 1 ? `${row.step} 🔁${row.launch}` : row.step;
}

// What a row says about its gate: the note it recorded, else its verdict word.
function gateDetail(row) {
  return row.note || row.word;
}

// The first gate that keeps the run from being happy, or null when every gate is positively clean.
function firstFailingGate(state, rows, plan) {
  if (isStateObject(state.termination)) return `terminated at ${state.termination.phase}: ${state.termination.reason}`;
  const failed = rows.find((row) => row.icon === "❌");
  if (failed) return `${failed.step} ❌ ${gateDetail(failed)}`;
  const rerun = rows.find((row) => row.launch > 1);
  if (rerun) return `${stepCell(rerun)} ${gateDetail(rerun)}`;
  const warned = rows.find((row) => row.icon === "⚠️");
  if (warned) return `${warned.step} ⚠️ ${gateDetail(warned)}`;
  if (CONFIRMATION_HEADING.test(plan)) return "the plan carries ## Requires user confirmation";
  const status = isStateObject(state.outcome) ? state.outcome.status : null;
  return status === "done" ? null : `the run recorded no delivery (outcome ${status ?? "none"})`;
}

// A recorded text made safe for one markdown table cell or line: `|` escaped and every line break collapsed to a space.
function cellText(value) {
  return String(value ?? "")
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

// The line of the report table one row prints.
function tableRow(row) {
  return `| ${stepCell(row)} | ${row.agent} | ${cellText(`${row.icon} ${row.word}`.trim())} | ${cellText(row.note) || EMPTY} | ${durationCell(row.durationS)} |`;
}

// The rows of the report table of a run.
function tableRows(rows) {
  return rows.map(tableRow).join("\n");
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
function dedicatedTickets(runDir) {
  const qa = lastRound(readRunFile(runDir, PHASE_ARTIFACTS.get("05").file));
  return sectionBullets(sectionOf(qa, "## Suggestions"))
    .filter((bullet) => bullet.includes(DEDICATED_TICKET))
    .map((bullet) => `dedicated ticket: ${bullet}`);
}

// The `OPEN:` lines one check answers for its artifact, named by the check; a check that cannot be evaluated is an open item itself.
function openLinesOf(check, runDir, state) {
  const file = PHASE_ARTIFACTS.get(check).file;
  if (readRunFile(runDir, file) === "") return [];
  const texts = Object.fromEntries([...CHECK_CONTEXT_FILES, file].map((name) => [name, readRunFile(runDir, name)]));
  try {
    return evaluateCheck({ check, texts, state })
      .lines.filter((line) => line.startsWith("OPEN: "))
      .map((line) => `${check} open: ${line.slice("OPEN: ".length)}`);
  } catch {
    return [`the open items of check ${check} could not be read`];
  }
}

// The `OPEN:` lines the QA and runtime checks answer for their artifacts.
function checkOpenLines(runDir, state) {
  return OPEN_CHECKS.flatMap((check) => openLinesOf(check, runDir, state));
}

// The items the run leaves open, which the Notice translates into its Still open.
function runOpenItems(runDir, state) {
  return [...dedicatedTickets(runDir), ...checkOpenLines(runDir, state)];
}

// The telemetry row of the run, derived from its state.json.
function runSpec(run, state) {
  const outcome = derivedOutcome(state);
  return {
    projectId: run.projectId,
    slug: run.slug,
    taskType: state.type ?? null,
    outcome,
    gateStop: derivedGateStop(state, outcome),
    phases: statePipelinePhases(state),
  };
}

// The word the report answers for the telemetry write.
function recordedWord(logged) {
  if (logged?.queued === true) return "queued";
  return logged?.skipped === true ? "already recorded" : "recorded";
}

// Records the run's telemetry once per attempt, else unless its last record has the same facts; a failure answers `not recorded` and leaves an open item, never an error.
async function recordRun(run, state, { env, openItems }) {
  try {
    const since = run.jobId === null ? null : await attemptSince(run.jobId, env);
    return recordedWord(await recordPipelineRun({ spec: runSpec(run, state), since }, env));
  } catch (error) {
    const reason = error?.message ?? String(error);
    openItems.push("the run was not recorded in the telemetry");
    return `not recorded: ${reason}`;
  }
}

// The open items as the report's list lines, or `- none`.
function openItemLines(items) {
  return items.length === 0 ? "- none" : items.map((item) => `- ${cellText(item)}`).join("\n");
}

// Everything the report says about the run, before it is printed.
function buildReport(run, state, log) {
  const rows = reportRows(state, phaseRows(state, log));
  const reason = firstFailingGate(state, rows, readRunFile(run.runDir, "03-plan.md"));
  return {
    slug: run.slug,
    rows,
    happy: reason === null,
    reason,
    durationS: runDurationS(log),
  };
}

// The values the report layout (references/report.md) is filled with.
function reportValues(report) {
  return {
    SLUG: report.slug,
    ROWS: tableRows(report.rows),
    HAPPY_LINE: report.happy ? "Happy: yes" : `Happy: no — ${cellText(report.reason)}`,
    TOTAL: durationCell(report.durationS),
    OPEN_ITEMS: openItemLines(report.openItems),
  };
}

// The printed lines of the report, rendered from references/report.md; the orchestrator pastes them verbatim.
function reportLines(report) {
  return renderSkillTemplate(skillReferencesDir(), "report", reportValues(report)).replace(/\n$/, "").split("\n");
}

// Runs `run report`, which renders the tables of the final report from the run's own records.
export async function runReport(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { ...RUN_OPTIONS, json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: REPORT_USAGE });
  const run = await resolveRun(values, ctx);
  const state = requireRunState(run, ctx.env);
  const openItems = runOpenItems(run.runDir, state);
  const recorded = await recordRun(run, state, { env: ctx.env, openItems });
  const report = { ...buildReport(run, state, readJobLog(run.jobId, ctx.env)), openItems, recorded };
  if (values.json === true) ctx.out(JSON.stringify(report));
  else for (const line of reportLines(report)) ctx.out(line);
  return 0;
}
