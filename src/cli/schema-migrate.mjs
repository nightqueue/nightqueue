import { existsSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { lockOwnerPid, lockPath } from "../config/lock.mjs";
import { dbPath, preVersionBackupPath } from "../config/paths.mjs";
import { DB_USER_VERSION } from "../memory/schema.mjs";
import { jobRef } from "../memory/refs.mjs";
import { liveRunnersReport } from "../queue/registry.mjs";
import { homeActivity, homeSchema, migrateHome } from "../store/open.mjs";

export const SCHEMA_LABEL = "database schema";

export const SCHEMA_PARENT_ENV = "NIGHTQUEUE_SCHEMA_PARENT";

// Tells whether this `update --schema-only` was spawned by an update/setup that holds the home lock for it: the token names this process's parent and the lock records that parent as its owner.
export function borrowsParentLock(env, ppid = process.ppid) {
  return env?.[SCHEMA_PARENT_ENV] === String(ppid) && lockOwnerPid(lockPath(env)) === ppid;
}

// How one live registered process is named: its pid, and the job it runs or closes when it holds one.
function runnerLabel(runner) {
  if (!Number.isInteger(runner.jobId)) return `pid ${runner.pid}`;
  const job = runner.mode === "close" ? `close ${jobRef(runner.jobId)}` : jobRef(runner.jobId);
  return `pid ${runner.pid} (${job})`;
}

// Every process and lease that blocks the migration, named one by one; empty when the home is idle.
function blockers(runners, activity) {
  return [
    ...runners.map(runnerLabel),
    ...activity.liveJobs.map((id) => `${jobRef(id)} (live lease)`),
    ...activity.liveCloses.map((id) => `close ${jobRef(id)} (live close lease)`),
  ];
}

// The registered live runners and closes; a registry that cannot be listed refuses, since a live runner may then be invisible.
function liveRunnersOrRefuse(ctx, from) {
  const { runners, error } = liveRunnersReport(ctx.env, ctx.killImpl);
  if (error === null) return runners;
  throw new UserError(
    `the database must migrate from v${from} to v${DB_USER_VERSION}, but the runner registry cannot be listed (${error}), so a live runner may be invisible; nothing was written`,
  );
}

// Refuses the migration while anything uses the home: a registered runner or close, a job or a close holding a live lease. There is no force.
async function refuseBusyHome(ctx, from) {
  const runners = liveRunnersOrRefuse(ctx, from);
  const activity = await homeActivity(ctx.env);
  const named = blockers(runners, activity);
  if (named.length) {
    throw new UserError(
      `the database must migrate from v${from} to v${DB_USER_VERSION}, but ${named.join(", ")} still use it - stop them (\`nightqueue queue run --stop\`, wait for a close to finish) and run \`nightqueue update\` again; nothing was written`,
    );
  }
  return activity;
}

// Warns about the `running` rows whose lease expired: a dead runner left them, and the first runner after the migration recovers them.
function warnStaleRunning(ctx, activity) {
  for (const id of activity.staleRunning) ctx.err(`warning: ${jobRef(id)} is \`running\` with an expired lease; the next runner recovers it`);
}

// Where the copy taken before this migration goes: `nightqueue.db.pre-v<N>`, or a stamped name beside it so an earlier copy is never overwritten.
function backupPathFor(env) {
  const base = preVersionBackupPath(env, DB_USER_VERSION);
  if (!existsSync(base)) return base;
  return `${base}.${new Date().toISOString().replace(/[-:.]/g, "")}`;
}

// The refusal of a database newer than this build, which no migration of this build may touch.
function newerRefusal(env, version) {
  return new UserError(
    `the database at ${dbPath(env)} is at schema v${version}, newer than this nightqueue (v${DB_USER_VERSION}): update nightqueue / restart the client that runs the old version`,
  );
}

// The single migrator of a home's database, run by `nightqueue update --schema-only` under the home lock: refuses a busy home, backs the file up, then migrates it; a file it cannot read is left to `doctor`, never a block on the install that may repair it.
export async function migrateHomeSchema(ctx) {
  const schema = await homeSchema(ctx.env);
  if (!schema.exists) {
    ctx.out(`${SCHEMA_LABEL}: no database yet`);
    return { status: "none" };
  }
  if (schema.unknown) {
    ctx.out(`${SCHEMA_LABEL}: unreadable, left as it is (run \`nightqueue doctor --db\`)`);
    return { status: "unreadable" };
  }
  if (schema.version > DB_USER_VERSION) throw newerRefusal(ctx.env, schema.version);
  if (schema.fresh || schema.version === DB_USER_VERSION) {
    ctx.out(`${SCHEMA_LABEL}: v${DB_USER_VERSION} (current)`);
    return { status: "current" };
  }
  const activity = await refuseBusyHome(ctx, schema.version);
  warnStaleRunning(ctx, activity);
  const result = await migrateHome(ctx.env, { backupPath: backupPathFor(ctx.env) });
  if (!result.migrated) {
    ctx.out(`${SCHEMA_LABEL}: v${DB_USER_VERSION} (current)`);
    return { status: "current" };
  }
  ctx.out(`${SCHEMA_LABEL}: v${schema.version} -> v${DB_USER_VERSION} (backup at ${result.backup})`);
  return { status: "migrated", from: schema.version, to: DB_USER_VERSION, backup: result.backup };
}
