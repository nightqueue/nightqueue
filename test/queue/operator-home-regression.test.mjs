import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
import { isolatedHostVars } from "../../test-support/host.mjs";
import { makeDir, makeHome, registerCheckout, seedClosedJob, seedDoneJob } from "../../test-support/memory.mjs";

const WORKER = "test:operator-home-regression";
const DEAD_PID = 2147483646;
const BY_ABSOLUTE_PATH = /never \(`git worktree remove\|move` names its worktree by its absolute path/;
const UNTRUSTED = /does not point to the admin dir git keeps for it/;
const HARDENED = "-c core.fsmonitor=false -c core.hooksPath=/dev/null";
const READ_HARDENED = /never \(a worktree under the nightqueue home is read only hardened.*`git -C <worktree> -c core\.fsmonitor=false -c core\.hooksPath=\/dev\/null \[--no-optional-locks\] <read>`/;
const LONG_AGO = new Date("2020-01-01T00:00:00Z");
const WRAPPED_GUARDED = /git, `nightqueue doctor --fix` and home maintenance run as one bare command, never behind/;

// Refuses to let a fixture's git write anywhere but a temporary directory, so a test never touches a real repository.
function assertTempDir(cwd) {
  const root = realpathSync(tmpdir());
  if (!realpathSync(cwd).startsWith(`${root}/`)) throw new Error(`refusing to run git outside the temp dir: ${cwd}`);
}

// The environment of the fixtures' git: no inherited GIT_* variable, no global or system config, a fixed identity.
function gitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "qa",
    GIT_AUTHOR_EMAIL: "qa@example.invalid",
    GIT_COMMITTER_NAME: "qa",
    GIT_COMMITTER_EMAIL: "qa@example.invalid",
  });
}

// Git for the fixtures: no hook and no fsmonitor, only inside the temp dir.
function git(cwd, args) {
  assertTempDir(cwd);
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env: gitEnv(), stdio: "pipe" }).toString();
}

// Runs a shell command the guard let through on a worktree in the temp dir, with the fixtures' git environment.
function runAllowed(worktree, command) {
  assertTempDir(worktree);
  execFileSync("sh", ["-c", command], { cwd: worktree, env: gitEnv(), stdio: "pipe" });
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
    `git -C ${worktree} ${HARDENED} --no-optional-locks status --ignore-submodules=all`,
    `git -C ${worktree} ${HARDENED} log --oneline -1`,
    `git -C ${worktree} ${HARDENED} diff --ignore-submodules=all`,
    `git -C ${worktree} ${HARDENED} stash list`,
  ];
  for (const command of reads) assert.equal(bash(env, { command, cwd: home }), null, command);
  assert.match(bash(env, { command: `git -C ${worktree} --no-optional-locks status`, cwd: home }), READ_HARDENED);
  assert.match(bash(env, { command: `cd ${worktree} && git diff`, cwd: home }), /is only read as `git -C <worktree> -c core\.fsmonitor=false/);
  assert.notEqual(bash(env, { command: `cd ${worktree} && git ${HARDENED} diff --ignore-submodules=all`, cwd: home }), null);
  assert.match(bash(env, { command: `git -C ${worktree} ${HARDENED} format-patch -1 -o ${fixture.checkout}`, cwd: home }), /needs consent \(git-write git -C /);
  assert.match(bash(env, { command: `git -C ${worktree} ${HARDENED} stash`, cwd: home }), /never \(a worktree under the nightqueue home is never stashed/);
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
  assert.match(bash(env, { command: `git -C ${wt} ${HARDENED} format-patch -1 -o ${checkout}`, cwd: home }), /salvage copies from a closed or cancelled job; .* belongs to J-\d+ \(done\)/);
  assert.match(bash(env, { command: `git -C ${wt} ${HARDENED} stash`, cwd: home }), /never \(a worktree under the nightqueue home is never stashed/);
});

const GIT_OFF_ALLOWLIST = [
  "--config-env=x", "--config-env x", "--attr-source=HEAD", "--attr-source HEAD", "--super-prefix x/", "--list-cmds=main",
  "--literal-pathspecs", "--bare", "-p", "--exec-path=/x", "--git-dir=/x", "--work-tree /x", "--namespace x", "-c core.worktree=/x",
  "--future-flag",
];
const UNKNOWN_WRAPPERS = ["stdbuf -oL ", "ionice -c3 ", "setsid ", "caffeinate -i ", "frobwrap x "];
const GIT_WRAPPERS = ["", "env ", "nice ", "sudo ", "FOO=1 ", "timeout 5 ", "sudo -u root ", "env -u HOME ", "env -C /tmp ", "timeout -s KILL 5 ", ...UNKNOWN_WRAPPERS];

test("H6: a git global option off the allowlist is never, behind every wrapper, and no consent reaches a running job's worktree", (t) => {
  const fixture = setup(t);
  const { env, checkout, project, projectId } = fixture;
  jobAt(env, { projectId, slug: "fix-login", status: "running" });
  const wt = linkedWorktree(fixture, "fix-login");
  grant(env, { project, kind: "git-write", scope: "git stash" });
  grant(env, { project, kind: "run", scope: "env" });
  const tails = [`worktree remove -f ${wt}`, `-C ${checkout} checkout -- .`, "stash", "commit -m x"];
  for (const option of GIT_OFF_ALLOWLIST) {
    for (const tail of tails) {
      for (const wrapper of GIT_WRAPPERS) {
        const command = `${wrapper}git ${option} ${tail}`;
        const never = neverBashReason(command, { cwd: checkout, env });
        assert.match(never ?? "", tail.includes(wt) ? /./ : /a git global option other than/, command);
        assert.notEqual(bash(env, { command, cwd: checkout }), null, `allowed: ${command}`);
      }
      assert.throws(() => grant(env, { project, kind: "git-write", scope: `git ${option} ${tail}` }), /never band/, option);
      assert.throws(() => grant(env, { project, kind: "run", scope: `env git ${option} ${tail}` }), /never band/, option);
    }
  }
  assert.ok(existsSync(join(wt, ".git")), "the running job's worktree was touched");
});

test("H6: the allowlisted git globals stay out of the never band, and a wrapped or path-spelled git has no consentable form", (t) => {
  const { env, checkout, project } = setup(t);
  const allowed = [
    `git --no-pager -C ${checkout} log`,
    `git -C ${checkout} --no-optional-locks status`,
    `git -C ${checkout} -c core.fsmonitor=false -c core.hooksPath=/dev/null diff`,
    "git version",
  ];
  for (const command of allowed) assert.equal(neverBashReason(command, { cwd: checkout, env }), null, command);
  for (const command of ["git --version", "git --help", "git -- status", `git -C ${checkout} -c core.fsmonitor=true status`]) {
    assert.match(neverBashReason(command, { cwd: checkout, env }), /a git global option other than/, command);
  }
  grant(env, { project, kind: "git-write", scope: "git stash" });
  grant(env, { project, kind: "run", scope: "env" });
  assert.equal(bash(env, { command: "git stash", cwd: checkout }), null);
  for (const command of ["env git stash", "nice git stash", "sudo git stash", "FOO=1 git stash", "/usr/bin/git stash", ...UNKNOWN_WRAPPERS.map((wrapper) => `${wrapper}git stash`)]) {
    assert.match(bash(env, { command, cwd: checkout }), WRAPPED_GUARDED, command);
  }
});

test("H6: a wrapper option that takes a value does not hide git from the never band or the wrapped-git shape", (t) => {
  const { env, checkout, project } = setup(t);
  const injections = [
    "env -u HOME git -c core.hooksPath=/tmp/h commit -m x",
    "sudo -u root git -c core.fsmonitor=/tmp/evil status",
    "sudo -Eu root -g wheel git -c core.hooksPath=/tmp/h commit -m x",
    "sudo --user=root git -c core.hooksPath=/tmp/h commit -m x",
    "env --chdir /tmp git -c core.hooksPath=/tmp/h commit -m x",
    "timeout -s KILL 5 git --config-env=x stash",
    "timeout --kill-after 2 5 git --config-env=x stash",
    "nice -n -5 git --config-env=x stash",
    "xargs -I {} git -c core.hooksPath=/tmp/h commit -m {}",
  ];
  for (const command of injections) {
    assert.match(neverBashReason(command, { cwd: checkout, env }) ?? "", /a git global option other than/, command);
  }
  assert.match(neverBashReason("env -S 'git -c core.hooksPath=/tmp/h commit -m x'", { cwd: checkout, env }) ?? "", /env -S/);
  grant(env, { project, kind: "git-write", scope: "git stash" });
  grant(env, { project, kind: "run", scope: "env" });
  const wrapped = ["sudo -u root git stash", "env -u HOME git stash", "env -C /tmp git stash", "timeout -s KILL 5 git stash", "sudo --unknown-option value git stash"];
  for (const command of wrapped) {
    assert.match(bash(env, { command, cwd: checkout }), WRAPPED_GUARDED, command);
  }
});

const DOCTOR_FIX_WRAPPERS = ["env ", "nice ", "sudo ", "FOO=1 ", "sudo -u root ", "env -C /tmp ", "timeout -s KILL 5 ", ...UNKNOWN_WRAPPERS];
const DOCTOR_FIX_SPELLING = /never \(`doctor --fix` is consented only as `nightqueue doctor --fix`\)/;

test("H8: a wrapped or nested `doctor --fix` is never, and no wrapped consent covers it", (t) => {
  const { env, checkout, project } = setup(t);
  const nested = ["sh -c 'nightqueue doctor --fix'", "eval nightqueue doctor --fix"];
  for (const command of [...DOCTOR_FIX_WRAPPERS.map((wrapper) => `${wrapper}nightqueue doctor --fix`), ...nested]) {
    assert.match(neverBashReason(command, { cwd: checkout, env }) ?? "", /`doctor --fix` is consented only as `nightqueue doctor --fix`/, command);
    assert.match(bash(env, { command, cwd: checkout }), DOCTOR_FIX_SPELLING, command);
  }
  for (const wrapper of DOCTOR_FIX_WRAPPERS) {
    assert.throws(() => grant(env, { project, kind: "run", scope: `${wrapper}nightqueue doctor --fix` }), /never band/, wrapper);
  }
  grant(env, { project, kind: "run", scope: "nightqueue doctor" });
  grant(env, { project, kind: "run", scope: "env nightqueue doctor" });
  assert.match(bash(env, { command: "nightqueue doctor --fix", cwd: checkout }), /needs consent \(run nightqueue doctor --fix/);
  assert.match(bash(env, { command: "sudo --unknown-option value nightqueue doctor --fix", cwd: checkout }), DOCTOR_FIX_SPELLING);
  assert.throws(() => grant(env, { project, kind: "run", scope: "sudo --unknown-option value nightqueue doctor --fix" }), /never band/);
  assert.throws(() => grant(env, { project, kind: "run", scope: "sh -c 'nightqueue doctor --fix'" }), /never band/);
  grant(env, { project, kind: "run", scope: "timeout 30 nightqueue doctor --fix" });
  assert.equal(bash(env, { command: "nightqueue doctor --fix", cwd: checkout }), null);
  assert.equal(bash(env, { command: "timeout 9 nightqueue doctor --fix", cwd: checkout }), null);
  for (const wrapper of DOCTOR_FIX_WRAPPERS) {
    assert.match(bash(env, { command: `${wrapper}nightqueue doctor --fix`, cwd: checkout }), DOCTOR_FIX_SPELLING, wrapper);
  }
});

test("H8: a wrapped git or home maintenance scope is refused at grant time, and a wrapped command is covered only by its exact words", (t) => {
  const fixture = setup(t);
  const { env, checkout, project } = fixture;
  seedClosedJob(env, { slug: "old-fix" });
  const wt = linkedWorktree(fixture, "old-fix");
  for (const scope of ["env git stash", "/usr/bin/git stash", "sudo -u root git commit -m x"]) {
    assert.throws(() => grant(env, { project, kind: "git-write", scope }), /no consentable form|never band/, scope);
    assert.throws(() => grant(env, { project, kind: "run", scope }), /no consentable form|never band/, scope);
  }
  for (const scope of [`/usr/bin/git -C ${checkout} worktree prune`, `env git -C ${checkout} worktree prune`, `nice rm -rf ${wt}`, `FOO=1 git -C ${checkout} worktree remove ${wt}`]) {
    assert.throws(() => grant(env, { project, scope }), /no consentable form|never band|home-maintenance consent is one exact command/, scope);
  }
  for (const command of [`env git -C ${checkout} worktree prune`, `/usr/bin/git -C ${checkout} worktree prune`, `nice rm -rf ${wt}`, `sudo git -C ${checkout} worktree remove ${wt}`]) {
    assert.notEqual(bash(env, { command, cwd: checkout }), null, `allowed: ${command}`);
  }
  assert.ok(existsSync(join(wt, ".git")), "the worktree was touched");
  grant(env, { project, kind: "run", scope: "env NODE_ENV=test npm test" });
  assert.equal(bash(env, { command: "env NODE_ENV=test npm test", cwd: checkout }), null);
  for (const command of ["npm test", "sudo env NODE_ENV=test npm test", "nice env NODE_ENV=test npm test"]) {
    assert.match(bash(env, { command, cwd: checkout }), /needs consent \(run /, command);
  }
});

test("H8: an unknown wrapper hides neither git, `doctor --fix` nor home maintenance, and its consent covers only its exact words", (t) => {
  const { env, checkout, home, project } = setup(t);
  for (const wrapper of UNKNOWN_WRAPPERS) {
    const injected = `${wrapper}git -c core.hooksPath=/tmp/h commit -m x`;
    assert.match(neverBashReason(injected, { cwd: checkout, env }) ?? "", /a git global option other than/, injected);
    assert.notEqual(neverBashReason(`${wrapper}rm -rf ${join(home, "runs")}`, { cwd: checkout, env }), null, wrapper);
    for (const scope of [injected, `${wrapper}git stash`, `${wrapper}nightqueue doctor --fix`, `${wrapper}git -C ${checkout} worktree prune`]) {
      assert.throws(() => grant(env, { project, kind: "run", scope }), /never band|no consentable form/, scope);
      assert.throws(() => grant(env, { project, kind: "git-write", scope }), /never band|no consentable form/, scope);
      assert.notEqual(bash(env, { command: scope, cwd: checkout }), null, `allowed: ${scope}`);
    }
  }
  grant(env, { project, kind: "run", scope: "stdbuf -oL npm test" });
  assert.equal(bash(env, { command: "stdbuf -oL npm test", cwd: checkout }), null);
  for (const command of ["npm test", "stdbuf npm test", "nice stdbuf -oL npm test"]) {
    assert.match(bash(env, { command, cwd: checkout }), /needs consent \(run /, command);
  }
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

// Turns the pull request check on and points gh at the fake CLI answering one pull request state.
function fakeGhAnswering(t, env, state) {
  const vars = isolatedHostVars(makeDir(t, "operator-home-regression-gh"));
  delete env.NIGHTQUEUE_NO_PR_CHECK;
  Object.assign(env, { NIGHTQUEUE_GH_BIN: vars.NIGHTQUEUE_GH_BIN, NIGHTQUEUE_FAKE_GH_LOG: vars.NIGHTQUEUE_FAKE_GH_LOG, NIGHTQUEUE_FAKE_GH_PR_STATE: state });
}

test("Stage 4: no S1 or S3 spelling removes a done job's run dir or worktree while its pull request is open", (t) => {
  const fixture = setup(t);
  const { env, checkout, home, project, projectId, outside } = fixture;
  fakeGhAnswering(t, env, "OPEN");
  const id = seedDoneJob(env, { slug: "shipped", prUrl: "https://github.com/acme/api/pull/7" });
  const wt = linkedWorktree(fixture, "shipped");
  const run = join(home, "runs", projectId, "shipped");
  mkdirSync(run, { recursive: true });
  const named = new RegExp(`never \\(.*belongs to J-${id} \\(done, pull request https://github\\.com/acme/api/pull/7 is open\\)`);
  assert.match(bash(env, { command: `git -C ${checkout} worktree remove -f ${wt}`, cwd: home }), named);
  assert.match(bash(env, { command: `rm -rf ${run}`, cwd: home }), named);
  assert.throws(() => grant(env, { project, scope: `git -C ${checkout} worktree remove -f ${wt}` }), new RegExp(`belongs to J-${id} \\(done, pull request`));
  assert.throws(() => grant(env, { project, scope: `rm -rf ${run}` }), new RegExp(`belongs to J-${id} \\(done, pull request`));
  const link = join(outside, "link");
  symlinkSync(wt, link);
  const spellings = [
    { command: `cd ${wt} && git worktree remove -f .`, cwd: home },
    { command: "git worktree remove -f .", cwd: wt },
    { command: "git worktree remove shipped", cwd: dirname(wt) },
    { command: `git -C ${checkout} worktree remove ${relative(checkout, wt)}`, cwd: home },
    { command: `sh -c "cd ${wt} && git worktree remove -f ."`, cwd: home },
    { command: `git -C ${checkout} worktree remove ${link}`, cwd: home },
    { command: `cd ${run} && rm -rf .`, cwd: home },
    { command: "rm -rf shipped", cwd: dirname(run) },
  ];
  for (const call of spellings) assert.match(bash(env, call) ?? "", /never \(/, call.command);
  if (existsSync(upperCased(run, "shipped"))) {
    const variants = [
      `rm -rf ${upperCased(run, "shipped")}`,
      `git -C ${checkout} worktree remove -f ${upperCased(wt, "shipped")}`,
      `rm -rf ${run.replace(projectId, projectId.toLowerCase())}`,
      `rm -rf ${upperCased(run, ".nightqueue")}`,
    ];
    for (const command of variants) assert.match(bash(env, { command, cwd: home }) ?? "", named, command);
  }
  assert.ok(existsSync(join(wt, ".git")), "the worktree of a done job with an open pull request was removed");
  assert.ok(existsSync(run), "the run dir of a done job with an open pull request was removed");
});

test("H1 (fix loop 4): an argument that only shares git's name keeps a read out of the never band, and git hidden behind a wrapper stays never", (t) => {
  const { env, checkout } = setup(t);
  const free = [
    `git -C ${checkout} diff src/host/git.mjs`,
    `git -C ${checkout} log -- src/host/git.mjs`,
    `git -C ${checkout} log --grep git`,
    `git -C ${checkout} log -S git`,
    "git blame src/host/git.mjs",
    `cat ${checkout}/src/host/git.mjs`,
    "grep -n x test-support/git.mjs",
  ];
  for (const command of free) assert.equal(neverBashReason(command, { cwd: checkout, env }), null, command);
  assert.equal(bash(env, { command: `git -C ${checkout} log --grep git`, cwd: checkout }), null);
  assert.equal(bash(env, { command: `git -C ${checkout} diff src/host/git.mjs`, cwd: checkout }), null);
  const hidden = ["sudo git stash", "stdbuf -oL git stash", "stdbuf -oL /usr/bin/git stash", "frobwrap x git commit -m x", `git bisect run git -c core.hooksPath=${checkout} commit`];
  for (const command of hidden) assert.notEqual(neverBashReason(command, { cwd: checkout, env }), null, command);
});

// Writes a gh stand-in that answers `gh pr view <url>` after a delay, OPEN for pull request 5 and MERGED for any other, logging each URL.
function perUrlGh(t, env) {
  const dir = makeDir(t, "operator-home-regression-gh-per-url");
  const log = join(dir, "calls.log");
  const script = join(dir, "gh");
  const open = '{"state":"OPEN","mergedAt":null,"mergeCommit":null,"mergeable":"MERGEABLE","isDraft":false}';
  const merged = '{"state":"MERGED","mergedAt":"2026-09-11T15:54:01Z","mergeCommit":{"oid":"abc123"},"mergeable":"UNKNOWN","isDraft":false}';
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$3" >> "${log}"\nsleep 1.5\ncase "$3" in\n  */pull/5) printf '%s\\n' '${open}' ;;\n  *) printf '%s\\n' '${merged}' ;;\nesac\n`);
  chmodSync(script, 0o755);
  delete env.NIGHTQUEUE_NO_PR_CHECK;
  env.NIGHTQUEUE_GH_BIN = script;
  return () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
}

// Seeds one done job with a pull request and a run dir per slug; answers each one's id, run dir and pull request URL.
function doneRuns({ env, home, projectId }, slugs) {
  return slugs.map((slug, index) => {
    const run = join(home, "runs", projectId, slug);
    mkdirSync(run, { recursive: true });
    const prUrl = `https://github.com/acme/api/pull/${index + 1}`;
    return { run, prUrl, id: seedDoneJob(env, { slug, prUrl }) };
  });
}

test("H3 (fix loop 4): a chain of done jobs' run dirs reads every pull request once, in parallel, inside the hook's 5 s", (t) => {
  const fixture = setup(t);
  const { env, home } = fixture;
  const calls = perUrlGh(t, env);
  const runs = doneRuns(fixture, ["m1", "m2", "m3", "m4", "open5"]);
  const open = runs.at(-1);
  const started = Date.now();
  const reason = bash(env, { command: runs.map(({ run }) => `rm -rf ${run}`).join("; "), cwd: home });
  assert.ok(Date.now() - started < 5000, `the guard took ${Date.now() - started} ms`);
  assert.match(reason ?? "", new RegExp(`belongs to J-${open.id} \\(done, pull request ${open.prUrl} is open\\)`));
  assert.deepEqual(calls().sort(), runs.map(({ prUrl }) => prUrl).sort(), "each pull request is read exactly once");
  const before = calls().length;
  assert.match(bash(env, { command: `rm -rf ${runs[0].run}`, cwd: home }) ?? "", /needs consent \(home-maintenance rm -rf /);
  assert.equal(calls().length - before, 1, "the never and consent bands read the merged pull request once in one decision");
  for (const { run } of runs) assert.ok(existsSync(run), run);
});

// Writes an executable script that leaves a marker file and then runs a tail line; answers its path.
function markerScript(dir, { name, marker, tail }) {
  const script = join(dir, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\n: > "${marker}"\n${tail}\n`);
  chmodSync(script, 0o755);
  return script;
}

// Plants in a worktree a committed nested repo whose own config runs a script as its fsmonitor and as a clean filter, with `.gitmodules` asking git to read it; answers the two markers.
function plantNestedRepo({ outside }, worktree) {
  const nested = join(worktree, "nested");
  mkdirSync(nested);
  git(nested, ["init", "-q"]);
  writeFileSync(join(nested, "a.txt"), "one\n");
  git(nested, ["add", "a.txt"]);
  git(nested, ["commit", "-q", "-m", "nested"]);
  writeFileSync(join(worktree, ".gitmodules"), '[submodule "nested"]\n\tpath = nested\n\turl = ./nested\n\tignore = none\n');
  git(worktree, ["add", "nested", ".gitmodules"]);
  git(worktree, ["commit", "-q", "-m", "plant a nested repo"]);
  const markers = [join(outside, "ran-fsmonitor"), join(outside, "ran-clean-filter")];
  git(nested, ["config", "core.fsmonitor", markerScript(outside, { name: "fsmonitor", marker: markers[0], tail: "exit 0" })]);
  git(nested, ["config", "filter.evil.clean", markerScript(outside, { name: "clean", marker: markers[1], tail: "exec cat" })]);
  writeFileSync(join(nested, ".gitattributes"), "* filter=evil\n");
  writeFileSync(join(nested, "a.txt"), "two\n");
  utimesSync(join(nested, "a.txt"), LONG_AGO, LONG_AGO);
  return markers;
}

// The markers a run left, removed so the next run starts clean.
function takeMarkers(markers) {
  const left = markers.filter((marker) => existsSync(marker));
  for (const marker of left) rmSync(marker);
  return left;
}

test("H7: a nested repo planted with an fsmonitor and a clean filter runs nothing on a hardened worktree read", (t) => {
  const fixture = setup(t);
  const { env, checkout, home } = fixture;
  seedClosedJob(env, { slug: "fix-login" });
  const wt = linkedWorktree(fixture, "fix-login");
  const markers = plantNestedRepo(fixture, wt);
  assert.equal(bash(env, { command: `git -C ${checkout} ${HARDENED} --no-optional-locks status`, cwd: home }), null, "a hardened read of a checkout is not free");
  runAllowed(wt, `git -C ${wt} --no-optional-locks status`);
  assert.ok(takeMarkers(markers).includes(markers[0]), "control: the planted fsmonitor did not run on a plain status");
  runAllowed(wt, `git -C ${wt} ${HARDENED} --no-optional-locks status`);
  assert.deepEqual(takeMarkers(markers), [markers[1]], "control: the planted clean filter did not run past the -c pair alone");
  const refused = [
    `git -C ${wt} --no-optional-locks status`,
    `git -C ${wt} ${HARDENED} --no-optional-locks status`,
    `git -C ${wt} ${HARDENED} diff`,
    `git -C ${wt} ${HARDENED} diff --ignore-submodules=all --submodule=diff`,
    `git -C ${wt} ${HARDENED} log -p --submodule=diff`,
    `git -C ${wt} ${HARDENED} ls-files --recurse-submodules`,
    `git -C ${wt} ${HARDENED} --no-optional-locks status --ignore-submodules=all --ignore-submod=none`,
    `git -C ${wt} ${HARDENED} --no-optional-locks status --ignore-submodules=all --no-ignore-submodules`,
    `git -C ${wt} ${HARDENED} ls-files --recurse-submod`,
    `git -C ${wt} ${HARDENED} ls-files --rec`,
  ];
  for (const command of refused) assert.match(bash(env, { command, cwd: home }) ?? "", /never \(a worktree under the nightqueue home is read only hardened/, command);
  for (const command of [`git -C ${wt} stash`, `git -C ${wt} ${HARDENED} stash`, `git -C ${wt} ${HARDENED} stash push -m keep`]) {
    assert.match(bash(env, { command, cwd: home }) ?? "", /never \(a worktree under the nightqueue home is never stashed/, command);
  }
  assert.match(bash(env, { command: `cd ${wt} && git diff`, cwd: home }), /is only read as `git -C <worktree> -c core\.fsmonitor=false/);
  assert.notEqual(bash(env, { command: `cd ${wt} && git ${HARDENED} diff --ignore-submodules=all`, cwd: home }), null);
  const allowed = [
    `git -C ${wt} ${HARDENED} --no-optional-locks status --ignore-submodules=all`,
    `git -C ${wt} ${HARDENED} diff --ignore-submodules=all`,
    `git -C ${wt} ${HARDENED} log --oneline -3`,
    `git -C ${wt} ${HARDENED} log -p -2`,
    `git -C ${wt} ${HARDENED} show HEAD`,
    `git -C ${wt} ${HARDENED} blame .gitmodules`,
    `git -C ${wt} ${HARDENED} ls-tree HEAD`,
    `git -C ${wt} ${HARDENED} ls-files`,
    `git -C ${wt} ${HARDENED} rev-parse HEAD`,
    `git -C ${wt} ${HARDENED} branch --list`,
    `git -C ${wt} ${HARDENED} stash list`,
  ];
  for (const command of allowed) {
    assert.equal(bash(env, { command, cwd: home }), null, command);
    runAllowed(wt, command);
    assert.deepEqual(takeMarkers(markers), [], `the job's planted program ran from \`${command}\``);
  }
});
