import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { newId } from "../../src/config/ids.mjs";
import { operatorDecision } from "../../src/hooks/operator-guard.mjs";
import { makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";

const OLD_HARDENING = "-c core.fsmonitor=false -c core.hooksPath=/dev/null";
const HARDENING = `${OLD_HARDENING} --no-lazy-fetch`;
const EXCL = "':(top,exclude,glob)**/.env*'";
const FULL_SPELLING_SHOWN = /--no-lazy-fetch grep \[--cached\] <options> <pattern> -- \[<paths>\] ':\(top,exclude,glob\)\*\*\/\.env\*'/;
const REVISION_NEVER = /never a revision/;
const SECRET_TEXT = "TOPSECRET-foo-outside-the-repo";
const DOTENV_SECRET = "DOTENV-SECRET";
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const COMMITTER = ["-c", "user.name=t", "-c", "user.email=t@t"];
const RUN_TIMEOUT_MS = 30000;

// Tells whether a program runs on this machine, so the proof is skipped where git or zsh is absent.
function available(program, args) {
  return spawnSync(program, args, { encoding: "utf8" }).status === 0;
}

const SKIP = available("git", ["--version"]) && available("zsh", ["-f", "-c", "true"]) ? false : "git or zsh is not installed";

// Runs git with no global or system config, throwing with git's stderr when it fails.
function git(args, { cwd, allowFail = false } = {}) {
  const result = spawnSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8", timeout: RUN_TIMEOUT_MS });
  if (!allowFail && result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

// Writes an executable trap script that touches its marker in the markers dir when any git config runs it, then passes its input through (or exits, for a transport).
function writeTrap({ scripts, markers }, name, { passThrough = true } = {}) {
  const path = join(scripts, `${name}.sh`);
  writeFileSync(path, `#!/bin/sh\ntouch '${join(markers, name)}'\n${passThrough ? "cat" : "exit 1"}\n`, { mode: 0o755 });
  return path;
}

// The four working dirs of one proof (repo, trap scripts, markers, a neutral cwd), created under a temp root.
function proofDirs(t) {
  const root = makeDir(t, "grep-poc");
  const dirs = { root, repo: join(root, "repo"), scripts: join(root, "scripts"), markers: join(root, "markers"), cwd: join(root, "cwd") };
  for (const dir of [dirs.repo, dirs.scripts, dirs.markers, dirs.cwd]) mkdirSync(dir, { recursive: true });
  return dirs;
}

// Writes each file of a map under the repo, creating its directories.
function writeFiles(repo, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(repo, name, ".."), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
}

// Stages everything in the repo and commits it with a fixed identity.
function commitAll(repo, message) {
  git(["-C", repo, "add", "-A"]);
  git(["-C", repo, ...COMMITTER, "commit", "-q", "-m", message]);
}

// A real repository with every program trap planted in its .git/config and a tracked link to a secret file outside it.
function trappedRepo(t) {
  const dirs = proofDirs(t);
  const secret = join(dirs.root, "secret.txt");
  writeFileSync(secret, `${SECRET_TEXT}\n`);
  git(["init", "-q", dirs.repo]);
  writeFiles(dirs.repo, {
    "a.txt": "foo bar\nfunction foo() {\n  return 1;\n}\n",
    "b.p": "foo in a process-filtered file\n",
    ".gitattributes": "*.txt diff=trapdiff filter=trapfilter\n*.p filter=trapproc\n",
  });
  symlinkSync(secret, join(dirs.repo, "link"));
  commitAll(dirs.repo, "seed");
  plantTraps(dirs);
  return dirs;
}

// Plants a program trap under every config key that runs one: fsmonitor, textconv, clean, smudge, process, pager and a promisor's upload-pack.
function plantTraps(dirs) {
  const config = [
    ["core.fsmonitor", writeTrap(dirs, "fsmonitor")],
    ["diff.trapdiff.textconv", writeTrap(dirs, "textconv")],
    ["filter.trapfilter.clean", writeTrap(dirs, "clean")],
    ["filter.trapfilter.smudge", writeTrap(dirs, "smudge")],
    ["filter.trapproc.process", writeTrap(dirs, "process")],
    ["core.pager", writeTrap(dirs, "pager")],
    ["remote.origin.url", join(dirs.cwd, "missing-remote")],
    ["remote.origin.promisor", "true"],
    ["remote.origin.uploadpack", writeTrap(dirs, "uploadpack", { passThrough: false })],
  ];
  for (const [key, value] of config) git(["-C", dirs.repo, "config", key, value]);
}

// The trapped repository made a partial clone of its promisor remote, the file protocol allowed, with the blob of `a.txt` deleted.
function promisorRepo(t) {
  const dirs = trappedRepo(t);
  git(["-C", dirs.repo, "config", "extensions.partialClone", "origin"]);
  git(["-C", dirs.repo, "config", "protocol.file.allow", "always"]);
  const blob = git(["-C", dirs.repo, "rev-parse", "HEAD:a.txt"]).stdout.trim();
  unlinkSync(join(dirs.repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  return dirs;
}

// A real repository with tracked `.env*` files at every depth, an `.envrc`, a look-alike `config.env.ts`, and two commits for a reflog.
function dotenvRepo(t) {
  const dirs = proofDirs(t);
  git(["init", "-q", dirs.repo]);
  writeFiles(dirs.repo, { "a.txt": "foo first\n", "sub/config.env.ts": "foo config TODO: keep\n" });
  commitAll(dirs.repo, "first");
  writeFiles(dirs.repo, {
    ".env": `${DOTENV_SECRET}-root foo\n`,
    ".env.local": `${DOTENV_SECRET}-local foo\n`,
    "sub/deep/.env.production": `${DOTENV_SECRET}-production foo\n`,
    "sub/.envrc": `${DOTENV_SECRET}-envrc foo\n`,
  });
  commitAll(dirs.repo, "second");
  return dirs;
}

// The markers a run left, the dir emptied for the next one.
function takeMarkers(markers) {
  const found = readdirSync(markers);
  for (const name of found) rmSync(join(markers, name));
  return found;
}

// Runs one command line through zsh exactly as the operator's shell would, from a directory of its own.
function runZsh(command, cwd) {
  const result = spawnSync("zsh", ["-f", "-c", command], { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8", timeout: RUN_TIMEOUT_MS });
  if (result.error) throw new Error(`zsh -c ${command} did not finish: ${result.error.message}`);
  return result;
}

// An operator session's env with the repository as its one registered checkout.
function operatorEnv(t, repo) {
  const env = makeHome(t, "grep-poc-home");
  registerCheckout(env, { path: repo, name: "alpha" });
  return { ...env, NIGHTQUEUE_MODE: "operator", NIGHTQUEUE_OPERATOR_SESSION: newId() };
}

// The guard's answer to one Bash call on the main thread or a subagent.
function decide(env, command, agent = false) {
  const input = { hook_event_name: "PreToolUse", session_id: "s-1", cwd: "/", tool_name: "Bash", tool_input: { command } };
  return operatorDecision({ input: agent ? { ...input, agent_id: "a1", agent_type: "nightqueue:explore" } : input, env });
}

// Asserts both threads allow a command, so the proof only ever runs what the guard lets through.
function assertFree(env, command) {
  assert.equal(decide(env, command), null, `main thread allows ${command}`);
  assert.equal(decide(env, command, true), null, `a subagent allows ${command}`);
}

// Asserts both threads refuse a command in the never band, its reason matching.
function assertNeverOnBoth(env, command, reason) {
  for (const agent of [false, true]) {
    const answer = decide(env, command, agent) ?? "";
    assert.match(answer, /^operator guard: never \(/, command);
    assert.match(answer, reason, command);
  }
}

test("every free hardened git grep runs no planted program and prints no secret outside the checkout", { skip: SKIP }, (t) => {
  const dirs = trappedRepo(t);
  const env = operatorEnv(t, dirs.repo);
  takeMarkers(dirs.markers);
  assertNeverOnBoth(env, `git -C ${dirs.repo} ${HARDENING} grep foo HEAD -- ${EXCL}`, REVISION_NEVER);
  for (const spelling of ["foo --", "--cached foo --", "-p foo --", "-W foo --", "-n foo --", "-e foo -- 'link'"]) {
    const command = `git -C ${dirs.repo} ${HARDENING} grep ${spelling} ${EXCL}`;
    assertFree(env, command);
    const result = runZsh(command, dirs.cwd);
    assert.ok(result.status === 0 || result.status === 1, `${command} failed: ${result.stderr}`);
    assert.deepEqual(takeMarkers(dirs.markers), [], `${command} ran a planted program`);
    assert.equal(`${result.stdout}${result.stderr}`.includes(SECRET_TEXT), false, `${command} printed the secret`);
  }
  assert.match(runZsh(`git -C ${dirs.repo} ${HARDENING} grep -n foo -- ${EXCL}`, dirs.cwd).stdout, /^a\.txt:1:foo bar$/m, "the hardened grep still finds the pattern");
});

test("every control fires its planted trap, so the free proof is not vacuous", { skip: SKIP }, (t) => {
  const dirs = trappedRepo(t);
  takeMarkers(dirs.markers);
  const hardening = OLD_HARDENING.split(" ");
  const controls = [
    ["fsmonitor", () => git(["-C", dirs.repo, "grep", "foo"], { allowFail: true })],
    ["fsmonitor", () => git(["-C", dirs.repo, "status"], { allowFail: true })],
    ["textconv", () => git(["-C", dirs.repo, ...hardening, "grep", "--textconv", "foo"], { allowFail: true })],
    ["smudge", () => {
      unlinkSync(join(dirs.repo, "a.txt"));
      git(["-C", dirs.repo, ...hardening, "checkout", "--", "a.txt"], { allowFail: true });
    }],
    ["clean", () => {
      writeFileSync(join(dirs.repo, "a.txt"), "changed\n");
      git(["-C", dirs.repo, ...hardening, "add", "a.txt"], { allowFail: true });
    }],
  ];
  for (const [marker, run] of controls) {
    run();
    assert.ok(takeMarkers(dirs.markers).includes(marker), `the ${marker} control fired no marker`);
  }
});

test("with a promisor remote and a missing blob, no free grep lazily fetches, while the (A) spelling runs the planted upload-pack", { skip: SKIP }, (t) => {
  const dirs = promisorRepo(t);
  const env = operatorEnv(t, dirs.repo);
  takeMarkers(dirs.markers);
  for (const spelling of ["foo HEAD", "-e foo HEAD"]) assertNeverOnBoth(env, `git -C ${dirs.repo} ${HARDENING} grep ${spelling} -- ${EXCL}`, REVISION_NEVER);
  for (const spelling of ["--cached foo", "foo", "-e foo"]) {
    const command = `git -C ${dirs.repo} ${HARDENING} grep ${spelling} -- ${EXCL}`;
    assertFree(env, command);
    runZsh(command, dirs.cwd);
    assert.deepEqual(takeMarkers(dirs.markers), [], `${command} ran a planted program`);
  }
  for (const spelling of [`git -C ${dirs.repo} grep --cached foo`, `git -C ${dirs.repo} ${OLD_HARDENING} grep --cached foo`]) {
    runZsh(spelling, dirs.cwd);
    assert.ok(takeMarkers(dirs.markers).includes("uploadpack"), `the control ${spelling} fired no upload-pack marker`);
    assertNeverOnBoth(env, spelling, FULL_SPELLING_SHOWN);
  }
});

test("no free grep prints a tracked `.env*` file, and every spelling that could is never", { skip: SKIP }, (t) => {
  const dirs = dotenvRepo(t);
  const env = operatorEnv(t, dirs.repo);
  const hardened = `git -C ${dirs.repo} ${HARDENING} grep`;
  const fromSub = `git -C ${join(dirs.repo, "sub")} ${HARDENING} grep`;
  const free = [
    `${hardened} -n -e . -- '*.local' ${EXCL}`,
    `${hardened} -n -e . -- ${EXCL}`,
    `${hardened} -n --cached -e foo -- ${EXCL}`,
    `${hardened} -n --max-depth 0 -e foo -- ${EXCL}`,
    `${fromSub} -n -e foo -- ':/' ${EXCL}`,
    `${fromSub} -n -e foo -- '../*' ${EXCL}`,
    `${hardened} -e 'TODO:' -- ${EXCL}`,
  ];
  for (const command of free) {
    assertFree(env, command);
    const result = runZsh(command, dirs.cwd);
    assert.ok(result.status === 0 || result.status === 1, `${command} failed: ${result.stderr}`);
    assert.equal(result.stdout.includes(DOTENV_SECRET), false, `${command} printed a .env* file`);
  }
  assert.match(runZsh(`${hardened} -n -e config -- ${EXCL}`, dirs.cwd).stdout, /^sub\/config\.env\.ts:1:/m, "config.env.ts is still searched");
  const leak = runZsh(`git -C ${dirs.repo} grep -n -e . -- '*.local'`, dirs.cwd).stdout;
  assert.ok(leak.includes(DOTENV_SECRET), "the unexcluded control printed no .env* file");
  const blob = git(["-C", dirs.repo, "rev-parse", "HEAD:.env.local"]).stdout.trim();
  assert.ok(runZsh(`git -C ${dirs.repo} grep foo ${blob} -- ${EXCL}`, dirs.cwd).stdout.includes(DOTENV_SECRET), "the blob revision control printed no .env* file");
  const unexcluded = /always ends with `-- … ':\(top,exclude,glob\)\*\*\/\.env\*'`/;
  for (const command of [`${hardened} -n -e . -- '*.local'`, `${hardened} -n -e .`, `${fromSub} -n -e foo -- ':/'`]) {
    assertNeverOnBoth(env, command, unexcluded);
  }
  const revisions = [
    `${hardened} foo ${blob} -- ${EXCL}`,
    `${hardened} foo ${blob.slice(0, 10)} -- ${EXCL}`,
    `${hardened} foo :0:.env.local -- ${EXCL}`,
    `${hardened} -n -e . ${EXCL} --`,
    `${hardened} -n -e foo HEAD`,
    `${hardened} -n -e foo HEAD -- ${EXCL}`,
    `${hardened} foo HEAD -- ${EXCL}`,
    `${hardened} foo 'HEAD@{1}' -- ${EXCL}`,
    `${hardened} foo HEAD~1 -- ${EXCL}`,
  ];
  for (const command of revisions) assertNeverOnBoth(env, command, REVISION_NEVER);
  assertNeverOnBoth(env, `${hardened} foo HEAD:.env.local -- ${EXCL}`, /reading or printing secrets/);
});

test("zsh splits a brace into option words, and the guard refuses every paren or glob spelling before it could run", { skip: SKIP }, (t) => {
  const dirs = trappedRepo(t);
  const env = operatorEnv(t, dirs.repo);
  assert.equal(runZsh("print -l -- {-O,x}", dirs.cwd).stdout, "-O\nx\n");
  const refused = [
    `git -C ${dirs.repo} log -1 =(touch ${join(dirs.markers, "zsh")})`,
    `git -C ${dirs.repo} log *(e:'touch ${join(dirs.markers, "zsh")}':)`,
    `git -C ${dirs.repo} ${HARDENING} grep {-O,x} foo -- ${EXCL}`,
    `git -C ${dirs.repo} ${HARDENING} grep -O${join(dirs.scripts, "pager.sh")} foo -- ${EXCL}`,
    `git -C ${dirs.repo} ${HARDENING} grep foo.*bar -- ${EXCL}`,
    `git -C ${dirs.repo} grep foo`,
    `git -C ${dirs.repo} ${OLD_HARDENING} grep -n foo`,
  ];
  for (const command of refused) {
    for (const agent of [false, true]) assert.match(decide(env, command, agent) ?? "", /^operator guard: never \(/, command);
  }
  assertNeverOnBoth(env, `git -C ${dirs.repo} ${OLD_HARDENING} grep -n foo`, FULL_SPELLING_SHOWN);
  assert.deepEqual(takeMarkers(dirs.markers), []);
});

// A clone whose fetched tag `leak` and remote-tracking ref `origin/evil` name the blob of a `.env.local` its origin committed then removed.
function blobRefClone(t) {
  const dirs = proofDirs(t);
  const origin = join(dirs.root, "origin");
  git(["init", "-q", origin]);
  writeFiles(origin, { "a.txt": "foo first\n", ".env.local": `${DOTENV_SECRET}-local foo\n` });
  commitAll(origin, "with secret");
  const blob = git(["-C", origin, "rev-parse", "HEAD:.env.local"]).stdout.trim();
  git(["-C", origin, "rm", "-q", ".env.local"]);
  git(["-C", origin, ...COMMITTER, "commit", "-q", "-m", "drop secret"]);
  git(["-C", origin, "tag", "leak", blob]);
  rmSync(dirs.repo, { recursive: true, force: true });
  git(["clone", "-q", origin, dirs.repo]);
  git(["-C", dirs.repo, "fetch", "-q", "origin", "refs/tags/*:refs/tags/*"]);
  git(["-C", dirs.repo, "update-ref", "refs/remotes/origin/evil", blob]);
  return dirs;
}

test("a ref naming a blob (fetched tag, remote-tracking ref, symref'd HEAD) never reaches a free grep, and the free greps print no secret", { skip: SKIP }, (t) => {
  const dirs = blobRefClone(t);
  const env = operatorEnv(t, dirs.repo);
  const hardened = `git -C ${dirs.repo} ${HARDENING} grep`;
  const control = git(["-C", dirs.repo, "grep", "-n", ".", "leak"], { allowFail: true }).stdout;
  assert.ok(control.includes(DOTENV_SECRET), "the non-vacuity control (unguarded `grep -n . leak`) printed no secret");
  for (const revision of ["leak", "origin/evil", "HEAD", "HEAD~0", "'HEAD@{0}'"]) {
    assertNeverOnBoth(env, `${hardened} -n . ${revision} -- ${EXCL}`, REVISION_NEVER);
  }
  const branch = git(["-C", dirs.repo, "symbolic-ref", "HEAD"]).stdout.trim();
  git(["-C", dirs.repo, "symbolic-ref", "HEAD", "refs/tags/leak"]);
  t.after(() => git(["-C", dirs.repo, "symbolic-ref", "HEAD", branch], { allowFail: true }));
  for (const command of [`${hardened} -n . -- ${EXCL}`, `${hardened} --cached -n . -- ${EXCL}`]) {
    assertFree(env, command);
    const result = runZsh(command, dirs.cwd);
    assert.equal(`${result.stdout}${result.stderr}`.includes(DOTENV_SECRET), false, `${command} printed the secret`);
  }
});

test("an unquoted `#` that would drop the exclusion is never and never runs, while a quoted `'#'` stays free and prints no secret", { skip: SKIP }, (t) => {
  const dirs = dotenvRepo(t);
  const env = operatorEnv(t, dirs.repo);
  const hardened = `git -C ${dirs.repo} ${HARDENING} grep`;
  const hash = /an unquoted `#`|never a revision.*\(`#`\)\): no consent/;
  const refused = [
    `${hardened} -n -e . # -- ${EXCL}`,
    `${hardened} -n . # -- ${EXCL}`,
    `${hardened} --cached -n -e . # -- ${EXCL}`,
    `cd ${dirs.repo} && git ${HARDENING} grep -n -e . # -- ${EXCL}`,
  ];
  for (const command of refused) assertNeverOnBoth(env, command, hash);
  const quoted = `${hardened} -e '#' -- ${EXCL}`;
  assertFree(env, quoted);
  const result = runZsh(quoted, dirs.cwd);
  assert.ok(result.status === 0 || result.status === 1, `${quoted} failed: ${result.stderr}`);
  assert.equal(result.stdout.includes(DOTENV_SECRET), false, `${quoted} printed a .env* file`);
});

test("a form feed that zsh keeps inside a word is never and never runs, while the plain spaced grep stays free and prints no secret", { skip: SKIP }, (t) => {
  const dirs = dotenvRepo(t);
  const env = operatorEnv(t, dirs.repo);
  const hardened = `git -C ${dirs.repo} ${HARDENING} grep`;
  assert.equal(runZsh("print -l -- a\fb", dirs.cwd).stdout, "a\fb\n", "the non-vacuity control: zsh does not split on a form feed");
  const blank = /never \(a blank other than a space or a tab/;
  assertNeverOnBoth(env, `${hardened} -n -F -e '' -e x\f--\f${EXCL}`, blank);
  assertNeverOnBoth(env, `git -C ${dirs.repo} ${OLD_HARDENING}\f--no-lazy-fetch grep -n --cached foo -- ${EXCL}`, blank);
  const spaced = `${hardened} -n -F -e '' -e x -- ${EXCL}`;
  assertFree(env, spaced);
  const result = runZsh(spaced, dirs.cwd);
  assert.ok(result.status === 0 || result.status === 1, `${spaced} failed: ${result.stderr}`);
  assert.equal(result.stdout.includes(DOTENV_SECRET), false, `${spaced} printed a .env* file`);
});
