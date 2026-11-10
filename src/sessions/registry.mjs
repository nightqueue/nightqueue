import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { isId, newId } from "../config/ids.mjs";
import { sessionsDir } from "../config/paths.mjs";
import { writeFileAtomic } from "../config/store.mjs";
import { claudeConfigDir } from "../host/paths.mjs";
import { readProcess } from "../host/process-identity.mjs";

export const SESSION_SCHEMA_VERSION = 1;
const BOOT_SKEW_S = 60;
const RECORD_SUFFIX = ".json";
const CLAIM_SUFFIX = ".launcher";
const TAKEOVER_SUFFIX = ".takeover";
const UNPARSED_CLAIM_GRACE_MS = 10_000;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Path of one session's record file.
function recordPath(id, env) {
  return join(sessionsDir(env), `${id}${RECORD_SUFFIX}`);
}

// Writes one record, creating the sessions directory private to the user.
function writeRecord(record, env) {
  mkdirSync(sessionsDir(env), { recursive: true, mode: 0o700 });
  writeFileAtomic(recordPath(record.id, env), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

// Tells whether a parsed record carries the shape this version writes.
function isRecord(value, id) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.schemaVersion === SESSION_SCHEMA_VERSION &&
    value.id === id &&
    typeof value.cwd === "string" &&
    typeof value.claudeSessionId === "string" &&
    UUID_SHAPE.test(value.claudeSessionId)
  );
}

// Creates and writes the record of a new chat session, with its own ULID and the Claude session id it will be launched under.
export function createSession({ agent = null, agentSource = null, cwd, worktree = null, project = null }, env = process.env) {
  const now = new Date().toISOString();
  return writeRecord(
    {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: newId(),
      kind: "chat",
      agent,
      agentSource,
      claudeSessionId: randomUUID(),
      cwd,
      worktree,
      project: project ? { id: project.id, name: project.name } : null,
      createdAt: now,
      updatedAt: now,
    },
    env,
  );
}

// Reads one session's record, refusing an id that is not one, an unknown session or a broken record.
export function readSession(id, env = process.env) {
  if (!isId(id)) throw new UserError(`\`${id}\` is not a session id; run \`nightqueue sessions list\` to see them`);
  const path = recordPath(id, env);
  if (!existsSync(path)) throw new UserError(`unknown session \`${id}\`; run \`nightqueue sessions list\` to see them`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UserError(`the record of session \`${id}\` at ${path} cannot be read: ${err.message}`);
  }
  if (!isRecord(parsed, id)) throw new UserError(`the record of session \`${id}\` at ${path} is not a session record of version ${SESSION_SCHEMA_VERSION}`);
  return parsed;
}

// The ids of every record file in the sessions directory, none when it does not exist.
function recordIds(env) {
  try {
    return readdirSync(sessionsDir(env))
      .filter((name) => name.endsWith(RECORD_SUFFIX))
      .map((name) => name.slice(0, -RECORD_SUFFIX.length));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw new UserError(`the sessions directory ${sessionsDir(env)} cannot be read: ${err.message}`);
  }
}

// Every readable session record, newest first, and the problem of each one that is not.
export function listSessions(env = process.env) {
  const sessions = [];
  const broken = [];
  for (const id of recordIds(env)) {
    try {
      sessions.push(readSession(id, env));
    } catch (err) {
      broken.push({ id, error: err.message });
    }
  }
  sessions.sort((a, b) => (a.id < b.id ? 1 : -1));
  return { sessions, broken };
}

// Path of one session's launch claim file.
function claimPath(id, env) {
  return join(sessionsDir(env), `${id}${CLAIM_SUFFIX}`);
}

// The text of a session's launch claim, or null when there is none.
function readClaimText(id, env) {
  const path = claimPath(id, env);
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new UserError(`the launch claim of session \`${id}\` at ${path} cannot be read: ${err.message}`);
  }
}

// The launch claim a text holds, or null when it is not one.
function parseClaim(text) {
  try {
    const value = JSON.parse(text);
    return Number.isInteger(value?.pid) && value.pid > 0 ? value : null;
  } catch {
    return null;
  }
}

// Tells whether a file changed within the given milliseconds; false when it is gone.
function changedWithin(path, ms) {
  try {
    return Date.now() - statSync(path).mtimeMs < ms;
  } catch {
    return false;
  }
}

// Tells whether a claim's launcher still runs: its pid lives this boot and, when both are known, started at the recorded time.
function claimLive(claim, { killImpl, psImpl }) {
  if (probePid(claim.pid, killImpl) === "gone" || precedesThisBoot(claim)) return false;
  const started = typeof claim.lstart === "string" ? psImpl(claim.pid)?.lstart : null;
  return typeof started !== "string" || started === claim.lstart;
}

// The claim of a session's launcher that still runs (an unparseable claim while it is fresh), or null when no launcher holds it.
export function liveLauncher(record, { env = process.env, killImpl = process.kill, psImpl = readProcess } = {}) {
  const text = readClaimText(record.id, env);
  if (text === null) return null;
  const claim = parseClaim(text);
  if (claim === null) return changedWithin(claimPath(record.id, env), UNPARSED_CLAIM_GRACE_MS) ? { pid: null } : null;
  return claimLive(claim, { killImpl, psImpl }) ? claim : null;
}

// Refuses an action on a session whose launcher still runs, naming its pid.
export function refuseOpenSession(record, { env, killImpl, psImpl, action }) {
  const holder = liveLauncher(record, { env, killImpl, psImpl });
  if (holder !== null) throw new UserError(`session \`${record.id}\` is still open (pid ${holder.pid ?? "unknown"}); close it before ${action}`);
}

// Creates a launch claim exclusively; false when one already exists.
function createClaim(claim, env) {
  try {
    writeFileSync(claimPath(claim.id, env), JSON.stringify(claim), { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw new UserError(`the launch claim of session \`${claim.id}\` cannot be written: ${err.message}`);
  }
}

// Takes the takeover lock of a session's claim exclusively, refusing when another launcher holds it.
function lockTakeover(id, env) {
  const path = `${claimPath(id, env)}${TAKEOVER_SUFFIX}`;
  try {
    writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
    return path;
  } catch (err) {
    if (err?.code === "EEXIST") throw new UserError(`session \`${id}\` is being launched by another process; if none is, remove ${path}`);
    throw new UserError(`the takeover lock of session \`${id}\` at ${path} cannot be written: ${err.message}`);
  }
}

// Replaces the stale claim judged from its text by this launcher's claim under the takeover lock; false when the claim changed meanwhile.
function takeOverClaim(claim, staleText, env) {
  const lock = lockTakeover(claim.id, env);
  try {
    if (readClaimText(claim.id, env) !== staleText) return false;
    rmSync(claimPath(claim.id, env), { force: true });
    return createClaim(claim, env);
  } finally {
    rmSync(lock, { force: true });
  }
}

// Claims the launch of a session for this process, refusing one a live launcher holds; a stale claim is taken over once, atomically.
export function markLaunched(record, env = process.env, { killImpl = process.kill, psImpl = readProcess } = {}) {
  const claim = { id: record.id, pid: process.pid, lstart: psImpl(process.pid)?.lstart ?? null, uptimeS: uptime() };
  mkdirSync(sessionsDir(env), { recursive: true, mode: 0o700 });
  if (createClaim(claim, env)) return claim;
  const staleText = readClaimText(record.id, env);
  refuseOpenSession(record, { env, killImpl, psImpl, action: "resuming" });
  if (takeOverClaim(claim, staleText, env)) return claim;
  throw new UserError(`session \`${record.id}\` is being launched by another process`);
}

// Releases a launch claim: its file goes only while it still names the caller's pid and start time, and the record is never written.
export function markStopped(claim, env = process.env) {
  if (!isId(claim?.id)) return;
  const current = parseClaim(readClaimText(claim.id, env));
  if (current?.pid === claim.pid && current?.lstart === claim.lstart) rmSync(claimPath(claim.id, env), { force: true });
}

// Deletes one session's record and a claim no live launcher holds: never its worktree nor its Claude transcript.
export function removeSession(id, env = process.env) {
  const record = readSession(id, env);
  rmSync(recordPath(id, env), { force: true });
  if (liveLauncher(record, { env }) === null) rmSync(claimPath(id, env), { force: true });
  return record;
}

// Probes a pid: `alive`, `foreign` (it exists under another user) or `gone`.
export function probePid(pid, killImpl = process.kill) {
  try {
    killImpl(pid, 0);
    return "alive";
  } catch (err) {
    return err?.code === "EPERM" ? "foreign" : "gone";
  }
}

// Tells whether a launcher was recorded before this boot: inside one boot uptime only grows.
export function precedesThisBoot(launcher) {
  const recordedUptimeS = Number(launcher?.uptimeS);
  if (!Number.isFinite(recordedUptimeS)) return false;
  return recordedUptimeS > Number(uptime()) + BOOT_SKEW_S;
}

// Whether a session is `live` (a launcher holding its claim still runs) or `stopped`, derived and never stored; with no env there is no claim to read.
export function sessionState(record, { env, killImpl, psImpl } = {}) {
  if (env === undefined || !isId(record?.id)) return "stopped";
  return liveLauncher(record, { env, killImpl, psImpl }) === null ? "stopped" : "live";
}

// The transcript Claude Code wrote for the session under its projects directory, or null when there is none yet.
export function transcriptPath(record, env = process.env) {
  const sessionId = record?.claudeSessionId;
  if (typeof sessionId !== "string" || !UUID_SHAPE.test(sessionId)) return null;
  const projects = join(claudeConfigDir(env), "projects");
  try {
    const project = readdirSync(projects, { withFileTypes: true }).find(
      (entry) => entry.isDirectory() && existsSync(join(projects, entry.name, `${sessionId}.jsonl`)),
    );
    return project ? join(projects, project.name, `${sessionId}.jsonl`) : null;
  } catch {
    return null;
  }
}
