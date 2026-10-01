import { basename, join } from "node:path";

export const MERGER_CEILING_MS = 1_200_000;
export const MERGER_FLOOR_MS = 60_000;
export const MERGER_HUNK_BUDGET = 12;
export const MERGER_FILE_BUDGET = 6;

const GIT_OWN_MS = 120000;
const REASON_CHARS = 200;
const HEADER_LINES = 5;
const RISK_NAMES = new Set(["package.json", "package-lock.json"]);
const GENERATED_NAMES = new Set(["pnpm-lock.yaml", "npm-shrinkwrap.json", "bun.lockb"]);
const GENERATED_SEGMENTS = new Set(["dist", "build", "generated", "__generated__", "vendor", "node_modules", "coverage"]);
const GENERATED_SUFFIXES = [".min.js", ".min.css", ".map", ".snap"];
const GENERATED_HEADER = /@generated|DO NOT EDIT/i;
const HUNK_START = /^<{7}( |$)/gm;
const ANY_MARKER = /^(<{7}|={7}|>{7}|\|{7})( |$)/m;
const TIME_FLOOR_REASON = "not enough of the close's timeout left for the merger and the suite; raise queue.closeTimeoutS";

// Tells whether a conflicted path is on the risk list the merger never touches.
export function riskFile(path) {
  const name = basename(path);
  return RISK_NAMES.has(name) || name.endsWith(".lock") || path === "src/memory/schema.mjs" || path.startsWith("src/memory/migration/");
}

// Tells whether a path names a generated file by its name, a directory on the way or its suffix.
export function generatedByPath(path) {
  const name = basename(path);
  if (GENERATED_NAMES.has(name)) return true;
  if (path.split("/").slice(0, -1).some((segment) => GENERATED_SEGMENTS.has(segment))) return true;
  return GENERATED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

// Tells whether the first lines of a text mark it as generated.
export function generatedByHeader(text) {
  return GENERATED_HEADER.test(String(text ?? "").split("\n").slice(0, HEADER_LINES).join("\n"));
}

// The number of conflict hunks in a text, one per opening marker.
export function countHunks(text) {
  return (String(text ?? "").match(HUNK_START) ?? []).length;
}

// Tells whether a text still carries any conflict marker line.
export function hasMarkers(text) {
  return ANY_MARKER.test(String(text ?? ""));
}

// A verdict line without the backticks or asterisks around it and without a trailing period.
function bareVerdictLine(line) {
  return line.replace(/^[`*]+/, "").replace(/[`*.]+$/, "").trim();
}

// The verdict of the merger's final text: resolved, or the reason it gave or the lack of one.
export function parseVerdict(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const last = bareVerdictLine(lines.at(-1) ?? "");
  if (last === "RESOLVED") return { resolved: true };
  const unresolved = /^UNRESOLVED:[`*]*\s*(.+)$/.exec(last);
  if (unresolved) return { resolved: false, reason: `UNRESOLVED: ${unresolved[1].trim()}`.slice(0, REASON_CHARS) };
  return { resolved: false, reason: "ended without a RESOLVED/UNRESOLVED line" };
}

// The merger's timeout at one stop: half of what the suite's reserve leaves, never past the ceiling.
export function mergerTimeoutMs(remainingMs, reserveMs) {
  return Math.min(MERGER_CEILING_MS, Math.floor((remainingMs - reserveMs) / 2));
}

// The task handed to the merger agent at one rebase stop.
export function mergerPrompt({ files, base, head }) {
  const list = files.map((file) => `- ${file}`).join("\n");
  return [
    `A rebase of the branch \`${head}\` onto \`origin/${base}\` stopped on conflicts in this throwaway worktree.`,
    "Resolve the conflict markers in these files only, following your rules:",
    list,
    "End with one line: RESOLVED, or UNRESOLVED: <reason>.",
  ].join("\n");
}

// The first non-empty line of a text, or a placeholder naming its absence.
function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0]?.trim() || "no output";
}

// The non-empty lines of a text.
function linesOf(text) {
  return String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

// Runs git in the stopped rebase's worktree, never past the close's deadline.
async function mergerGit(ctx, deps, work, args) {
  return await deps.git(args, { cwd: work.dir, timeoutMs: Math.max(1, Math.min(GIT_OWN_MS, ctx.remainingMs())), signal: ctx.signal });
}

// The answer of a conflict the merger did not resolve, naming every file met so far.
function unresolved(state, { eligible, reason }) {
  return { resolved: false, eligible, reason, hunks: state.budget.hunks, files: [...new Set([...state.budget.files, ...state.stopFiles])] };
}

// The texts of the stop's files, read once from the worktree.
function readStopTexts(deps, work, files) {
  return new Map(files.map((file) => [file, deps.fs.readText?.(join(work.dir, file)) ?? null]));
}

// The files git marks `linguist-generated`, or the reason the attribute could not be read.
async function attrGenerated(ctx, deps, work, files) {
  const read = await mergerGit(ctx, deps, work, ["check-attr", "linguist-generated", "--", ...files]);
  if (!read.ok) return { problem: `git check-attr failed (${firstLine(read.stderr)})` };
  const marked = linesOf(read.stdout).filter((line) => /: linguist-generated: (set|true)$/.test(line));
  return { files: marked.map((line) => line.slice(0, line.lastIndexOf(": linguist-generated: "))) };
}

// Why one stop's files are not for the merger by their path, or null.
function pathProblem(files) {
  const risky = files.find(riskFile);
  if (risky) return `risk-list file: ${risky}`;
  const generated = files.find(generatedByPath);
  return generated ? `generated file: ${generated}` : null;
}

// Why one stop's files are not for the merger by their content, or null.
function contentProblem(files, texts) {
  const generated = files.find((file) => generatedByHeader(texts.get(file)));
  if (generated) return `generated file: ${generated}`;
  const markerless = files.find((file) => texts.get(file) === null || countHunks(texts.get(file)) === 0);
  return markerless ? `no conflict markers in ${markerless} (a delete, rename or binary conflict)` : null;
}

// Why the summed budget cannot take this stop, or null.
function budgetProblem(state, stopHunks) {
  const hunks = state.budget.hunks + stopHunks;
  const files = new Set([...state.budget.files, ...state.stopFiles]).size;
  if (hunks <= MERGER_HUNK_BUDGET && files <= MERGER_FILE_BUDGET) return null;
  return `${hunks} hunks in ${files} files over the ${MERGER_HUNK_BUDGET}/${MERGER_FILE_BUDGET} budget`;
}

// Checks in code that one stop may go to the merger: answers its hunk count, or the reason it may not.
async function stopEligibility(ctx, deps, state) {
  const { work, stopFiles } = state;
  if (ctx.force) return { reason: "--force never runs the merger" };
  if (!deps.fs.readTestScript(work.dir)) return { reason: "no scripts.test" };
  const byPath = pathProblem(stopFiles);
  if (byPath) return { reason: byPath };
  const attr = await attrGenerated(ctx, deps, work, stopFiles);
  if (attr.problem) return { reason: attr.problem };
  if (attr.files.length) return { reason: `generated file: ${attr.files[0]}` };
  const texts = readStopTexts(deps, work, stopFiles);
  const byContent = contentProblem(stopFiles, texts);
  if (byContent) return { reason: byContent };
  const hunks = stopFiles.reduce((sum, file) => sum + countHunks(texts.get(file)), 0);
  const overBudget = budgetProblem(state, hunks);
  if (overBudget) return { reason: overBudget };
  if (ctx.signal?.aborted) return { reason: "interrupted" };
  return { hunks };
}

// Runs the merger agent on one stop, turning a throw into a failed run.
async function runAgent(ctx, deps, state, timeoutMs) {
  const { work, stopFiles } = state;
  try {
    const prompt = mergerPrompt({ files: stopFiles, base: work.base, head: work.head });
    return await deps.merger({ cwd: work.dir, files: stopFiles, prompt, timeoutMs, signal: ctx.signal, jobId: ctx.jobId });
  } catch (err) {
    return { spawnError: `the merger could not run (${err?.message ?? String(err)})` };
  }
}

// Why a merger run does not count as resolved, or null when it says RESOLVED.
function runProblem(ctx, run, timeoutMs) {
  if (run?.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)} s`;
  if (run?.stopped || ctx.signal?.aborted) return "interrupted";
  if (run?.spawnError) return run.spawnError;
  if (run?.exitCode !== 0) return `exited with code ${run?.exitCode ?? "unknown"}`;
  const verdict = parseVerdict(run.resultText);
  return verdict.resolved ? null : verdict.reason;
}

// Why the runtime refuses the agent's resolution: markers left, or a file touched outside the conflict; null when it holds.
async function verificationProblem(ctx, deps, state) {
  const { work, stopFiles } = state;
  const texts = readStopTexts(deps, work, stopFiles);
  const marked = stopFiles.filter((file) => texts.get(file) === null || hasMarkers(texts.get(file)));
  if (marked.length) return `conflict markers left in: ${marked.join(", ")}`;
  const changed = await mergerGit(ctx, deps, work, ["diff", "--name-only"]);
  if (!changed.ok) return `git diff --name-only failed (${firstLine(changed.stderr)})`;
  const outside = linesOf(changed.stdout).filter((file) => !stopFiles.includes(file));
  return outside.length ? `the resolution touched files outside the conflict: ${outside.join(", ")}` : null;
}

// Stages the resolution and continues the rebase: answers done, the next stop's files, or why it could not.
async function continueRebase(ctx, deps, state) {
  const { work, stopFiles } = state;
  if (ctx.signal?.aborted) return { reason: "interrupted" };
  const added = await mergerGit(ctx, deps, work, ["add", "--", ...stopFiles]);
  if (!added.ok) return { reason: `git add failed (${firstLine(added.stderr)})` };
  const continued = await mergerGit(ctx, deps, work, ["-c", "core.editor=true", "rebase", "--continue"]);
  if (continued.ok) return { done: true };
  const unmerged = await mergerGit(ctx, deps, work, ["diff", "--name-only", "--diff-filter=U"]);
  const next = linesOf(unmerged.stdout);
  return next.length ? { next } : { reason: `git rebase --continue failed (${firstLine(continued.stderr)})` };
}

// Resolves one rebase stop with the merger: answers the final outcome, or the files of the next stop.
async function resolveStop(ctx, deps, state) {
  const eligibility = await stopEligibility(ctx, deps, state);
  if (eligibility.reason) return { outcome: unresolved(state, { eligible: false, reason: eligibility.reason }) };
  const timeoutMs = mergerTimeoutMs(ctx.remainingMs(), state.work.reserveMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < MERGER_FLOOR_MS) return { outcome: unresolved(state, { eligible: true, reason: TIME_FLOOR_REASON }) };
  state.budget.hunks += eligibility.hunks;
  for (const file of state.stopFiles) state.budget.files.add(file);
  await ctx.progress?.(`merger resolving ${eligibility.hunks} hunks in ${state.stopFiles.length} files`);
  const problem = runProblem(ctx, await runAgent(ctx, deps, state, timeoutMs), timeoutMs) ?? (await verificationProblem(ctx, deps, state));
  if (problem) return { outcome: unresolved(state, { eligible: true, reason: problem }) };
  const continued = await continueRebase(ctx, deps, state);
  if (continued.reason) return { outcome: unresolved(state, { eligible: true, reason: continued.reason }) };
  if (continued.done) return { outcome: { resolved: true, hunks: state.budget.hunks, files: [...state.budget.files].sort() } };
  return { next: continued.next };
}

// Hands a stopped rebase to the bounded merger, stop after stop within the summed budget; never aborts the rebase.
export async function resolveConflictedRebase(ctx, deps, work) {
  const state = { work, budget: { hunks: 0, files: new Set() }, stopFiles: work.files };
  for (let stop = 0; stop < MERGER_HUNK_BUDGET; stop += 1) {
    const result = await resolveStop(ctx, deps, state);
    if (result.outcome) return result.outcome;
    state.stopFiles = result.next;
  }
  return unresolved(state, { eligible: true, reason: `the rebase still stopped after ${MERGER_HUNK_BUDGET} resolved stops` });
}
