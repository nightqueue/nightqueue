import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { newId } from "../../src/config/ids.mjs";
import { qaDir, qaWorktreePath } from "../../src/config/paths.mjs";
import { runSubagentStop } from "../../src/hooks/subagent-stop.mjs";
import { operatorSettings } from "../../src/host/settings.mjs";
import {
  QA_WORKTREE_TTL_MS,
  createQaWorktree,
  dropQaWorktree,
  listQaWorktrees,
  sweepQaWorktrees,
} from "../../src/queue/qa-worktree.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { deadPid, git, gitVars, registeredWorktrees } from "../../test-support/worktrees.mjs";

const HOUR_MS = 3600 * 1000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// An id born at a past time: `newId` is monotonic within a process, so it cannot hand one out after a later id.
function pastId(ms) {
  let value = ms;
  let time = "";
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[value % 32] + time;
    value = Math.floor(value / 32);
  }
  return `${time}${"0".repeat(16)}`;
}

// A registered qa worktree whose id says it was born `ageMs` ago, unlocked.
function addAgedWorktree({ env, project, ageMs }) {
  const path = qaWorktreePath(project.id, pastId(Date.now() - ageMs), env);
  mkdirSync(dirname(path), { recursive: true });
  git(["-C", project.path, "worktree", "add", "-q", "--detach", path, "HEAD"]);
  return path;
}

// A temporary home with one real registered checkout `alpha`, in a hermetic git environment.
function qaFixture(t) {
  const env = { ...makeHome(t, "qa-worktree"), ...gitVars() };
  const checkout = realpathSync(initGitRepo(makeDir(t, "qa-alpha")));
  const row = registerCheckout(env, { path: checkout, name: "alpha" });
  const project = { id: row.id, name: "alpha", path: checkout };
  return { env, checkout, project };
}

// A kill seam that answers for the listed live pids and reports every other one gone.
function killOnly(livePids) {
  return (pid) => {
    if (livePids.includes(pid)) return true;
    const err = new Error("no such process");
    err.code = "ESRCH";
    throw err;
  };
}

// Runs the CLI in process over a home, capturing its output lines.
async function cli(env, argv) {
  const out = [];
  const errors = [];
  const ctx = { ...defaultContext(), env, cwd: env.NIGHTQUEUE_HOME, out: (line) => out.push(line), err: (line) => errors.push(line) };
  const code = await run(argv, ctx);
  return { code, out, errors };
}

test("createQaWorktree adds a detached worktree under qa/<project id>/<id>, locked to the operator pid when one is recorded", (t) => {
  const { env, checkout, project } = qaFixture(t);
  const path = createQaWorktree({ project, env: { ...env, NIGHTQUEUE_OPERATOR_PID: "4242" } });
  assert.equal(realpathSync(join(path, "..")), realpathSync(join(qaDir(env), project.id)));
  assert.equal(git(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]).trim(), "HEAD");
  const listed = git(["-C", checkout, "worktree", "list", "--porcelain"]);
  assert.match(listed, /locked nightqueue qa \(pid 4242\)/);
  const unlocked = createQaWorktree({ project, env });
  assert.equal(git(["-C", checkout, "worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("locked")).length, 1);
  assert.ok(existsSync(unlocked));
});

test("dropQaWorktree removes and prunes a locked worktree, answers gone the second time, and refuses a path outside qa/", (t) => {
  const { env, checkout, project } = qaFixture(t);
  const path = createQaWorktree({ project, env: { ...env, NIGHTQUEUE_OPERATOR_PID: String(process.pid) } });
  assert.deepEqual(dropQaWorktree({ path, checkout, env }), { dropped: true, reason: null });
  assert.equal(existsSync(path), false);
  assert.deepEqual(registeredWorktrees(checkout), []);
  assert.deepEqual(dropQaWorktree({ path, checkout, env }), { dropped: false, reason: "gone" });
  assert.throws(() => dropQaWorktree({ path: checkout, checkout, env }), /not a qa worktree/);
  assert.throws(() => dropQaWorktree({ path: join(qaDir(env), project.id), checkout, env }), /not a qa worktree/);
});

test("sweepQaWorktrees drops the old, the dead-owned and the missing ones, and leaves a young live one and anything that is not a qa worktree", (t) => {
  const { env, checkout, project } = qaFixture(t);
  const now = Date.now();
  const old = addAgedWorktree({ env, project, ageMs: 7 * HOUR_MS });
  const dead = createQaWorktree({ project, env: { ...env, NIGHTQUEUE_OPERATOR_PID: String(deadPid()) }, now });
  const live = createQaWorktree({ project, env: { ...env, NIGHTQUEUE_OPERATOR_PID: String(process.pid) }, now });
  const missing = createQaWorktree({ project, env, now });
  rmSync(missing, { recursive: true, force: true });
  const notAnId = join(qaDir(env), project.id, "scratch");
  mkdirSync(notAnId, { recursive: true });
  const unregistered = join(qaDir(env), project.id, newId());
  mkdirSync(unregistered, { recursive: true });
  writeFileSync(join(unregistered, "keep.txt"), "x");
  const swept = sweepQaWorktrees({ env, projects: [project], killImpl: killOnly([process.pid]), now });
  assert.deepEqual(swept.failed, []);
  assert.deepEqual(swept.dropped.map((row) => basename(row.path)).sort(), [old, dead, missing].map((path) => basename(path)).sort());
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(dead), false);
  assert.ok(existsSync(live));
  assert.ok(existsSync(notAnId));
  assert.ok(existsSync(join(unregistered, "keep.txt")));
  assert.deepEqual(registeredWorktrees(checkout).map((path) => realpathSync(path)), [realpathSync(live)]);
});

test("listQaWorktrees ages a worktree by its id and reports what is not a qa worktree as foreign, writing nothing", (t) => {
  const { env, project } = qaFixture(t);
  const now = Date.now();
  addAgedWorktree({ env, project, ageMs: 2 * HOUR_MS });
  mkdirSync(join(qaDir(env), "not-a-project"), { recursive: true });
  const rows = listQaWorktrees({ env, projects: [project], now });
  const qa = rows.find((row) => !row.foreign);
  assert.ok(qa.ageMs >= 2 * HOUR_MS && qa.ageMs < QA_WORKTREE_TTL_MS);
  assert.equal(qa.stale, false);
  assert.equal(qa.ownerState, "none");
  assert.equal(rows.filter((row) => row.foreign).length, 1);
});

test("nightqueue sandbox worktree prints QA_WORKTREE, --drop removes it, and both are refused inside a job against the runner home", async (t) => {
  const { env } = qaFixture(t);
  const created = await cli(env, ["sandbox", "worktree", "alpha"]);
  assert.equal(created.code, 0, created.errors.join("\n"));
  assert.equal(created.out.length, 1);
  const [, path] = /^QA_WORKTREE: (.+)$/.exec(created.out[0]);
  assert.ok(existsSync(path));
  const dropped = await cli(env, ["sandbox", "worktree", "--drop", path]);
  assert.deepEqual(dropped.out, [`dropped ${path}`]);
  assert.equal(existsSync(path), false);
  assert.deepEqual((await cli(env, ["sandbox", "worktree", "--drop", path])).out, [`gone ${path}`]);
  const insideJob = { ...env, NIGHTQUEUE_JOB_ID: "7", NIGHTQUEUE_JOB_HOME: env.NIGHTQUEUE_HOME };
  const refused = await cli(insideJob, ["sandbox", "worktree", "alpha"]);
  assert.equal(refused.code, 1);
  assert.match(refused.errors.join("\n"), /refused/);
});

test("nightqueue sandbox worktree --drop refuses a worktree another live session holds, and drops its own, an unlocked or a dead-owned one", async (t) => {
  const { env, project } = qaFixture(t);
  const session = { ...env, NIGHTQUEUE_MODE: "operator", NIGHTQUEUE_OPERATOR_PID: "999999" };
  const foreign = createQaWorktree({ project, env: { ...env, NIGHTQUEUE_OPERATOR_PID: String(process.pid) } });
  const refused = await cli(session, ["sandbox", "worktree", "--drop", foreign]);
  assert.equal(refused.code, 1);
  assert.match(refused.errors.join("\n"), new RegExp(`locked by the live operator session pid ${process.pid}`));
  assert.ok(existsSync(foreign));
  const owned = createQaWorktree({ project, env: { ...env, NIGHTQUEUE_OPERATOR_PID: String(process.pid) } });
  const ownSession = { ...session, NIGHTQUEUE_OPERATOR_PID: String(process.pid) };
  for (const path of [owned, createQaWorktree({ project, env }), createQaWorktree({ project, env: { ...env, NIGHTQUEUE_OPERATOR_PID: String(deadPid()) } })]) {
    const dropped = await cli(path === owned ? ownSession : session, ["sandbox", "worktree", "--drop", path]);
    assert.deepEqual(dropped.out, [`dropped ${path}`], dropped.errors.join("\n"));
    assert.equal(existsSync(path), false);
  }
});

test("the SubagentStop hook drops the qa worktree its own session announced and keeps one another live session holds", (t) => {
  const { env, project } = qaFixture(t);
  const session = { ...env, NIGHTQUEUE_MODE: "operator", NIGHTQUEUE_OPERATOR_PID: "999999" };
  const own = createQaWorktree({ project, env: session });
  const other = createQaWorktree({ project, env: { ...env, NIGHTQUEUE_OPERATOR_PID: String(process.pid) } });
  const stop = (path, agentType = "nightqueue:qa", hookEnv = session) =>
    runSubagentStop({ input: { hook_event_name: "SubagentStop", agent_type: agentType, last_assistant_message: `QA_WORKTREE: ${path}\nreproduced` }, env: hookEnv });
  assert.equal(stop(own, "nightqueue:triage"), "");
  assert.ok(existsSync(own));
  assert.equal(stop(own, "nightqueue:qa", { ...session, NIGHTQUEUE_JOB_ID: "3" }), "");
  assert.ok(existsSync(own));
  assert.equal(stop(own), "");
  assert.equal(existsSync(own), false);
  assert.equal(stop(other), "");
  assert.ok(existsSync(other));
  assert.equal(runSubagentStop({ input: { hook_event_name: "SubagentStop", agent_type: "qa", last_assistant_message: 42 }, env: session }), "");
});

// The checks of `nightqueue doctor --json` over a home, gh answered by a fake so nothing leaves the machine.
async function doctorChecks(env, args = []) {
  const out = [];
  const spawnSyncImpl = (file, argv, options) => (file === "gh" ? { status: 1, stdout: "", stderr: "no token" } : defaultContext().spawnSyncImpl(file, argv, options));
  await run(["doctor", "--json", ...args], { ...defaultContext(), env, out: (line) => out.push(line), err: () => {}, spawnSyncImpl });
  return JSON.parse(out[0]).checks;
}

test("doctor lists the qa worktrees without writing, and doctor --fix drops the stale one only", async (t) => {
  const { env, project } = qaFixture(t);
  const old = addAgedWorktree({ env, project, ageMs: 7 * HOUR_MS });
  const live = createQaWorktree({ project, env: { ...env, NIGHTQUEUE_OPERATOR_PID: String(process.pid) } });
  const rowOf = (checks, path) => checks.find((check) => check.name === `qa alpha/${basename(path)}`);
  const before = await doctorChecks(env);
  assert.equal(rowOf(before, old).status, "warn");
  assert.match(rowOf(before, old).detail, /^stale \(age 7h\)/);
  assert.equal(rowOf(before, live).status, "ok");
  assert.match(rowOf(before, live).detail, new RegExp(`^in use by pid ${process.pid}`));
  assert.ok(existsSync(old));
  const after = await doctorChecks(env, ["--fix"]);
  assert.deepEqual([rowOf(after, old).status, rowOf(after, old).detail], ["ok", "removed: stale qa worktree"]);
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(live));
});

test("operatorSettings wires the SubagentStop hook", (t) => {
  const env = makeHome(t, "qa-settings");
  const [group] = operatorSettings(env).hooks.SubagentStop;
  assert.match(group.hooks[0].command, / hook subagent-stop$/);
});
