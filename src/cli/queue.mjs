import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, queuePausedPath } from "../config/paths.mjs";
import { projectByName, resolveProject } from "../config/projects.mjs";
import { ensureHome, loadConfig, writeFileAtomic } from "../config/store.mjs";
import { addJob, cancelJob, countsByStatus, getJob, jobView, listJobs, truncateByCodePoint } from "../memory/jobs.mjs";
import { followLog, readLogTail } from "../queue/follow.mjs";
import { createNarrator, formatDuration, formatNarration, lastOrchestratorLine, narrateLog } from "../queue/narrate.mjs";
import { runCycle, runWatch, WATCH_INTERVAL_DEFAULT_S } from "../queue/runner.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const USAGE = {
  add: "nightshift queue add [project] <prompt...> [--run] [--priority <n>] [--max-attempts <n>] [--timeout <s>]",
  status: "nightshift queue status [id] [--limit <n>] [--json]",
  run: "nightshift queue run [--job <id>] [--max <n>] [--watch [seconds]] [--dry] [--json]",
  cancel: "nightshift queue cancel <id> [--reason <text>]",
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

// Chooses the project of the job: the first positional when it is a registered NAME, otherwise the project of the current directory.
function resolveTarget(config, positionals, ctx) {
  const named = projectByName(config, positionals[0]);
  if (named) return { project: named, words: positionals.slice(1), fromCwd: false };
  const cwd = ctx.cwd ?? process.cwd();
  const resolved = resolveProject(config, { cwd });
  if (!resolved) {
    throw new UserError(`no project registered for ${cwd}; run \`nightshift init\` here, or pass the project NAME (\`nightshift project list\`)`);
  }
  return { project: resolved, words: positionals, fromCwd: true };
}

// Runs the job in the foreground and turns its outcome into the exit code: 0 only when it finished as `done`.
async function runInForeground(job, ctx) {
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

// Runs `queue add`, with the project taken from the arguments or from the current directory.
async function runAdd(argv, ctx) {
  if (argv.length === 1 && ADD_HELP_FLAGS.has(argv[0])) {
    ctx.out(ADD_HELP);
    return 0;
  }
  const { values, positionals } = parseAdd(argv);
  const target = resolveTarget(loadConfig(ctx.env, { warn: ctx.err }), positionals, ctx);
  const prompt = target.words.join(" ").trim();
  if (!prompt) throw new UserError(`missing argument; usage: ${USAGE.add}`);
  if (target.fromCwd) ctx.out(`project \`${target.project.name}\` resolved from the current directory`);
  const job = addJob(
    {
      project: target.project.name,
      prompt,
      priority: requireInt("--priority", values.priority),
      maxAttempts: requireInt("--max-attempts", values["max-attempts"]),
      timeoutS: requireInt("--timeout", values.timeout),
    },
    ctx.env,
  );
  ctx.out(`queued job #${job.id} for project \`${job.project}\` (priority ${job.priority}, timeout ${job.timeoutS}s)`);
  return values.run === true ? await runInForeground(job, ctx) : 0;
}

const ADD_OPTIONS = {
  priority: { type: "string" },
  "max-attempts": { type: "string" },
  timeout: { type: "string" },
  run: { type: "boolean" },
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
  checkArgs(words, { min: 1, max: Number.POSITIVE_INFINITY, usage: USAGE.add });
  return { values, positionals: words };
}

const NARRATION_LIMIT = 60;
const JOB_LINE_WIDTH = 58;

// One line of the job table of `queue status`.
function formatJob(job) {
  return [
    `#${job.id}`.padEnd(6),
    String(job.status).padEnd(10),
    String(job.project).padEnd(20),
    `p${job.priority}`.padEnd(4),
    `${job.attempts}/${job.max_attempts}`.padEnd(6),
    job.pr_url ?? job.slug ?? "-",
  ].join("");
}

// How long a running job has been up, read from its own `started_at`.
function formatRunningFor(job, nowMs) {
  const startedMs = Date.parse(String(job.started_at ?? ""));
  return Number.isFinite(startedMs) ? formatDuration(nowMs - startedMs) : "-";
}

// Last narration line of the log of a job; a log that is missing or unreadable says so instead of inventing one.
function lastNarration(id, env) {
  const tail = readLogTail(jobLogPath(id, env));
  const line = typeof tail === "string" ? lastOrchestratorLine(tail) : "";
  return line ? `» ${truncateByCodePoint(line, NARRATION_LIMIT)}` : "-";
}

// Line of a running job: the columns of the table plus how long it has been running and what it last said.
function formatRunningJob(job, nowMs, env) {
  return `${formatJob(job).padEnd(JOB_LINE_WIDTH)}${formatRunningFor(job, nowMs).padEnd(8)}${lastNarration(job.id, env)}`;
}

// One line for each job of the table, with the live columns of the ones that are running.
function formatJobLines(jobs, env) {
  const nowMs = Date.now();
  return jobs.map((job) => (job.status === "running" ? formatRunningJob(job, nowMs, env) : formatJob(job)));
}

// Detail block of a single job, one field per line.
function formatDetail(job) {
  return Object.entries(job)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key.padEnd(16)}${value}`);
}

// Runs `queue status`, for one job or for the tail of the queue.
async function runStatus(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" }, limit: { type: "string" } });
  checkArgs(positionals, { max: 1, usage: USAGE.status });
  if (positionals.length === 1) {
    const id = requireInt("id", positionals[0]);
    const job = jobView(getJob(id, ctx.env));
    if (!job) throw new UserError(`unknown job \`${id}\``);
    if (values.json) ctx.out(JSON.stringify({ job }));
    else for (const line of formatDetail(job)) ctx.out(line);
    return;
  }
  const jobs = listJobs({ limit: requireInt("--limit", values.limit) }, ctx.env).map(jobView);
  const counts = countsByStatus(ctx.env);
  if (values.json) {
    ctx.out(JSON.stringify({ jobs, counts }));
    return;
  }
  if (!jobs.length) {
    ctx.out("no jobs in the queue");
    return;
  }
  for (const line of formatJobLines(jobs, ctx.env)) ctx.out(line);
  ctx.out(Object.entries(counts).map(([status, total]) => `${status}=${total}`).join("  "));
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

// Runs `queue run`: one cycle, one job, a dry report or the watch loop.
async function runRun(argv, ctx) {
  const { values, positionals } = parseCommand(normalizeWatchArgv(argv), {
    job: { type: "string" },
    max: { type: "string" },
    watch: { type: "string" },
    dry: { type: "boolean" },
    json: { type: "boolean" },
  });
  checkArgs(positionals, { max: 0, usage: USAGE.run });
  const jobId = requireInt("--job", values.job) ?? null;
  const max = requireInt("--max", values.max) ?? null;
  if (values.dry) {
    const report = await runCycle({ jobId, max, dry: true, env: ctx.env });
    if (values.json) ctx.out(JSON.stringify(report));
    else for (const line of formatDry(report)) ctx.out(line);
    return;
  }
  if (values.watch !== undefined) {
    await runWatch({ intervalS: requireInt("--watch", values.watch), jobId, max, env: ctx.env, onCycle: (cycle) => printCycle(cycle, ctx) });
    return;
  }
  const cycle = await runCycle({ jobId, max, env: ctx.env });
  if (values.json) ctx.out(JSON.stringify(cycle));
  else printCycle(cycle, ctx);
}

// Runs `queue cancel`, which refuses without writing when the job is running under a live lease.
async function runCancel(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { reason: { type: "string" }, json: { type: "boolean" } });
  checkArgs(positionals, { min: 1, usage: USAGE.cancel });
  const job = cancelJob(requireInt("id", positionals[0]), { reason: values.reason }, ctx.env);
  ctx.out(values.json ? JSON.stringify({ job }) : `cancelled job #${job.id}`);
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
function jobStatusReader(id, env) {
  return () => getJob(id, env)?.status ?? null;
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

// Runs `queue log` in narrated mode, the default: one line for each relevant event of the stream.
async function runLogNarrated(path, id, { follow, all }, ctx) {
  const color = useColor(ctx);
  const print = (event) => ctx.out(formatNarration(event, { color }));
  if (!follow) {
    const text = readingLog(path, () => readFileSync(path, "utf8"));
    for (const event of narrateLog(text, { all })) print(event);
    return;
  }
  const narrator = createNarrator({ all });
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
