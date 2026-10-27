import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { newId } from "../../src/config/ids.mjs";
import { homeDir, secretsPath } from "../../src/config/paths.mjs";
import { operatorDecision } from "../../src/hooks/operator-guard.mjs";
import { addJob, claimJobById, finishJob } from "../../src/memory/jobs.mjs";
import { registeredCheckouts } from "../../src/memory/registry-access.mjs";
import { neverBashReason } from "../../src/queue/operator-bands.mjs";
import { recordConsent } from "../../src/queue/operator-consent.mjs";
import { homeEntry, homeOwner } from "../../src/queue/operator-home.mjs";
import { makeDir, makeHome, registerCheckout, seedClosedJob, seedDoneJob } from "../../test-support/memory.mjs";

const WORKER = "test:operator-home-regression";
const DEAD_PID = 2147483646;
const BY_ABSOLUTE_PATH = /never \(`git worktree remove\|move` names its worktree by its absolute path/;
const UNTRUSTED = /does not point to the admin dir git keeps for it/;

// Refuses to let a fixture's git write anywhere but a temporary directory, so a test never touches a real repository.
function assertTempDir(cwd) {
  const root = realpathSync(tmpdir());
  if (!realpathSync(cwd).startsWith(`${root}/`)) throw new Error(`refusing to run git outside the temp dir: ${cwd}`);
}

// Git for the fixtures: no inherited GIT_* variable, no global or system config, no hook and no fsmonitor, only inside the temp dir.
function git(cwd, args) {
  assertTempDir(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "qa",
    GIT_AUTHOR_EMAIL: "qa@example.invalid",
    GIT_COMMITTER_NAME: "qa",
    GIT_COMMITTER_EMAIL: "qa@example.invalid",
  });
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env, stdio: "pipe" }).toString();
}

// An isolated home at `~/.nightqueue` of its own user home, one real git checkout registered as alpha, and an operator session.
function setup(t) {
  const env = makeHome(t, "operator-home-regression");
  const base = makeDir(t, "operator-home-regression-host");
  Object.assign(env, { HOME: join(base, "user"), CLAUDE_CONFIG_DIR: join(base, "claude"), NIGHTQUEUE_MODE: "operator", NIGHTQUEUE_OPERATOR_SESSION: newId() });
  env.NIGHTQUEUE_HOME = join(env.HOME, ".nightqueue");
  mkdirSync(env.NIGHTQUEUE_HOME, { recursive: true });
  const checkout = makeDir(t, "operator-home-regression-repo");
  git(checkout, ["init", "-q"]);
  git(checkout, ["commit", "-q", "--allow-empty", "-m", "init"]);
  registerCheckout(env, { path: checkout, name: "alpha" });
  const project = registeredCheckouts(env).find((row) => row.name === "alpha");
  return { env, checkout, home: homeDir(env), project, projectId: project.id, outside: makeDir(t, "operator-home-regression-outside") };
}

// A real linked worktree of the checkout at the path of a slug under the home's worktrees of the project.
function linkedWorktree({ checkout, home, projectId }, slug) {
  const path = join(home, "worktrees", projectId, slug);
  mkdirSync(dirname(path), { recursive: true });
  git(checkout, ["worktree", "add", "-q", "-b", slug, path]);
  return path;
}

// Queues a job bound to a slug or a start worktree and moves it to a status through the real store writes; answers its id.
function jobAt(env, { projectId, slug = null, startWorktree = null, status }) {
  const { id } = addJob({ projectId, prompt: `job ${slug ?? "unslugged"}`, slug, startWorktree }, env);
  if (status === "pending") return id;
  claimJobById(id, { worker: WORKER, cap: null }, env);
  if (status !== "running") finishJob(id, { worker: WORKER, status, noticeMd: "seeded" }, env);
  return id;
}

// The guard's answer to one Bash call on the operator's main thread (null when allowed).
function bash(env, { command, cwd }) {
  const input = { hook_event_name: "PreToolUse", session_id: "s-1", cwd, tool_name: "Bash", tool_input: { command } };
  return operatorDecision({ input, env });
}

// Records a consent of a project in the session.
function grant(env, { project, scope, kind = "home-maintenance" }) {
  return recordConsent({ session: env.NIGHTQUEUE_OPERATOR_SESSION, project, kind, scope, reason: "clean up after a job", answer: "yes, go ahead", env });
}

// A path with the case of one of its components flipped to upper case.
function upperCased(path, component) {
  return path.split("/").map((part) => (part === component ? part.toUpperCase() : part)).join("/");
}

test("S1 (H2): every relative or linked spelling of a running job's worktree removal is never, the absolute one names the job", (t) => {
  const fixture = setup(t);
  const { env, checkout, home, projectId, outside } = fixture;
  const id = jobAt(env, { projectId, slug: "fix-login", status: "running" });
  const wt = linkedWorktree(fixture, "fix-login");
  assert.match(bash(env, { command: `git -C ${checkout} worktree remove -f ${wt}`, cwd: home }), new RegExp(`never \\(.*belongs to J-${id} \\(running\\)`));
  const link = join(outside, "link");
  symlinkSync(wt, link);
  const relativeSpellings = [
    { command: `cd ${wt} && git worktree remove -f .`, cwd: home },
    { command: "git worktree remove -f .", cwd: wt },
    { command: "git worktree remove fix-login", cwd: dirname(wt) },
    { command: `git -C ${checkout} worktree remove ${relative(checkout, wt)}`, cwd: home },
    { command: `sh -c "cd ${wt} && git worktree remove -f ."`, cwd: home },
  ];
  for (const call of relativeSpellings) assert.match(bash(env, call), BY_ABSOLUTE_PATH, call.command);
  assert.match(bash(env, { command: `git -C ${checkout} worktree remove ${link}`, cwd: home }), /never \(/);
  assert.match(bash(env, { command: `git -C ${checkout} worktree move ${wt} ${join(outside, "moved")}`, cwd: home }), /never \(/);
});

test("S1 (H2): a consent for a relative removal of a running job's worktree is refused, like the absolute one", (t) => {
  const fixture = setup(t);
  const { env, checkout, project, projectId } = fixture;
  const id = jobAt(env, { projectId, slug: "fix-login", status: "running" });
  const wt = linkedWorktree(fixture, "fix-login");
  assert.throws(() => grant(env, { project, scope: `git -C ${checkout} worktree remove -f ${wt}` }), new RegExp(`belongs to J-${id} \\(running\\)`));
  assert.throws(() => grant(env, { project, scope: `cd ${wt} && git worktree remove -f .` }));
  assert.throws(() => grant(env, { project, scope: `git -C ${checkout} worktree remove ${relative(checkout, wt)}` }));
});

test("S1 (H2): the command the guard lets through does not remove the running job's worktree", (t) => {
  const fixture = setup(t);
  const { env, home, project, projectId } = fixture;
  jobAt(env, { projectId, slug: "fix-login", status: "running" });
  const wt = linkedWorktree(fixture, "fix-login");
  const command = `cd ${wt} && git worktree remove -f .`;
  assert.throws(() => grant(env, { project, scope: command }));
  if (bash(env, { command, cwd: home }) === null) execFileSync("sh", ["-c", command], { cwd: home, stdio: "pipe" });
  assert.ok(existsSync(join(wt, ".git")), `the worktree of the running job was removed by \`${command}\``);
});

test("S3 (H1): a case-variant spelling of a held entry is judged as the stored entry, by slug, project id and home prefix", (t) => {
  const fixture = setup(t);
  const { env, checkout, home, projectId } = fixture;
  const id = jobAt(env, { projectId, slug: "fix-login", status: "gate" });
  const run = join(home, "runs", projectId, "fix-login");
  const worktree = join(home, "worktrees", projectId, "fix-login");
  mkdirSync(run, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  if (!existsSync(upperCased(run, "fix-login"))) {
    t.skip("temp dir is case-sensitive: the case variant is a different directory");
    return;
  }
  const named = new RegExp(`belongs to J-${id} \\(gate\\)`);
  assert.match(neverBashReason(`rm -rf ${upperCased(run, "fix-login")}`, { cwd: home, env }) ?? "", named);
  assert.match(neverBashReason(`git -C ${checkout} worktree remove ${upperCased(worktree, "fix-login")}`, { cwd: home, env }) ?? "", named);
  assert.match(neverBashReason(`rm -rf ${run.replace(projectId, projectId.toLowerCase())}`, { cwd: home, env }) ?? "", named);
  assert.match(neverBashReason(`rm -rf ${upperCased(run, ".nightqueue")}`, { cwd: home, env }) ?? "", named);
  assert.equal(homeEntry(upperCased(run, "fix-login"), env).slug, "fix-login");
  assert.match(neverBashReason(`cat ${upperCased(secretsPath(env), ".nightqueue")}`, { cwd: home, env }) ?? "", /never-band|secrets/);
});

test("S3 (H1): the ownership read finds the holder of a case variant, by slug and by an upper-cased start worktree", (t) => {
  const { env, home, projectId } = setup(t);
  const id = jobAt(env, { projectId, slug: "fix-login", status: "running" });
  const run = join(home, "runs", projectId, "fix-login");
  const adopted = join(home, "worktrees", projectId, "adopted");
  mkdirSync(run, { recursive: true });
  mkdirSync(adopted, { recursive: true });
  if (!existsSync(upperCased(run, "fix-login"))) {
    t.skip("temp dir is case-sensitive: the case variant is a different directory");
    return;
  }
  assert.match(homeOwner(homeEntry(upperCased(run, "fix-login"), env), env) ?? "", new RegExp(`belongs to J-${id} \\(running\\)`));
  const adopter = jobAt(env, { projectId, startWorktree: upperCased(adopted, "adopted"), status: "pending" });
  assert.match(homeOwner(homeEntry(adopted, env), env) ?? "", new RegExp(`belongs to J-${adopter} \\(pending\\)`));
});

test("S3 (H1): a closed job's case variant needs consent, and that consent covers only its exact spelling", (t) => {
  const { env, home, project, projectId } = setup(t);
  seedClosedJob(env, { slug: "merged" });
  const run = join(home, "runs", projectId, "merged");
  mkdirSync(run, { recursive: true });
  const variant = upperCased(run, "merged");
  if (!existsSync(variant)) {
    t.skip("temp dir is case-sensitive: the case variant is a different directory");
    return;
  }
  assert.match(bash(env, { command: `rm -rf ${variant}`, cwd: home }), /needs consent \(home-maintenance rm -rf /);
  grant(env, { project, scope: `rm -rf ${variant}` });
  assert.equal(bash(env, { command: `rm -rf ${variant}`, cwd: home }), null);
  assert.match(bash(env, { command: `rm -rf ${run}`, cwd: home }), /needs consent \(home-maintenance/);
});

test("control: the exact-case spelling of a gate job's run dir is refused as held", (t) => {
  const { env, home, projectId } = setup(t);
  const id = jobAt(env, { projectId, slug: "ctl-login", status: "gate" });
  const run = join(home, "runs", projectId, "ctl-login");
  mkdirSync(run, { recursive: true });
  assert.match(neverBashReason(`rm -rf ${run}`, { cwd: home, env }) ?? "", new RegExp(`belongs to J-${id} \\(gate\\)`));
  assert.match(homeOwner(homeEntry(run, env), env) ?? "", new RegExp(`belongs to J-${id} \\(gate\\)`));
});

// Rewrites a worktree's `.git` to a repository of the job's own whose config runs a script on `git status` and `git diff`; answers the script's marker.
function hijackPointer(fixture, worktree) {
  const evilRepo = join(fixture.outside, "repo");
  mkdirSync(evilRepo, { recursive: true });
  git(evilRepo, ["init", "-q"]);
  writeFileSync(join(evilRepo, "a.txt"), "one\n");
  git(evilRepo, ["add", "a.txt"]);
  git(evilRepo, ["commit", "-q", "-m", "evil"]);
  const marker = join(fixture.outside, "ran-by-job");
  const script = join(fixture.outside, "fsmonitor.sh");
  writeFileSync(script, `#!/bin/sh\n: > "${marker}"\nexit 0\n`);
  chmodSync(script, 0o755);
  git(evilRepo, ["config", "core.fsmonitor", script]);
  git(evilRepo, ["config", "diff.evil.textconv", script]);
  writeFileSync(join(worktree, ".gitattributes"), "* diff=evil\n");
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(evilRepo, ".git")}\n`);
  return marker;
}

test("S4 (H3): a worktree whose .git a job rewrote is never read nor salvaged, and runs none of the job's programs", (t) => {
  const fixture = setup(t);
  const { env, home } = fixture;
  seedClosedJob(env, { slug: "fix-login" });
  const worktree = linkedWorktree(fixture, "fix-login");
  const marker = hijackPointer(fixture, worktree);
  for (const command of [`git -C ${worktree} --no-optional-locks status`, `git -C ${worktree} diff`, `git -C ${worktree} stash`]) {
    const decision = bash(env, { command, cwd: home });
    assert.match(decision ?? "", UNTRUSTED, command);
    if (decision === null) execFileSync("sh", ["-c", command], { env, stdio: "pipe" });
  }
  assert.equal(existsSync(marker), false, "the job's script ran from a free read");
});

test("S4 (H3): a real linked worktree with an intact pointer is read freely and salvaged under consent", (t) => {
  const fixture = setup(t);
  const { env, home } = fixture;
  seedClosedJob(env, { slug: "fix-login" });
  const worktree = linkedWorktree(fixture, "fix-login");
  const reads = [
    `git -C ${worktree} --no-optional-locks status`,
    `git -C ${worktree} log --oneline -1`,
    `git -C ${worktree} diff`,
    `git -C ${worktree} stash list`,
    `cd ${worktree} && git diff`,
  ];
  for (const command of reads) assert.equal(bash(env, { command, cwd: home }), null, command);
  assert.match(bash(env, { command: `git -C ${worktree} stash`, cwd: home }), /needs consent \(git-write git -C /);
});

test("S5: git's own lock in the checkout's admin dir holds a worktree, whatever its .git says", (t) => {
  const fixture = setup(t);
  const { env, checkout, home, outside } = fixture;
  seedClosedJob(env, { slug: "live" });
  seedClosedJob(env, { slug: "stale" });
  const live = linkedWorktree(fixture, "live");
  const stale = linkedWorktree(fixture, "stale");
  git(checkout, ["worktree", "lock", "--reason", `nightqueue job (pid ${process.pid})`, live]);
  git(checkout, ["worktree", "lock", "--reason", `nightqueue job (pid ${DEAD_PID})`, stale]);
  const held = new RegExp(`held by a live process \\(pid ${process.pid}\\)`);
  assert.match(bash(env, { command: `git -C ${checkout} worktree remove ${live}`, cwd: home }), held);
  assert.match(bash(env, { command: `git -C ${checkout} worktree remove ${stale}`, cwd: home }), /needs consent \(home-maintenance/);
  writeFileSync(join(live, ".git"), `gitdir: ${outside}\n`);
  assert.match(bash(env, { command: `rm -rf ${live}`, cwd: home }), held);
});

test("S6 (H5): doctor --fix is consentable only spelled `nightqueue doctor --fix`", (t) => {
  const { env, checkout, project } = setup(t);
  const program = "/opt/nq-poc/bin/nightqueue";
  grant(env, { project, kind: "run", scope: `${program} doctor` });
  const spelling = /never \(`doctor --fix` is consented only as `nightqueue doctor --fix`\)/;
  for (const command of [`cd ${checkout} && ${program} doctor --fix`, "bin/nightqueue.mjs doctor --fix", `timeout 30 ${program} doctor --fix`]) {
    assert.match(bash(env, { command, cwd: checkout }), spelling, command);
  }
  assert.match(bash(env, { command: "nightqueue doctor --fix", cwd: checkout }), /needs consent \(run nightqueue doctor --fix/);
  grant(env, { project, kind: "run", scope: "nightqueue doctor" });
  assert.match(bash(env, { command: "nightqueue doctor --fix", cwd: checkout }), /needs consent \(run nightqueue doctor --fix/);
  grant(env, { project, kind: "run", scope: "nightqueue doctor --fix" });
  assert.equal(bash(env, { command: "nightqueue doctor --fix", cwd: checkout }), null);
  assert.equal(bash(env, { command: "nightqueue doctor --json", cwd: checkout }), null);
});

test("H4: no relative-spelled salvage of a done job's worktree is allowed", (t) => {
  const fixture = setup(t);
  const { env, checkout, home } = fixture;
  seedDoneJob(env, { slug: "shipped" });
  const wt = linkedWorktree(fixture, "shipped");
  const salvage = [
    `cd ${wt} && cp -r . ${checkout}/salvaged`,
    `cd ${wt} && git stash`,
    `cd ${wt} && git stash push -m keep`,
    `cd ${wt} && git format-patch -1 -o ${checkout}`,
  ];
  for (const command of salvage) assert.notEqual(bash(env, { command, cwd: home }), null, `allowed: ${command}`);
  assert.match(bash(env, { command: `git -C ${wt} stash`, cwd: home }), /salvage copies from a closed or cancelled job; .* belongs to J-\d+ \(done\)/);
});

test("H4: a git-write stash consent of the checkout does not reach a done job's worktree through a relative spelling", (t) => {
  const fixture = setup(t);
  const { env, checkout, home, project } = fixture;
  seedDoneJob(env, { slug: "shipped" });
  const wt = linkedWorktree(fixture, "shipped");
  grant(env, { project, kind: "git-write", scope: "git stash" });
  assert.notEqual(bash(env, { command: `cd ${wt} && git stash`, cwd: home }), null, "a checkout stash consent covered a done job's worktree");
  assert.notEqual(bash(env, { command: `cd ${wt} && cp -r . ${checkout}/salvaged`, cwd: home }), null, "a copy out of a done job's worktree was allowed");
});
