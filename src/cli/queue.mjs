import { closeSync, existsSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, queuePausedPath } from "../config/paths.mjs";
import { projectByName } from "../config/projects.mjs";
import { ensureHome, loadConfig, writeFileAtomic } from "../config/store.mjs";
import { addJob, cancelJob, countsByStatus, getJob, jobView, listJobs } from "../memory/jobs.mjs";
import { runCycle, runWatch, WATCH_INTERVAL_DEFAULT_S } from "../queue/runner.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const FOLLOW_POLL_MS = 1000;

const USAGE = {
  add: "shift queue add <project> <prompt> [--priority <n>] [--max-attempts <n>] [--timeout <s>]",
  status: "shift queue status [id] [--limit <n>] [--json]",
  run: "shift queue run [--job <id>] [--max <n>] [--watch [seconds]] [--dry] [--json]",
  cancel: "shift queue cancel <id> [--reason <text>]",
  pause: "shift queue pause",
  resume: "shift queue resume",
  log: "shift queue log <id> [--follow]",
};

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

// Runs `queue add`, refusing a project that is not registered by NAME.
async function runAdd(argv, ctx) {
  const { values, positionals } = parseAdd(argv);
  const [name, prompt] = positionals;
  if (!projectByName(loadConfig(ctx.env, { warn: ctx.err }), name)) {
    throw new UserError(`unknown project \`${name}\`; pass the registered project NAME, not a path (\`shift project list\`)`);
  }
  const job = addJob(
    {
      project: name,
      prompt,
      priority: requireInt("--priority", values.priority),
      maxAttempts: requireInt("--max-attempts", values["max-attempts"]),
      timeoutS: requireInt("--timeout", values.timeout),
    },
    ctx.env,
  );
  ctx.out(`queued job #${job.id} for project \`${job.project}\` (priority ${job.priority}, timeout ${job.timeoutS}s)`);
}

// Parses the arguments of `queue add`, which takes exactly the project name and one quoted prompt.
function parseAdd(argv) {
  const parsed = parseCommand(argv, {
    priority: { type: "string" },
    "max-attempts": { type: "string" },
    timeout: { type: "string" },
  });
  checkArgs(parsed.positionals, { min: 2, max: 2, usage: USAGE.add });
  return parsed;
}

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
  for (const job of jobs) ctx.out(formatJob(job));
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

// One line of report for each job the cycle processed.
function printCycle(cycle, ctx) {
  for (const job of cycle.processed) {
    ctx.out(`job #${job.id} ${job.status}${job.code ? ` ${job.code}` : ""}${job.prUrl ? ` ${job.prUrl}` : ""}`);
  }
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

// Runs `queue log`, printing the accumulated stream of a job and optionally following it.
async function runLog(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { follow: { type: "boolean" } });
  checkArgs(positionals, { min: 1, usage: USAGE.log });
  const id = requireInt("id", positionals[0]);
  const path = jobLogPath(id, ctx.env);
  if (!existsSync(path)) throw new UserError(`no log for job \`${id}\`; expected ${path}`);
  let offset = printFrom(path, 0, ctx);
  while (values.follow) {
    await sleep(FOLLOW_POLL_MS);
    offset = printFrom(path, offset, ctx);
  }
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

// Dispatches the subcommands of `shift queue`.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(`unknown queue subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}`);
  }
  await handler(rest, ctx);
}
