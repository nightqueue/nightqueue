import { UserError } from "../config/errors.mjs";
import { DEFAULT_PIPELINE, loadReport, pinnedPipelineName, reportLayoutOf } from "../queue/pipeline-package.mjs";
import { openQuestion } from "../queue/question-text.mjs";
import { attemptSince, derivedGateStop, derivedOutcome, entryDurationS, recordPipelineRun, statePipelinePhases, verdictIcon, verdictWord } from "../queue/pipeline-record.mjs";
import { defaultGitImpl } from "../queue/preflight.mjs";
import { isStateObject } from "../queue/resume.mjs";
import { draftLine, refusedDraftLine } from "../queue/run-state.mjs";
import { renderSkillTemplate, skillReferencesDir } from "../queue/skill-template.mjs";
import { runDurationS } from "../queue/telemetry.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { FACTS_HEADING, reportFacts } from "./report-facts.mjs";
import { changedFiles, durationCell, readJobLog, readRunFile, requireRunState, resolveRun, RUN_OPTIONS, worktreeOf } from "./run-context.mjs";

export const REPORT_USAGE = "nightqueue run report [--json] [--facts] [--project <name> --slug <slug>]";

const EMPTY = durationCell(null);

// The failures the run's pull request leaves open, or null when it delivered with none.
function draftFailuresOf(state) {
  const outcome = isStateObject(state.outcome) ? state.outcome : {};
  return outcome.draftFailures ?? (outcome.draft === true ? "unknown" : null);
}

// The line naming the failures a delivery leaves open, in the words of a real draft or of one gh refused; null when it left none.
function openFailuresLine(state, url = "") {
  const failures = draftFailuresOf(state);
  if (failures === null) return null;
  return state.outcome.draft === true ? draftLine(failures, url) : refusedDraftLine(failures, url);
}

// The delivery fact the runtime recorded: the pull request, or the conclusion that none was needed; null when neither.
function deliveryNote(state) {
  const outcome = isStateObject(state.outcome) ? state.outcome : {};
  if (outcome.status === "done" && typeof outcome.prUrl === "string") return openFailuresLine(state, outcome.prUrl) ?? `PR ${outcome.prUrl}`;
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

// The icon, word and note the package reads one row as, or null when it leaves the row to the runtime's default.
function packageResult(rowOf, row) {
  const result = typeof rowOf === "function" ? rowOf(row) : null;
  return result === null || result === undefined ? null : { icon: "", word: "", note: "", ...result };
}

// The result and the note of one recorded execution: the package's reading, else its verdict and what it recorded.
function resultOf(phase, entry, { state, rowOf }) {
  const note = noteOf(entry);
  const custom = packageResult(rowOf, { phase, entry, state, delivery: deliveryNote(state), note });
  return custom ?? { icon: verdictIcon(entry.verdict), word: verdictWord(entry.verdict), note };
}

// One row per recorded execution, in the order state.json recorded them, with the duration its own entry recorded; an entry without a phase is skipped.
function recordedRows(state, { layout, rowOf }) {
  const phases = Array.isArray(state.phases) ? state.phases : [];
  const launches = new Map();
  const rows = [];
  for (const entry of phases) {
    const phase = typeof entry?.phase === "string" ? entry.phase : "";
    if (phase.trim() === "") continue;
    const launch = (launches.get(phase) ?? 0) + 1;
    launches.set(phase, launch);
    const step = layout.find((candidate) => candidate.phase === phase);
    rows.push({ phase, step: step?.step ?? phase, agent: step?.agent ?? EMPTY, launch, ...resultOf(phase, entry, { state, rowOf }), durationS: entryDurationS(entry) });
  }
  return rows;
}

// The icon and the note of a planned step the run never recorded: the package's reading of what was recorded around it, else not recorded.
function missingStatus(step, { state, rowOf }) {
  if (step.phase === null) return { icon: "⏳", word: "", note: "this report" };
  const custom = packageResult(rowOf, { phase: step.phase, entry: null, state, delivery: deliveryNote(state), note: "" });
  return custom ?? { icon: "⚠️", word: "", note: "not recorded" };
}

// The single row of a planned step with no record.
function missingRow(step, view) {
  const { icon, word, note } = missingStatus(step, view);
  return { phase: step.phase, step: step.step, agent: step.agent, launch: 0, icon, word, note, durationS: null };
}

// The rows of the report: every recorded execution in temporal order, each unrecorded step of the pipeline's layout once at its nominal slot.
export function reportRows(state, { layout, rowOf = null }) {
  const view = { state, layout, rowOf };
  const recorded = recordedRows(state, view);
  const has = new Set(recorded.map((row) => row.phase));
  const rows = [];
  let next = 0;
  const fill = (upTo) => {
    for (; next < upTo; next++) if (!has.has(layout[next].phase)) rows.push(missingRow(layout[next], view));
  };
  for (const row of recorded) {
    const at = layout.findIndex((step) => step.phase === row.phase);
    if (at >= 0) {
      fill(at);
      next = Math.max(next, at + 1);
    }
    rows.push(row);
  }
  fill(layout.length);
  return rows;
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
  const openFailures = openFailuresLine(state);
  if (openFailures !== null) return openFailures;
  if (isStateObject(state.termination)) return `terminated at ${state.termination.phase}: ${state.termination.reason}`;
  const failed = rows.find((row) => row.icon === "❌");
  if (failed) return `${failed.step} ❌ ${gateDetail(failed)}`;
  const rerun = rows.find((row) => row.launch > 1);
  if (rerun) return `${stepCell(rerun)} ${gateDetail(rerun)}`;
  const warned = rows.find((row) => row.icon === "⚠️");
  if (warned) return `${warned.step} ⚠️ ${gateDetail(warned)}`;
  if (openQuestion(plan, state)) return "the plan carries ## Requires user confirmation";
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

// The items the pipeline's package says its artifacts leave open, none when it says nothing.
function packageOpenItems(runDir, state, report) {
  if (typeof report.openItems !== "function") return [];
  const items = report.openItems({ read: (name) => readRunFile(runDir, name), state });
  return Array.isArray(items) ? items : [];
}

// The open item of a pull request gh would not turn ready, whose failures are gone.
function staysDraftItems(state) {
  const outcome = isStateObject(state.outcome) ? state.outcome : {};
  return outcome.staysDraft === true ? [`pull request ${outcome.prUrl ?? "of this run"} stays a draft`] : [];
}

// The items the run leaves open, which the Notice translates into its Still open.
function runOpenItems(runDir, state, report) {
  const openFailures = openFailuresLine(state);
  return [...(openFailures === null ? [] : [openFailures]), ...staysDraftItems(state), ...packageOpenItems(runDir, state, report)];
}

// The telemetry row of the run, derived from its state.json and the manifest of its pipeline.
function runSpec(run, state, manifest) {
  const outcome = derivedOutcome(state, manifest);
  return {
    projectId: run.projectId,
    slug: run.slug,
    taskType: state.type ?? null,
    outcome,
    gateStop: derivedGateStop(state, outcome, manifest),
    phases: statePipelinePhases(state),
  };
}

// The word the report answers for the telemetry write.
function recordedWord(logged) {
  if (logged?.queued === true) return "queued";
  return logged?.skipped === true ? "already recorded" : "recorded";
}

// Records the run's telemetry once per attempt, else unless its last record has the same facts; a failure answers `not recorded` and leaves an open item, never an error.
async function recordRun(run, state, { env, openItems, manifest }) {
  try {
    const since = run.jobId === null ? null : await attemptSince(run.jobId, env);
    return recordedWord(await recordPipelineRun({ spec: runSpec(run, state, manifest), since }, env));
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

// The plan the pipeline gates on, empty when its manifest names no gate artifact.
function gatePlan(runDir, manifest) {
  return typeof manifest.gateArtifact === "string" ? readRunFile(runDir, manifest.gateArtifact) : "";
}

// Everything the report says about the run, before it is printed.
function buildReport({ run, state, log }, { manifest, report }) {
  const rows = reportRows(state, { layout: reportLayoutOf(manifest), rowOf: report.rowOf });
  const reason = firstFailingGate(state, rows, gatePlan(run.runDir, manifest));
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

// The worktree of the run and what it changed, or null when git cannot tell.
function worktreeChanges(run, ctx) {
  try {
    const path = worktreeOf(run, ctx.env);
    return { path, changed: changedFiles(path, ctx.gitImpl ?? defaultGitImpl) };
  } catch {
    return null;
  }
}

// The printed lines of the facts section.
function factLines(facts) {
  return ["", FACTS_HEADING, "", ...facts];
}

// Answers `run report --facts`: the facts section alone, with nothing recorded.
function printFacts(facts, values, ctx) {
  if (values.json === true) ctx.out(JSON.stringify({ facts }));
  else for (const line of factLines(facts).slice(1)) ctx.out(line);
  return 0;
}

// The package the report reads: the pinned pipeline's, else the default one's with an open item naming why the pinned one could not be read.
async function reportPackageOf(state, ctx) {
  const load = ctx.loadReport ?? loadReport;
  const name = pinnedPipelineName(state) ?? DEFAULT_PIPELINE;
  try {
    return { pipeline: await load(name), unreadable: [] };
  } catch (error) {
    if (!(error instanceof UserError) || name === DEFAULT_PIPELINE) throw error;
    return { pipeline: await load(DEFAULT_PIPELINE), unreadable: [`reported with the \`${DEFAULT_PIPELINE}\` layout: ${error.message}`] };
  }
}

// Runs `run report`, which renders the tables of the final report from the run's own records, then the facts of its artifacts; `--facts` prints only those and records nothing.
export async function runReport(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { ...RUN_OPTIONS, json: { type: "boolean" }, facts: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: REPORT_USAGE });
  const run = await resolveRun(values, ctx);
  const state = requireRunState(run, ctx.env);
  const { pipeline, unreadable } = await reportPackageOf(state, ctx);
  const facts = await reportFacts({ runDir: run.runDir, state, worktree: worktreeChanges(run, ctx), ...pipeline });
  if (values.facts === true) return printFacts(facts, values, ctx);
  const openItems = [...unreadable, ...runOpenItems(run.runDir, state, pipeline.report)];
  const recorded = await recordRun(run, state, { env: ctx.env, openItems, manifest: pipeline.manifest });
  const report = { ...buildReport({ run, state, log: readJobLog(run.jobId, ctx.env) }, pipeline), openItems, recorded, facts };
  if (values.json === true) ctx.out(JSON.stringify(report));
  else for (const line of [...reportLines(report), ...factLines(facts)]) ctx.out(line);
  return 0;
}
