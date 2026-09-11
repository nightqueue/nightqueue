import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { closeDb, openDbReadOnly } from "../memory/db.mjs";
import { withLock } from "../config/lock.mjs";
import { jobLogPath, queuePausedPath } from "../config/paths.mjs";
import { projectByName, registrationOffer, resolveProject } from "../config/projects.mjs";
import { ensureHome, loadConfig, writeFileAtomic } from "../config/store.mjs";
import { updateNoticeLine } from "../host/update-notice.mjs";
import {
  addJob,
  cancelJob,
  countActiveJobs,
  countsByStatus,
  getJob,
  jobView,
  listJobs,
  truncateByCodePoint,
} from "../memory/jobs.mjs";
import { PROMPT_SOURCE_CONFLICT, queueRoadmapItem } from "../memory/roadmap.mjs";
import { followLog, readLogTail } from "../queue/follow.mjs";
import { isQueueIdle, pendingJobs } from "../queue/hints.mjs";
import { prViewer, refreshMergedJobs } from "../queue/merged.mjs";
import {
  createNarrator,
  formatDuration,
  formatNarration,
  lastNarratedLine,
  narrateLog,
  noticeNarration,
} from "../queue/narrate.mjs";
import {
  removeOwnRunnerPidfile,
  runnerPidfileState,
  runnerView,
  stopRunner,
  STOP_TIMEOUT_MS,
} from "../queue/pidfile.mjs";
import { repairWarningLine } from "../queue/reconcile.mjs";
import { applyRetry, callerJobId } from "../queue/retry.mjs";
import { runCycle, runDrain, runWatch, WATCH_INTERVAL_DEFAULT_S } from "../queue/runner.mjs";
import { registerForegroundRunner, runnerBusyAdvisory, runnerBusyLine, runnerMode, startQueueRunner } from "../queue/start.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { registerProject } from "./project.mjs";
import { confirm } from "./prompt.mjs";
import { runtimeLabel } from "./runtime-versions.mjs";

const USAGE = {
  add: "nightshift queue add [project] <prompt...> [--run] [--foreground] [--priority <n>] [--max-attempts <n>] [--timeout <s>] [--yes] [--tier <trivial|simple|complex>] [--roadmap <id>]",
  status: "nightshift queue status [id] [--limit <n>] [--json] [--follow [seconds]] [--until-idle]",
  run: "nightshift queue run [--job <id> | --watch [seconds]] [--max <n>] [--stop] [--foreground] [--dry] [--json]",
  cancel: "nightshift queue cancel <id> [--reason <text>]",
  retry: "nightshift queue retry <id> [--note <text>] [--fresh] [--run] [--foreground]",
  pause: "nightshift queue pause",
  resume: "nightshift queue resume",
  log: "nightshift queue log <id> [--follow] [--raw] [--all]",
};

const ADD_HELP_FLAGS = new Set(["--help", "-h"]);

const ADD_HELP = `usage: ${USAGE.add}

One job is one self-contained deliverable that can be reviewed and merged on its own. Large work is ONE job
with numbered stages written in the prompt — never several jobs that depend on each other. A job that needs
another job's pull request merged first is cut wrong: fold it into that job. Independent jobs may run in
parallel and merge in any order.

example:
  nightshift queue add "Self-contained install. Stages: 1) runtime under ~/.nightshift; 2) shim + PATH prompt; 3) embedding opt-in; 4) rename bin to ns. Each stage verified before the next; one PR."`;

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Requires an option or argument to be a positive integer, so a typo never becomes a silent default.
function requireInt(name, raw) {
  if (raw === undefined || raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UserError(`\`${name}\` expects a positive integer, got \`${raw}\``);
  return parsed;
}

// Tells whether a token is a positive integer, the value a bare `--watch` does not carry.
function isPositiveIntToken(token) {
  return typeof token === "string" && /^\d+$/.test(token) && Number(token) > 0;
}

// Turns a bare `--watch` into `--watch=<default>`, because strict parseArgs has no optional-value option.
function normalizeWatchArgv(argv) {
  return argv.flatMap((token, index) =>
    token === "--watch" && !isPositiveIntToken(argv[index + 1]) ? [`--watch=${WATCH_INTERVAL_DEFAULT_S}`] : [token],
  );
}

// The error `queue add` ends on whenever the current directory resolves to no project and nothing is registered for it.
function unregisteredError(cwd) {
  return new UserError(`no project registered for ${cwd}; run \`nightshift init\` here, or pass the project NAME (\`nightshift project list\`)`);
}

// The question `queue add` asks before it registers the repository of the current directory.
function registerQuestion(cwd, offer) {
  return `No project registered for ${cwd}. Register it as \`${offer.name}\` in org \`${offer.org}\` and queue the job? [Y/n] `;
}

// Tells whether the operator accepted the registration: `--yes` answers for a script, the terminal answers for a person.
async function wantsRegistration(offer, cwd, values, ctx) {
  if (values.yes === true) return true;
  return await confirm({ stdin: ctx.stdin, stdout: ctx.stdout, question: registerQuestion(cwd, offer) });
}

// Registers the repository of the current directory, taking the configuration lock `queue` never takes for itself.
async function registerFromCwd(offer, ctx) {
  return await withLock(ctx.env, () => registerProject(ctx, { path: offer.path, name: offer.name }));
}

// Refuses to register a project from inside an unattended run: there is no user there to confirm it.
function refuseRegistrationInsideJob(cwd, env) {
  const own = callerJobId(env);
  if (own === null) return;
  throw new UserError(
    `refusing to register ${cwd} from inside job \`${own}\`: an unattended run never registers a project; ` +
      "pass the registered project NAME (`nightshift project list`), or ask the operator to run `nightshift init` there",
  );
}

// Offers to register the repository of the current directory, and answers the project it landed on.
async function offerRegistration(config, values, ctx) {
  const cwd = ctx.cwd ?? process.cwd();
  refuseRegistrationInsideJob(cwd, ctx.env);
  if (values.yes !== true && !ctx.stdin?.isTTY) throw unregisteredError(cwd);
  const offer = registrationOffer(config, cwd);
  if (!offer) throw unregisteredError(cwd);
  if (!(await wantsRegistration(offer, cwd, values, ctx))) throw unregisteredError(cwd);
  return await registerFromCwd(offer, ctx);
}

// Chooses the project of the job: the first positional when it is a registered NAME, otherwise the project of the current directory.
async function resolveTarget(config, positionals, values, ctx) {
  const named = projectByName(config, positionals[0]);
  if (named) return { project: named, words: positionals.slice(1), fromCwd: false };
  const resolved = resolveProject(config, { cwd: ctx.cwd ?? process.cwd() });
  if (resolved) return { project: resolved, words: positionals, fromCwd: true };
  return { project: await offerRegistration(config, values, ctx), words: positionals, fromCwd: false };
}

// Tells the operator the job of a refused single-job start will not be picked up, because its row is no longer pending.
function notPendingLine(jobId, env) {
  if (jobId === null) return null;
  const job = getJob(jobId, env);
  if (!job || job.status === "pending") return null;
  return `job #${jobId} is ${job.status}, not pending - it will not be picked up`;
}

// Everything a refused start says: the refusal itself, the advisory of a runner that stops after one job, and the row that stays where it is.
function busyLines({ pid, mode }, { jobId, watchIntervalS }, env) {
  const advisory = runnerBusyAdvisory(mode, runnerMode({ jobId, watchIntervalS }));
  return [runnerBusyLine(pid, mode), advisory, notPendingLine(jobId, env)].filter(Boolean);
}

// Reports the live runner that made this start unnecessary; a start nobody needed is not a failure.
function reportBusy(guard, options, ctx) {
  for (const line of busyLines(guard, options, ctx.env)) ctx.out(line);
  return 0;
}

// The line that tells the operator what started and how to follow it or stop it.
function startedLine({ jobId, pid, watchIntervalS, logPath }) {
  if (watchIntervalS !== null) return `runner started (pid ${pid}, every ${watchIntervalS} s) - stop with: nightshift queue run --stop`;
  if (jobId !== null) return `job #${jobId} started (pid ${pid}) - follow with: nightshift queue log ${jobId} --follow`;
  return `runner started (pid ${pid}) - draining the queue until nothing is pending; follow with: nightshift queue status --follow (log: ${logPath})`;
}

// Starts the runner detached, with the guard and the registration inside one hold of the home lock, and says what happened.
async function startDetached({ jobId = null, max = null, watchIntervalS = null }, ctx) {
  const started = await startQueueRunner({
    jobId,
    max,
    watchIntervalS,
    env: ctx.env,
    spawnImpl: ctx.spawnImpl,
    killImpl: ctx.killImpl,
  });
  if (!started.started) return reportBusy(started, { jobId, watchIntervalS }, ctx);
  ctx.out(startedLine({ jobId, pid: started.pid, watchIntervalS, logPath: started.logPath }));
  return 0;
}

// Runs the queue in THIS process as the registered runner, unless another one already owns it; the registration never outlives the run.
async function runGuardedHere({ jobId = null, watchIntervalS = null, ctx, run }) {
  const guard = await registerForegroundRunner({ jobId, watchIntervalS, env: ctx.env, killImpl: ctx.killImpl });
  if (!guard.ok) return reportBusy(guard, { jobId, watchIntervalS }, ctx);
  try {
    return await run();
  } finally {
    removeOwnRunnerPidfile(ctx.env);
  }
}

// Runs one job here and turns its outcome into the exit code: 0 only when it finished as `done`.
async function runJobHere(job, ctx) {
  ctx.out(`running job #${job.id} in the foreground; follow the stream with \`nightshift queue log ${job.id} --follow\``);
  const cycle = await runCycle({ jobId: job.id, max: 1, env: ctx.env });
  const processed = cycle.processed.find((entry) => entry.id === job.id);
  if (!processed) {
    ctx.out(`job #${job.id} did not start (${cycle.reason}); it stays in the queue`);
    return 1;
  }
  ctx.out(formatProcessed(processed));
  return processed.status === "done" ? 0 : 1;
}

// Takes the job through a runner in this process, unless a live runner already owns the queue.
async function runInForeground(job, ctx) {
  return await runGuardedHere({ jobId: job.id, ctx, run: () => runJobHere(job, ctx) });
}

// Takes the job the command just queued through the runner: in this process with `--foreground`, detached otherwise.
async function runNow(job, values, ctx) {
  return values.foreground === true ? await runInForeground(job, ctx) : await startDetached({ jobId: job.id }, ctx);
}

// Refuses `--foreground` on a command that was never asked to run the job.
function checkForegroundNeedsRun(values, usage) {
  if (values.foreground === true && values.run !== true) {
    throw new UserError(`\`--foreground\` only has meaning with \`--run\`; usage: ${usage}`);
  }
}

// The line `queue add` answers with: the old confirmation when the job is about to run, the backlog nudge otherwise.
function addedLine(job, willRun, env) {
  if (willRun) return `queued job #${job.id} for project \`${job.project}\` (priority ${job.priority}, timeout ${job.timeoutS}s)`;
  return `queued job #${job.id} for \`${job.project}\` (${countsByStatus(env).pending} pending). Start the batch: nightshift queue run`;
}

// The knobs of a `queue add` that reach the job: priority, attempts, timeout and the operator's tier.
function addLimits(values) {
  return {
    priority: requireInt("--priority", values.priority),
    maxAttempts: requireInt("--max-attempts", values["max-attempts"]),
    timeoutS: requireInt("--timeout", values.timeout),
    tier: values.tier,
  };
}

// Queues the job the words of the command line describe, with the project taken from them or from the current directory.
async function addFromPrompt(positionals, values, ctx) {
  if (positionals.join(" ").trim() === "") throw new UserError(`missing argument; usage: ${USAGE.add}`);
  const target = await resolveTarget(loadConfig(ctx.env, { warn: ctx.err }), positionals, values, ctx);
  const prompt = target.words.join(" ").trim();
  if (!prompt) throw new UserError(`missing argument; usage: ${USAGE.add}`);
  if (target.fromCwd) ctx.out(`project \`${target.project.name}\` resolved from the current directory`);
  return addJob({ project: target.project.name, prompt, ...addLimits(values) }, ctx.env);
}

// Queues the job a roadmap item builds; the item owns the project, so nothing is resolved from the current directory.
async function addFromRoadmap(positionals, values, ctx) {
  if (positionals.length) throw new UserError(PROMPT_SOURCE_CONFLICT);
  const queued = await queueRoadmapItem({ id: requireInt("--roadmap", values.roadmap), ...addLimits(values) }, ctx.env);
  ctx.out(`roadmap item #${queued.item.id} of \`${queued.item.project}\` is now \`queued\``);
  return queued.job;
}

// Runs `queue add`, with the job built from the words of the command line or from the roadmap item `--roadmap` names.
async function runAdd(argv, ctx) {
  if (argv.length === 1 && ADD_HELP_FLAGS.has(argv[0])) {
    ctx.out(ADD_HELP);
    return 0;
  }
  const { values, positionals } = parseAdd(argv);
  checkForegroundNeedsRun(values, USAGE.add);
  const job =
    values.roadmap === undefined
      ? await addFromPrompt(positionals, values, ctx)
      : await addFromRoadmap(positionals, values, ctx);
  ctx.out(addedLine(job, values.run === true, ctx.env));
  return values.run === true ? await runNow(job, values, ctx) : 0;
}

const ADD_OPTIONS = {
  priority: { type: "string" },
  "max-attempts": { type: "string" },
  timeout: { type: "string" },
  run: { type: "boolean" },
  foreground: { type: "boolean" },
  yes: { type: "boolean" },
  roadmap: { type: "string" },
  tier: { type: "string" },
};

// Tells whether a token is written as an option, the only shape the edges of `queue add` read as one.
function isOptionToken(token) {
  return typeof token === "string" && token.length > 1 && token.startsWith("-") && token !== "--";
}

// Tells whether an option token takes the token after it as its value.
function takesNextValue(token) {
  return !token.includes("=") && ADD_OPTIONS[token.slice(2)]?.type === "string";
}

// End of the leading run of options of `queue add`, where the free text begins.
function optionPrefixEnd(argv) {
  let index = 0;
  while (index < argv.length && isOptionToken(argv[index])) {
    index += takesNextValue(argv[index]) && index + 1 < argv.length ? 2 : 1;
  }
  return Math.min(index, argv.length);
}

// Start of the trailing run of options of `queue add`, where the free text ends.
function optionSuffixStart(tokens) {
  let index = tokens.length;
  while (index > 0) {
    if (isOptionToken(tokens[index - 1])) index -= 1;
    else if (index > 1 && isOptionToken(tokens[index - 2]) && takesNextValue(tokens[index - 2])) index -= 2;
    else break;
  }
  return index;
}

// Splits the argv of `queue add` into the options of the two edges and the free text between them, kept byte for byte.
function splitAddArgv(argv) {
  const prefixEnd = optionPrefixEnd(argv);
  const rest = argv.slice(prefixEnd);
  const escape = rest.indexOf("--");
  if (escape !== -1) {
    return { optionTokens: argv.slice(0, prefixEnd), words: [...rest.slice(0, escape), ...rest.slice(escape + 1)] };
  }
  const suffixStart = optionSuffixStart(rest);
  return { optionTokens: [...argv.slice(0, prefixEnd), ...rest.slice(suffixStart)], words: rest.slice(0, suffixStart) };
}

// Parses the arguments of `queue add`: an optional project name and the words of the prompt, with options read only at the edges.
function parseAdd(argv) {
  const { optionTokens, words } = splitAddArgv(argv);
  const { values } = parseCommand(optionTokens, ADD_OPTIONS);
  if (values.roadmap === undefined) checkArgs(words, { min: 1, max: Number.POSITIVE_INFINITY, usage: USAGE.add });
  return { values, positionals: words };
}

const FOLLOW_INTERVAL_DEFAULT_S = 2;
const DEFAULT_WIDTH = 120;
const MIN_LAST_WIDTH = 20;

// Fixed columns of the table of `queue status`, in the order of the cockpit; SLUG/LAST takes whatever width is left and PR closes the row.
const COLUMNS = [
  { key: "id", title: "ID", width: 6 },
  { key: "status", title: "STATUS", width: 13 },
  { key: "duration", title: "DURATION", width: 10 },
  { key: "tokens", title: "TOKENS", width: 8 },
  { key: "project", title: "PROJECT", width: 22 },
];

// Icon and ANSI color of each status; the icon is always printed, the color only on a real terminal.
const STATUS_STYLE = {
  running: { icon: "●", color: "33" },
  done: { icon: "✓", color: "32" },
  gate: { icon: "⚑", color: "35" },
  failed: { icon: "✗", color: "31" },
  cancelled: { icon: "⊘", color: "2" },
  pending: { icon: "○", color: "2" },
  merged: { icon: "⇡", color: "2;32" },
};

// Paints a text with an ANSI code, or leaves it alone when color is off.
function paint(text, code, color) {
  return color && code ? `\u001b[${code}m${text}\u001b[0m` : text;
}

// Width of the terminal the table is drawn on, with a sane default when nobody knows.
function terminalWidth(ctx) {
  const columns = ctx.stdout?.columns;
  return Number.isInteger(columns) && columns > 40 ? columns : DEFAULT_WIDTH;
}

// Width left for SLUG/LAST once the fixed columns and PR took theirs; never below the minimum, so a narrow terminal still shows something.
function lastWidth(ctx, pr) {
  const fixed = COLUMNS.reduce((total, column) => total + column.width, 0) + pr + 1;
  return Math.max(MIN_LAST_WIDTH, terminalWidth(ctx) - fixed);
}

// Cuts a cell to its column, with an ellipsis when something was left out.
function fit(text, width) {
  const value = String(text ?? "").replace(/\s+/g, " ");
  if (value.length <= width) return value;
  return width <= 3 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`;
}

// How long a job ran: since its start while it runs, start to finish once it stopped, nothing before it started.
function formatDurationCell(job, nowMs) {
  const startedMs = Date.parse(String(job.started_at ?? ""));
  if (!Number.isFinite(startedMs)) return "-";
  const finishedMs = Date.parse(String(job.finished_at ?? ""));
  return formatDuration((Number.isFinite(finishedMs) ? finishedMs : nowMs) - startedMs);
}

// Tokens the job spent, in and out, compact: `374k`, `1.2M`, `-` before the first usage report.
function formatTokens(job) {
  const total = (job.tokens_in ?? 0) + (job.tokens_out ?? 0);
  if (!Number.isFinite(total) || total <= 0) return "-";
  if (total < 1000) return String(total);
  if (total < 1_000_000) return `${Math.round(total / 1000)}k`;
  return `${(total / 1_000_000).toFixed(1)}M`;
}

// The pull request of a job as its plain URL: terminals turn a bare URL into a link on their own, which an escape sequence cannot count on.
function formatPr(job) {
  return job.pr_url ? String(job.pr_url) : "-";
}

// Width of the PR column for this listing: the longest URL present, never less than the header.
function prWidth(jobs) {
  return jobs.reduce((width, job) => Math.max(width, formatPr(job).length), "PR".length);
}
// Last narrated line of the log of a job, as `queue log` would print it; a log that is missing or unreadable says so instead of inventing one.
function lastNarration(id, env) {
  const tail = readLogTail(jobLogPath(id, env));
  const line = typeof tail === "string" ? lastNarratedLine(tail) : "";
  return line || "-";
}

// First line of the notice of a job, the reason it stopped, for the table.
function firstNoticeLine(job) {
  const line = String(job.notice_md ?? "").split("\n").find((entry) => entry.trim());
  return line ? line.trim() : null;
}

// The preflight block a pending job carries in its result, or null: the reason the runner gave it back.
function blockedOf(job) {
  if (job.status !== "pending") return null;
  try {
    const parsed = typeof job.result === "string" ? JSON.parse(job.result) : job.result;
    const blocked = parsed?.blocked;
    return blocked?.code ? { code: String(blocked.code), message: String(blocked.message ?? "") } : null;
  } catch {
    return null;
  }
}

// What SLUG/LAST says about a job: what it is doing while it runs, why it stopped at the gate, why the runner gave it back, its slug otherwise.
function lastCell(job, env) {
  if (job.status === "running") return lastNarration(job.id, env);
  if (job.status === "gate" || job.status === "failed") return firstNoticeLine(job) ?? job.slug ?? "-";
  const blocked = blockedOf(job);
  if (blocked) return `⛔ ${blocked.code}: ${blocked.message}`;
  return job.slug ?? "-";
}

// Cells of one row of the table, before any cut or paint.
function rowCells(job, nowMs, env) {
  return {
    id: `#${job.id}`,
    status: `${(STATUS_STYLE[job.status] ?? { icon: "·" }).icon} ${job.status}`,
    duration: formatDurationCell(job, nowMs),
    tokens: formatTokens(job),
    project: String(job.project),
    last: lastCell(job, env),
  };
}

// One row of the table: fixed columns padded to their width, SLUG/LAST cut to what is left, the status painted on a terminal.
function formatRow(job, { nowMs, env, width, color }) {
  const cells = rowCells(job, nowMs, env);
  const fixed = COLUMNS.map((column) => {
    const cell = fit(cells[column.key], column.width - 1).padEnd(column.width);
    return column.key === "status" ? paint(cell, STATUS_STYLE[job.status]?.color, color) : cell;
  });
  const last = fit(cells.last, width - 1).padEnd(width);
  return `${fixed.join("")}${last}${formatPr(job)}`.trimEnd();
}

// Header of the table and the rule under it, dimmed on a terminal.
function formatHeader({ width, color }) {
  const titles = `${COLUMNS.map((column) => column.title.padEnd(column.width)).join("")}${"SLUG/LAST".padEnd(width)}PR`;
  return [paint(titles, "2", color), paint("─".repeat(titles.length), "2", color)];
}
// The whole table: header, one row per job, nothing else.
function formatTable(jobs, ctx) {
  const layout = { nowMs: Date.now(), env: ctx.env, width: lastWidth(ctx, prWidth(jobs)), color: useColor(ctx) };
  return [...formatHeader(layout), ...jobs.map((job) => formatRow(job, layout))];
}

// The notice of a job, printed under its own line and indented, plus the way to answer it while the job waits at the gate.
function formatNotice(job) {
  if (!job.notice_md) return [];
  const body = String(job.notice_md).split("\n").map((line) => `  ${line}`);
  const answer = job.status === "gate" ? [`retry it with: nightshift queue retry ${job.id} --note "<your answer>"`] : [];
  return ["notice", ...body, ...answer];
}

// Detail block of a single job, one field per line, with the reason it stopped spelled out instead of dumped on one line.
function formatDetail(job) {
  const fields = Object.entries(job)
    .filter(([key, value]) => key !== "notice_md" && value !== null && value !== undefined)
    .map(([key, value]) => `${key.padEnd(16)}${value}`);
  const at = fields.findIndex((line) => line.startsWith("status".padEnd(16)));
  const notice = formatNotice(job);
  return at < 0 ? [...fields, ...notice] : [...fields.slice(0, at + 1), ...notice, ...fields.slice(at + 1)];
}

// What the registered runner does: how often it looks at the queue, or the single job it was started for.
function runnerCadence(runner) {
  if (runner.mode === "watch") return `watch every ${runner.intervalS} s`;
  if (runner.mode === "once") return runner.jobId === null ? "once" : `once, job #${runner.jobId}`;
  return `${runner.mode ?? "runner"}`;
}

// The `runner:` line of `queue status`, the first thing the operator reads about the queue: the registered runner, or the job that runs without one.
function formatRunner(runner, activeJobs = 0, env = process.env) {
  if (runner.running) {
    const label = runtimeLabel(runner.runtimeDir, env);
    const runtime = label ? `, runtime ${label}` : "";
    return `runner: running (pid ${runner.pid}, ${runnerCadence(runner)}${runtime}, since ${runner.startedAt})`;
  }
  if (activeJobs > 0) return `runner: ${pendingJobs(activeJobs).replace("pending", "running")} under a one-shot runner - nothing will pick up the pending jobs after it (start a drain with: nightshift queue run)`;
  return "runner: stopped";
}

// The line `queue status` closes with when a backlog is sitting there with nobody working it, or when the runner gave a job back.
function backlogLine({ activeJobs, counts, runner, jobs = [] }) {
  const blocked = jobs.map(blockedOf).filter(Boolean);
  if (blocked.length) return `${blocked.length} job${blocked.length === 1 ? "" : "s"} blocked (${[...new Set(blocked.map((entry) => entry.code))].join(", ")}) - fix the cause, the runner retries by itself`;
  if (!isQueueIdle({ activeJobs, runner }) || counts.pending === 0) return null;
  return `${pendingJobs(counts.pending)} waiting - start the batch: nightshift queue run`;
}

const STATUS_OPTIONS = {
  json: { type: "boolean" },
  limit: { type: "string" },
  follow: { type: "string" },
  "until-idle": { type: "boolean" },
};

// Gives `--follow` its default interval when the operator wrote it without one, the same way `run --watch` does.
function normalizeFollowArgv(argv) {
  return argv.flatMap((token, index) =>
    token === "--follow" && !isPositiveIntToken(argv[index + 1]) ? [`--follow=${FOLLOW_INTERVAL_DEFAULT_S}`] : [token],
  );
}

// Brings the jobs whose pull request was merged up to date before a view reads the rows; it is silent and never fails the command.
function sweepMerged(ctx) {
  refreshMergedJobs({ env: ctx.env, ghImpl: prViewer(ctx.env, ctx.spawnSyncImpl) });
}

// Lines of the queue view: runner, table, counts and the backlog hint, in that order.
function queueViewLines(values, ctx) {
  sweepMerged(ctx);
  const jobs = listJobs({ limit: requireInt("--limit", values.limit) }, ctx.env).map(jobView);
  const counts = countsByStatus(ctx.env);
  const runner = runnerView(runnerPidfileState(ctx.env, ctx.killImpl));
  const activeJobs = countActiveJobs(ctx.env);
  const lines = [formatRunner(runner, activeJobs, ctx.env)];
  if (!jobs.length) return { lines: [...lines, "no jobs in the queue"], idle: true };
  lines.push(...formatTable(jobs, ctx));
  lines.push(Object.entries(counts).map(([status, total]) => `${status}=${total}`).join("  "));
  const backlog = backlogLine({ activeJobs, counts, runner, jobs });
  if (backlog) lines.push(backlog);
  return { lines, idle: isQueueIdle({ activeJobs, runner }) && counts.pending === 0 };
}

// Keeps redrawing the queue view until Ctrl-C, or until the queue goes idle when asked; on a pipe it only prints what changed.
async function followStatus(values, intervalS, ctx) {
  const wait = ctx.sleep ?? sleep;
  const tty = ctx.stdout?.isTTY === true;
  let previous = null;
  let stop = false;
  const onSignal = () => {
    stop = true;
  };
  process.once("SIGINT", onSignal);
  try {
    while (!stop) {
      closeDb(ctx.env);
      repairFromWitness(ctx);
      const view = queueViewLines(values, ctx);
      const text = view.lines.join("\n");
      if (tty) {
        ctx.stdout.write(`\u001b[2J\u001b[H${text}\n${paint(`every ${intervalS}s - Ctrl-C to stop`, "2", useColor(ctx))}\n`);
      } else if (text !== previous) {
        for (const line of view.lines) ctx.out(line);
        ctx.out("");
      }
      previous = text;
      if (values["until-idle"] === true && view.idle) return;
      await wait(intervalS * 1000);
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
  }
}

// Restores the jobs whose run directory already says how they ended; a repair that cannot be written only warns.
function repairFromWitness(ctx) {
  const warning = repairWarningLine(ctx.env);
  if (warning) ctx.err(`warning: ${warning}`);
}

// Prints `queue status`, for one job or for the tail of the queue, and tells whether it answered in json.
async function printStatus(argv, ctx) {
  const { values, positionals } = parseCommand(normalizeFollowArgv(argv), STATUS_OPTIONS);
  checkArgs(positionals, { max: 1, usage: USAGE.status });
  repairFromWitness(ctx);
  const intervalS = values.follow === undefined ? null : Math.max(1, requireInt("--follow", values.follow));
  if (intervalS !== null && values.json) throw new UserError(`\`--follow\` cannot be used with \`--json\`; usage: ${USAGE.status}`);
  if (intervalS !== null && positionals.length) throw new UserError(`\`--follow\` shows the whole queue, not one job; usage: ${USAGE.status}`);
  if (positionals.length === 1) {
    const id = requireInt("id", positionals[0]);
    sweepMerged(ctx);
    const job = jobView(getJob(id, ctx.env));
    if (!job) throw new UserError(`unknown job \`${id}\``);
    if (values.json) ctx.out(JSON.stringify({ job }));
    else for (const line of formatDetail(job)) ctx.out(line);
    return values.json === true;
  }
  if (values.json) {
    sweepMerged(ctx);
    const jobs = listJobs({ limit: requireInt("--limit", values.limit) }, ctx.env).map(jobView);
    ctx.out(JSON.stringify({ runner: runnerView(runnerPidfileState(ctx.env, ctx.killImpl)), jobs, counts: countsByStatus(ctx.env) }));
    return true;
  }
  if (intervalS !== null) {
    await followStatus(values, intervalS, ctx);
    return true;
  }
  for (const line of queueViewLines(values, ctx).lines) ctx.out(line);
  return false;
}

// Runs `queue status` and closes the text output with the update notice, which the json output and the follow never carry.
async function runStatus(argv, ctx) {
  if (await printStatus(argv, ctx)) return;
  const notice = await updateNoticeLine({ env: ctx.env, fetchImpl: ctx.fetchImpl });
  if (notice) ctx.out(notice);
}

// Report lines of `queue run --dry`, the cycle that only reads.
function formatDry(report) {
  return [
    `paused          ${report.paused}`,
    `cap             ${report.cap}`,
    `heartbeat       ${report.heartbeatS}s`,
    `active          ${report.active}`,
    `next            ${report.next ?? "-"}`,
    Object.entries(report.counts)
      .map(([status, total]) => `${status}=${total}`)
      .join("  "),
  ];
}

// Report line of one processed job, with only the fields the operator may read.
function formatProcessed(job) {
  const details = [job.code, job.prUrl, job.error].filter(Boolean);
  return `job #${job.id} ${job.status}${details.map((detail) => ` ${detail}`).join("")}`;
}

// One line of report for each job the cycle processed.
function printCycle(cycle, ctx) {
  for (const job of cycle.processed) ctx.out(formatProcessed(job));
  if (!cycle.processed.length) ctx.out(`queue: nothing to run (${cycle.reason})`);
}

const RUN_OPTIONS = {
  job: { type: "string" },
  max: { type: "string" },
  watch: { type: "string" },
  dry: { type: "boolean" },
  json: { type: "boolean" },
  foreground: { type: "boolean" },
  stop: { type: "boolean" },
  drain: { type: "boolean" },
};

// Refuses `--stop` next to any other option: ending the runner reads nothing else of the command line.
function checkStopAlone(values) {
  const others = Object.keys(values).filter((name) => name !== "stop");
  if (others.length) throw new UserError(`\`--stop\` takes no other option; usage: ${USAGE.run}`);
}

// Refuses `--job` next to `--watch`: running one job and watching the whole queue are opposite intents.
function checkJobNotWatched(values) {
  if (values.job !== undefined && values.watch !== undefined) {
    throw new UserError(`\`--job\` and \`--watch\` cannot be used together; usage: ${USAGE.run}`);
  }
}

// What the operator reads after a stop, and the exit code it answers with: only a runner that refuses to die fails.
function stopReport({ outcome, pid }) {
  if (outcome === "absent") return { line: "runner is not running", code: 0 };
  if (outcome === "stale") return { line: "runner was not running (stale pidfile removed)", code: 0 };
  if (outcome === "stopped") return { line: `runner stopped (pid ${pid})`, code: 0 };
  const seconds = STOP_TIMEOUT_MS / 1000;
  return { line: `runner (pid ${pid}) did not stop within ${seconds}s; it finishes the job it is running and exits by itself`, code: 1 };
}

// Runs `queue run --stop`, which ends the watcher registered in the pidfile.
async function runStop(ctx) {
  const report = stopReport(await stopRunner({ env: ctx.env, killImpl: ctx.killImpl }));
  ctx.out(report.line);
  return report.code;
}

// Runs the drain loop in this process, as the registered runner of the queue.
async function runDrainHere({ max }, ctx) {
  return await runGuardedHere({
    ctx,
    run: () => runDrain({ max, env: ctx.env, onCycle: (cycle) => printCycle(cycle, ctx) }).then(() => 0),
  });
}

// Runs the watch loop in this process, as the registered runner of the queue.
async function runWatchHere({ intervalS, jobId, max }, ctx) {
  return await runGuardedHere({
    jobId,
    watchIntervalS: intervalS,
    ctx,
    run: () => runWatch({ intervalS, jobId, max, env: ctx.env, onCycle: (cycle) => printCycle(cycle, ctx) }).then(() => 0),
  });
}

// Runs one cycle over the queue in this process and reports it, as text or as the json a script reads.
async function runCycleHere({ jobId, max, json }, ctx) {
  const cycle = await runCycle({ jobId, max, env: ctx.env });
  if (json) ctx.out(JSON.stringify(cycle));
  else printCycle(cycle, ctx);
  return 0;
}

// Runs `queue run`: it starts the runner detached unless `--foreground`, `--dry` or `--stop` says otherwise.
async function runRun(argv, ctx) {
  const { values, positionals } = parseCommand(normalizeWatchArgv(argv), RUN_OPTIONS);
  checkArgs(positionals, { max: 0, usage: USAGE.run });
  if (values.stop === true) {
    checkStopAlone(values);
    return await runStop(ctx);
  }
  checkJobNotWatched(values);
  const jobId = requireInt("--job", values.job) ?? null;
  const max = requireInt("--max", values.max) ?? null;
  if (values.dry) {
    const report = await runCycle({ jobId, max, dry: true, env: ctx.env });
    if (values.json) ctx.out(JSON.stringify(report));
    else for (const line of formatDry(report)) ctx.out(line);
    return;
  }
  const intervalS = values.watch === undefined ? null : requireInt("--watch", values.watch);
  if (values.foreground !== true) return await startDetached({ jobId, max, watchIntervalS: intervalS }, ctx);
  if (intervalS !== null) return await runWatchHere({ intervalS, jobId, max }, ctx);
  if (values.drain === true && jobId === null) return await runDrainHere({ max }, ctx);
  return await runGuardedHere({ jobId, ctx, run: () => runCycleHere({ jobId, max, json: values.json === true }, ctx) });
}

// Runs `queue cancel`, which refuses without writing when the job is running under a live lease.
async function runCancel(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { reason: { type: "string" }, json: { type: "boolean" } });
  checkArgs(positionals, { min: 1, usage: USAGE.cancel });
  const job = cancelJob(requireInt("id", positionals[0]), { reason: values.reason }, ctx.env);
  ctx.out(values.json ? JSON.stringify({ job }) : `cancelled job #${job.id}`);
}

// Reports what happened to the run directory of a `--fresh` retry: a directory that was kept says why, and never brings the retry down.
function reportRunDir(discarded, ctx) {
  if (!discarded || discarded.status !== "kept") return;
  ctx.out(`run directory kept (${discarded.reason}): ${discarded.dir ?? "no safe path"}`);
}

// Runs `queue retry`, which sends a gated, failed or cancelled job back to the queue; a gated one only moves with a note.
async function runRetry(argv, ctx) {
  const { values, positionals } = parseCommand(argv, {
    note: { type: "string" },
    fresh: { type: "boolean" },
    run: { type: "boolean" },
    foreground: { type: "boolean" },
    json: { type: "boolean" },
  });
  checkArgs(positionals, { min: 1, usage: USAGE.retry });
  checkForegroundNeedsRun(values, USAGE.retry);
  const { job, runDir } = applyRetry({
    id: requireInt("id", positionals[0]),
    note: values.note,
    fresh: values.fresh === true,
    env: ctx.env,
  });
  if (values.json) ctx.out(JSON.stringify({ job }));
  else ctx.out(`job #${job.id} is pending again${values.fresh === true ? ", starting from phase 0" : ""}`);
  reportRunDir(runDir, ctx);
  return values.run === true ? await runNow(job, values, ctx) : 0;
}

// Runs `queue pause`, which stops new claims without touching any job.
async function runPause(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { max: 0, usage: USAGE.pause });
  ensureHome(ctx.env);
  writeFileAtomic(queuePausedPath(ctx.env), `${new Date().toISOString()}\n`);
  ctx.out("queue paused; running jobs finish normally");
}

// Runs `queue resume`, which removes the pause sentinel.
async function runResume(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { max: 0, usage: USAGE.resume });
  rmSync(queuePausedPath(ctx.env), { force: true });
  ctx.out("queue resumed");
}

// Runs a read of the log file, turning an I/O failure into a message for the operator instead of a stack.
function readingLog(path, read) {
  try {
    return read();
  } catch (err) {
    throw new UserError(`could not read the log at ${path}: ${err?.message ?? String(err)}`);
  }
}

// Prints the part of the file after the given offset and returns the new offset.
function printFrom(path, offset, ctx) {
  const size = statSync(path).size;
  const from = size < offset ? 0 : offset;
  if (size <= from) return size;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    ctx.out(buffer.toString("utf8").replace(/\n$/, ""));
    return size;
  } finally {
    closeSync(fd);
  }
}

// Tells whether the narration may paint its lines: only a real terminal, and never with NO_COLOR set.
function useColor(ctx) {
  return ctx.stdout?.isTTY === true && !ctx.env?.NO_COLOR;
}

// Reads the status of a job for the follow loop; a job whose row is gone has no status at all.
// Each poll opens its own read-only connection and closes it: a follow lives for hours, and a cached connection
// can sit on a WAL read snapshot and keep answering `running` long after the runner wrote `done`.
function jobStatusReader(id, env) {
  return () => {
    const db = openDbReadOnly(env);
    try {
      return db.prepare("SELECT status FROM jobs WHERE id = ?").get(id)?.status ?? null;
    } finally {
      db.close();
    }
  };
}

// Watches the output of the process, so a closed pipe ends the follow instead of crashing it.
function watchOutputClosed(ctx) {
  let closed = false;
  ctx.stdout?.on?.("error", () => {
    closed = true;
  });
  return () => (closed ? "output closed" : null);
}

// Traces every poll of the follow on stderr, the hook that captures a stream that went quiet in the wild.
function pollTracer(ctx) {
  if (ctx.env?.NIGHTSHIFT_FOLLOW_DEBUG !== "1") return null;
  return (notice) => ctx.err(`follow: t=${notice.at} size=${notice.size} offset=${notice.offset} lines=${notice.lines}`);
}

// Reports why a follow that did not end on a clean outcome of the job stopped, without changing the exit code.
function reportStop(result, ctx) {
  if (!result.status || result.logError) ctx.err(`queue log stopped: ${result.reason}`);
}

// Runs `queue log --raw`, which prints the stream exactly as it was written, byte for byte.
async function runLogRaw(path, id, follow, ctx) {
  const offset = readingLog(path, () => printFrom(path, 0, ctx));
  if (!follow) return;
  const trace = pollTracer(ctx);
  const result = await followLog(
    {
      path,
      offset,
      readStatus: jobStatusReader(id, ctx.env),
      stopReason: watchOutputClosed(ctx),
      onLine: (line) => ctx.out(line),
      onNotice: (notice) => {
        if (notice.kind === "poll") trace?.(notice);
        if (notice.kind === "error") ctx.err(notice.message);
        if (notice.kind === "truncated") ctx.err("log truncated; following it from the start");
      },
    },
    { quietMs: 0 },
  );
  if (result.status) ctx.err(`job #${id} ${result.status}`);
  reportStop(result, ctx);
}

// Turns a notice of the follow loop into a narration line, a warning on stderr, or the debug trace of one poll.
function narrateNotice(notice, { narrator, print, trace, warn }) {
  if (notice.kind === "poll") trace?.(notice);
  if (notice.kind === "error") warn(notice.message);
  if (notice.kind === "truncated") print(narrator.note("truncated", "log truncated; narration restarted"));
  if (notice.kind === "quiet") print(narrator.note("quiet", `still running (${Math.round(notice.silentMs / 1000)}s quiet)`));
}

// Prints the reason the job is stopped when the stream itself never carried one, so a gate is never narrated in silence.
function printJobNotice(id, { narrator, print, sawNotice }, ctx) {
  if (sawNotice()) return;
  const notice = jobView(getJob(id, ctx.env))?.notice_md;
  if (!notice) return;
  print(narrator.note("notice", noticeNarration(notice)));
}

// Runs `queue log` in narrated mode, the default: one line for each relevant event of the stream.
async function runLogNarrated(path, id, { follow, all }, ctx) {
  const color = useColor(ctx);
  let seen = false;
  const print = (event) => {
    if (event.kind === "notice") seen = true;
    ctx.out(formatNarration(event, { color }));
  };
  const narrator = createNarrator({ all });
  const tail = { narrator, print, sawNotice: () => seen };
  if (!follow) {
    const text = readingLog(path, () => readFileSync(path, "utf8"));
    const running = getJob(id, ctx.env)?.status === "running";
    for (const event of narrateLog(text, { all, running })) print(event);
    printJobNotice(id, tail, ctx);
    return;
  }
  const trace = pollTracer(ctx);
  const result = await followLog({
    path,
    readStatus: jobStatusReader(id, ctx.env),
    stopReason: watchOutputClosed(ctx),
    onLine: (line) => {
      for (const event of narrator.push(line)) print(event);
    },
    onNotice: (notice) => narrateNotice(notice, { narrator, print, trace, warn: (message) => ctx.err(message) }),
  });
  for (const event of narrator.finish()) print(event);
  if (result.logError) print(narrator.note("toolError", `${result.logError}; this narration is missing the tail of the log`));
  printJobNotice(id, tail, ctx);
  if (result.status) print(narrator.note("resultEnd", `job #${id} ${result.status}`));
  reportStop(result, ctx);
}

// Runs `queue log`, which narrates the stream of a job by default and can keep following it.
async function runLog(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { follow: { type: "boolean" }, raw: { type: "boolean" }, all: { type: "boolean" } });
  checkArgs(positionals, { min: 1, usage: USAGE.log });
  const id = requireInt("id", positionals[0]);
  if (values.raw && values.all) throw new UserError("`--all` has no meaning with `--raw`; the raw stream already carries every event");
  const path = jobLogPath(id, ctx.env);
  if (!existsSync(path)) throw new UserError(`no log for job \`${id}\`; expected ${path}`);
  const follow = values.follow === true;
  if (values.raw) return await runLogRaw(path, id, follow, ctx);
  return await runLogNarrated(path, id, { follow, all: values.all === true }, ctx);
}

const SUBCOMMANDS = new Map([
  ["add", runAdd],
  ["status", runStatus],
  ["run", runRun],
  ["cancel", runCancel],
  ["retry", runRetry],
  ["pause", runPause],
  ["resume", runResume],
  ["log", runLog],
]);

// Dispatches the subcommands of `nightshift queue`, returning the exit code the subcommand decided.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown queue subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  return await handler(rest, ctx);
}
