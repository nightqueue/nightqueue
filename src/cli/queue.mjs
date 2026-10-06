import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { jobLogPath } from "../config/paths.mjs";
import { registrationOffer, issueQueueTarget } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { launchOperator, operatorPrompt } from "../host/operator.mjs";
import { updateNoticeLine } from "../host/update-notice.mjs";
import { JOB_STATUSES, jobView, truncateByCodePoint } from "../memory/jobs.mjs";
import { ALL_PROJECTS } from "../memory/issues.mjs";
import { ensureStoreExists, openStore, openStoreReadOnly, withReadOnlyStore } from "../store/open.mjs";
import { startAdvisoryLines } from "../queue/advisory.mjs";
import { followLog } from "../queue/follow.mjs";
import { blockedOf, formatTokens, lastCell } from "../queue/last-cell.mjs";
import { jobStatusReader, narrateJob, readingLog } from "../queue/narrated-tail.mjs";
import { pauseQueue, resumeQueue } from "../queue/pause.mjs";
import {
  claimingRunners,
  isQueueIdle,
  noRunnerWait,
  onceOnlyLine,
  parkedBacklogLine,
  pausedRunnerLine,
  pendingJobs,
  runnerPauseLabel,
  runnersOnline,
  windowCadenceLabel,
  windowClosedLine,
  windowWaitingLine,
} from "../queue/hints.mjs";
import { formatDuration, formatNarration } from "../queue/narrate.mjs";
import { blockerLines, claimBlocker } from "../queue/claim.mjs";
import { worktreeLine } from "../queue/close.mjs";
import { cancelJobAndWorktree } from "../queue/cancel.mjs";
import { closeMerged, CLOSE_MERGED_DEADLINE_MS } from "../queue/close-merged.mjs";
import { runMaintenance } from "../queue/maintenance.mjs";
import { jobIdOfPrUrl } from "../queue/pr-lookup.mjs";
import { createPrStateCache } from "../queue/pr-state.mjs";
import { closeSuggestion, failedCoreSection, jobDetailView, prUrlsOf, queueView, truncationSuggestion } from "../queue/view.mjs";
import {
  liveRunnersReport,
  removeOwnRunnerRecord,
  stampRunnerDbWitness,
} from "../queue/registry.mjs";
import { logOnlyTail } from "../queue/lost-rows.mjs";
import { reclassifyFromLog, recoverFromDisk, replayPending } from "../queue/repair.mjs";
import { applyRetry, callerJobId } from "../queue/retry.mjs";
import { runCycle, runDrain, runWatch, WATCH_INTERVAL_DEFAULT_S } from "../queue/runner.mjs";
import { resolveJobSession } from "../queue/session.mjs";
import { stopReport, stopRunners } from "../queue/stop.mjs";
import { runCloseHere, runPostCloseSteps, startCloseDetached } from "../queue/close-start.mjs";
import { CLOSE_FAILED_LABEL, CLOSE_STALLED_LABEL, CLOSE_STEP_ICONS, CLOSING_LABEL, closeChecklistLines, closeStoppedLine, queueWorkers, statusLabel } from "../queue/close-view.mjs";
import { registerForegroundRunner, runnerMode, startQueueRunner } from "../queue/start.mjs";
import { parseWallClock } from "../queue/window.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { keyOption, registerProject } from "./project.mjs";
import { confirm } from "./prompt.mjs";
import { runtimeLabel } from "./runtime-versions.mjs";
import { itemRef, jobRef, parseJobRef } from "../memory/refs.mjs";
import { coverageLabel, jobOriginCoverage } from "../integrations/coverage.mjs";
import { originLabel } from "../integrations/origin.mjs";

export const USAGE = {
  add: "nightqueue queue add [project] <prompt...> [--project <name>] [--run] [--foreground] [--priority <n>] [--max-attempts <n>] [--timeout <s>] [--yes] [--key <KEY>] [--tier <trivial|simple|complex>] [--origin <kind>:<ref>] [--issue <ref> [--project <name|all>] [<note...>]]",
  status: "nightqueue queue status [J-<id>|<id>|<PR URL>] [--limit <n>] [--json] [--follow [seconds]] [--until-idle] [--blocked]",
  run: "nightqueue queue run [--job <id> | --watch [seconds] [--from HH:MM] --until HH:MM] [--max <jobs>] [--stop] [--foreground] [--dry] [--json]",
  cancel: "nightqueue queue cancel <id> [--reason <text>] [--json]",
  close: "nightqueue queue close <id> [--force] [--foreground] [--json], nightqueue queue close <id> --steps origin,log [--again] [--json], or nightqueue queue close --merged [--json]",
  retry: "nightqueue queue retry <id> [--note <text>] [--fresh] [--run] [--foreground]",
  repair: "nightqueue queue repair [<id>] [--from-disk] [--json]",
  pause: "nightqueue queue pause",
  resume: "nightqueue queue resume",
  log: "nightqueue queue log <id> [--follow] [--raw] [--all]",
  session: "nightqueue queue session <id> [--print] [--json] [--prompt <text>]",
};

const ADD_HELP_FLAGS = new Set(["--help", "-h"]);

const PROJECT_NAMED_TWICE = "name the project once: the positional `[project]` or `--project <name>`, never both";

const ADD_HELP = `usage: ${USAGE.add}

One job is one self-contained deliverable that can be reviewed and merged on its own. Large work is ONE job
with numbered stages written in the prompt — never several jobs that depend on each other. A job that needs
another job's pull request merged first is cut wrong: fold it into that job. Independent jobs may run in
parallel and merge in any order.

example:
  nightqueue queue add "Self-contained install. Stages: 1) runtime under ~/.nightqueue; 2) shim + PATH prompt; 3) embedding opt-in; 4) rename bin to ns. Each stage verified before the next; one PR."`;

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
  return new UserError(`no project registered for ${cwd}; run \`nightqueue init\` here, or pass the project NAME (\`nightqueue project list\`)`);
}

// The question `queue add` asks before it registers the repository of the current directory.
function registerQuestion(cwd, offer) {
  return `No project registered for ${cwd}. Register it as \`${offer.name}\` (key ${offer.key}) in org \`${offer.org}\` and queue the job? [Y/n] `;
}

// Tells whether the operator accepted the registration: `--yes` answers for a script, the terminal answers for a person.
async function wantsRegistration(offer, cwd, values, ctx) {
  if (values.yes === true) return true;
  return await confirm({ stdin: ctx.stdin, stdout: ctx.stdout, question: registerQuestion(cwd, offer) });
}

// Registers the repository of the current directory, taking the configuration lock `queue` never takes for itself.
async function registerFromCwd(offer, ctx) {
  return await withLock(ctx.env, () => registerProject(ctx, { path: offer.path, name: offer.name, key: offer.key }));
}

// Refuses to register a project from inside an unattended run: there is no user there to confirm it.
function refuseRegistrationInsideJob(cwd, env) {
  const own = callerJobId(env);
  if (own === null) return;
  throw new UserError(
    `refusing to register ${cwd} from inside job \`${own}\`: an unattended run never registers a project; ` +
      "pass the registered project NAME (`nightqueue project list`), or ask the operator to run `nightqueue init` there",
  );
}

// Offers to register the repository of the current directory, and answers the project it landed on.
async function offerRegistration({ store, config }, values, ctx) {
  const cwd = ctx.cwd ?? process.cwd();
  refuseRegistrationInsideJob(cwd, ctx.env);
  if (values.yes !== true && !ctx.stdin?.isTTY) throw unregisteredError(cwd);
  const suggested = await registrationOffer(store, config, cwd);
  if (!suggested) throw unregisteredError(cwd);
  const offer = { ...suggested, key: keyOption(values) ?? suggested.key };
  if (!(await wantsRegistration(offer, cwd, values, ctx))) throw unregisteredError(cwd);
  return await registerFromCwd(offer, ctx);
}

// The registered project with a checkout of that NAME, or null.
async function namedProject(store, name) {
  if (typeof name !== "string" || !name) return null;
  const project = await store.projects.byName(name);
  return project?.path ? project : null;
}

// Project `--project <name>` names, refusing an unknown one and the double spelling with the positional.
async function flaggedProject(store, positionals, values) {
  if (values.project === undefined) return null;
  if (await namedProject(store, positionals[0])) throw new UserError(PROJECT_NAMED_TWICE);
  const named = await namedProject(store, values.project);
  if (named) return named;
  throw new UserError(`unknown project \`${values.project}\`; run \`nightqueue project list\``);
}

// Chooses the project of the job: `--project`, the first positional when it is a registered NAME, otherwise the project of the current directory.
async function resolveTarget(config, positionals, values, ctx) {
  const store = openStore(ctx.env);
  const flagged = await flaggedProject(store, positionals, values);
  if (flagged) return { project: flagged, words: positionals, fromCwd: false };
  const named = await namedProject(store, positionals[0]);
  if (named) return { project: named, words: positionals.slice(1), fromCwd: false };
  const resolved = await store.projects.at(ctx.cwd ?? process.cwd());
  if (resolved) return { project: resolved, words: positionals, fromCwd: true };
  return { project: await offerRegistration({ store, config }, values, ctx), words: positionals, fromCwd: false };
}

// Echoes once the advisory lines of this home at the moment of a start, on stderr when stdout carries json.
async function echoAdvisories(ctx, { json = false } = {}) {
  const write = json ? ctx.err : ctx.out;
  for (const line of await startAdvisoryLines({ env: ctx.env, killImpl: ctx.killImpl })) write(line);
}

// Reports why a start would claim nothing and spawned nothing; a start nobody needed is not a failure.
async function reportWaiting(blocker, ctx) {
  for (const line of blockerLines(blocker, ctx.env)) ctx.out(line);
  await echoAdvisories(ctx);
  return 0;
}

// The line that tells the operator what started and how to follow it or stop it.
function startedLine({ jobId, pid, watchIntervalS, logPath }) {
  if (watchIntervalS !== null) return `runner started (pid ${pid}, every ${watchIntervalS} s) - stop with: nightqueue queue run --stop`;
  if (jobId !== null) return `${jobRef(jobId)} started (pid ${pid}) - follow with: nightqueue queue log ${jobRef(jobId)} --follow`;
  return `runner started (pid ${pid}) - draining the queue until nothing is pending; follow with: nightqueue queue status --follow (log: ${logPath})`;
}

// Starts the runner detached, with the prune and the registration inside one hold of the home lock, and says what happened.
async function startDetached({ jobId = null, max = null, watchIntervalS = null, from = null, until = null }, ctx) {
  const started = await startQueueRunner({
    jobId,
    max,
    watchIntervalS,
    from,
    until,
    env: ctx.env,
    spawnImpl: ctx.spawnImpl,
    killImpl: ctx.killImpl,
  });
  if (!started.started) return await reportWaiting(started.waiting, ctx);
  ctx.out(startedLine({ jobId, pid: started.pid, watchIntervalS, logPath: started.logPath }));
  await echoAdvisories(ctx);
  return 0;
}

// Runs the queue in THIS process as a registered runner; the connection is opened here so the registration can witness which shared-memory file this runner is attached to, and it never outlives the run.
async function runGuardedHere({ jobId = null, watchIntervalS = null, from = null, until = null, json, ctx, run }) {
  if (typeof json !== "boolean") throw new TypeError("runGuardedHere needs `json` (true or false) so the advisory echo never lands on the stdout of a --json run");
  const registered = await registerForegroundRunner({ jobId, watchIntervalS, from, until, env: ctx.env, killImpl: ctx.killImpl });
  try {
    await openStore(ctx.env).connect();
    await stampRunnerDbWitness(ctx.env);
    if (registered.self === true) await echoAdvisories(ctx, { json });
    return await run();
  } finally {
    removeOwnRunnerRecord(ctx.env);
  }
}

// Why the cycle of a single job claimed nothing, in the same words a detached start would have used.
async function notStartedLines(job, cycle, ctx) {
  const blocker = await claimBlocker({ jobId: job.id, mode: "once", env: ctx.env });
  return blocker ? blockerLines(blocker, ctx.env) : [`${jobRef(job.id)} did not start (${cycle.reason}); it stays in the queue`];
}

// Runs one job here and turns its outcome into the exit code: 0 only when it finished as `done`.
async function runJobHere(job, ctx) {
  ctx.out(`running ${jobRef(job.id)} in the foreground; follow the stream with \`nightqueue queue log ${jobRef(job.id)} --follow\``);
  const cycle = await runCycle({ jobId: job.id, max: 1, env: ctx.env });
  const processed = cycle.processed.find((entry) => entry.id === job.id);
  if (!processed) {
    for (const line of await notStartedLines(job, cycle, ctx)) ctx.out(line);
    return 1;
  }
  ctx.out(formatProcessed(processed));
  return processed.status === "done" ? 0 : 1;
}

// Takes the job through a runner in this process, unless a live runner already owns the queue.
async function runInForeground(job, { json }, ctx) {
  return await runGuardedHere({ jobId: job.id, json, ctx, run: () => runJobHere(job, ctx) });
}

// Takes the job the command just queued through the runner: in this process with `--foreground`, detached otherwise.
async function runNow(job, values, ctx) {
  if (values.foreground !== true) return await startDetached({ jobId: job.id }, ctx);
  return await runInForeground(job, { json: values.json === true }, ctx);
}

// Refuses `--foreground` on a command that was never asked to run the job.
function checkForegroundNeedsRun(values, usage) {
  if (values.foreground === true && values.run !== true) {
    throw new UserError(`\`--foreground\` only has meaning with \`--run\`; usage: ${usage}`);
  }
}

// The closing sentence of `queue add` when the job is not about to run: what happens to it given who is online right now.
function queuedRunnerLine(ctx, jobId) {
  const { runners, error } = liveRunnersReport(ctx.env, ctx.killImpl);
  if (error !== null) return "Start the batch: nightqueue queue run";
  const workers = queueWorkers(runners);
  const claimers = claimingRunners(workers, jobId);
  if (workers.length > 0 && claimers.length === 0) return `${onceOnlyLine(workers)}.`;
  if (claimers.length === 0) return `${noRunnerWait()}.`;
  return `${runnersOnline(claimers.length)} - it will be picked up.`;
}

// The line `queue add` answers with: the old confirmation when the job is about to run, the backlog nudge otherwise.
async function addedLine(job, willRun, ctx) {
  if (willRun) return `queued ${jobRef(job.id)} for project \`${job.project}\` (priority ${job.priority}, timeout ${job.timeoutS}s)`;
  const counts = await openStore(ctx.env).jobs.countsByStatus();
  return `queued ${jobRef(job.id)} for \`${job.project}\` (${counts.pending} pending). ${queuedRunnerLine(ctx, job.id)}`;
}

// The origin `--origin <kind>:<ref>` names, split on the first colon; undefined when the option is absent.
function originOption(value) {
  if (value === undefined) return undefined;
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) throw new UserError(`\`--origin\` expects <kind>:<ref>, got \`${value}\`; usage: ${USAGE.add}`);
  return { kind: value.slice(0, colon), ref: value.slice(colon + 1) };
}

// The knobs of a `queue add` that reach the job: priority, attempts, timeout, the operator's tier and the origin.
function addLimits(values) {
  return {
    priority: requireInt("--priority", values.priority),
    maxAttempts: requireInt("--max-attempts", values["max-attempts"]),
    timeoutS: requireInt("--timeout", values.timeout),
    tier: values.tier,
    origin: originOption(values.origin),
  };
}

// The line naming where a queued job came from and the connection covering it, or null when it has no origin.
async function originLine(job, ctx) {
  const coverage = await jobOriginCoverage({ origin: job.origin, projectId: job.projectId, store: openStore(ctx.env), env: ctx.env });
  return coverage ? `origin: ${coverageLabel(coverage)}` : null;
}

// Queues the job the words of the command line describe, with the project taken from them or from the current directory.
async function addFromPrompt(positionals, values, ctx) {
  if (positionals.join(" ").trim() === "") throw new UserError(`missing argument; usage: ${USAGE.add}`);
  const target = await resolveTarget(loadConfig(ctx.env, { warn: ctx.err }), positionals, values, ctx);
  const prompt = target.words.join(" ").trim();
  if (!prompt) throw new UserError(`missing argument; usage: ${USAGE.add}`);
  if (target.fromCwd) ctx.out(`project \`${target.project.name}\` resolved from the current directory`);
  return await openStore(ctx.env).jobs.addJob({ projectId: target.project.id, prompt, ...addLimits(values) });
}

// Refuses `--run` for an org item queued for `all`, because it starts one job and `all` fathers one per project.
function refuseRunForAll(values) {
  if (values.run === true && values.project === ALL_PROJECTS) {
    throw new UserError(`\`--run\` starts one job, and \`--project ${ALL_PROJECTS}\` queues one per project; queue them, then start the batch with \`nightqueue queue run\``);
  }
}

// The lines the issue path answers with: a project item is now `in_progress`; an org item names each project row its jobs went to and the ones skipped.
function issueQueuedLines({ item, jobs, skipped }) {
  if (item.scope !== "org") return [`issue ${itemRef(item)} of \`${item.project}\` is now \`in_progress\``];
  const lines = [
    `issue ${itemRef(item)} of org \`${item.org}\` queued for ${jobs.map((job) => `\`${job.project}\``).join(", ")}; its status is derived from its project rows`,
  ];
  for (const entry of skipped) lines.push(`skipped \`${entry.project}\`: ${jobRef(entry.job_id ?? "?")} (${entry.job_status ?? "unknown"}) still holds it`);
  return lines;
}

// Queues the job an issue builds; a project item owns its project, an org item needs `--project <name|all>`.
async function addFromIssue(positionals, values, ctx) {
  refuseRunForAll(values);
  const store = openStore(ctx.env);
  const id = await store.issues.itemIdOfRef(values.issue);
  const target = await issueQueueTarget(store, values.project);
  const queued = await store.issues.queueIssue({
    id,
    ...target,
    ...addLimits(values),
    operatorNote: positionals.join(" ").trim() || undefined,
  });
  for (const line of issueQueuedLines(queued)) ctx.out(line);
  return queued.jobs;
}

// Runs `queue add`, with the job built from the words of the command line or from the issue `--issue` names.
async function runAdd(argv, ctx) {
  if (argv.length === 1 && ADD_HELP_FLAGS.has(argv[0])) {
    ctx.out(ADD_HELP);
    return 0;
  }
  const { values, positionals } = parseAdd(argv);
  checkForegroundNeedsRun(values, USAGE.add);
  const jobs =
    values.issue === undefined
      ? [await addFromPrompt(positionals, values, ctx)]
      : await addFromIssue(positionals, values, ctx);
  const job = jobs[jobs.length - 1];
  for (const earlier of jobs.slice(0, -1)) ctx.out(`queued ${jobRef(earlier.id)} for \`${earlier.project}\``);
  ctx.out(await addedLine(job, values.run === true, ctx));
  const origin = await originLine(job, ctx);
  if (origin) ctx.out(origin);
  return values.run === true ? await runNow(job, values, ctx) : 0;
}

const RUN_DIR_RETIRED =
  "`--run-dir` was removed by D-58: operator runs no longer exist, so there is no run to bind; put what was found in the prompt or the issue's note";

const ADD_OPTIONS = {
  priority: { type: "string" },
  "max-attempts": { type: "string" },
  timeout: { type: "string" },
  run: { type: "boolean" },
  foreground: { type: "boolean" },
  yes: { type: "boolean" },
  issue: { type: "string" },
  "run-dir": { type: "string" },
  project: { type: "string" },
  tier: { type: "string" },
  key: { type: "string" },
  origin: { type: "string" },
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
  if (values["run-dir"] !== undefined) throw new UserError(RUN_DIR_RETIRED);
  if (values.issue === undefined) checkArgs(words, { min: 1, max: Number.POSITIVE_INFINITY, usage: USAGE.add });
  return { values, positionals: words };
}

const FOLLOW_INTERVAL_DEFAULT_S = 2;
const PR_PRIME_DEADLINE_MS = 5000;
const DEFAULT_WIDTH = 120;
const MIN_LAST_WIDTH = 20;

// Fixed columns of the table of `queue status`, in the order of the cockpit; TITLE/LAST takes whatever width is left and PR closes the row.
const COLUMNS = [
  { key: "id", title: "ID", width: 6 },
  { key: "status", title: "STATUS", width: 13 },
  { key: "duration", title: "DURATION", width: 10 },
  { key: "tokens", title: "TOKENS", width: 8 },
  { key: "project", title: "PROJECT", width: 22 },
];

// Icon and ANSI color of each status; the icon is always printed, the color only on a real terminal.
const STATUS_STYLE = {
  running: { icon: "●", color: "91" },
  done: { icon: "✓", color: "32" },
  gate: { icon: "⚑", color: "33" },
  failed: { icon: "✗", color: "31" },
  cancelled: { icon: "⊘", color: "2" },
  pending: { icon: "○", color: "2" },
  closed: { icon: "■", color: "38;5;91" },
};

// Style of a row whose status is not one this build knows: marked loud instead of blending in with the rest.
const UNKNOWN_STATUS_STYLE = { icon: "!", color: "97;41" };

// Style of a job a live close holds: neither done nor closed yet, so its own icon and color rather than either's.
const CLOSING_STYLE = { icon: "◐", color: "36" };

// The icon and color a status renders with: its own style, or the loud unknown one for a status outside the enum.
function statusStyleOf(status) {
  return JOB_STATUSES.includes(status) ? (STATUS_STYLE[status] ?? { icon: "·", color: null }) : UNKNOWN_STATUS_STYLE;
}

// Paints a text with an ANSI code, or leaves it alone when color is off.
function paint(text, code, color) {
  return color && code ? `\u001b[${code}m${text}\u001b[0m` : text;
}

// Width of the terminal the table is drawn on, with a sane default when nobody knows.
function terminalWidth(ctx) {
  const columns = ctx.stdout?.columns;
  return Number.isInteger(columns) && columns > 40 ? columns : DEFAULT_WIDTH;
}

// Width left for TITLE/LAST once the fixed columns and PR took theirs; never below the minimum, so a narrow terminal still shows something.
function lastWidth(ctx, pr, columns) {
  const fixed = columns.reduce((total, column) => total + column.width, 0) + pr + 1;
  return Math.max(MIN_LAST_WIDTH, terminalWidth(ctx) - fixed);
}

// The fixed columns of this listing: STATUS grows past its width only when a status label needs it, so a listing of short labels renders as before.
function columnsFor(jobs, nowMs) {
  const statusCell = jobs.reduce((width, job) => Math.max(width, statusCellOf(job, nowMs).length + 1), 0);
  return COLUMNS.map((column) => (column.key === "status" ? { ...column, width: Math.max(column.width, statusCell) } : column));
}

// The style a row renders with: the failed one for a failed close, the closing one for a live or stalled close, its status's otherwise.
function rowStyleOf(job, nowMs) {
  const label = statusLabel(job, nowMs);
  if (label === CLOSE_FAILED_LABEL) return statusStyleOf("failed");
  return label === CLOSING_LABEL || label === CLOSE_STALLED_LABEL ? CLOSING_STYLE : statusStyleOf(job.status);
}

// The STATUS cell of a job: the icon of its row style and the label the close view gives it.
function statusCellOf(job, nowMs) {
  return `${rowStyleOf(job, nowMs).icon} ${statusLabel(job, nowMs)}`;
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

// The pull request of a job as its plain URL plus its derived state: terminals turn a bare URL into a link on their own, which an escape sequence cannot count on.
function formatPr(job) {
  if (!job.pr_url) return "-";
  return job.pr_state ? `${job.pr_url} (${job.pr_state})` : String(job.pr_url);
}

// Width of the PR column for this listing: the longest URL present, never less than the header.
function prWidth(jobs) {
  return jobs.reduce((width, job) => Math.max(width, formatPr(job).length), "PR".length);
}

// Cells of one row of the table, before any cut or paint.
function rowCells(job, nowMs) {
  return {
    id: jobRef(job.id),
    status: statusCellOf(job, nowMs),
    duration: formatDurationCell(job, nowMs),
    tokens: formatTokens(job),
    project: String(job.project),
    last: lastCell(job),
  };
}

// One row of the table: fixed columns padded to their width, TITLE/LAST cut to what is left, the status painted on a terminal.
function formatRow(job, { nowMs, width, color, columns }) {
  const cells = rowCells(job, nowMs);
  const fixed = columns.map((column) => {
    const cell = fit(cells[column.key], column.width - 1).padEnd(column.width);
    return column.key === "status" ? paint(cell, rowStyleOf(job, nowMs).color, color) : cell;
  });
  const last = fit(cells.last, width - 1).padEnd(width);
  return `${fixed.join("")}${last}${formatPr(job)}`.trimEnd();
}

// Header of the table and the rule under it, dimmed on a terminal.
function formatHeader({ width, color, columns }) {
  const titles = `${columns.map((column) => column.title.padEnd(column.width)).join("")}${"TITLE/LAST".padEnd(width)}PR`;
  return [paint(titles, "2", color), paint("─".repeat(titles.length), "2", color)];
}
// The whole table: header, one row per job, nothing else.
function formatTable(jobs, ctx) {
  const nowMs = Date.now();
  const columns = columnsFor(jobs, nowMs);
  const layout = { nowMs, width: lastWidth(ctx, prWidth(jobs), columns), color: useColor(ctx), columns };
  return [...formatHeader(layout), ...jobs.map((job) => formatRow(job, layout))];
}

// The notice of a job, printed under its own line and indented, plus the way to answer it while the job waits at the gate.
function formatNotice(job) {
  if (!job.notice_md) return [];
  const body = String(job.notice_md).split("\n").map((line) => `  ${line}`);
  return ["notice", ...body, ...gateAnswer(job)];
}

// The way to answer a gated job: a preflight block needs only its cause fixed, any other gate needs the operator's answer.
function gateAnswer(job) {
  if (job.status !== "gate") return [];
  if (blockedOf(job)) return [`retry it with: nightqueue queue retry ${jobRef(job.id)}`];
  return [`retry it with: nightqueue queue retry ${jobRef(job.id)} --note "<your answer>"`];
}

// The run's OWN notice, read fresh from its log, printed under its own line whenever it differs from the row's `notice_md`.
function formatRunNotice(job) {
  if (!job.run_notice) return [];
  const body = String(job.run_notice).split("\n").map((line) => `  ${line}`);
  return ["run_notice", ...body];
}

// The block a gated job is stopped on, readable: the code alone, or with its message when one is still on the result.
function formatBlocked(job) {
  const blocked = blockedOf(job);
  if (!blocked) return [];
  const label = blocked.message ? `${blocked.code}: ${blocked.message}` : blocked.code;
  return [`${"blocked".padEnd(16)}${label}`];
}

// The whole live block of a running job, one field per line; nothing for a job that has none.
function formatLive(job) {
  if (!job.live) return [];
  return ["live", ...Object.entries(job.live).map(([key, value]) => `  ${key.padEnd(16)} ${value !== null && typeof value === "object" ? JSON.stringify(value) : value}`)];
}

// The fields the detail view prints as blocks of their own instead of one key/value line.
const DETAIL_BLOCK_KEYS = new Set(["notice_md", "run_notice", "close", "live"]);

// The text one detail field prints: the origin as `<kind> <ref>`, any other value as it is.
function detailValue(key, value) {
  return key === "origin" ? originLabel(value) : value;
}

// Detail block of a single job, one field per line, with the reason it stopped spelled out instead of dumped on one line.
function formatDetail(job) {
  const fields = Object.entries(job)
    .filter(([key, value]) => !DETAIL_BLOCK_KEYS.has(key) && value !== null && value !== undefined)
    .map(([key, value]) => `${key.padEnd(15)} ${detailValue(key, value)}`);
  const at = fields.findIndex((line) => line.startsWith("status".padEnd(16)));
  const suggestion = closeSuggestion([job]);
  const extra = [
    ...closeChecklistLines(job),
    ...formatBlocked(job),
    ...formatLive(job),
    ...(suggestion ? [suggestion] : []),
    ...formatNotice(job),
    ...formatRunNotice(job),
  ];
  return at < 0 ? [...fields, ...extra] : [...fields.slice(0, at + 1), ...extra, ...fields.slice(at + 1)];
}

// What the registered runner does: how often it looks at the queue, or the single job it was started for.
function runnerCadence(runner) {
  if (runner.mode === "watch") {
    const window = windowCadenceLabel(runner.window);
    return `watch every ${runner.intervalS} s${window ? ` · ${window}` : ""}`;
  }
  if (runner.mode === "once") return runner.jobId === null ? "once" : `once, ${jobRef(runner.jobId)}`;
  if (runner.mode === "close") return `close, ${jobRef(runner.jobId)}`;
  return `${runner.mode ?? "runner"}`;
}

// The `runner:` line of one registered runner, with the cadence it works the queue at and the tree it loaded from;
// a runner waiting out a rate limit leads with the wait, because that is the whole reason nothing is moving.
function formatRunner(runner, env = process.env) {
  const label = runtimeLabel(runner.runtimeDir, env);
  const runtime = label ? `, runtime ${label}` : "";
  const foreground = runner.detached === false ? ", foreground" : "";
  const state = runnerPauseLabel(runner) ?? "running";
  return `runner: ${state} (pid ${runner.pid}, ${runnerCadence(runner)}${foreground}${runtime}, since ${runner.startedAt})`;
}

// What `queue status` opens with: the live-runner count first, then one line per live runner, or the state of a queue nobody is working.
function formatRunners(runners, activeJobs = 0, env = process.env) {
  if (runners.length) return [runnersOnline(runners.length), ...runners.map((runner) => formatRunner(runner, env))];
  if (activeJobs > 0) {
    return [`${runnersOnline(0)} - ${pendingJobs(activeJobs).replace("pending", "running")} under a one-shot runner - nothing will pick up the pending jobs after it (start a drain with: nightqueue queue run)`];
  }
  return [noRunnerWait()];
}

// The backlog line of the jobs a preflight block gated: their codes and the retry that sends each one back once fixed.
function blockedBacklogLine(gated) {
  const codes = [...new Set(gated.map((job) => blockedOf(job).code))].join(", ");
  const refs = gated.map((job) => jobRef(job.id)).join(" / ");
  return `${gated.length} job${gated.length === 1 ? "" : "s"} blocked (${codes}) - fix the cause, then: nightqueue queue retry ${refs}`;
}

// The line `queue status` closes with when a backlog is sitting there with nobody working it, when the preflight gated a
// job, or when a rate limit holds the queue - whether a live runner is waiting it out or the backlog was parked by a
// runner that has since exited, starting another one then would only put it to sleep too.
function backlogLine({ activeJobs, counts, runners, jobs = [] }) {
  const gated = jobs.filter(blockedOf);
  if (gated.length) return blockedBacklogLine(gated);
  if (counts.pending === 0) return null;
  const paused = pausedRunnerLine(runners);
  if (paused) return `${pendingJobs(counts.pending)} waiting - ${paused}`;
  const waiting = windowWaitingLine(runners);
  if (waiting) return `${pendingJobs(counts.pending)} waiting - ${waiting}`;
  if (!isQueueIdle({ activeJobs, runners: queueWorkers(runners) })) return null;
  const parked = parkedBacklogLine({ jobs, pending: counts.pending });
  if (parked) return `${pendingJobs(counts.pending)} waiting - ${parked}`;
  return `${pendingJobs(counts.pending)} waiting - start the batch: nightqueue queue run`;
}

const STATUS_OPTIONS = {
  json: { type: "boolean" },
  limit: { type: "string" },
  follow: { type: "string" },
  "until-idle": { type: "boolean" },
  blocked: { type: "boolean" },
};

// Gives `--follow` its default interval when the operator wrote it without one, the same way `run --watch` does.
function normalizeFollowArgv(argv) {
  return argv.flatMap((token, index) =>
    token === "--follow" && !isPositiveIntToken(argv[index + 1]) ? [`--follow=${FOLLOW_INTERVAL_DEFAULT_S}`] : [token],
  );
}

// The `runner:` line of a home whose registry could not be listed: nothing is known about the runners, least of all that none is live.
function unreadableRegistryLine(error) {
  return `runner: unknown - the runner registry cannot be listed (${error}), a runner may be live; run \`nightqueue doctor\``;
}

// The counts-by-status line, breaking out how many of the gated jobs a preflight block stopped.
function countsLine(counts, blockedGates) {
  return Object.entries(counts)
    .map(([status, total]) => (status === "gate" && blockedGates > 0 ? `gate=${total} (${blockedGates} blocked)` : `${status}=${total}`))
    .join("  ");
}

// The line printed in place of the table when the listing is empty; `--blocked` filters the queue, so an empty result
// under it never means the queue itself is empty.
function emptyQueueLine(blockedOnly) {
  return blockedOnly ? "no blocked job in the queue" : "no jobs in the queue";
}

// Lines of a queue view, pure formatting: the runner lines, the advisory lines, table, counts, the suggestions (minus the text-cut one, since the table clips by width) and the backlog hint, in that order.
function renderQueueView(view, ctx, { blockedOnly = false } = {}) {
  const readable = view.registryError === null;
  const lines = readable ? formatRunners(view.runners, view.activeJobs, ctx.env) : [unreadableRegistryLine(view.registryError)];
  lines.push(...view.advisories, ...unreadSectionLines(view));
  if (!sectionOk(view, "jobs")) return lines;
  if (!view.jobs.length) return [...lines, emptyQueueLine(blockedOnly)];
  lines.push(...formatTable(view.jobs, ctx));
  const truncation = truncationSuggestion(view.jobs);
  const suggestions = view.suggestions.filter((line) => line !== truncation);
  if (!sectionOk(view, "counts")) return [...lines, ...suggestions];
  lines.push(countsLine(view.counts, view.blockedGates), ...suggestions);
  const backlog = readable ? backlogLine({ activeJobs: view.activeJobs, counts: view.counts, runners: view.runners, jobs: view.jobs }) : null;
  if (backlog) lines.push(backlog);
  return lines;
}

// Whether one section of a view was read.
function sectionOk(view, name) {
  return view.sections?.find((section) => section.name === name)?.ok !== false;
}

// One stable line per core section the view could not read, so a pipe still only prints what changed.
function unreadSectionLines(view) {
  return (view.sections ?? [])
    .filter((section) => (section.name === "jobs" || section.name === "counts") && !section.ok)
    .map((section) => `${section.name}: cannot be read (${section.error})`);
}

// How long apart two frames really started, as the footer writes it, or `-` for the first one.
function formatAchieved(ms) {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "-";
}

// The footer of a follow frame: the cadence it achieved against the one asked, and what each section of the read cost.
function cadenceFooter({ achievedMs, intervalS, readMs, sections }) {
  const parts = sections.map((section) => (section.ok ? `${section.name} ${section.ms}ms` : `${section.name} error (${section.error})`));
  return `achieved every ${formatAchieved(achievedMs)} (asked ${intervalS}s) · read ${Math.round(readMs)}ms: ${parts.join(", ")} · Ctrl-C to stop`;
}

// What a listing reads: the `--limit` and `--blocked` of the command line.
function listingOptions(values) {
  return { limit: requireInt("--limit", values.limit), blockedOnly: values.blocked === true };
}

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CLEAR_BELOW = "\u001b[0J";
// Autowrap goes off while a frame is written: a double-width character (⛔, ⏸, CJK in a slug) then never wraps a row, which would make the next climb fall short.
const WRAP_OFF = "\u001b[?7l";
const WRAP_ON = "\u001b[?7h";
const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[A-Za-z]/y;

// Cuts a painted line to a number of visible columns, letting the ANSI codes through, so a line never wraps and the row count of a frame stays exact.
function clipAnsi(line, width) {
  if ([...stripAnsi(line)].length <= width) return line;
  let visible = 0;
  let result = "";
  let index = 0;
  while (visible < width - 1) {
    ANSI_SEQUENCE.lastIndex = index;
    const sequence = ANSI_SEQUENCE.exec(line);
    const piece = sequence ? sequence[0] : String.fromCodePoint(line.codePointAt(index));
    if (!sequence) visible += 1;
    result += piece;
    index += piece.length;
  }
  return `${result}…\u001b[0m`;
}

// A text without its ANSI codes.
function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

// The rows of a frame as the terminal can hold them: every row cut to the width, and the body cut to the height with a line saying how much was left out.
function fitFrame(lines, footer, stdout) {
  const columns = Number.isInteger(stdout.columns) && stdout.columns > 0 ? stdout.columns : null;
  const rows = Number.isInteger(stdout.rows) && stdout.rows > 3 ? stdout.rows : null;
  const room = rows === null ? lines.length : rows - 2;
  const body = lines.length <= room ? lines : [...lines.slice(0, room - 1), `… +${lines.length - room + 1} more lines - narrow it with --limit`];
  const all = [...body, footer];
  return columns === null ? all : all.map((line) => clipAnsi(line, columns));
}

// The terminal side of a follow: it redraws the frame over the previous one instead of clearing the screen, so the scrollback
// keeps one table and not one per tick. A resize redraws from the top, because the rows already drawn rewrapped under it.
function createFrameScreen(stdout) {
  let drawn = 0;
  let size = null;
  return {
    draw(lines, footer) {
      const rows = fitFrame(lines, footer, stdout);
      const nextSize = `${stdout.columns}x${stdout.rows}`;
      const back = drawn === 0 ? `${HIDE_CURSOR}\r` : size === nextSize ? `\u001b[${drawn}A\r` : "\u001b[H";
      stdout.write(`${back}${CLEAR_BELOW}${WRAP_OFF}${rows.join("\n")}\n${WRAP_ON}`);
      drawn = rows.length;
      size = nextSize;
    },
    release() {
      if (drawn > 0) stdout.write(SHOW_CURSOR);
    },
  };
}

// Writes one frame of the follow: redrawn in place on a terminal, only what changed on a pipe; it returns the text it drew.
function writeFrame(lines, { ctx, footer, previous, screen }) {
  const text = lines.join("\n");
  if (screen) {
    screen.draw(lines, paint(footer, "2", useColor(ctx)));
  } else if (text !== previous) {
    for (const line of lines) ctx.out(line);
    ctx.out("");
  }
  return text;
}

// Keeps redrawing the queue view until Ctrl-C, or until the queue goes idle when asked; on a pipe it only prints what changed.
// Every poll reads on a read-only connection opened and closed for that poll, because a session lives for hours and a
// connection held that long can answer from a stale WAL snapshot; the process-wide write connection is never closed here,
// because a close SQLite believes is the last one deletes `-shm`/`-wal` under a runner still attached to them.
async function followStatus(values, intervalS, ctx, prStates) {
  const wait = ctx.sleep ?? sleep;
  const now = ctx.now ?? (() => performance.now());
  const options = listingOptions(values);
  let previous = null;
  let previousStart = null;
  let stop = false;
  const onSignal = () => {
    stop = true;
  };
  const screen = ctx.stdout?.isTTY === true ? createFrameScreen(ctx.stdout) : null;
  const onExit = () => screen?.release();
  await ensureStoreExists(ctx.env);
  process.once("SIGINT", onSignal);
  process.once("exit", onExit);
  try {
    while (!stop) {
      const startedAt = now();
      const view = await withReadOnlyStore(ctx.env, (store) => queueView(store, { ...options, env: ctx.env, prStates, killImpl: ctx.killImpl, now }));
      const achievedMs = previousStart === null ? null : startedAt - previousStart;
      const footer = cadenceFooter({ achievedMs, intervalS, readMs: now() - startedAt, sections: view.sections });
      previous = writeFrame(renderQueueView(view, ctx, options), { ctx, footer, previous, screen });
      previousStart = startedAt;
      void prStates.refresh(prUrlsOf(view.jobs), ctx.env);
      if (values["until-idle"] === true && view.idle) return true;
      await wait(Math.max(0, intervalS * 1000 - (now() - startedAt)));
    }
    return true;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("exit", onExit);
    screen?.release();
    prStates.dispose();
  }
}

// The upkeep a one-shot `queue status` runs before it reads: prune and repair once; a repair that cannot be written only warns.
async function oneShotMaintenance(ctx) {
  const { warning } = await runMaintenance({ env: ctx.env, killImpl: ctx.killImpl });
  if (warning) ctx.err(`warning: ${warning}`);
}

// Prints one job in full with the state of its pull request, asked for once and awaited, and the close it suggests.
async function printJobDetail(id, values, ctx, prStates) {
  const store = openStore(ctx.env);
  await primePrStates(prStates, prUrlsOf([await store.jobs.getJob(id)]), ctx.env);
  const job = await jobDetailView(store, id, { prStates, env: ctx.env });
  if (!job) throw new UserError(`unknown job \`${id}\``);
  if (values.json) ctx.out(JSON.stringify({ job }));
  else for (const line of formatDetail(job)) ctx.out(line);
  return values.json === true;
}

// Prints the tail of the queue, as a table or as json, after asking gh once about the pull requests it lists.
async function printQueueView(values, ctx, prStates) {
  const store = openStore(ctx.env);
  const options = listingOptions(values);
  await primePrStates(prStates, prUrlsOf(await store.jobs.listJobs(options).catch(() => [])), ctx.env);
  const view = await queueView(store, { ...options, env: ctx.env, prStates, killImpl: ctx.killImpl });
  const unread = failedCoreSection(view);
  if (unread) throw new UserError(`the queue cannot be read: ${unread.error}`);
  if (!values.json) {
    for (const line of renderQueueView(view, ctx, options)) ctx.out(line);
    return false;
  }
  if (view.registryError !== null) {
    throw new UserError(`the runner registry cannot be listed (${view.registryError}); \`--json\` will not answer that no runner is running for a registry it could not read`);
  }
  const { runners, advisories, jobs, counts, suggestions, sections } = view;
  ctx.out(JSON.stringify({ runners, runnersOnline: runners.length, advisories, jobs, counts, suggestions, sections }));
  return true;
}

// The job `queue status <arg>` names: the one that opened a pull request URL, or a job ref or plain id.
async function statusJobId(arg, ctx) {
  if (/^https?:\/\//i.test(arg.trim())) return await jobIdOfPrUrl(openStore(ctx.env), arg.trim());
  return parseJobRef(arg);
}

// Prints `queue status`, for one job or for the tail of the queue, and tells whether it answered in json.
async function printStatus(argv, ctx) {
  const { values, positionals } = parseCommand(normalizeFollowArgv(argv), STATUS_OPTIONS);
  checkArgs(positionals, { max: 1, usage: USAGE.status });
  const intervalS = values.follow === undefined ? null : Math.max(1, requireInt("--follow", values.follow));
  if (intervalS !== null && values.json) throw new UserError(`\`--follow\` cannot be used with \`--json\`; usage: ${USAGE.status}`);
  if (intervalS !== null && positionals.length) throw new UserError(`\`--follow\` shows the whole queue, not one job; usage: ${USAGE.status}`);
  await openStoreReadOnly(ctx.env).requireCurrentSchema();
  const prStates = ctx.prStates ?? createPrStateCache();
  if (intervalS !== null) return await followStatus(values, intervalS, ctx, prStates);
  try {
    await oneShotMaintenance(ctx);
    if (positionals.length === 1) return await printJobDetail(await statusJobId(positionals[0], ctx), values, ctx, prStates);
    return await printQueueView(values, ctx, prStates);
  } finally {
    prStates.dispose();
  }
}

// Asks gh about the pull requests a one-shot is about to print, waiting at most one overall deadline; what did not answer by then prints as it is cached.
async function primePrStates(prStates, urls, env) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, PR_PRIME_DEADLINE_MS);
  });
  try {
    await Promise.race([prStates.refresh(urls, env), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// Runs `queue status` and closes the text output with the update notice, which the json output and the follow never carry.
async function runStatus(argv, ctx) {
  if (await printStatus(argv, ctx)) return;
  const notice = await updateNoticeLine({ env: ctx.env, fetchImpl: ctx.fetchImpl });
  if (notice) ctx.out(notice);
}

// The rate limit line of the dry report: the pause a claim would have to wait out, or a dash when nothing holds a claim back.
function dryRateLimitLine(report) {
  const label = runnerPauseLabel({ running: true, pausedUntil: report.pausedUntil, rateLimit: report.rateLimit });
  return `rate limit      ${label ?? "-"}`;
}

// Report lines of `queue run --dry`, the cycle that only reads.
function formatDry(report) {
  return [
    `paused          ${report.paused}`,
    dryRateLimitLine(report),
    `cap             ${report.cap ?? "none"}`,
    `max             ${report.max ?? "none"}`,
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
  return `${jobRef(job.id)} ${job.status}${details.map((detail) => ` ${detail}`).join("")}`;
}

// One line of report for each job the cycle processed.
function printCycle(cycle, ctx) {
  for (const job of cycle.processed) ctx.out(formatProcessed(job));
  if (cycle.reason === "window-closed") return ctx.out(windowClosedLine(cycle));
  if (!cycle.processed.length) ctx.out(`queue: nothing to run (${cycle.reason})`);
  if (cycle.reason === "max-reached") ctx.out("queue: stopped - the --max budget of this run is spent");
}

const RUN_OPTIONS = {
  job: { type: "string" },
  max: { type: "string" },
  watch: { type: "string" },
  from: { type: "string" },
  until: { type: "string" },
  dry: { type: "boolean" },
  json: { type: "boolean" },
  foreground: { type: "boolean" },
  stop: { type: "string" },
  drain: { type: "boolean" },
};

// Turns a bare `--stop` into `--stop=`, because strict parseArgs has no optional-value option; the empty value means every runner.
function normalizeStopArgv(argv) {
  return argv.flatMap((token, index) => (token === "--stop" && !isPositiveIntToken(argv[index + 1]) ? ["--stop="] : [token]));
}

// Refuses `--stop` next to any other option: ending a runner reads nothing else of the command line.
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

// Refuses `--from`/`--until` outside of `--watch`, beside `--job`, without one another, equal to one another, or written any way other than `HH:MM`.
function checkWindowFlags(values) {
  if (values.from === undefined && values.until === undefined) return;
  if (values.job !== undefined) throw new UserError(`\`--from\`/\`--until\` cannot be used with \`--job\`; usage: ${USAGE.run}`);
  if (values.watch === undefined) throw new UserError(`\`--from\`/\`--until\` only have meaning with \`--watch\`; usage: ${USAGE.run}`);
  if (values.until === undefined) throw new UserError(`\`--from\` requires \`--until\`; usage: ${USAGE.run}`);
  if (values.from !== undefined && !parseWallClock(values.from)) {
    throw new UserError(`\`--from\` expects a time written HH:MM (00-23:00-59), got \`${values.from}\`; usage: ${USAGE.run}`);
  }
  if (!parseWallClock(values.until)) {
    throw new UserError(`\`--until\` expects a time written HH:MM (00-23:00-59), got \`${values.until}\`; usage: ${USAGE.run}`);
  }
  if (values.from !== undefined && values.from === values.until) {
    throw new UserError(`\`--from\` and \`--until\` cannot name the same time; usage: ${USAGE.run}`);
  }
}

// Runs `queue run --stop [pid]`, which ends every registered runner or the one the operator named.
async function runStop(value, ctx) {
  const pid = value === "" ? null : requireInt("--stop", value);
  const reports = (await stopRunners({ pid, env: ctx.env, killImpl: ctx.killImpl })).map(stopReport);
  for (const report of reports) ctx.out(report.line);
  return reports.some((report) => report.code !== 0) ? 1 : 0;
}

// Runs the drain loop in this process, as the registered runner of the queue.
async function runDrainHere({ max, json }, ctx) {
  return await runGuardedHere({
    json,
    ctx,
    run: () => runDrain({ max, env: ctx.env, onCycle: (cycle) => printCycle(cycle, ctx) }).then(() => 0),
  });
}

// Runs the watch loop in this process, as the registered runner of the queue.
async function runWatchHere({ intervalS, jobId, max, json, from = null, until = null }, ctx) {
  return await runGuardedHere({
    jobId,
    watchIntervalS: intervalS,
    from,
    until,
    json,
    ctx,
    run: () => runWatch({ intervalS, jobId, max, from, until, env: ctx.env, onCycle: (cycle) => printCycle(cycle, ctx) }).then(() => 0),
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
  const { values, positionals } = parseCommand(normalizeStopArgv(normalizeWatchArgv(argv)), RUN_OPTIONS);
  checkArgs(positionals, { max: 0, usage: USAGE.run });
  if (values.stop !== undefined) {
    checkStopAlone(values);
    return await runStop(values.stop, ctx);
  }
  checkJobNotWatched(values);
  checkWindowFlags(values);
  const jobId = values.job === undefined ? null : parseJobRef(values.job);
  const max = requireInt("--max", values.max) ?? null;
  if (values.dry) {
    const report = await runCycle({ jobId, max, dry: true, env: ctx.env });
    if (values.json) ctx.out(JSON.stringify(report));
    else for (const line of formatDry(report)) ctx.out(line);
    return;
  }
  const intervalS = values.watch === undefined ? null : requireInt("--watch", values.watch);
  const from = values.from ?? null;
  const until = values.until ?? null;
  if (values.foreground !== true) return await startDetached({ jobId, max, watchIntervalS: intervalS, from, until }, ctx);
  const json = values.json === true;
  if (intervalS !== null) return await runWatchHere({ intervalS, jobId, max, json, from, until }, ctx);
  if (values.drain === true && jobId === null) return await runDrainHere({ max, json }, ctx);
  const waiting = await claimBlocker({ jobId, mode: runnerMode({ jobId }), env: ctx.env });
  if (waiting) return await reportWaiting(waiting, ctx);
  return await runGuardedHere({ jobId, json, ctx, run: () => runCycleHere({ jobId, max, json }, ctx) });
}

// Runs `queue cancel`, which refuses without writing when the job is running or being closed under a live lease, and releases the worktree of a done or failed job.
async function runCancel(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { reason: { type: "string" }, json: { type: "boolean" } });
  checkArgs(positionals, { min: 1, usage: USAGE.cancel });
  const store = openStore(ctx.env);
  const { job, worktree } = await cancelJobAndWorktree({ store, id: parseJobRef(positionals[0]), reason: values.reason, env: ctx.env, killImpl: ctx.killImpl });
  if (values.json) {
    ctx.out(JSON.stringify({ job, worktree }));
    return;
  }
  ctx.out(`cancelled ${jobRef(job.id)}`);
  if (worktree) ctx.out(worktreeLine(worktree));
}

const CLOSE_OPTIONS = { json: { type: "boolean" }, merged: { type: "boolean" }, force: { type: "boolean" }, foreground: { type: "boolean" }, steps: { type: "string" }, again: { type: "boolean" } };

// The text line a close prints for one decision it accepted.
function acceptedLine(entry) {
  return `accepted ${entry.ref}: ${entry.title}`;
}

// One `closed job #N` line per closed job, each followed by the line of the worktree it released, when it had one.
function closedJobLines(closed, worktrees = []) {
  return closed.flatMap((job) => {
    const entry = worktrees.find((candidate) => candidate.id === job.id);
    return entry ? [`closed ${jobRef(job.id)}`, worktreeLine(entry)] : [`closed ${jobRef(job.id)}`];
  });
}

// The line `queue close --merged` prints before it asks gh, on stdout in text mode and never on the stdout of `--json`.
function reportChecking(n, values, ctx) {
  const line = `checking ${n} pull requests on GitHub...`;
  if (values.json) ctx.err(line);
  else ctx.out(line);
}

// Whether an undetermined candidate was never asked about at all: the ones over the query limit of this call.
function isUnchecked(entry) {
  return typeof entry.reason === "string" && entry.reason.startsWith("not checked: over the limit");
}

// Text lines of `queue close --merged`: one per closed (with its worktree), refused and undetermined job, one per settled proposal, plus a summary when some were left unchecked.
function closeMergedLines({ closed, refused, undetermined, worktrees, decisions }) {
  if (closed.length + refused.length + undetermined.length === 0) return ["nothing to close"];
  const lines = [
    ...closedJobLines(closed, worktrees),
    ...refused.map(({ id, reason }) => `${jobRef(id)} not closed: ${reason}`),
    ...undetermined.map(({ id, reason }) => `${jobRef(id)} not closed: ${reason}`),
    ...decisions.map(acceptedLine),
  ];
  const unchecked = undetermined.filter(isUnchecked);
  if (unchecked.length) lines.push(`${unchecked.length} job${unchecked.length === 1 ? "" : "s"} left unchecked; run nightqueue queue close --merged again`);
  return lines;
}

// Runs `queue close --merged`, which closes every done job the cache and, for the gap, gh itself confirm merged, accepting their proposals; it never fails because one pull request could not be read.
async function runCloseMerged(values, ctx) {
  const prStates = ctx.prStates ?? createPrStateCache();
  try {
    const store = openStore(ctx.env);
    const deadlineMs = ctx.closeMergedDeadlineMs ?? CLOSE_MERGED_DEADLINE_MS;
    const deps = ctx.closeDeps ?? null;
    const merged = await closeMerged({ store, prStates, env: ctx.env, deps, deadlineMs, onChecking: (n) => reportChecking(n, values, ctx) });
    if (values.json) ctx.out(JSON.stringify(merged));
    else for (const line of closeMergedLines(merged)) ctx.out(line);
  } finally {
    prStates.dispose();
  }
}

// The line a forced close prints first, so what `--force` skips, and what it never skips, is always said out loud.
function forcedCloseLine(id) {
  return `${jobRef(id)}: --force: pull request checks and the rebase suite are skipped; conflicts, attribution and status still stop the close`;
}

// One settled step of a foreground close, as the operator reads it.
function closeStepLine({ name, status, note, earlier = false }) {
  const icon = CLOSE_STEP_ICONS[status] ?? "·";
  return `${icon} ${String(name).padEnd(10)} ${note ?? ""}${earlier ? " (earlier attempt)" : ""}`.trimEnd();
}

// The number of a pull request, from the close's own data or its URL.
function prNumberOf(job) {
  const recorded = jobView(job)?.close?.data?.prNumber;
  if (Number.isInteger(recorded)) return recorded;
  return /\/pull\/(\d+)/.exec(String(job?.pr_url ?? ""))?.[1] ?? "?";
}

// The last line of a foreground close: what it merged and how the job ended, or where it stopped and how to resume.
function closeOutcomeLine(id, { outcome, job }) {
  const worktree = outcome.worktree ? `; ${worktreeLine(outcome.worktree)}` : "";
  if (outcome.status === "closed") return `${jobRef(id)} closed: PR #${prNumberOf(job)} merged as ${String(outcome.mergeSha ?? "").slice(0, 7)}${worktree}`;
  if (outcome.status === "cancelled") return `${jobRef(id)} cancelled: PR #${prNumberOf(job)} was closed without being merged; nothing to close${worktree}`;
  if (outcome.status === "lost") return `${jobRef(id)}: the close lease was taken over by another process; follow it with nightqueue queue status ${jobRef(id)}`;
  return closeStoppedLine(jobView(job)) ?? `⛔ close stopped at ${outcome.step}: ${outcome.reason} - run again with: nightqueue queue close ${jobRef(id)}`;
}

// Runs the close of a job in this process, printing each settled step, and answers its outcome with the job as it ended.
async function closeInThisProcess(id, values, ctx) {
  const say = values.json === true ? ctx.err : ctx.out;
  return await runCloseHere({
    store: openStore(ctx.env),
    id,
    force: values.force === true,
    env: ctx.env,
    deps: ctx.closeDeps ?? null,
    killImpl: ctx.killImpl,
    onStart: (lease) => lease.forced && say(forcedCloseLine(id)),
    onStep: closeStepPrinter(say, values.json === true ? null : ctx.stdout),
  });
}

// Prints the steps of a foreground close; on a TTY a running step redraws one live line that the next settled step replaces.
export function closeStepPrinter(say, tty) {
  const live = tty?.isTTY === true ? tty : null;
  let drawn = false;
  return (step) => {
    if (live && step.status === "running") {
      live.write(`\r\x1b[2K${closeStepLine(step)}`);
      drawn = true;
      return;
    }
    if (drawn) live.write("\r\x1b[2K");
    drawn = false;
    say(closeStepLine(step));
  };
}

// Prints how a foreground close ended, plus the decisions it accepted, and answers 0 only when it closed the job.
function reportCloseOutcome(id, result, values, ctx) {
  const { status, step = null, reason = null, mergeSha = null, accepted = [] } = result.outcome;
  const decisions = accepted.map((entry) => ({ job_id: id, ...entry }));
  if (values.json) {
    ctx.out(JSON.stringify({ job: jobView(result.job, { full: true }), outcome: { status, step, reason, mergeSha }, decisions }));
  } else {
    ctx.out(closeOutcomeLine(id, result));
    for (const entry of decisions) ctx.out(acceptedLine(entry));
  }
  return status === "closed" ? 0 : 1;
}

// Runs the closing pipeline of one job in this process, which accepts the job's proposals as it closes it.
async function runCloseForeground(id, values, ctx) {
  const result = await closeInThisProcess(id, values, ctx);
  return reportCloseOutcome(id, result, values, ctx);
}

// Starts the close of a job detached and says how to follow it.
async function runCloseDetached(id, values, ctx) {
  const started = await startCloseDetached({
    store: openStore(ctx.env),
    id,
    force: values.force === true,
    env: ctx.env,
    spawnImpl: ctx.spawnImpl,
    killImpl: ctx.killImpl,
  });
  if (values.json) {
    ctx.out(JSON.stringify({ started: true, jobId: id, pid: started.pid, logPath: started.logPath }));
    return 0;
  }
  if (started.forced) ctx.out(forcedCloseLine(id));
  ctx.out(`close of ${jobRef(id)} started (pid ${started.pid}) - follow with: tail -f ${started.logPath} (log: ${started.logPath}), or nightqueue queue status ${jobRef(id)}`);
  return 0;
}

// The step names a `--steps` value lists, split on commas.
function stepNames(text) {
  return String(text ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

// The summary line of a `--steps` re-run: each step with its status, or why nothing ran.
function postCloseSummaryLine(id, result, again) {
  if (!result.steps.length) return `${jobRef(id)} post-close: nothing run - ${result.note}`;
  const mark = again ? " (again)" : "";
  return `${jobRef(id)} post-close: ${result.steps.map(({ name, status }) => `${name} ${status}${mark}`).join(", ")}`;
}

// Runs `queue close <id> --steps <a,b>`: only the named post-close steps of a closed job, in this process; 1 when any of them warned or nothing could run.
async function runCloseSteps(positionals, values, ctx) {
  if (values.merged === true || values.force === true) throw new UserError(`\`--steps\` cannot be combined with --merged or --force; usage: ${USAGE.close}`);
  const again = values.again === true;
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.close });
  const id = parseJobRef(positionals[0]);
  const say = values.json === true ? ctx.err : ctx.out;
  const store = openStore(ctx.env);
  const onStep = closeStepPrinter(say, values.json === true ? null : ctx.stdout);
  const result = await runPostCloseSteps({ store, id, names: stepNames(values.steps), again, env: ctx.env, deps: ctx.closeDeps ?? null, onStep });
  if (values.json) ctx.out(JSON.stringify({ job: jobView(await store.jobs.getJob(id), { full: true }), steps: result.steps }));
  else ctx.out(postCloseSummaryLine(id, result, again));
  return result.status !== "refused" && result.status !== "failed" && result.steps.every((step) => step.status !== "warning") ? 0 : 1;
}

// Runs `queue close`: the closing pipeline on one done job with a pull request, detached unless --foreground, or `--merged` for every done job the pull request state confirms merged.
async function runClose(argv, ctx) {
  if (argv.some((arg) => arg === "--decisions" || arg.startsWith("--decisions="))) {
    throw new UserError(`\`--decisions\` no longer exists: a close accepts the decisions its job proposed; usage: ${USAGE.close}`);
  }
  const { values, positionals } = parseCommand(argv, CLOSE_OPTIONS);
  if (values.again === true && values.steps === undefined) throw new UserError(`\`--again\` is valid only with --steps; usage: ${USAGE.close}`);
  if (values.steps !== undefined) return await runCloseSteps(positionals, values, ctx);
  if (values.merged === true) {
    checkArgs(positionals, { max: 0, usage: USAGE.close });
    return await runCloseMerged(values, ctx);
  }
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.close });
  const id = parseJobRef(positionals[0]);
  if (values.foreground === true) return await runCloseForeground(id, values, ctx);
  return await runCloseDetached(id, values, ctx);
}

// Reports what happened to the run directory of a `--fresh` retry: a directory that was kept says why, and never brings the retry down.
function reportRunDir(discarded, ctx) {
  if (!discarded || discarded.status !== "kept") return;
  ctx.out(`run directory kept (${discarded.reason}): ${discarded.dir ?? "no safe path"}`);
}

// The line `queue retry` answers with: the job is pending again, plus what happens to it when no runner is started for it.
function retriedLine(job, values, ctx) {
  const line = `${jobRef(job.id)} is pending again${values.fresh === true ? ", starting from phase 0" : ""}`;
  return values.run === true ? line : `${line}. ${queuedRunnerLine(ctx, job.id)}`;
}

// Runs `queue retry`, which sends a gated, failed or cancelled job back to the queue; a gated one only moves with a note, unless a preflight block gated it.
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
  const { job, runDir } = await applyRetry({
    id: parseJobRef(positionals[0]),
    note: values.note,
    fresh: values.fresh === true,
    env: ctx.env,
  });
  if (values.json) ctx.out(JSON.stringify({ job }));
  else ctx.out(retriedLine(job, values, ctx));
  reportRunDir(runDir, ctx);
  return values.run === true ? await runNow(job, values, ctx) : 0;
}

// What a re-classification answers the operator: the outcome it corrected, or that there was nothing to correct.
function repairLine(outcome) {
  if (!outcome.changed) return `${jobRef(outcome.id)} is still \`${outcome.from}\`; there is nothing to correct`;
  if (outcome.noticeOnly) return `${jobRef(outcome.id)} is still \`${outcome.from}\`; its notice was re-read from the log. Read it with: nightqueue queue status ${jobRef(outcome.id)}`;
  return `${jobRef(outcome.id)} re-classified from \`${outcome.from}\` to \`${outcome.to}\`${outcome.prUrl ? ` (${outcome.prUrl})` : ""}`;
}

// What a replay answers the operator for one run directory: its counts, or the failure of its own.
function replayLine(run) {
  const where = `${run.projectId}/${run.slug}`;
  if (run.failed) return `${where}: not replayed: ${run.failed}`;
  const counts = `applied ${run.applied}, filled ${run.filled}, superseded ${run.superseded}, refused ${run.refused}`;
  return `${where}: ${counts}${run.malformed ? `, ${run.malformed} malformed line(s) skipped` : ""}`;
}

// Replays every run's pending writes and prints one line per run directory, or that nothing was pending.
async function runReplay(values, ctx) {
  const runs = await replayPending({ env: ctx.env });
  if (values.json) ctx.out(JSON.stringify({ replay: runs }));
  else ctx.out(runs.length === 0 ? "nothing pending" : runs.map(replayLine).join("\n"));
}

// What a recovery from disk answers the operator for one job.
function recoveryLine(entry) {
  const pr = entry.prUrl ? ` (${entry.prUrl})` : "";
  return `${jobRef(entry.jobId)} ${entry.project}/${entry.slug}: ${entry.result}${pr}`;
}

// Recreates the lost rows from disk and prints one line per job, then the log-only tail.
async function runRecovery(values, positionals, ctx) {
  const id = positionals.length === 0 ? null : parseJobRef(positionals[0]);
  const { results, logOnly } = await recoverFromDisk({ id, env: ctx.env });
  if (values.json) return ctx.out(JSON.stringify({ recovered: results, logOnly }));
  const lines = results.map(recoveryLine);
  if (lines.length === 0) lines.push("no job on disk is missing from the table");
  const tail = logOnlyTail(logOnly);
  ctx.out([...lines, ...(tail ? [tail] : [])].join("\n"));
}

// Runs `queue repair`: bare, it replays the pending writes of every run; with an id, it re-derives the outcome of a gated or failed job from its own log and state.json; `--from-disk` recreates the rows the table lost.
async function runRepair(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" }, "from-disk": { type: "boolean" } });
  checkArgs(positionals, { max: 1, usage: USAGE.repair });
  if (values["from-disk"] === true) return await runRecovery(values, positionals, ctx);
  if (positionals.length === 0) return await runReplay(values, ctx);
  const outcome = await reclassifyFromLog({ id: parseJobRef(positionals[0]), env: ctx.env });
  ctx.out(values.json ? JSON.stringify({ repair: outcome }) : repairLine(outcome));
}

// Runs `queue pause`, which stops new claims without touching any job.
async function runPause(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { max: 0, usage: USAGE.pause });
  pauseQueue(ctx.env);
  ctx.out("queue paused; running jobs finish normally");
}

// Runs `queue resume`, which removes the pause sentinel and stamps the instant every runner waiting out a rate limit compares its own pause against.
async function runResume(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { max: 0, usage: USAGE.resume });
  resumeQueue(ctx.env);
  ctx.out("queue resumed");
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
  if (ctx.env?.NIGHTQUEUE_FOLLOW_DEBUG !== "1") return null;
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
  if (result.status) ctx.err(`${jobRef(id)} ${result.status}`);
  reportStop(result, ctx);
}

// Runs `queue log` in narrated mode, the default: one line for each relevant event of the stream.
async function runLogNarrated(id, { follow, all }, ctx) {
  const color = useColor(ctx);
  const result = await narrateJob({
    id,
    env: ctx.env,
    follow,
    all,
    onEvent: (event) => ctx.out(formatNarration(event, { color })),
    stopReason: follow ? watchOutputClosed(ctx) : undefined,
    trace: follow ? pollTracer(ctx) : null,
    warn: (message) => ctx.err(message),
  });
  if (result) reportStop(result, ctx);
}

// Runs `queue log`, which narrates the stream of a job by default and can keep following it.
async function runLog(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { follow: { type: "boolean" }, raw: { type: "boolean" }, all: { type: "boolean" } });
  checkArgs(positionals, { min: 1, usage: USAGE.log });
  const id = parseJobRef(positionals[0]);
  if (values.raw && values.all) throw new UserError("`--all` has no meaning with `--raw`; the raw stream already carries every event");
  const path = jobLogPath(id, ctx.env);
  if (!existsSync(path)) throw new UserError(`no log for job \`${id}\`; expected ${path}`);
  const follow = values.follow === true;
  if (values.raw) return await runLogRaw(path, id, follow, ctx);
  return await runLogNarrated(id, { follow, all: values.all === true }, ctx);
}

const SESSION_OPTIONS = { print: { type: "boolean" }, json: { type: "boolean" }, prompt: { type: "string" } };

// The one line printed before a session resumes: the job, attempt, session id and cwd, with a note when the worktree behind it is gone.
function sessionLine(resolved) {
  const base = `${jobRef(resolved.jobId)} · attempt ${resolved.attempt} · session ${resolved.session} · cwd ${resolved.cwd}`;
  return resolved.worktreeReleased ? `${base} (worktree released, using the checkout)` : base;
}

// Wraps a text in single quotes for a POSIX shell.
function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

// The shell command `--print` answers: the operator resuming the session, run from its cwd, with the request when one was given.
function sessionCommand(resolved, prompt) {
  const command = `cd ${shellQuote(resolved.cwd)} && nightqueue open --resume ${resolved.session}`;
  return prompt === null ? command : `${command} --prompt ${shellQuote(prompt)}`;
}

// Runs `nightqueue queue session`, which resumes the session of a job's last attempt through the operator launcher, in the run's worktree or, when that is gone, the project's checkout.
async function runSession(argv, ctx) {
  const { values, positionals } = parseCommand(argv, SESSION_OPTIONS);
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.session });
  const id = parseJobRef(positionals[0]);
  const prompt = operatorPrompt(values.prompt, USAGE.session);
  const job = await openStore(ctx.env).jobs.getJob(id);
  if (!job) throw new UserError(`unknown job \`${id}\``);
  const resolved = resolveJobSession(job, ctx.env);
  const command = sessionCommand(resolved, prompt);
  if (values.json) ctx.out(JSON.stringify({ ...resolved, command }));
  else ctx.out(sessionLine(resolved));
  if (values.print) {
    if (!values.json) ctx.out(command);
    return 0;
  }
  return await launchOperator({ cwd: resolved.cwd, resumeSession: resolved.session, prompt, ctx });
}

const SUBCOMMANDS = new Map([
  ["add", runAdd],
  ["status", runStatus],
  ["run", runRun],
  ["cancel", runCancel],
  ["close", runClose],
  ["retry", runRetry],
  ["repair", runRepair],
  ["pause", runPause],
  ["resume", runResume],
  ["log", runLog],
  ["session", runSession],
]);

export const SUBCOMMAND_NAMES = Object.freeze([...SUBCOMMANDS.keys()]);

// Dispatches the subcommands of `nightqueue queue`, returning the exit code the subcommand decided.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown queue subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  return await handler(rest, ctx);
}
