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

// The commit step reads the delivery the runtime recorded: the pull request, not a verdict.
function commitStep(state) {
  const outcome = isStateObject(state.outcome) ? state.outcome : {};
  if (outcome.status === "done" && typeof outcome.prUrl === "string") return { icon: "✅", highlight: `PR ${outcome.prUrl}` };
  if (outcome.status === "no_change") return { icon: "✅", highlight: "no change needed - resolved without a pull request" };
  if (entriesOf(state, "commit").length > 0) return { icon: "✅", highlight: "committed, no pull request recorded" };
  return { icon: "⚠️", highlight: "no pull request recorded" };
}

// The status and the highlight of one step, derived from what the run recorded.
function stepStatus(step, { state }) {
  if (step.phase === null) return { icon: "⏳", highlight: "this report" };
  if (step.phase === "commit") return commitStep(state);
  const entries = entriesOf(state, step.phase);
  const last = entries.at(-1);
  const note = typeof last?.note === "string" ? last.note.trim() : "";
  if (entries.length === 0 && step.phase === "runtime" && passedWithoutRuntimeDebt(state)) return { icon: "⏭️", highlight: "purely static change" };
  if (entries.length === 0) return { icon: "⚠️", highlight: "not recorded" };
  if (entries.length > 1) return { icon: "🔁", highlight: note || `recorded ${entries.length} times` };
  return { icon: verdictIcon(last.verdict), highlight: note || (typeof last.verdict === "string" ? last.verdict.trim() : "") };
}

// One row per step of the pipeline, each with its icon and highlight; every run executes every step.
function stepRows(state) {
  return STEPS.map((step) => ({ ...step, ...stepStatus(step, { state }) }));
}

// One file of the run directory, or an empty text when the run wrote none.
function readRunFile(runDir, file) {
  try {
    return readFileSync(join(runDir, file), "utf8");
  } catch {
    return "";
  }
}

// The first gate that keeps the run from being happy, or null when every gate is positively clean.
function firstFailingGate(state, steps, plan) {
  if (isStateObject(state.termination)) return `terminated at ${state.termination.phase}: ${state.termination.reason}`;
  for (const icon of ["❌", "🔁", "⚠️"]) {
    const step = steps.find((row) => row.icon === icon);
    if (step) return `${step.step} ${icon} ${step.highlight}`.trim();
  }
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

// The rows of the step table of a run.
function stepTableRows(steps) {
  return steps.map((row) => `| ${row.step} | ${row.agent} | ${row.icon} | ${cellText(row.highlight)} |`).join("\n");
}

// The agent of a recorded phase, as the execution table names it.
function agentOf(phase) {
  return STEPS.find((step) => step.phase === phase)?.agent ?? phase;
}

// The execution rows of the run: every recorded phase with its note and what the runtime measured for it.
function executionRows(state, log) {
  const phases = Array.isArray(state.phases) ? state.phases : [];
  return phaseRows(state, log).map((row, index) => ({ ...row, note: typeof phases[index]?.note === "string" ? phases[index].note.trim() : "" }));
}

// The rows of the execution table of an unhappy run: one per recorded phase with the time the runtime measured.
function executionTableRows(rows) {
  return rows.map((row) => `| ${row.phase} | ${agentOf(row.phase)} | ${row.status} | ${cellText(row.note) || "-"} | ${durationCell(row.durationS)} |`).join("\n");
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
  const steps = stepRows(state);
  const reason = firstFailingGate(state, steps, readRunFile(run.runDir, "03-plan.md"));
  return {
    slug: run.slug,
    steps,
    happy: reason === null,
    reason,
    execution: executionRows(state, log),
    durationS: runDurationS(log),
  };
}

// The values the report layout (references/report.md) is filled with.
function reportValues(report) {
  return {
    SLUG: report.slug,
    STEP_ROWS: stepTableRows(report.steps),
    HAPPY: report.happy,
    HAPPY_LINE: report.happy ? "Happy: yes" : `Happy: no — ${cellText(report.reason)}`,
    EXECUTION_ROWS: executionTableRows(report.execution),
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
