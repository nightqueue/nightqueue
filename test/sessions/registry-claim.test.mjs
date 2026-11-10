import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionsDir } from "../../src/config/paths.mjs";
import { createSession, markLaunched, markStopped, readSession, removeSession, sessionState } from "../../src/sessions/registry.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

const REGISTRY_URL = new URL("../../src/sessions/registry.mjs", import.meta.url).href;
const OTHER_LSTART = "Thu Jan 1 00:00:00 1970";
const HOLD_MS = 1500;

// A temp home with one recorded session and the path of its launch claim.
function claimHome(t, name) {
  const env = makeHome(t, name);
  const base = realpathSync(makeDir(t, `${name}-host`));
  env.CLAUDE_CONFIG_DIR = join(base, "claude-config");
  const record = createSession({ cwd: base }, env);
  return { env, record, claimPath: join(sessionsDir(env), `${record.id}.launcher`) };
}

// Writes a launch claim file by hand, as another launcher would have left it.
function writeClaim(path, claim) {
  writeFileSync(path, typeof claim === "string" ? claim : JSON.stringify(claim));
}

// Runs one child process that claims the session, prints the outcome and holds the claim a moment before exiting.
function claimingChild(env, id) {
  const script = `
    const { markLaunched, readSession } = await import(${JSON.stringify(REGISTRY_URL)});
    try {
      markLaunched(readSession(${JSON.stringify(id)}), process.env);
      process.stdout.write("launched");
    } catch (err) {
      process.stdout.write(err.message);
    }
    setTimeout(() => {}, ${HOLD_MS});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  return new Promise((resolve) => child.on("exit", () => resolve(out)));
}

test("two concurrent launches of one session claim it once; the other is refused as still open", async (t) => {
  const { env, record } = claimHome(t, "claim-race");
  const outcomes = await Promise.all([claimingChild(env, record.id), claimingChild(env, record.id)]);
  assert.equal(outcomes.filter((out) => out === "launched").length, 1, JSON.stringify(outcomes));
  assert.ok(outcomes.some((out) => /still open|being launched by another process/.test(out)), JSON.stringify(outcomes));
});

test("a second launch in the same process is refused while the first holds the claim", (t) => {
  const { env, record } = claimHome(t, "claim-twice");
  const claim = markLaunched(record, env);
  assert.throws(() => markLaunched(record, env), new RegExp(`session \`${record.id}\` is still open \\(pid ${process.pid}\\)`));
  markStopped(claim, env);
  markStopped(markLaunched(record, env), env);
});

test("a live pid with another start time, or from a previous boot, does not keep a session live", (t) => {
  const { env, record, claimPath } = claimHome(t, "claim-identity");
  writeClaim(claimPath, { id: record.id, pid: process.pid, lstart: OTHER_LSTART, uptimeS: uptime() });
  assert.equal(sessionState(record, { env }), "stopped");
  assert.equal(sessionState(record, { env, psImpl: () => null }), "live", "with no ps answer the pid and boot decide");
  writeClaim(claimPath, { id: record.id, pid: process.pid, lstart: null, uptimeS: uptime() + 3600 });
  assert.equal(sessionState(record, { env }), "stopped");
  const claim = markLaunched(record, env);
  assert.equal(claim.pid, process.pid, "a stale claim is taken over");
  markStopped(claim, env);
});

test("two launchers taking over one stale claim: the one whose judgement went stale is refused", (t) => {
  const { env, record, claimPath } = claimHome(t, "claim-takeover-race");
  const deadPid = 2147483000;
  writeClaim(claimPath, { id: record.id, pid: deadPid, lstart: null, uptimeS: uptime() });
  let winner = null;
  let raced = false;
  const killImpl = (pid) => {
    if (pid !== deadPid) return true;
    if (!raced) {
      raced = true;
      winner = markLaunched(record, env, { killImpl, psImpl: () => null });
    }
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  };
  assert.throws(() => markLaunched(record, env, { killImpl, psImpl: () => null }), /being launched by another process/);
  assert.deepEqual(JSON.parse(readFileSync(claimPath, "utf8")), winner);
  assert.equal(existsSync(`${claimPath}.takeover`), false, "the takeover lock is released");
});

test("a late markStopped after removeSession does not recreate the record", (t) => {
  const { env, record } = claimHome(t, "claim-late-stop");
  const claim = markLaunched(record, env);
  removeSession(record.id, env);
  markStopped(claim, env);
  assert.throws(() => readSession(record.id, env), /unknown session/);
  assert.equal(existsSync(join(sessionsDir(env), `${record.id}.json`)), false);
});

test("markStopped never removes a claim another launcher holds", (t) => {
  const { env, record, claimPath } = claimHome(t, "claim-foreign");
  const claim = markLaunched(record, env);
  const foreign = { ...claim, lstart: OTHER_LSTART };
  writeClaim(claimPath, foreign);
  markStopped(claim, env);
  assert.deepEqual(JSON.parse(readFileSync(claimPath, "utf8")), foreign);
});

test("an unparseable claim blocks while it is fresh and is reclaimed once it is old", (t) => {
  const { env, record, claimPath } = claimHome(t, "claim-unparsed");
  writeClaim(claimPath, "");
  assert.equal(sessionState(record, { env }), "live");
  assert.throws(() => markLaunched(record, env), /still open \(pid unknown\)/);
  const past = new Date(Date.now() - 60_000);
  utimesSync(claimPath, past, past);
  assert.equal(sessionState(record, { env }), "stopped");
  markStopped(markLaunched(record, env), env);
  assert.equal(existsSync(claimPath), false);
});
