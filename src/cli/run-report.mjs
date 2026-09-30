import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isStateObject } from "../queue/resume.mjs";
import { phasesFor } from "../queue/routing.mjs";
import { renderSkillTemplate, skillReferencesDir } from "../queue/skill-template.mjs";
import { isSubagentEvent, parseAttemptMarker, parseEventLine } from "../queue/stream.mjs";
import { runDurationS } from "../queue/telemetry.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { durationCell, phaseRows, readJobLog, requireRunState, resolveRun, RUN_OPTIONS } from "./run-context.mjs";

export const REPORT_USAGE = "nightqueue run report [--json] [--project <name> --slug <slug>]";

const LESSON_SAVE_TOOL = "mcp__nightqueue__lesson_save";
const CONFIRMATION_HEADING = /^## Requires user confirmation\s*$/m;

// The steps of the report, in order: the canonical phase, the step label and the agent of the visual identity.
const STEPS = [
  { phase: "triage", step: "1 Triage", agent: "🔍 Triager" },
  { phase: "explore", step: "2 Exploration", agent: "🧭 Explore" },
  { phase: "architecture", step: "3 Architecture", agent: "📐 Architect" },
  { phase: "implementation", step: "4 Implementation", agent: "⚙️ Coder" },
  { phase: "qa", step: "5 QA", agent: "🛡️ QA-Guardian" },
  { phase: "verification", step: "6 Verification", agent: "✅ Verifier" },
  { phase: "runtime", step: "6.5 Runtime", agent: "📱 Runtime" },
  { phase: "commit", step: "7 Commit/PR", agent: "🚀 Commit/PR" },
];

const OK_VERDICTS = new Set(["PROCEED", "APPROVED", "PASSED", "CONFIRMED", "DONE", "OK"]);
const FAILED_VERDICT = /^(NEEDS|FAILED|NOT-|NOT |SYMPTOM-PERSISTS)/;

// The verdict word a phase recorded, without a heading prefix such as `## Verification:`.
function verdictWord(verdict) {
  const text = typeof verdict === "string" ? verdict.trim() : "";
  if (!text) return "OK";
  return text.replace(/^#+\s*/, "").split(":").pop().trim().toUpperCase();
}

// The status icon a recorded verdict earns: ✅ a clean pass, ❌ a failure, ⚠️ anything the report cannot call clean.
function verdictIcon(verdict) {
  const word = verdictWord(verdict);
  if (OK_VERDICTS.has(word)) return "✅";
  return FAILED_VERDICT.test(word) ? "❌" : "⚠️";
}

// The recorded entries of one phase in state.json, in the order they were recorded.
function entriesOf(state, phase) {
  const phases = Array.isArray(state.phases) ? state.phases : [];
  return phases.filter((entry) => entry?.phase === phase);
}

// True when the verification passed with a real run of the checks, which is what lets a complex change skip 6.5 as purely static.
function passedWithoutRuntimeDebt(state) {
  const last = entriesOf(state, "verification").at(-1);
  return last !== undefined && verdictWord(last.verdict) === "PASSED";
}

// The commit step reads the delivery the runtime recorded: the pull request, not a verdict.
function commitStep(state) {
  const outcome = isStateObject(state.outcome) ? state.outcome : {};
  if (outcome.status === "done" && typeof outcome.prUrl === "string") return { icon: "✅", highlight: `PR ${outcome.prUrl}` };
  if (entriesOf(state, "commit").length > 0) return { icon: "✅", highlight: "committed, no pull request recorded" };
  return { icon: "⚠️", highlight: "no pull request recorded" };
}

// The status and the highlight of one step, derived from what the run recorded and whether the tier runs it.
function stepStatus(step, { state, planned }) {
  if (step.phase === "commit") return commitStep(state);
  const entries = entriesOf(state, step.phase);
  const last = entries.at(-1);
  const note = typeof last?.note === "string" ? last.note.trim() : "";
  if (!planned.includes(step.phase)) return { icon: "⏭️", highlight: "does not run in this tier" };
  if (entries.length === 0 && step.phase === "runtime" && passedWithoutRuntimeDebt(state)) return { icon: "⏭️", highlight: "purely static change" };
  if (entries.length === 0) return { icon: "⚠️", highlight: "not recorded" };
  if (entries.length > 1) return { icon: "🔁", highlight: note || `recorded ${entries.length} times` };
  return { icon: verdictIcon(last.verdict), highlight: note || (typeof last.verdict === "string" ? last.verdict.trim() : "") };
}

// The phases the tier of the run plans; a run that never recorded its tier or type is held to every phase (fail-safe).
function plannedPhases(state) {
  try {
    return phasesFor(state.tier, state.type);
  } catch {
    return STEPS.map((step) => step.phase);
  }
}

// One row per step of the pipeline, each with its icon and highlight.
function stepRows(state) {
  const planned = plannedPhases(state);
  return STEPS.map((step) => ({ ...step, ...stepStatus(step, { state, planned }) }));
}

// The plan of the run, or an empty text when the tier wrote none.
function readPlan(runDir) {
  try {
    return readFileSync(join(runDir, "03-plan.md"), "utf8");
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

// The assistant tool_use blocks of the orchestrator in one event of the stream.
function orchestratorToolUses(event) {
  if (event?.type !== "assistant" || isSubagentEvent(event) || !Array.isArray(event.message?.content)) return [];
  return event.message.content.filter((block) => block?.type === "tool_use");
}

// The tool results one `user` event carries, by the id of the call they answer.
function toolResults(event) {
  if (event?.type !== "user" || !Array.isArray(event.message?.content)) return [];
  return event.message.content.filter((block) => block?.type === "tool_result");
}

// The lessons the orchestrator saved in the last attempt: each `lesson_save` call whose result was not an error.
export function savedLessons(log) {
  let calls = new Map();
  let failed = new Set();
  for (const line of String(log ?? "").split("\n")) {
    if (parseAttemptMarker(line)) {
      calls = new Map();
      failed = new Set();
      continue;
    }
    const event = parseEventLine(line);
    for (const block of orchestratorToolUses(event)) if (block.name === LESSON_SAVE_TOOL) calls.set(block.id, block.input?.target ?? null);
    for (const result of toolResults(event)) if (result.is_error === true) failed.add(result.tool_use_id);
  }
  const targets = [...calls].filter(([id]) => !failed.has(id)).map(([, target]) => target);
  return { count: targets.length, targets: [...new Set(targets.filter(Boolean))] };
}

// The audit line of the lessons the run saved.
function lessonsLine({ count, targets }) {
  return count > 0 ? `Lessons saved: ${count} (targets: ${targets.join(", ")})` : "Lessons saved: 0";
}

// A recorded text made safe for one markdown table cell or line: `|` escaped and every line break collapsed to a space.
function cellText(value) {
  return String(value ?? "")
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

// The rows of the step table of a complex run.
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

// Everything the report says about the run, before it is printed.
function buildReport(run, state, log) {
  const steps = stepRows(state);
  const reason = firstFailingGate(state, steps, readPlan(run.runDir));
  return {
    slug: run.slug,
    tier: state.tier ?? null,
    steps,
    lessons: savedLessons(log),
    happy: reason === null,
    reason,
    execution: executionRows(state, log),
    durationS: runDurationS(log),
  };
}

// The values the report layout (references/report.md) is filled with.
function reportValues(report) {
  const stepOf = (phase) => report.steps.find((row) => row.phase === phase);
  return {
    SLUG: report.slug,
    FAST_TRACK: report.tier === "trivial" || report.tier === "simple",
    VERIFICATION_ICON: stepOf("verification").icon,
    DELIVERY: stepOf("commit").highlight,
    STEP_ROWS: stepTableRows(report.steps),
    LESSONS_LINE: lessonsLine(report.lessons),
    HAPPY: report.happy,
    HAPPY_LINE: report.happy ? "Happy: yes" : `Happy: no — ${cellText(report.reason)}`,
    EXECUTION_ROWS: executionTableRows(report.execution),
    TOTAL: durationCell(report.durationS),
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
  const report = buildReport(run, state, readJobLog(run.jobId, ctx.env));
  if (values.json === true) ctx.out(JSON.stringify(report));
  else for (const line of reportLines(report)) ctx.out(line);
  return 0;
}
