import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withPathLock } from "../config/lock.mjs";
import { gitConfigGuardDir, jobLogPath, logsDir } from "../config/paths.mjs";
import { writeFileAtomic } from "../config/store.mjs";
import { runGit } from "../host/git.mjs";
import { rowClaimOrdinal } from "./resume.mjs";
import { recordGitConfigRestore } from "./run-state.mjs";
import { canonicalPath } from "./worktree.mjs";

const DRIVER_KEY_PATTERNS = [
  /^filter\..+\.(clean|smudge|process)$/i,
  /^diff\..+\.(textconv|command)$/i,
  /^diff\.external$/i,
  /^merge\..+\.driver$/i,
  /^core\.(fsmonitor|hookspath)$/i,
  /^include\.path$/i,
  /^includeif\..+\.path$/i,
];

const VALUE_SHOWN_MAX = 200;
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const SNAPSHOT_UNREADABLE = "SNAPSHOT_UNREADABLE";
const LATE_WRITE_WATCH_MS = 10 * 60 * 1000;

// Tells whether a git config key names a program git runs, the set an attempt is not allowed to leave behind.
export function isDriverKey(name) {
  const key = String(name ?? "");
  return DRIVER_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

// First line of a failure, the way a log line carries it.
function reasonOf(err) {
  return String(err?.message ?? err).split("\n")[0];
}

// The git common dir of a checkout and the config file every worktree of it shares.
export function sharedConfigOf(checkout, env = process.env) {
  const answered = runGit({ args: ["rev-parse", "--git-common-dir"], cwd: checkout, env });
  const out = answered.stdout.trim();
  if (!answered.ok || !out) throw new Error(`git rev-parse --git-common-dir failed in ${checkout}: ${reasonOf(answered.stderr || "no answer")}`);
  const commonDir = canonicalPath(resolve(checkout, out));
  return { commonDir, configPath: join(commonDir, "config") };
}

// Parses the `-z --list` output of git config into a map from key to its ordered values, a key with no value recorded as null.
function parseConfigList(stdout) {
  const keys = new Map();
  for (const entry of stdout.split("\0").filter(Boolean)) {
    const cut = entry.indexOf("\n");
    const key = cut < 0 ? entry : entry.slice(0, cut);
    const value = cut < 0 ? null : entry.slice(cut + 1);
    keys.set(key, [...(keys.get(key) ?? []), value]);
  }
  return keys;
}

// The driver keys one config file holds right now, read without following its includes.
export function readDriverKeys(configPath, env = process.env) {
  const answered = runGit({ args: ["config", "--file", configPath, "--no-includes", "-z", "--list"], env });
  if (!answered.ok) throw new Error(`git config could not read ${configPath}: ${reasonOf(answered.stderr || "no answer")}`);
  return new Map([...parseConfigList(answered.stdout)].filter(([key]) => isDriverKey(key)));
}

// One value as a log line shows it: control and line-separator characters blanked, capped, quoted.
function shownValue(value) {
  if (value === null) return "(no value)";
  const clean = Array.from(String(value).replace(UNPRINTABLE, " ")).slice(0, VALUE_SHOWN_MAX).join("");
  return JSON.stringify(clean);
}

// The values of one key as a log line shows them.
function shownValues(values) {
  return values.map(shownValue).join(", ");
}

// A key as a log line shows it, with no character that could break the line.
function shownKey(key) {
  return String(key).replace(UNPRINTABLE, " ");
}

// Tells whether two value lists of a key are the same, absent included.
function sameValues(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

// Runs one write of git config on the shared file, answering null when git accepted it, else its reason.
function configWrite(configPath, args, env) {
  const answered = runGit({ args: ["config", "--file", configPath, ...args], env });
  return answered.ok ? null : reasonOf(answered.stderr || "no answer");
}

// Writes the baseline values of one key: the first replaces every current value in one write, so a refused write never leaves the key without one, the rest are added in order.
function writeBaselineValues({ configPath, key, values, env }) {
  const [first, ...rest] = values.map((value) => value ?? "true");
  const replaced = configWrite(configPath, ["--replace-all", "--", key, first], env);
  return replaced ?? rest.map((value) => configWrite(configPath, ["--add", "--", key, value], env)).find(Boolean) ?? null;
}

// Puts one key back to what the baseline holds: dropped when the baseline has none, else rewritten to the baseline values.
function restoreKey({ configPath, key, before, now, env }) {
  const failure = before === null ? configWrite(configPath, ["--unset-all", "--", key], env) : writeBaselineValues({ configPath, key, values: before, env });
  if (failure !== null) return { ok: false, line: `git config: could not restore ${shownKey(key)}: ${failure}` };
  if (before === null) return { ok: true, line: `git config: removed ${shownKey(key)} = ${shownValues(now)} (written during the attempt)` };
  return { ok: true, line: `git config: restored ${shownKey(key)} to ${shownValues(before)} (was ${now === null ? "absent" : shownValues(now)})` };
}

// Puts every driver key of the shared config back to the baseline, answering one line per key it touched and whether any write failed.
function restoreToBaseline(configPath, baseline, env) {
  const current = readDriverKeys(configPath, env);
  const keys = [...new Set([...baseline.keys(), ...current.keys()])].filter((key) => !sameValues(baseline.get(key), current.get(key)));
  const outcomes = keys.map((key) => restoreKey({ configPath, key, before: baseline.get(key) ?? null, now: current.get(key) ?? null, env }));
  return { lines: outcomes.map((outcome) => outcome.line), failed: outcomes.some((outcome) => !outcome.ok) };
}

// Path of the snapshot file of one git common dir.
function baselinePath(commonDir, env) {
  return join(gitConfigGuardDir(env), `${createHash("sha256").update(commonDir).digest("hex").slice(0, 16)}.json`);
}

// The failure of a snapshot file that is not one, marked so a claim can move it aside and take a fresh one.
function unreadableSnapshot(path, why) {
  const err = new Error(`the git config snapshot ${path} ${why}`);
  err.code = SNAPSHOT_UNREADABLE;
  return err;
}

// Tells whether a baseline value list is the shape the guard writes: one value or more, each a string or null.
function isValueList(values) {
  return Array.isArray(values) && values.length > 0 && values.every((value) => value === null || typeof value === "string");
}

// Tells whether a holder entry names a job.
function isHolder(holder) {
  return holder !== null && typeof holder === "object" && holder.jobId !== undefined && holder.jobId !== null;
}

// Tells whether the restore a snapshot owes after its last release has the shape the guard writes.
function isOwed(owed) {
  return owed === undefined || (owed !== null && typeof owed === "object" && isHolder(owed.holder) && (owed.until === null || Number.isFinite(Date.parse(owed.until))));
}

// Tells whether a parsed snapshot has the shape the guard writes: its config path, a map of value lists, its holders and what it still owes.
function isSnapshot(parsed) {
  const keys = parsed?.keys;
  const keysOk = keys !== null && typeof keys === "object" && !Array.isArray(keys) && Object.values(keys).every(isValueList);
  return typeof parsed?.configPath === "string" && keysOk && Array.isArray(parsed.holders) && parsed.holders.every(isHolder) && isOwed(parsed.owed);
}

// Reads one snapshot file, null when there is none; a file that is not a snapshot fails as unreadable, with its path.
function readBaseline(path) {
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw unreadableSnapshot(path, `cannot be read (${reasonOf(err)})`);
  }
  if (!isSnapshot(parsed)) throw unreadableSnapshot(path, "is malformed");
  return parsed;
}

// The baseline keys of a snapshot as a map.
function baselineKeys(baseline) {
  return new Map(Object.entries(baseline.keys));
}

// Writes a snapshot.
function writeBaseline(path, baseline) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

// Deletes a snapshot nothing is owed to any more.
function dropBaseline(path) {
  rmSync(path, { force: true });
  return null;
}

// The restore a snapshot owes once its last holder is gone: a watch for late writes that ends after a while, or a retry with no end after a failed restore.
function owedAfter(holder, restoreFailed) {
  return { holder, until: restoreFailed ? null : new Date(Date.now() + LATE_WRITE_WATCH_MS).toISOString() };
}

// The holders a snapshot still owes a restore to besides its dead ones: the last holder while its watch or retry lasts.
function owedHolders(baseline) {
  const owed = baseline.owed;
  if (owed === undefined) return [];
  return owed.until === null || Date.parse(owed.until) > Date.now() ? [owed.holder] : [];
}

// Moves an unreadable snapshot aside so a fresh one guards the claim, answering the line that says so.
function setSnapshotAside(path, err) {
  const aside = `${path}.unreadable-${Date.now()}`;
  renameSync(path, aside);
  return `git config: ${reasonOf(err)}; it was moved to ${aside} and a new snapshot was taken`;
}

// Tells whether two holders are the same claim of the same job.
function sameHolder(left, right) {
  return left.jobId === right.jobId && left.ordinal === right.ordinal;
}

// The holder entry of one claimed job.
function holderOf(job, slug = job.slug) {
  return { jobId: job.id, ordinal: Number.isInteger(job.claim_attempt) ? job.claim_attempt : null, projectId: job.project_id, slug, at: new Date().toISOString() };
}

// Whether a holder's claim is still running; a liveness that cannot be read counts as live, so nothing is restored on a guess.
async function isHolderLive(isLive, holder) {
  try {
    return (await isLive(holder)) !== false;
  } catch {
    return true;
  }
}

// The liveness of a holder read from the queue: its job running under the same claim.
export function holderLiveness(store) {
  return async (holder) => {
    const row = await store.jobs.getJob(holder.jobId);
    return row?.status === "running" && rowClaimOrdinal(row) === holder.ordinal;
  };
}

// Splits the holders of a snapshot into the live ones and the dead ones.
async function splitHolders(holders, isLive) {
  const live = [];
  const dead = [];
  for (const holder of holders) (await isHolderLive(isLive, holder) ? live : dead).push(holder);
  return { live, dead };
}

// Drops the dead holders of one snapshot and, when none is left alive, restores the config to it for every holder it still owes; answers the snapshot left and the lines owed to each of them.
async function reconcileBaseline(path, isLive, env) {
  const baseline = readBaseline(path);
  if (baseline === null) return { baseline: null, notes: [] };
  const { live, dead } = await splitHolders(baseline.holders, isLive);
  if (live.length > 0) return { baseline: dead.length ? writeBaseline(path, { ...baseline, holders: live }) : baseline, notes: [] };
  const owed = [...dead, ...owedHolders(baseline)];
  if (!owed.length) return { baseline: dropBaseline(path), notes: [] };
  if (!existsSync(baseline.configPath)) {
    return { baseline: dropBaseline(path), notes: owed.map((holder) => ({ holder, lines: [`git config: ${shownKey(baseline.configPath)} is gone; its snapshot was dropped`] })) };
  }
  const restored = restoreToBaseline(baseline.configPath, baselineKeys(baseline), env);
  const left = restored.failed ? writeBaseline(path, { ...baseline, holders: [], owed: owedAfter(owed.at(-1), true) }) : dropBaseline(path);
  return { baseline: left, notes: owed.map((holder) => ({ holder, lines: restored.lines })) };
}

// Reconciles the snapshot a claim is about to join; one that is unreadable is set aside, so the claim takes a fresh snapshot instead of running unguarded.
async function reconcileForClaim({ path, holder, isLive, env }) {
  try {
    return await reconcileBaseline(path, isLive, env);
  } catch (err) {
    if (err?.code !== SNAPSHOT_UNREADABLE) throw err;
    return { baseline: null, notes: [{ holder, lines: [setSnapshotAside(path, err)] }] };
  }
}

// Adds one holder to the snapshot of a shared config, taking the snapshot when nobody holds it yet.
async function addHolder({ path, shared, holder, isLive, env }) {
  const { baseline, notes } = await reconcileForClaim({ path, holder, isLive, env });
  const base = baseline ?? { ...shared, keys: Object.fromEntries(readDriverKeys(shared.configPath, env)), holders: [] };
  writeBaseline(path, { ...base, holders: [...base.holders.filter((held) => !sameHolder(held, holder)), holder], owed: undefined });
  return notes;
}

// Restores the config to its snapshot and removes one holder; the last one leaves the snapshot owing a watch for late writes. Answers the lines of what was restored.
function dropHolder(path, holder, env) {
  const baseline = readBaseline(path);
  if (baseline === null) return [];
  const restored = restoreToBaseline(baseline.configPath, baselineKeys(baseline), env);
  const holders = baseline.holders.filter((held) => !sameHolder(held, holder));
  writeBaseline(path, { ...baseline, holders, owed: holders.length ? undefined : owedAfter(holder, restored.failed) });
  return restored.lines;
}

// Appends one line to the log of a job; a log that refuses the write never costs the run.
function appendGuardLog(jobId, line, env) {
  try {
    mkdirSync(logsDir(env), { recursive: true });
    appendFileSync(jobLogPath(jobId, env), `${line}\n`);
  } catch {
    return;
  }
}

// Writes the lines of one restore to the job's log and to the state of its run.
export function noteConfigRestore({ holder, lines }, env = process.env) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  for (const line of lines) appendGuardLog(holder.jobId, line, env);
  const written = recordGitConfigRestore({ projectId: holder.projectId, slug: holder.slug, ordinal: holder.ordinal, lines, env });
  if (written.status !== "written") appendGuardLog(holder.jobId, `the git config restore could not be recorded in the state of the run: ${written.reason}`, env);
}

// Snapshots the driver keys of the config a job's checkout shares and registers the attempt as one of its holders; a failure is one job-log line and never gates the job.
export async function holdSharedConfig({ job, checkout, store, env = process.env }) {
  try {
    const shared = sharedConfigOf(checkout, env);
    const path = baselinePath(shared.commonDir, env);
    const notes = await withPathLock(`${path}.lock`, () => addHolder({ path, shared, holder: holderOf(job), isLive: holderLiveness(store), env }));
    for (const note of notes) noteConfigRestore(note, env);
    return { ok: true, path };
  } catch (err) {
    appendGuardLog(job.id, `the shared git config could not be snapshot: ${reasonOf(err)}; driver keys this attempt writes will not be restored`, env);
    return { ok: false, path: null };
  }
}

// Restores the shared config to its snapshot at the end of an attempt and drops the attempt as a holder, noting one line per key it touched.
export async function releaseSharedConfig({ hold, job, slug = job.slug, env = process.env }) {
  if (!hold?.ok) return [];
  const holder = holderOf(job, slug);
  try {
    const lines = await withPathLock(`${hold.path}.lock`, () => dropHolder(hold.path, holder, env));
    noteConfigRestore({ holder, lines }, env);
    return lines;
  } catch (err) {
    appendGuardLog(job.id, `the shared git config could not be restored: ${reasonOf(err)}`, env);
    return [];
  }
}

// The snapshot files of this home.
function baselineFiles(env) {
  try {
    return readdirSync(gitConfigGuardDir(env)).filter((name) => name.endsWith(".json")).map((name) => join(gitConfigGuardDir(env), name));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

// Restores every shared config whose holders all died without releasing it (a killed runner), answering the reasons of the snapshots it could not reconcile.
export async function recoverSharedConfigs({ store, isLive = holderLiveness(store), env = process.env }) {
  const errors = [];
  for (const path of baselineFiles(env)) {
    try {
      const { notes } = await withPathLock(`${path}.lock`, () => reconcileBaseline(path, isLive, env));
      for (const note of notes) noteConfigRestore(note, env);
    } catch (err) {
      errors.push(reasonOf(err));
    }
  }
  return errors;
}
