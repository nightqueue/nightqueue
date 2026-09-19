import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, runDir } from "../config/paths.mjs";
import { packageRoot } from "../host/paths.mjs";
import { sqliteToIso } from "../memory/schema.mjs";
import { openStore } from "../store/open.mjs";
import { classifyJobResult } from "./classify.mjs";
import { isSafeSegment, readRunState, writeRunTerminal } from "./resume.mjs";
import { lastAttemptStream } from "./stream.mjs";

// Statuses a re-classification may correct: a row that ended badly, never one the queue still owes work for.
const REPAIRABLE_STATUSES = new Set(["gate", "failed"]);

// The `result` the finish recorded, as an object; anything else is no ending to re-derive from.
function parseResult(value) {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// How the process of the last attempt ended, taken from the row: the repair re-reads the stream, never the ending.
function endingFromRow(id, row) {
  const result = parseResult(row.result);
  if (!Number.isInteger(result?.exitCode)) {
    throw new UserError(`job \`${id}\` recorded no exit code; there is no ending to re-classify it against`);
  }
  return { exitCode: result.exitCode, timedOut: result.timedOut === true, idleTimedOut: result.idleTimedOut === true, stopped: false };
}

// The persisted stream of a job, the raw evidence the re-classification reads.
function readJobLog(id, env) {
  const path = jobLogPath(id, env);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new UserError(`the log of job \`${id}\` is not on disk (${path}); there is nothing to re-classify`);
  }
}

// Refuses, by name, every row a re-classification must never rewrite.
function refuseRow(id, row, active) {
  if (active) throw new UserError(`job \`${id}\` is running with a live lease on worker \`${row.worker}\`; stop that runner first`);
  if (!REPAIRABLE_STATUSES.has(row.status)) {
    throw new UserError(`job \`${id}\` is \`${row.status}\`; only a \`gate\` or a \`failed\` job is re-classified`);
  }
}

// Tells whether the re-derived outcome says anything the witness next to the run does not already say.
function differsFromWitness(row, outcome) {
  if (outcome.status !== row.status) return true;
  return Boolean(outcome.prUrl) && outcome.prUrl !== row.pr_url;
}

// Tells whether the re-derived notice corrects the one the row carries; an outcome with no notice never erases one.
function noticeDiffers(row, outcome) {
  return Boolean(outcome.noticeMd) && outcome.noticeMd !== row.notice_md;
}

// Rewrites the witness next to the run, so the file and the row agree once the repair has written both.
function mirrorWitness(row, outcome, env) {
  return writeRunTerminal({
    project: row.project,
    slug: row.slug,
    terminal: {
      status: outcome.status,
      prUrl: outcome.prUrl ?? null,
      finishedAt: sqliteToIso(row.finished_at) ?? new Date().toISOString(),
      writtenBy: packageRoot(),
      pid: process.pid,
    },
    env,
  });
}

// Re-derives the outcome of a gated or failed job from its own log and state.json, writing the row and the witness when it changed.
export async function reclassifyFromLog({ id, env = process.env } = {}) {
  const jobs = openStore(env).jobs;
  const row = await jobs.getJob(id);
  if (!row) throw new UserError(`unknown job \`${id}\``);
  refuseRow(id, row, await jobs.isJobActive(id));
  const log = lastAttemptStream(readJobLog(id, env));
  const ending = endingFromRow(id, row);
  const planPath = isSafeSegment(row.slug) ? join(runDir(row.project, row.slug, env), "03-plan.md") : null;
  const outcome = classifyJobResult({ log, ...ending, state: readRunState({ project: row.project, slug: row.slug, env }), planPath });
  const witness = differsFromWitness(row, outcome);
  const notice = noticeDiffers(row, outcome);
  if (!witness && !notice) return { id, from: row.status, to: row.status, prUrl: row.pr_url ?? null, changed: false, noticeOnly: false };
  const written = await jobs.reclassifyJob(id, { status: outcome.status, prUrl: outcome.prUrl, noticeMd: outcome.noticeMd });
  if (!written) throw new UserError(`job \`${id}\` changed while it was being re-classified; read it again with \`nightshift queue status ${id}\``);
  if (witness) mirrorWitness(row, outcome, env);
  return { id, from: row.status, to: outcome.status, prUrl: outcome.prUrl ?? row.pr_url ?? null, changed: true, noticeOnly: !witness };
}
