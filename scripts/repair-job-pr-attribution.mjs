#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dbPath } from "../src/config/paths.mjs";
import { CLOSED_PREFIX, parseCloseChecklist } from "../src/queue/close-view.mjs";
import { openStore, withReadOnlyStore } from "../src/store/open.mjs";

export const JOB_ID = 57;
export const FROM_URL = "https://github.com/maykonVinicius/nightshift/pull/71";
export const TO_URL = "https://github.com/maykonVinicius/nightshift/pull/72";
export const FROM_LINE = "Closed: PR #71 merged as c1fe093 on 2026-09-22";
export const TO_LINE = "Closed: PR #72 merged as 1b62622 on 2026-09-22";
export const REFUSAL_EXIT = 2;

const USAGE = "usage: node scripts/repair-job-pr-attribution.mjs --job 57 [--apply]";

// Reads the command line; a job other than 57 is refused because the values this one-off writes are job 57's.
function parseOptions(argv) {
  const { values } = parseArgs({ args: argv, options: { job: { type: "string" }, apply: { type: "boolean", default: false } } });
  if (Number(values.job) !== JOB_ID) throw new Error(`this one-off repair only knows job ${JOB_ID}. ${USAGE}`);
  return { apply: values.apply };
}

// Tells whether the notice holds this text exactly once, and as a whole line of its own.
function holdsLineOnce(notice, line) {
  if (notice.split(line).length !== 2) return false;
  return notice.split("\n").filter((candidate) => candidate === line).length === 1;
}

// Classifies the row: still carrying job 57's wrong attribution, already corrected, or anything else.
export function attributionState(row) {
  const notice = typeof row?.notice_md === "string" ? row.notice_md : "";
  if (row?.pr_url === TO_URL && holdsLineOnce(notice, TO_LINE) && !notice.includes(FROM_LINE)) return "corrected";
  if (row?.pr_url === FROM_URL && holdsLineOnce(notice, FROM_LINE) && !notice.includes(TO_LINE)) return "repairable";
  return "unexpected";
}

// The lines of the notice that record a close, joined, or a placeholder.
function closedLines(row) {
  const notice = typeof row?.notice_md === "string" ? row.notice_md : "";
  const lines = notice.split("\n").filter((line) => line.startsWith(CLOSED_PREFIX));
  return lines.length > 0 ? lines.join(" | ") : "(none)";
}

// A value of the close checklist as printed, or a placeholder.
function shown(value) {
  return value === undefined || value === null || value === "" ? "(none)" : String(value);
}

// The row as the operator reads it before anything is written, the close column included and never altered.
export function describeRow(row, env) {
  const data = parseCloseChecklist(row?.close)?.data ?? {};
  return [
    `job ${JOB_ID} in ${dbPath(env)}`,
    `  pr_url: ${shown(row?.pr_url)}`,
    `  Closed line: ${closedLines(row)}`,
    "  close column (the true log of what the close merged; printed, never written):",
    `    prNumber: ${shown(data.prNumber)}`,
    `    headBranch: ${shown(data.headBranch)}`,
    `    noticeLine: ${shown(data.noticeLine)}`,
  ];
}

// The two changes the repair makes.
export function describeChanges() {
  return ["changes:", `  pr_url: ${FROM_URL} -> ${TO_URL}`, `  notice line: ${FROM_LINE} -> ${TO_LINE}`];
}

// The refusal printed when the row is not the one this repair was written for.
function refusalMessage() {
  return `refusing: job ${JOB_ID} does not hold the expected attribution (pr_url ${FROM_URL} and the notice line \`${FROM_LINE}\` exactly once); nothing written`;
}

// Reads job 57 without creating nor migrating the database.
async function readJobReadOnly(env) {
  return withReadOnlyStore(env, (store) => store.jobs.getJob(JOB_ID));
}

// Prints the row and what a dry run would do; writes nothing.
async function dryRun(env, io) {
  const row = await readJobReadOnly(env);
  return report({ row, env, io, apply: false });
}

// Prints the row, then writes the correction through the store's compare-and-swap.
async function applyRepair(env, io) {
  const store = openStore(env);
  try {
    const row = await store.jobs.getJob(JOB_ID);
    const code = report({ row, env, io, apply: true });
    if (code !== null) return code;
    const written = await store.jobs.correctJobPrAttribution(JOB_ID, { fromUrl: FROM_URL, toUrl: TO_URL, fromLine: FROM_LINE, toLine: TO_LINE });
    if (!written) {
      io.error(`refusing: job ${JOB_ID} changed while it was being repaired; nothing written`);
      return REFUSAL_EXIT;
    }
    io.log(`applied: pr_url and the one notice line written; the close column is untouched.`);
    return 0;
  } finally {
    await store.close();
  }
}

// Prints the row and settles every case but an apply that must still write: an exit code, or null to go on writing.
function report({ row, env, io, apply }) {
  if (!row) {
    io.error(`refusing: job ${JOB_ID} is not in ${dbPath(env)}; nothing written`);
    return REFUSAL_EXIT;
  }
  for (const line of describeRow(row, env)) io.log(line);
  const state = attributionState(row);
  if (state === "corrected") {
    io.log(`nothing to do: job ${JOB_ID} already records PR #72.`);
    return 0;
  }
  if (state === "unexpected") {
    io.error(refusalMessage());
    return REFUSAL_EXIT;
  }
  for (const line of describeChanges()) io.log(line);
  if (apply) return null;
  io.log("dry run: nothing written; re-run with --apply to write these two changes.");
  return 0;
}

// Runs the repair, dry by default; answers the exit code.
export async function main(argv = process.argv.slice(2), env = process.env, io = console) {
  const options = parseOptions(argv);
  return options.apply ? applyRepair(env, io) : dryRun(env, io);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`repair-job-pr-attribution: ${err?.message ?? String(err)}`);
      process.exitCode = 1;
    },
  );
}
