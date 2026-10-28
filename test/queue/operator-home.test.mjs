import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { newId } from "../../src/config/ids.mjs";
import { dbPath, homeDir, secretsPath } from "../../src/config/paths.mjs";
import { operatorDecision } from "../../src/hooks/operator-guard.mjs";
import { acquireClose, addJob, cancelJob, claimJobById, finishJob, retryJob } from "../../src/memory/jobs.mjs";
import { registeredCheckouts } from "../../src/memory/registry-access.mjs";
import { consentBash, neverBashReason } from "../../src/queue/operator-bands.mjs";
import { recordConsent } from "../../src/queue/operator-consent.mjs";
import { WORKTREE_READ_SPELLING, homeEntry, homeOwner, homeSegment } from "../../src/queue/operator-home.mjs";
import { saveRunState } from "../../src/queue/resume.mjs";
import { isolatedHostVars } from "../../test-support/host.mjs";
import { ensureProject, makeDir, makeHome, makeProject, projectIdOf, seedClosedJob, seedDoneJob } from "../../test-support/memory.mjs";

const WORKER = "test:operator-home";
const HARDENED = "-c core.fsmonitor=false -c core.hooksPath=/dev/null";
const HARDENED_WORDS = HARDENED.split(" ");
const READ_HARDENED = /never \(a worktree under the nightqueue home is read only hardened.*core\.fsmonitor=false -c core\.hooksPath=\/dev\/null/;
const GREP_UNHARDENED = /never \(`git grep` runs only hardened and with no lazy fetch.*--no-lazy-fetch grep \[--cached\] <options>/;
const WORKTREE_CD_NEVER = /never \(a worktree under the nightqueue home is read only through `git -C <worktree>`, never after a `cd` into it: `git -C <worktree> -c core\.fsmonitor=false/;

// A home at `~/.nightqueue` of its own user home, one registered checkout, one run dir and one worktree of a project.
function homeFixture(t) {
  const env = makeHome(t, "operator-home");
  const base = makeDir(t, "operator-home-host");
  Object.assign(env, { HOME: join(base, "user"), CLAUDE_CONFIG_DIR: join(base, "claude") });
  env.NIGHTQUEUE_HOME = join(env.HOME, ".nightqueue");
  const checkout = makeProject(t, env, "alpha");
  const home = homeDir(env);
  const projectId = newId();
  const run = join(home, "runs", projectId, "fix-login");
  const worktree = join(home, "worktrees", projectId, "fix-login");
  mkdirSync(join(run, "sub"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return { env, checkout, home, projectId, run, worktree, outside: makeDir(t, "operator-home-outside") };
}

test("homeEntry classifies a run dir or worktree, and refuses every other home path", (t) => {
  const { env, home, projectId, run, worktree, outside } = homeFixture(t);
  assert.deepEqual(homeEntry(run, env), { root: "runs", projectId, slug: "fix-login", depth: 2, canonical: homeEntry(run, env).canonical });
  assert.equal(homeEntry(worktree, env).root, "worktrees");
  assert.equal(homeEntry(join(run, "sub"), env).depth, 3);
  assert.equal(homeEntry(outside, env), null);
  assert.equal(homeEntry("relative/path", env), null);
  const refused = [
    home,
    join(home, "runs"),
    join(home, "worktrees", projectId),
    join(home, "runs", ".by-id"),
    join(home, "runs", projectId, ".start-points.lock"),
    join(home, "runs", "not-an-id", "x"),
    join(home, "logs", "x"),
    join(home, "nightqueue.db"),
    secretsPath(env),
    join(worktree, ".git"),
  ];
  for (const path of refused) assert.ok(homeEntry(path, env)?.never, path);
});

test("homeEntry refuses an entry reached through a link, at the leaf or on the way", (t) => {
  const { env, home, projectId, outside } = homeFixture(t);
  const linkedProject = newId();
  mkdirSync(join(home, "worktrees"), { recursive: true });
  symlinkSync(outside, join(home, "worktrees", linkedProject));
  assert.equal(homeEntry(join(home, "worktrees", linkedProject, "x"), env), null);
  symlinkSync(outside, join(home, "runs", projectId, "linked"));
  assert.match(homeEntry(join(home, "runs", projectId, "linked"), env).never, /link/);
  const alias = join(makeDir(t, "operator-home-alias"), "alias");
  symlinkSync(home, alias);
  assert.match(homeEntry(join(alias, "runs", projectId, "fix-login"), env).never, /through a link/);
});

test("homeSegment accepts one bare delete or worktree removal of one entry, and a cd into one", (t) => {
  const { env, checkout, run, worktree } = homeFixture(t);
  assert.equal(homeSegment(["rm", "-rf", run], { env }).kind, "maintenance");
  assert.deepEqual([...homeSegment(["rm", "-rf", run], { env }).accepted], [run]);
  assert.equal(homeSegment(["timeout", "30", "rm", "-rf", run], { start: 2, env }).kind, "maintenance");
  assert.equal(homeSegment(["git", "-C", checkout, "worktree", "remove", "--force", worktree], { env }).kind, "maintenance");
  assert.deepEqual(homeSegment(["git", "-C", worktree, "worktree", "prune"], { env }), { unclassified: true });
  assert.equal(homeSegment(["cd", join(run, "sub")], { env }).kind, "read");
  assert.equal(homeSegment(["npm", "test"], { env }), null);
  assert.match(homeSegment(["sudo", "rm", "-rf", run], { start: 1, env }).never, /one bare command/);
  assert.match(homeSegment(["rm", "-rf", run], { env, nested: true }).never, /one bare command/);
  assert.match(homeSegment(["rm", "-rf", run, worktree], { env }).never, /one run dir or worktree per command/);
  assert.deepEqual(homeSegment(["git", "-C", checkout, "worktree", "remove", run], { env }), { unclassified: true });
  assert.deepEqual(homeSegment(["mv", run, "/tmp/x"], { env }), { unclassified: true });
});

test("neverBashReason leaves one entry's removal to the consent band and keeps the rest of the home never", (t) => {
  const { env, checkout, home, projectId, run, worktree } = homeFixture(t);
  const cwd = home;
  const tildeRun = `~/.nightqueue/runs/${projectId}/fix-login`;
  const allowed = [
    `rm -rf ${run}`,
    `rm -rf ${tildeRun}`,
    `timeout 30 rmdir ${run}`,
    `find ${run} -delete`,
    `cd ${checkout} && rm -rf ${worktree}`,
    `git -C ${checkout} worktree remove --force ${worktree}`,
    `git -C ${checkout} worktree prune`,
  ];
  for (const command of allowed) assert.equal(neverBashReason(command, { cwd, env }), null, command);
  const never = [
    `rm -rf ${home}`,
    "rm -rf ~/.nightqueue",
    `rm -rf ${join(home, "runs")}`,
    `rm -rf ${join(home, "worktrees", projectId)}`,
    `rm -rf ${join(home, "runs", ".by-id")}`,
    `rm -f ${join(home, "runs", projectId, ".start-points.lock")}`,
    `rm -rf ${join(home, "logs", "x")}`,
    `rm -f ${secretsPath(env)}`,
    `rm -f ${join(home, "nightqueue.db")}`,
    `rm -rf ${join(run, "sub")}`,
    `rm -rf ${run}/../../../secrets.json`,
    `rm -rf ${run}/../fix-login`,
    `rm -rf ${worktree}/.git`,
    `rm -rf runs/${projectId}/fix-login`,
    `rm -rf $HOME/.nightqueue/runs/${projectId}/fix-login`,
    `rm -rf ${join(home, "runs", projectId)}/{fix-login,other}`,
    `rm -rf ${run} ${worktree}`,
    `rm -rf ${run} build`,
    `sudo rm -rf ${run}`,
    `FOO=1 rm -rf ${run}`,
    `sh -c "rm -rf ${run}"`,
    `eval rm -rf ${run}`,
    `echo ${run} | xargs rm -rf`,
    `find ${run} -exec rm {} ;`,
    `mv ${run} /tmp/x`,
    `git -C ${checkout} worktree remove ${run}`,
    `git -C ${checkout} worktree remove ${worktree} ${join(home, "worktrees", projectId, "other")}`,
    `git -C ${worktree} worktree prune`,
    `git -C ${worktree} worktree remove ${join(home, "worktrees", projectId, "other")}`,
    `git -C ${checkout} worktree move ${worktree} /tmp/x`,
  ];
  for (const command of never) assert.ok(neverBashReason(command, { cwd, env }), command);
});

test("consentBash asks a home-maintenance consent for a removal, never a run or git-write one", (t) => {
  const { env, checkout, home, run, worktree, outside } = homeFixture(t);
  assert.deepEqual(consentBash(`rm -rf ${run}`, { cwd: home, env }), { kind: "home-maintenance", dir: home, argv: ["rm", "-rf", run], shown: `rm -rf ${run}` });
  assert.deepEqual(consentBash(`cd ${checkout} && timeout 30 rm -rf ${worktree}`, { env }).argv, ["rm", "-rf", worktree]);
  assert.deepEqual(consentBash(`git -C ${checkout} worktree remove ${worktree}`, { cwd: home, env }), {
    kind: "home-maintenance",
    dir: home,
    gitDir: checkout,
    argv: ["git", "-C", checkout, "worktree", "remove", worktree],
    shown: `git -C ${checkout} worktree remove ${worktree}`,
  });
  assert.equal(consentBash(`git -C ${checkout} worktree prune`, { cwd: home, env }).kind, "home-maintenance");
  assert.equal(consentBash("git worktree prune", { cwd: checkout, env }).kind, "home-maintenance");
  assert.match(consentBash("git worktree prune", { cwd: home, env }).shape, /runs in the project's checkout/);
  assert.match(consentBash(`git -C${checkout} worktree prune`, { cwd: home, env }).shape, /is refused: a git global option other than/);
  assert.match(consentBash(`cd ${worktree} && git worktree prune`, { env }).shape, /runs in the project's checkout/);
  assert.match(consentBash("git worktree prune", { cwd: worktree, env }).shape, /runs in the project's checkout/);
  assert.match(consentBash(`git -C ${checkout} worktree prune --expire`, { cwd: home, env }).shape, /runs in the project's checkout/);
  assert.equal(consentBash(`git -C ${checkout} worktree prune -n --expire now`, { cwd: home, env }).kind, "home-maintenance");
  assert.match(consentBash(`rm -rf ${run}`, { cwd: outside, env }).shape, /no registered checkout, worktree or the nightqueue home/);
  assert.match(consentBash(`rm -rf ${join(home, "runs")}/*`, { cwd: home, env }).shape, /glob or brace/);
});

// Queues a job of a project, bound to a slug or a start worktree, and moves it to a status through the real store writes; answers its id.
function jobAt(env, { projectId, slug = null, startWorktree = null, status }) {
  const { id } = addJob({ projectId, prompt: `job ${slug ?? "unslugged"}`, slug, startWorktree }, env);
  if (status === "cancelled") cancelJob(id, {}, env);
  if (status === "pending" || status === "cancelled") return id;
  claimJobById(id, { worker: WORKER, cap: null }, env);
  if (status !== "running") finishJob(id, { worker: WORKER, status, noticeMd: "seeded" }, env);
  return id;
}

// A run dir and a worktree of a project under the home, created, answered as `{ run, worktree }`.
function entriesOf(home, projectId, slug) {
  const run = join(home, "runs", projectId, slug);
  const worktree = join(home, "worktrees", projectId, slug);
  mkdirSync(run, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return { run, worktree };
}

// Links a worktree entry to a checkout the way `git worktree add` does: an admin dir in `<checkout>/.git/worktrees` pointing back, and a `.git` file pointing to it.
function linkWorktree(checkout, worktree) {
  const admin = join(checkout, ".git", "worktrees", basename(worktree));
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, "gitdir"), `${join(worktree, ".git")}\n`);
  writeFileSync(join(admin, "commondir"), "../..\n");
  writeFileSync(join(worktree, ".git"), `gitdir: ${admin}\n`);
  return admin;
}

// A worktree entry of a project under the home, created and linked to the checkout.
function linkedTree({ checkout, home, projectId, slug }) {
  const { worktree } = entriesOf(home, projectId, slug);
  linkWorktree(checkout, worktree);
  return worktree;
}

// Locks a linked worktree entry the way git does: a `locked` file with the reason in the admin dir git keeps for it in the checkout.
function lockWorktree(checkout, worktree, reason) {
  writeFileSync(join(linkWorktree(checkout, worktree), "locked"), reason);
}

test("an open job's run dir or worktree is never removed, and the refusal names the job", (t) => {
  const { env, checkout, home } = homeFixture(t);
  const projectId = projectIdOf(env, "alpha");
  for (const status of ["pending", "running", "gate"]) {
    const id = jobAt(env, { projectId, slug: `held-${status}`, status });
    const { run, worktree } = entriesOf(home, projectId, `held-${status}`);
    const named = new RegExp(`belongs to J-${id} \\(${status}\\)`);
    assert.match(neverBashReason(`rm -rf ${run}`, { cwd: home, env }), named);
    assert.match(neverBashReason(`git -C ${checkout} worktree remove ${worktree}`, { cwd: home, env }), named);
  }
  const free = {
    cancelled: jobAt(env, { projectId, slug: "dropped", status: "cancelled" }),
    failed: jobAt(env, { projectId, slug: "broken", status: "failed" }),
    done: seedDoneJob(env, { slug: "shipped" }),
    noChange: seedDoneJob(env, { slug: "unchanged", prUrl: null }),
    closed: seedClosedJob(env, { slug: "merged" }),
  };
  for (const slug of ["dropped", "broken", "unchanged", "merged", "orphan"]) {
    const { run, worktree } = entriesOf(home, projectId, slug);
    assert.equal(neverBashReason(`rm -rf ${run}`, { cwd: home, env }), null, slug);
    assert.equal(neverBashReason(`git -C ${checkout} worktree remove ${worktree}`, { cwd: home, env }), null, slug);
  }
  const unconfirmed = new RegExp(`belongs to J-${free.done} \\(done, pull request https://github\\.com/acme/api/pull/7 could not be confirmed merged or closed: pull request checks are off`);
  const shipped = entriesOf(home, projectId, "shipped");
  assert.match(neverBashReason(`rm -rf ${shipped.run}`, { cwd: home, env }), unconfirmed);
  assert.match(neverBashReason(`git -C ${checkout} worktree remove ${shipped.worktree}`, { cwd: home, env }), unconfirmed);
  assert.equal(neverBashReason(`git -C ${checkout} worktree prune`, { cwd: home, env }), null);
  retryJob(free.cancelled, {}, env);
  assert.match(neverBashReason(`rm -rf ${join(home, "runs", projectId, "dropped")}`, { cwd: home, env }), new RegExp(`belongs to J-${free.cancelled} \\(pending\\)`));
  assert.ok(acquireClose(free.done, { worker: WORKER, leaseS: 600 }, env));
  assert.match(neverBashReason(`rm -rf ${join(home, "runs", projectId, "shipped")}`, { cwd: home, env }), new RegExp(`J-${free.done} \\(done, being closed\\)`));
});

test("a worktree is owned through its start worktree and its run state too, and only by a job of its own project", (t) => {
  const { env, home } = homeFixture(t);
  const projectId = projectIdOf(env, "alpha");
  const adopted = entriesOf(home, projectId, "adopted").worktree;
  const adopter = jobAt(env, { projectId, startWorktree: adopted, status: "pending" });
  assert.match(homeOwner(homeEntry(adopted, env), env), new RegExp(`belongs to J-${adopter} \\(pending\\)`));
  const renamed = entriesOf(home, projectId, "renamed").worktree;
  const stateful = jobAt(env, { projectId, slug: "stateful", status: "gate" });
  saveRunState({ projectId, slug: "stateful", env, state: { worktree: renamed } });
  assert.match(homeOwner(homeEntry(renamed, env), env), new RegExp(`belongs to J-${stateful} \\(gate\\)`));
  const betaId = ensureProject(env, "beta");
  const beta = jobAt(env, { projectId: betaId, slug: "shared", status: "gate" });
  assert.equal(homeOwner(homeEntry(entriesOf(home, projectId, "shared").run, env), env), null);
  assert.match(homeOwner(homeEntry(entriesOf(home, betaId, "shared").run, env), env), new RegExp(`belongs to J-${beta} \\(gate\\)`));
});

test("a running job that has not chosen its run dir yet holds every entry of its project", (t) => {
  const { env, home } = homeFixture(t);
  const projectId = projectIdOf(env, "alpha");
  const { run } = entriesOf(home, projectId, "orphan");
  assert.equal(homeOwner(homeEntry(run, env), env), null);
  const id = jobAt(env, { projectId, status: "running" });
  assert.match(homeOwner(homeEntry(run, env), env), new RegExp(`J-${id} \\(running\\) is still choosing its run directory`));
});

test("a worktree locked by a live process or by hand is held; a stale lock is not", (t) => {
  const { env, checkout, home } = homeFixture(t);
  const projectId = projectIdOf(env, "alpha");
  const live = entriesOf(home, projectId, "live").worktree;
  lockWorktree(checkout, live, `nightqueue job (pid ${process.pid})`);
  assert.match(neverBashReason(`rm -rf ${live}`, { cwd: home, env }), new RegExp(`held by a live process \\(pid ${process.pid}\\)`));
  const manual = entriesOf(home, projectId, "manual").worktree;
  lockWorktree(checkout, manual, "kept for review\n");
  assert.match(homeOwner(homeEntry(manual, env), env), /locked by hand \(kept for review\)/);
  const stale = entriesOf(home, projectId, "stale").worktree;
  lockWorktree(checkout, stale, "nightqueue job (pid 2147483646)");
  assert.equal(homeOwner(homeEntry(stale, env), env), null);
});

test("a worktree's lock is read from git's admin dir in the checkout, never through the job-written pointer", (t) => {
  const { env, checkout, home, outside } = homeFixture(t);
  const projectId = projectIdOf(env, "alpha");
  const forged = entriesOf(home, projectId, "forged").worktree;
  lockWorktree(checkout, forged, `nightqueue job (pid ${process.pid})`);
  writeFileSync(join(forged, ".git"), `gitdir: ${outside}\n`);
  assert.match(homeOwner(homeEntry(forged, env), env), new RegExp(`held by a live process \\(pid ${process.pid}\\)`));
  const fake = entriesOf(home, projectId, "fake").worktree;
  writeFileSync(join(outside, "locked"), `nightqueue job (pid ${process.pid})`);
  writeFileSync(join(fake, ".git"), `gitdir: ${outside}\n`);
  assert.equal(homeOwner(homeEntry(fake, env), env), null);
});

test("an unreadable queue refuses a removal instead of finding no owner, and a command naming no entry never reads it", (t) => {
  const env = makeHome(t, "operator-home-corrupt");
  const { worktree } = entriesOf(homeDir(env), newId(), "fix-login");
  writeFileSync(dbPath(env), "not a sqlite database");
  assert.match(homeSegment(["rm", "-rf", worktree], { env }).never, /cannot be checked: the queue could not be read/);
  assert.equal(homeSegment(["git", "worktree", "prune"], { env }), null);
  assert.equal(homeSegment(["cd", worktree], { env }).kind, "read");
  assert.equal(homeSegment(["npm", "test"], { env }), null);
});

// The home fixture as an operator session, with alpha's registered row and id.
function sessionFixture(t) {
  const fixture = homeFixture(t);
  Object.assign(fixture.env, { NIGHTQUEUE_MODE: "operator", NIGHTQUEUE_OPERATOR_SESSION: newId() });
  const project = registeredCheckouts(fixture.env).find((row) => row.name === "alpha");
  return { ...fixture, project, alphaId: project.id };
}

// Records one home-maintenance (or other kind) consent of a project in the fixture's session.
function grant(env, { project, scope, kind = "home-maintenance" }) {
  return recordConsent({ session: env.NIGHTQUEUE_OPERATOR_SESSION, project, kind, scope, reason: "clean up after a job", answer: "yes, remove it", env });
}

// The guard's answer to one Bash call, on the main thread or, with `agent`, on a subagent's.
function bash(env, { command, cwd, agent = false }) {
  const input = { hook_event_name: "PreToolUse", session_id: "s-1", cwd, tool_name: "Bash", tool_input: { command } };
  return operatorDecision({ input: agent ? { ...input, agent_id: "a1", agent_type: "nightqueue:explore" } : input, env });
}

test("a home-maintenance consent lets exactly its command through, in its own project, on the operator's own thread", (t) => {
  const { env, checkout, home, project, alphaId } = sessionFixture(t);
  const { run, worktree } = entriesOf(home, alphaId, "stale");
  const remove = `git -C ${checkout} worktree remove ${worktree}`;
  assert.match(bash(env, { command: `rm -rf ${run}`, cwd: home }), /needs consent \(home-maintenance rm -rf /);
  assert.deepEqual(grant(env, { project, scope: `rm -rf ${run}` }).consent.argv, ["rm", "-rf", run]);
  assert.equal(bash(env, { command: `rm -rf ${run}`, cwd: home }), null);
  assert.equal(bash(env, { command: `cd ${checkout} && timeout 30 rm -rf ${run}` }), null);
  assert.match(bash(env, { command: `rm -r ${run}`, cwd: home }), /needs consent \(home-maintenance/);
  assert.match(bash(env, { command: `rm -rf ${worktree}`, cwd: home }), /needs consent \(home-maintenance/);
  assert.match(bash(env, { command: remove, cwd: home }), /needs consent \(home-maintenance git -C /);
  grant(env, { project, scope: remove });
  assert.equal(bash(env, { command: remove, cwd: home }), null);
  grant(env, { project, scope: `cd ${checkout} && git worktree prune` });
  assert.equal(bash(env, { command: "git worktree prune", cwd: checkout }), null);
  const beta = makeProject(t, env, "beta");
  assert.match(bash(env, { command: "git worktree prune", cwd: beta }), /needs consent \(home-maintenance git worktree prune\)/);
  assert.match(bash(env, { command: `rm -rf ${run}`, cwd: home, agent: true }), /never \(home maintenance runs on the operator's own thread\)/);
});

test("a home-maintenance consent is refused for a held, whole, foreign or misshapen target, and under any other kind", (t) => {
  const { env, checkout, home, project, alphaId, run } = sessionFixture(t);
  const held = jobAt(env, { projectId: alphaId, slug: "held", status: "gate" });
  const heldRun = entriesOf(home, alphaId, "held").run;
  assert.throws(() => grant(env, { project, scope: `rm -rf ${heldRun}` }), new RegExp(`belongs to J-${held} \\(gate\\)`));
  assert.throws(() => grant(env, { project, scope: `rm -rf ${join(home, "runs")}` }), /never band \(deleting under the nightqueue home: one run dir or worktree per command/);
  assert.throws(() => grant(env, { project, scope: `rm -rf ${run}` }), /stays in its own project/);
  assert.throws(() => grant(env, { project, scope: `ls ${heldRun}` }), /one exact command/);
  assert.throws(() => grant(env, { project, scope: `rm -rf ${join(home, "runs", alphaId)}/*` }), /glob or brace/);
  assert.throws(() => grant(env, { project, scope: `git -C ${makeProject(t, env, "beta")} worktree prune` }), /outside the checkout of alpha/);
  const free = entriesOf(home, alphaId, "free");
  assert.throws(() => grant(env, { project, kind: "run", scope: `rm -rf ${free.run}` }), /consented as kind home-maintenance/);
  assert.throws(() => grant(env, { project, kind: "git-write", scope: `git -C ${checkout} worktree prune` }), /consented as kind home-maintenance/);
  assert.throws(() => grant(env, { project, kind: "git-write", scope: `worktree remove ${free.worktree}` }), /consented as kind home-maintenance/);
});

test("a consent recorded while a job was cancelled is refused at run time once the job is retried", (t) => {
  const { env, home, project, alphaId } = sessionFixture(t);
  const id = jobAt(env, { projectId: alphaId, slug: "dropped", status: "cancelled" });
  const { run } = entriesOf(home, alphaId, "dropped");
  grant(env, { project, scope: `rm -rf ${run}` });
  assert.equal(bash(env, { command: `rm -rf ${run}`, cwd: home }), null);
  retryJob(id, {}, env);
  assert.match(bash(env, { command: `rm -rf ${run}`, cwd: home }), new RegExp(`never \\(.*belongs to J-${id} \\(pending\\)\\)`));
});

// Points the fixture's gh at the fake CLI answering one pull request state (none makes it fail), with the pull request check on.
function fakeGh(t, env, { state = null, sleepMs = null } = {}) {
  const vars = isolatedHostVars(makeDir(t, "operator-home-gh"));
  delete env.NIGHTQUEUE_NO_PR_CHECK;
  delete env.NIGHTQUEUE_FAKE_GH_PR_STATE;
  delete env.NIGHTQUEUE_FAKE_GH_SLEEP_MS;
  Object.assign(env, { NIGHTQUEUE_GH_BIN: vars.NIGHTQUEUE_GH_BIN, NIGHTQUEUE_FAKE_GH_LOG: vars.NIGHTQUEUE_FAKE_GH_LOG });
  if (state) env.NIGHTQUEUE_FAKE_GH_PR_STATE = state;
  if (sleepMs) env.NIGHTQUEUE_FAKE_GH_SLEEP_MS = String(sleepMs);
  return vars.NIGHTQUEUE_FAKE_GH_LOG;
}

test("a done job's run dir and worktree stay never while its pull request is not merged or closed, and the refusal names the job and the pull request", (t) => {
  const { env, checkout, home, project, alphaId } = sessionFixture(t);
  const url = "https://github.com/acme/api/pull/7";
  const done = seedDoneJob(env, { slug: "shipped", prUrl: url });
  const { run, worktree } = entriesOf(home, alphaId, "shipped");
  const remove = `git -C ${checkout} worktree remove ${worktree}`;
  const held = (words) => new RegExp(`never \\(.*belongs to J-${done} \\(done, pull request ${url.replaceAll(".", "\\.")} ${words}`);
  const assertHeld = (words) => {
    assert.match(bash(env, { command: `rm -rf ${run}`, cwd: home }), held(words));
    assert.match(bash(env, { command: remove, cwd: home }), held(words));
    assert.throws(() => grant(env, { project, scope: `rm -rf ${run}` }), new RegExp(`belongs to J-${done} \\(done, pull request `));
  };
  fakeGh(t, env, { state: "OPEN" });
  assertHeld("is open\\)");
  env.NIGHTQUEUE_FAKE_GH_PR_DRAFT = "1";
  assertHeld("is a draft\\)");
  delete env.NIGHTQUEUE_FAKE_GH_PR_DRAFT;
  fakeGh(t, env);
  assertHeld("could not be confirmed merged or closed: gh failed: ");
  env.NIGHTQUEUE_GH_BIN = join(home, "no-gh-here");
  assertHeld("could not be confirmed merged or closed: gh is not installed\\)");
  env.NIGHTQUEUE_NO_PR_CHECK = "1";
  assertHeld("could not be confirmed merged or closed: pull request checks are off");
  for (const state of ["MERGED", "CLOSED"]) {
    fakeGh(t, env, { state });
    assert.match(bash(env, { command: `rm -rf ${run}`, cwd: home }), /needs consent \(home-maintenance rm -rf /, state);
    assert.match(bash(env, { command: remove, cwd: home }), /needs consent \(home-maintenance git -C /, state);
  }
  grant(env, { project, scope: `rm -rf ${run}` });
  assert.equal(bash(env, { command: `rm -rf ${run}`, cwd: home }), null);
  fakeGh(t, env, { state: "OPEN" });
  assert.match(bash(env, { command: `rm -rf ${run}`, cwd: home }), held("is open\\)"));
});

test("a done job's pull request that is not on GitHub or does not answer in time holds its entries, and one with no pull request does not", (t) => {
  const { env, home, alphaId } = sessionFixture(t);
  const foreign = seedDoneJob(env, { slug: "foreign", prUrl: "https://gitlab.com/acme/api/-/merge_requests/7" });
  const slow = seedDoneJob(env, { slug: "slow", prUrl: "https://github.com/acme/api/pull/8" });
  seedDoneJob(env, { slug: "unchanged", prUrl: null });
  const log = fakeGh(t, env, { state: "MERGED", sleepMs: 8000 });
  const runOf = (slug) => entriesOf(home, alphaId, slug).run;
  assert.match(bash(env, { command: `rm -rf ${runOf("foreign")}`, cwd: home }), new RegExp(`belongs to J-${foreign} \\(done, pull request .* could not be confirmed merged or closed: it is not a GitHub pull request URL\\)`));
  assert.equal(existsSync(log), false, "gh was asked about a pull request URL that is not GitHub's");
  const started = Date.now();
  assert.match(bash(env, { command: `rm -rf ${runOf("slow")}`, cwd: home }), new RegExp(`belongs to J-${slow} \\(done, pull request .* could not be confirmed merged or closed: gh did not answer within 3 s\\)`));
  assert.ok(Date.now() - started < 5000, "the guard waited on gh past the hook's own 5 s timeout");
  assert.match(bash(env, { command: `rm -rf ${runOf("unchanged")}`, cwd: home }), /needs consent \(home-maintenance rm -rf /);
});

test("hardened git reads of a worktree under the home are free, and nothing else runs there", (t) => {
  const { env, checkout, home, alphaId } = sessionFixture(t);
  const worktree = linkedTree({ checkout, home, projectId: alphaId, slug: "fix-login" });
  const reads = [
    `git -C ${worktree} ${HARDENED} --no-optional-locks status --ignore-submodules=all`,
    `git -C ${worktree} ${HARDENED} log --oneline -5`,
    `git -C ${worktree} ${HARDENED} diff --ignore-submodules=all`,
    `git -C ${worktree} ${HARDENED} stash list`,
  ];
  for (const command of reads) assert.equal(bash(env, { command, cwd: home }), null, command);
  assert.notEqual(bash(env, { command: `cd ${worktree} && git ${HARDENED} diff --ignore-submodules=all`, cwd: home }), null);
  const unhardened = [
    `git -C ${worktree} --no-optional-locks status`,
    `git -C ${worktree} log --oneline -5`,
    `git -C ${worktree} -c core.hooksPath=/dev/null -c core.fsmonitor=false diff --ignore-submodules=all`,
    `git -C ${worktree} ${HARDENED} diff`,
    `git -C ${worktree} ${HARDENED} diff --ignore-submodules=all --submodule=diff`,
    `git -C ${worktree} ${HARDENED} log -p --submodule=diff`,
    `git -C ${worktree} ${HARDENED} ls-files --recurse-submodules`,
  ];
  for (const command of unhardened) assert.match(bash(env, { command, cwd: home }), READ_HARDENED, command);
  assert.match(bash(env, { command: `cd ${worktree} && git diff`, cwd: home }), WORKTREE_CD_NEVER);
  assert.match(bash(env, { command: `git -C ${worktree} commit -am x`, cwd: home }), /never \(naming a never-band path/);
  assert.match(bash(env, { command: `git -C ${worktree} log ${join(home, "logs")}`, cwd: home }), /never/);
  assert.match(bash(env, { command: `cd ${worktree} && git commit -am x`, cwd: home }), WORKTREE_CD_NEVER);
  assert.match(bash(env, { command: `git -C ${worktree} status`, cwd: home }), /never \(naming a never-band path/);
  assert.match(bash(env, { command: `git -C ${join(worktree, "src")} log`, cwd: home }), /never \(naming a never-band path/);
});

test("a hardened git grep of a worktree under the home is free on both threads; unhardened or with another global option it is never", (t) => {
  const { env, checkout, home, alphaId } = sessionFixture(t);
  const worktree = linkedTree({ checkout, home, projectId: alphaId, slug: "fix-login" });
  const grep = `${HARDENED} --no-lazy-fetch grep`;
  const excl = "':(top,exclude,glob)**/.env*'";
  for (const agent of [false, true]) {
    assert.equal(bash(env, { command: `git -C ${worktree} ${grep} -n foo -- ${excl}`, cwd: home, agent }), null);
    assert.equal(bash(env, { command: `git -C ${worktree} ${grep} -e foo -- 'src/*.mjs' ${excl}`, cwd: home, agent }), null);
    assert.equal(bash(env, { command: `git -C ${worktree} ${grep} --cached -n foo -- ${excl}`, cwd: home, agent }), null);
    assert.match(bash(env, { command: `cd ${worktree} && git ${grep} -n foo -- ${excl}`, cwd: home, agent }), WORKTREE_CD_NEVER);
    assert.match(bash(env, { command: `cd ${worktree} && git ${HARDENED} log`, cwd: home, agent }), WORKTREE_CD_NEVER);
    assert.match(bash(env, { command: `git -C ${worktree} ${grep} foo HEAD -- ${excl}`, cwd: home, agent }), /never \(`git grep` searches only the working tree .*never a revision/);
    assert.equal(bash(env, { command: `cd ${checkout} && git ${grep} -n foo -- ${excl}`, cwd: home, agent }), null);
    assert.match(bash(env, { command: `git -C ${worktree} grep -n foo`, cwd: home, agent }), GREP_UNHARDENED);
    assert.match(bash(env, { command: `git -C ${worktree} ${HARDENED} grep -n foo`, cwd: home, agent }), GREP_UNHARDENED);
    assert.match(bash(env, { command: `git -C ${worktree} --no-pager ${grep} foo -- ${excl}`, cwd: home, agent }), /never \(`git grep` takes no global option/);
    assert.match(bash(env, { command: `git -C ${worktree} ${grep} -n foo`, cwd: home, agent }), /never \(`git grep` always ends with/);
    assert.match(bash(env, { command: `git -C ${worktree} ${grep} foo c3886f3fec -- ${excl}`, cwd: home, agent }), /never a revision/);
    assert.match(bash(env, { command: `git -C ${worktree} ${HARDENED} --no-optional-locks grep foo`, cwd: home, agent }), /^operator guard: never \(/);
  }
  assert.equal(WORKTREE_READ_SPELLING.includes("cd "), false);
  assert.match(WORKTREE_READ_SPELLING, /`git -C <worktree> -c core\.fsmonitor=false -c core\.hooksPath=\/dev\/null --no-lazy-fetch grep \[--cached\]/);
});

test("a worktree read with a reversed or duplicated hardening pair is never free, in the -C form and the cd form", (t) => {
  const { env, checkout, home, alphaId } = sessionFixture(t);
  const worktree = linkedTree({ checkout, home, projectId: alphaId, slug: "fix-login" });
  const reversed = "-c core.hooksPath=/dev/null -c core.fsmonitor=false";
  const duplicated = `${HARDENED} -c core.hooksPath=/dev/null`;
  for (const pair of [reversed, duplicated]) {
    assert.match(bash(env, { command: `git -C ${worktree} ${pair} log --oneline -5`, cwd: home }), READ_HARDENED, pair);
    assert.notEqual(bash(env, { command: `cd ${worktree} && git ${pair} log --oneline -5`, cwd: home }), null, pair);
  }
});

test("a worktree whose .git leaves git's admin dir in the checkout is never read nor salvaged", (t) => {
  const { env, checkout, home, alphaId, outside } = sessionFixture(t);
  const untrusted = /never \(.*does not point to the admin dir git keeps for it/;
  const pointer = linkedTree({ checkout, home, projectId: alphaId, slug: "pointer" });
  writeFileSync(join(pointer, ".git"), `gitdir: ${outside}\n`);
  assert.match(bash(env, { command: `git -C ${pointer} --no-optional-locks status`, cwd: home }), untrusted);
  assert.match(bash(env, { command: `git -C ${pointer} diff`, cwd: home }), untrusted);
  assert.match(bash(env, { command: `git -C ${pointer} stash`, cwd: home }), untrusted);
  assert.match(bash(env, { command: `cd ${pointer} && git diff`, cwd: home }), WORKTREE_CD_NEVER);
  const directory = linkedTree({ checkout, home, projectId: alphaId, slug: "directory" });
  rmSync(join(directory, ".git"));
  mkdirSync(join(directory, ".git"));
  assert.match(bash(env, { command: `git -C ${directory} diff`, cwd: home }), untrusted);
  const common = linkedTree({ checkout, home, projectId: alphaId, slug: "common" });
  writeFileSync(join(checkout, ".git", "worktrees", "common", "commondir"), `${outside}\n`);
  assert.match(bash(env, { command: `git -C ${common} diff`, cwd: home }), untrusted);
  const unlinked = entriesOf(home, alphaId, "unlinked").worktree;
  assert.match(bash(env, { command: `git -C ${unlinked} log`, cwd: home }), untrusted);
});

test("homeSegment classifies a format-patch or a copy out of an entry as salvage, a stash as never, and nothing into one", (t) => {
  const { env, checkout, home, run } = homeFixture(t);
  const worktree = linkedTree({ checkout, home, projectId: projectIdOf(env, "alpha"), slug: "fix-login" });
  const stashes = [
    ["git", "-C", worktree, ...HARDENED_WORDS, "stash"],
    ["git", "-C", worktree, ...HARDENED_WORDS, "stash", "push", "-m", "keep"],
    ["git", "-C", worktree, ...HARDENED_WORDS, "stash", "-u"],
    ["git", "-C", worktree, "stash"],
  ];
  for (const words of stashes) assert.match(homeSegment(words, { env })?.never ?? "", /is never stashed/, words.join(" "));
  const salvage = [
    ["git", "-C", worktree, "format-patch", "-1", "-o", checkout],
    ["git", "-C", worktree, ...HARDENED_WORDS, "format-patch", "-1", "-o", checkout],
    ["cp", join(worktree, "src", "a.js"), join(checkout, "src", "a.js")],
    ["cp", "-rp", join(run, "sub"), join(checkout, "sub")],
  ];
  for (const words of salvage) assert.equal(homeSegment(words, { env })?.kind, "salvage", words.join(" "));
  const refused = [
    ["git", "-C", worktree, "stash", "pop"],
    ["git", "-C", worktree, "stash", "drop"],
    ["git", "-C", run, "stash"],
    ["git", "-C", join(worktree, "src"), "format-patch", "-1", "-o", checkout],
    ["cp", join(checkout, "x"), join(worktree, "x")],
    ["cp", "-t", checkout, join(worktree, "a.js")],
    ["cp", "-l", join(worktree, "a.js"), join(checkout, "a.js")],
    ["cp", join(worktree, "a.js")],
  ];
  for (const words of refused) assert.deepEqual(homeSegment(words, { env }), { unclassified: true }, words.join(" "));
  assert.equal(homeSegment(["git", "-C", worktree, ...HARDENED_WORDS, "stash", "list"], { env }).kind, "read");
  assert.match(homeSegment(["git", "-C", worktree, "stash", "list"], { env }).never, /read only hardened/);
  assert.match(homeSegment(["sudo", "cp", join(worktree, "a.js"), checkout], { start: 1, env }).never, /one bare command/);
  assert.match(homeSegment(["git", "-C", worktree, "format-patch", "-1", "-o", checkout], { env, nested: true }).never, /one bare command/);
});

test("salvage from a closed, cancelled or ownerless job's worktree is consentable; from an open, done or failed one never; a stash never", (t) => {
  const { env, checkout, home, project, alphaId } = sessionFixture(t);
  jobAt(env, { projectId: alphaId, slug: "dropped", status: "cancelled" });
  seedClosedJob(env, { slug: "merged" });
  const gate = jobAt(env, { projectId: alphaId, slug: "waiting", status: "gate" });
  const done = seedDoneJob(env, { slug: "shipped" });
  const failed = jobAt(env, { projectId: alphaId, slug: "broken", status: "failed" });
  const tree = (slug) => linkedTree({ checkout, home, projectId: alphaId, slug });
  const patch = (slug) => `git -C ${tree(slug)} ${HARDENED} format-patch -1 -o ${checkout}`;
  const neverStashed = /never \(a worktree under the nightqueue home is never stashed/;
  for (const slug of ["dropped", "merged", "orphan"]) {
    assert.match(bash(env, { command: patch(slug), cwd: home }), /needs consent \(git-write git -C /, slug);
    assert.match(bash(env, { command: `git -C ${tree(slug)} ${HARDENED} stash`, cwd: home }), neverStashed, slug);
  }
  grant(env, { project, kind: "git-write", scope: "git stash" });
  assert.match(bash(env, { command: `git -C ${tree("dropped")} ${HARDENED} stash`, cwd: home }), neverStashed);
  assert.match(bash(env, { command: `git -C ${tree("merged")} ${HARDENED} stash push -m keep`, cwd: home }), neverStashed);
  assert.match(bash(env, { command: `git -C ${tree("dropped")} stash`, cwd: home }), neverStashed);
  assert.match(bash(env, { command: `git -C ${join(tree("merged"), "src")} ${HARDENED} stash push -m keep`, cwd: home }), /never \(naming a never-band path/);
  assert.match(bash(env, { command: `git -C ${tree("orphan")} format-patch -1 -o ${checkout}`, cwd: home }), /needs consent \(git-write/);
  assert.match(bash(env, { command: patch("waiting"), cwd: home }), new RegExp(`never \\(.*belongs to J-${gate} \\(gate\\)`));
  for (const [slug, id, status] of [["shipped", done, "done"], ["broken", failed, "failed"]]) {
    const reason = new RegExp(`salvage copies from a closed or cancelled job; .* belongs to J-${id} \\(${status}\\)`);
    assert.match(bash(env, { command: patch(slug), cwd: home }), reason);
    assert.match(bash(env, { command: `cd ${checkout} && cp ${tree(slug)}/a.js a.js`, cwd: home }), reason);
  }
  assert.match(bash(env, { command: `cd ${tree("dropped")} && git stash`, cwd: home }), WORKTREE_CD_NEVER);
  assert.match(bash(env, { command: `git -C ${tree("dropped")} ${HARDENED} stash pop`, cwd: home }), /never \(naming a never-band path/);
  const beta = makeProject(t, env, "beta");
  const betaTree = linkedTree({ checkout: beta, home, projectId: projectIdOf(env, "beta"), slug: "other" });
  assert.match(bash(env, { command: `git -C ${betaTree} ${HARDENED} format-patch -1 -o ${checkout}`, cwd: home }), /needs consent \(git-write/);
  assert.match(bash(env, { command: `git -C ${betaTree} ${HARDENED} stash`, cwd: home }), neverStashed);
});

test("a copy out of a worktree runs under a run consent, and nothing writes into a worktree", (t) => {
  const { env, checkout, home, project, alphaId } = sessionFixture(t);
  jobAt(env, { projectId: alphaId, slug: "dropped", status: "cancelled" });
  const { worktree } = entriesOf(home, alphaId, "dropped");
  const copy = `cd ${checkout} && cp ${worktree}/src/a.js src/a.js`;
  assert.match(bash(env, { command: copy, cwd: home }), /needs consent \(run cp /);
  grant(env, { project, kind: "run", scope: copy });
  assert.equal(bash(env, { command: copy, cwd: home }), null);
  assert.match(bash(env, { command: `cp ${checkout}/x ${worktree}/x`, cwd: checkout }), /never \(naming a never-band path \(writing under the nightqueue home\)/);
  const write = { hook_event_name: "PreToolUse", session_id: "s-1", cwd: checkout, tool_name: "Write", tool_input: { file_path: join(worktree, "a.js"), content: "x" } };
  assert.match(operatorDecision({ input: write, env }), /never/);
  assert.throws(() => grant(env, { project, kind: "create", scope: join(worktree, "a.js") }), /never band \(writing under the nightqueue home\)/);
});
