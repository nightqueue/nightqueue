import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isId } from "../../src/config/ids.mjs";
import { sessionsDir } from "../../src/config/paths.mjs";
import { probePid as queueProbePid } from "../../src/queue/registry.mjs";
import {
  createSession,
  listSessions,
  markLaunched,
  markStopped,
  probePid,
  readSession,
  removeSession,
  sessionState,
  transcriptPath,
} from "../../src/sessions/registry.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

// A temp home with its own Claude config dir and a directory sessions can run in.
function registryHome(t, name) {
  const env = makeHome(t, name);
  const base = realpathSync(makeDir(t, `${name}-host`));
  env.CLAUDE_CONFIG_DIR = join(base, "claude-config");
  return { env, base };
}

test("a created session is one private JSON file named by its ULID, with a Claude session uuid and no stored state", (t) => {
  const { env, base } = registryHome(t, "sessions-create");
  const record = createSession({ agent: "coder", agentSource: "builtin", cwd: base, worktree: join(base, "wt"), project: { id: "P1", name: "alpha", path: "/x" } }, env);
  assert.ok(isId(record.id));
  assert.match(record.claudeSessionId, /^[0-9a-f-]{36}$/);
  const path = join(sessionsDir(env), `${record.id}.json`);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), record);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(sessionsDir(env)).mode & 0o777, 0o700);
  assert.deepEqual(record.project, { id: "P1", name: "alpha" });
  assert.equal(record.worktree, join(base, "wt"));
  for (const stored of ["state", "live", "status"]) assert.equal(Object.hasOwn(record, stored), false, stored);
  assert.deepEqual(readSession(record.id, env), record);
});

test("listing returns readable sessions newest first and reports broken records apart", (t) => {
  const { env, base } = registryHome(t, "sessions-list");
  const first = createSession({ cwd: base }, env);
  const second = createSession({ cwd: base }, env);
  writeFileSync(join(sessionsDir(env), "01ARZ3NDEKTSV4RRFFQ69G5FAV.json"), "{not json");
  const { sessions, broken } = listSessions(env);
  assert.deepEqual(sessions.map((s) => s.id), [second.id, first.id]);
  assert.equal(broken.length, 1);
  assert.match(broken[0].error, /cannot be read/);
});

test("an empty home lists nothing, an unknown or malformed id is a user error", (t) => {
  const { env } = registryHome(t, "sessions-empty");
  assert.deepEqual(listSessions(env), { sessions: [], broken: [] });
  assert.throws(() => readSession("01ARZ3NDEKTSV4RRFFQ69G5FAV", env), /unknown session/);
  assert.throws(() => readSession("../x", env), /is not a session id/);
});

test("live and stopped are derived from the launch claim, never stored in the record", (t) => {
  const { env, base } = registryHome(t, "sessions-state");
  const record = createSession({ cwd: base }, env);
  assert.equal(sessionState(record, { env }), "stopped");
  const claim = markLaunched(record, env);
  assert.equal(claim.pid, process.pid);
  assert.equal(sessionState(record, { env }), "live");
  assert.equal(sessionState(record, { env, killImpl: () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); } }), "stopped");
  assert.deepEqual(readSession(record.id, env), record, "a launch never rewrites the record");
  markStopped(claim, env);
  assert.equal(sessionState(record, { env }), "stopped");
});

test("the pid probe mirrors the queue registry's", () => {
  const cases = [() => {}, () => { throw Object.assign(new Error("x"), { code: "EPERM" }); }, () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); }];
  for (const killImpl of cases) assert.equal(probePid(123, killImpl), queueProbePid(123, killImpl));
});

test("removing a session deletes only its record", (t) => {
  const { env, base } = registryHome(t, "sessions-rm");
  const worktree = join(base, "wt");
  mkdirSync(worktree);
  const record = createSession({ cwd: worktree, worktree }, env);
  removeSession(record.id, env);
  assert.throws(() => readSession(record.id, env), /unknown session/);
  assert.ok(statSync(worktree).isDirectory());
});

test("the transcript is found under any Claude project directory by the session uuid, null before the first message", (t) => {
  const { env, base } = registryHome(t, "sessions-transcript");
  const record = createSession({ cwd: base }, env);
  assert.equal(transcriptPath(record, env), null);
  const dir = join(env.CLAUDE_CONFIG_DIR, "projects", "-some-dir");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.claudeSessionId}.jsonl`), "{}\n");
  assert.equal(transcriptPath(record, env), join(dir, `${record.claudeSessionId}.jsonl`));
  assert.equal(transcriptPath({ claudeSessionId: "../x" }, env), null);
});
