import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { newId } from "../../src/config/ids.mjs";
import { homeDir, secretsPath } from "../../src/config/paths.mjs";
import { consentBash, neverBashReason, neverWriteReason, scopeWords } from "../../src/queue/operator-bands.mjs";
import {
  bareTokens,
  checkoutRoots,
  expandsUnquoted,
  expansionFlags,
  gitGlobals,
  grepArgs,
  grepRevisions,
  grepSpellingNever,
  isDoctorFix,
  isDoctorFixForm,
  mainBashAllowed,
  readonlySubagentBashAllowed,
  refusedNightqueueForm,
} from "../../src/queue/operator-scope.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

// A home with one registered checkout, a user home and a Claude config dir of its own.
function bandsFixture(t) {
  const env = makeHome(t, "operator-bands");
  const base = makeDir(t, "operator-bands-host");
  Object.assign(env, { HOME: join(base, "user"), CLAUDE_CONFIG_DIR: join(base, "claude") });
  return { env, checkout: makeProject(t, env, "alpha") };
}

test("neverWriteReason names the home, the Claude/Codex settings and `.env*` files, and nothing in a checkout", (t) => {
  const { env, checkout } = bandsFixture(t);
  assert.equal(neverWriteReason(join(homeDir(env), "config.json"), env), "writing under the nightqueue home");
  assert.equal(neverWriteReason(secretsPath(env), env), "writing under the nightqueue home");
  assert.equal(neverWriteReason(join(env.CLAUDE_CONFIG_DIR, "settings.json"), env), "Claude/Codex settings");
  assert.equal(neverWriteReason(join(env.HOME, ".codex", "config.toml"), env), "Claude/Codex settings");
  assert.equal(neverWriteReason(join(checkout, ".claude", "settings.local.json"), env), "Claude/Codex settings");
  assert.equal(neverWriteReason(join(checkout, "apps", ".codex", "x"), env), "Claude/Codex settings");
  assert.equal(neverWriteReason(join(checkout, ".env.local"), env), "a `.env` file");
  for (const path of [join(checkout, "src", "a.mjs"), join(checkout, ".claude", "agents", "x.md"), join(checkout, ".envrc")]) {
    assert.equal(neverWriteReason(path, env), null, path);
  }
});

test("neverBashReason scans every segment, past wrappers, substitutions and an inline shell", (t) => {
  const { env, checkout } = bandsFixture(t);
  const never = [
    ["rm -rf x", "deleting files"],
    ["FOO=1 sudo -E rm x", "deleting files"],
    ["nice -n 10 unlink x", "deleting files"],
    ["timeout 5 shred x", "deleting files"],
    [`cd ${checkout} && npm test && rm -rf build`, "deleting files"],
    ["ls `rm x`", "deleting files"],
    ["find . -execdir rm {} ;", "deleting files"],
    ["sh -c 'git push -f'", "a force push or a remote delete"],
    ["eval git clean -fdx", "discarding untracked files"],
    ["git -C /x push --mirror", "a force push or a remote delete"],
    ["git push --for", "a force push or a remote delete"],
    ["git branch --delete x", "deleting a branch"],
    ["git reset --ha", "a hard reset"],
    ["grep -r TOKEN .env.example", "reading or printing secrets"],
    ["node --env-file=.env app.js", "reading or printing secrets"],
    ["git show main:secrets.json", "reading or printing secrets"],
    ["cat ${HOME}/x", "naming the nightqueue home or the Claude/Codex settings"],
  ];
  for (const [command, reason] of never) assert.equal(neverBashReason(command, { cwd: "/", env }), reason, command);
  assert.match(neverBashReason(`cd ${checkout} && cp x ${relative(checkout, join(homeDir(env), "y"))}`, { env }) ?? "", /never-band path/);
  assert.match(neverBashReason("nightqueue update", { env }), /nightqueue command/);
  const free = [
    "nightqueue queue status",
    "nightqueue verify",
    "nightqueue sandbox npm test",
    `git -C ${checkout} show HEAD:src/app.mjs`,
    `git -C ${checkout} commit -m "rm the dead code"`,
    "git push origin main",
    "git branch feature",
    "git reset HEAD~1",
    "grep -r rm src",
    "npm test",
  ];
  for (const command of free) assert.equal(neverBashReason(command, { cwd: homeDir(env), env }), null, command);
});

test("consentBash names the kind, the directory and the words, or the shape it refuses", (t) => {
  const { env, checkout } = bandsFixture(t);
  assert.deepEqual(consentBash(`cd ${checkout} && timeout 60 npm test`, { env }), { kind: "run", dir: checkout, argv: ["npm", "test"], shown: "timeout 60 npm test" });
  assert.deepEqual(consentBash(`git -C ${checkout} commit -m "a b"`, { env }), { kind: "git-write", dir: checkout, argv: ["commit", "-m", "a b"], shown: `git -C ${checkout} commit -m "a b"` });
  assert.deepEqual(consentBash(`cd ${checkout} && git log -3`, { env }), { free: true });
  assert.equal(consentBash("npm test", { cwd: checkout, env }).kind, "run");
  assert.match(consentBash("npm test", { cwd: homeDir(env), env }).shape, /outside every registered checkout/);
  assert.match(consentBash(`cd ${checkout} && npm test 2>&1`, { env }).shape, /chains, pipes or redirects/);
  assert.match(consentBash(`git -C ${checkout} -c core.editor=x commit`, { env }).shape, /`git -c` is refused/);
  assert.match(consentBash("git -C relative commit", { env }).shape, /absolute directory/);
});

test("doctor --fix leaves the never band for a run consent from any directory, and is free on no thread", (t) => {
  const { env, checkout } = bandsFixture(t);
  const home = homeDir(env);
  assert.equal(refusedNightqueueForm(["nightqueue", "doctor", "--fix"]), false);
  assert.equal(refusedNightqueueForm(["nightqueue", "doctor", "--fix", "--follow"]), true);
  assert.equal(neverBashReason("nightqueue doctor --fix", { cwd: home, env }), null);
  assert.deepEqual(consentBash("nightqueue doctor --fix", { cwd: home, env }), { kind: "run", home: true, dir: home, argv: ["nightqueue", "doctor", "--fix"], shown: "nightqueue doctor --fix" });
  assert.deepEqual(consentBash("timeout 120 nightqueue doctor --fix=true", { cwd: "/", env }).argv, ["nightqueue", "doctor", "--fix=true"]);
  for (const command of ["nightqueue doctor --fix", "nq doctor --fix"]) {
    assert.equal(mainBashAllowed(command, [checkout]), false, command);
    assert.equal(readonlySubagentBashAllowed(command, [checkout]), false, command);
  }
  assert.equal(mainBashAllowed("nightqueue doctor --json", [checkout]), true);
  assert.equal(isDoctorFix(["nightqueue", "doctor"]), false);
  assert.equal(isDoctorFix(["npm", "doctor", "--fix"]), false);
  assert.equal(isDoctorFix("nightqueue doctor --fix"), false);
  assert.equal(isDoctorFix(["/abs/bin/nightqueue", "doctor", "--fix"]), false);
  assert.equal(isDoctorFixForm(["/abs/bin/nightqueue", "doctor", "--fix"]), true);
  const spelling = /`doctor --fix` is consented only as `nightqueue doctor --fix`/;
  for (const command of ["/abs/bin/nightqueue doctor --fix", "bin/nightqueue.mjs doctor --fix", "timeout 30 /abs/nightqueue doctor --fix"]) {
    assert.match(neverBashReason(command, { cwd: checkout, env }) ?? "", spelling, command);
  }
  assert.equal(neverBashReason("/abs/bin/nightqueue doctor --json", { cwd: checkout, env }), null);
});

test("a home path in an ANSI-C quote or a variable is never, and a link on the way out of the home leaves today's never band", (t) => {
  const { env } = bandsFixture(t);
  const home = homeDir(env);
  const projectId = newId();
  const run = join(home, "runs", projectId, "stale");
  mkdirSync(run, { recursive: true });
  const canary = join(makeDir(t, "operator-bands-canary"), "keep");
  mkdirSync(canary);
  const linked = newId();
  mkdirSync(join(home, "worktrees"), { recursive: true });
  symlinkSync(dirname(canary), join(home, "worktrees", linked));
  const never = [`rm -rf $'${run}'`, `rm -rf "$NIGHTQUEUE_HOME/runs/${projectId}/stale"`, `rm -rf \${HOME}/.nightqueue/runs/${projectId}/stale`, `rm -rf ${join(home, "worktrees", linked, "keep")}`];
  for (const command of never) assert.ok(neverBashReason(command, { cwd: home, env }), command);
  assert.equal(neverBashReason(`rm -rf ${run}`, { cwd: home, env }), null);
  assert.ok(existsSync(canary));
});

test("grepArgs reads git grep options by exact name, refuses the first word off the allow list and finds the real `--`", () => {
  const accepted = [
    [["-n", "foo"], -1],
    [["-e", "a", "--and", "(", "-e", "b", ")"], -1],
    [["-C3", "foo"], -1],
    [["-C", "3", "foo"], -1],
    [["--context", "3", "foo"], -1],
    [["--context=3", "foo"], -1],
    [["--max-depth", "-1", "foo"], -1],
    [["--color=never", "-nC3", "foo"], -1],
    [["-e", "--", "x"], -1],
    [["-e", "-O"], -1],
    [["-eO"], -1],
    [["-3", "foo"], -1],
    [["--text", "--or", "--not", "-e", "x"], -1],
    [["foo", "--", "-O"], 1],
    [["-e", "foo", "-e", "bar", "--", "src/*.mjs"], 4],
  ];
  for (const [args, terminator] of accepted) assert.deepEqual(grepArgs(args), { refused: null, terminator }, args.join(" "));
  const refused = [
    [["-O", "foo"], "-O"],
    [["-nO", "foo"], "-nO"],
    [["--open", "foo"], "--open"],
    [["--o", "foo"], "--o"],
    [["--te", "foo"], "--te"],
    [["--textconv", "foo"], "--textconv"],
    [["-f", "x"], "-f"],
    [["-C/tmp", "foo"], "-C/tmp"],
    [["-C", "x", "foo"], "-C"],
    [["--context=x", "foo"], "--context=x"],
    [["--color", "foo"], "--color"],
    [["--no-index", "foo"], "--no-index"],
    [["-", "foo"], "-"],
    [["-e"], "-e"],
  ];
  for (const [args, word] of refused) assert.deepEqual(grepArgs(args), { refused: word, terminator: -1 }, args.join(" "));
});

test("expansionFlags marks each word zsh expands unquoted, and fails closed when the words do not align", () => {
  assert.deepEqual(expansionFlags("git log HEAD@{1} 'HEAD@{1}' ^main '^main' *.md \"*.md\""), [false, false, true, false, true, false, true, false]);
  assert.equal(expansionFlags("a\\ b"), null);
  assert.equal(expandsUnquoted("git -C /x grep foo -- src/*.mjs", ["git", "-C", "/x", "grep", "foo", "--", "src/*.mjs"]), false);
  assert.equal(expandsUnquoted("git -C /x grep foo.*bar -- src", ["git", "-C", "/x", "grep", "foo.*bar", "--", "src"]), true);
  assert.equal(expandsUnquoted("git -C /x log -- src/*.mjs", ["git", "-C", "/x", "log", "--", "src/*.mjs"]), true);
});

const OLD_HARDENING = "-c core.fsmonitor=false -c core.hooksPath=/dev/null";
const HARDENING = `${OLD_HARDENING} --no-lazy-fetch`;
const EXCL = "':(top,exclude,glob)**/.env*'";
const FULL_SPELLING =
  /-c core\.fsmonitor=false -c core\.hooksPath=\/dev\/null --no-lazy-fetch grep \[--cached\] <options> <pattern> -- \[<paths>\] ':\(top,exclude,glob\)\*\*\/\.env\*'/;
const REVISION_NEVER = /never a revision/;

test("neverBashReason refuses every git grep that is not the hardened spelling with an allow-listed option, by its named reason", (t) => {
  const { env, checkout } = bandsFixture(t);
  const hardened = `git -C ${checkout} ${HARDENING} grep`;
  const never = [
    [`git -C ${checkout} grep foo`, /^`git grep` runs only hardened and with no lazy fetch from a promisor remote, so no program planted in the shared `\.git\/config` runs: /],
    [`git -C ${checkout} ${OLD_HARDENING} grep -n foo -- ${EXCL}`, /^`git grep` runs only hardened/],
    [`git -C ${checkout} -c core.hooksPath=/dev/null -c core.fsmonitor=false --no-lazy-fetch grep foo -- ${EXCL}`, /^`git grep` runs only hardened/],
    [`git -C ${checkout} ${OLD_HARDENING} -c core.fsmonitor=false --no-lazy-fetch grep foo -- ${EXCL}`, /^`git grep` runs only hardened/],
    [`git -C ${checkout} --no-lazy-fetch ${OLD_HARDENING} grep foo -- ${EXCL}`, /^`git grep` runs only hardened/],
    [`git -C ${checkout} --no-optional-locks ${HARDENING} grep foo -- ${EXCL}`, /^`git grep` takes no global option but `-C <dir>`, the hardening pair and `--no-lazy-fetch` \(`--no-optional-locks`\); run it as /],
    [`${hardened} foo c3886f3fec -- ${EXCL}`, /^`git grep` searches only the working tree or the index \(`--cached`\), never a revision: .*`git -C <dir> log -S<text>`.*`git -C <dir> show <rev>` \(`c3886f3fec`\)$/],
    [`${hardened} -e foo :0:a.txt -- ${EXCL}`, /^`git grep` searches only the working tree .*never a revision.*\(`:0:a\.txt`\)$/],
    [`${hardened} foo HEAD~1 -- ${EXCL}`, /never a revision.*\(`HEAD~1`\)$/],
    [`${hardened} -n foo -- 'src/*.mjs'`, /^`git grep` always ends with `-- … ':\(top,exclude,glob\)\*\*\/\.env\*'`, so no tracked `\.env\*` file the Read rule refuses is printed: /],
    [`${hardened} -n foo`, /^`git grep` always ends with/],
    [`${hardened} -O foo`, /^`git grep` opening files in a pager .* runs a program \(`-O`\)$/],
    [`${hardened} --textconv foo`, /^`git grep --textconv` runs the textconv filters/],
    [`${hardened} -nf x`, /^`git grep -f` reads its patterns from a file/],
    [`${hardened} --untrack foo`, /^`git grep --no-index\|--untracked\|--no-exclude-standard` searches outside the tracked files/],
    [`${hardened} --ext-grep foo`, /^`git grep --ext-grep` hands the search to an external program/],
    [`${hardened} --no-recurse-submodules foo`, /^`git grep` into submodules/],
    [`${hardened} --open foo`, /^an option off the git grep allow list; spell every option by its full name \(`--open`\)$/],
    [`${hardened} foo.*bar`, /^an unquoted glob, brace or leading `\^` before the `--` of a `git grep`/],
    [`${hardened} ^foo`, /^an unquoted glob, brace or leading `\^`/],
    [`${hardened} 'a\\b'`, /^a backslash in a `git grep`/],
    [`${hardened} 'foo$'`, /^a `\$` in a `git grep`/],
    [`sh -c "${hardened} {-O,x}"`, /^an unquoted glob, brace or leading `\^`/],
    [`cd ${checkout} && git grep foo`, /^`git grep` runs only hardened/],
  ];
  for (const [command, reason] of never) assert.match(neverBashReason(command, { env }) ?? "", reason, command);
  for (const command of [`git -C ${checkout} grep foo`, `git -C ${checkout} ${OLD_HARDENING} grep -n foo`, `${hardened} -n foo`]) {
    assert.match(neverBashReason(command, { env }), FULL_SPELLING, command);
  }
  const free = [
    `${hardened} -n foo -- ${EXCL}`,
    `${hardened} 'foo.*bar' -- ${EXCL}`,
    `${hardened} foo -- src/*.mjs ${EXCL}`,
    `${hardened} --cached foo -- ${EXCL}`,
    `cd ${checkout} && git ${HARDENING} grep foo -- ${EXCL}`,
  ];
  for (const command of free) assert.equal(neverBashReason(command, { env }), null, command);
});

test("a free git grep takes no revision: every positional word before `--` is never, the working tree and `--cached` stay free", (t) => {
  const { env, checkout } = bandsFixture(t);
  const hardened = `git -C ${checkout} ${HARDENING} grep`;
  const positional = ["foo HEAD", "foo main", "foo HEAD~0", "foo leak", "foo origin/main", "foo 'HEAD@{1}'", "-e foo bar", "foo src"];
  for (const args of positional) {
    const command = `${hardened} ${args} -- ${EXCL}`;
    assert.match(neverBashReason(command, { env }) ?? "", REVISION_NEVER, command);
    assert.notDeepEqual(consentBash(command, { env }), { free: true }, command);
  }
  const free = ["foo", "-n foo", "--cached foo", "-e foo -e bar", "-e a --and '(' -e b ')'"];
  for (const args of free) {
    const command = `${hardened} ${args} -- ${EXCL}`;
    assert.equal(neverBashReason(command, { env }), null, command);
    assert.deepEqual(consentBash(command, { env }), { free: true }, command);
  }
});

test("the `.env*` exclusion pathspec is exempt from the secrets check only as its exact word", (t) => {
  const { env, checkout } = bandsFixture(t);
  const hardened = `git -C ${checkout} ${HARDENING} grep foo`;
  assert.equal(neverBashReason(`${hardened} -- ${EXCL}`, { env }), null);
  assert.equal(neverBashReason(`cd ${checkout} && cat ${EXCL}`, { env }), null);
  for (const command of [`${hardened} -- ':(top,exclude,glob)**/.env*x'`, `${hardened} -- ${EXCL} '.env.local'`, `${hardened} -- 'x:(top,exclude,glob)**/.env*'`]) {
    assert.equal(neverBashReason(command, { env }), "reading or printing secrets", command);
  }
});

test("gitGlobals reads the hardening pairs in order, once each, and refuses --no-lazy-fetch on every subcommand but grep", () => {
  assert.equal(gitGlobals(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "log"]).hardened, true);
  assert.equal(gitGlobals(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "log"]).hardened, false);
  assert.equal(gitGlobals(["-c", "core.fsmonitor=false", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "log"]).hardened, false);
  assert.equal(gitGlobals(["--no-lazy-fetch", "log"]).refused, "--no-lazy-fetch");
  assert.equal(gitGlobals(["--no-lazy-fetch"]).refused, "--no-lazy-fetch");
  assert.equal(gitGlobals(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-lazy-fetch", "grep"]).refused, null);
});

test("grepRevisions keeps every word past the options before the real `--`, the pattern dropped only when no -e gave it", () => {
  const cases = [
    [["foo", "HEAD", "--", "x"], ["HEAD"]],
    [["-n", "foo", "HEAD", "main"], ["HEAD", "main"]],
    [["-e", "foo", "HEAD", "--", "x"], ["HEAD"]],
    [["-ne", "foo", "HEAD"], ["HEAD"]],
    [["-e", "c3886f3fec", "--", "x"], []],
    [["-e", "a", "--and", "(", "-e", "b", ")", "HEAD"], ["HEAD"]],
    [["-C3", "foo", "c3886f3fec"], ["c3886f3fec"]],
    [["foo", "-e", "c3886f3fec", "--", "x"], ["-e", "c3886f3fec"]],
    [["-e", "--", "foo", "--", "x"], ["foo"]],
    [[], []],
    ["not a list", []],
  ];
  for (const [args, revisions] of cases) assert.deepEqual(grepRevisions(args), revisions, JSON.stringify(args));
});

test("grepSpellingNever accepts only the one free spelling and names each other one", () => {
  const globals = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-lazy-fetch"];
  const exclusion = ":(top,exclude,glob)**/.env*";
  assert.equal(grepSpellingNever([...globals, "grep", "-n", "foo", "--", exclusion]), null);
  assert.equal(grepSpellingNever([...globals, "grep", "--cached", "foo", "--", "src", exclusion]), null);
  assert.match(grepSpellingNever([...globals, "grep", "foo", "HEAD@{1}", "--", "src", exclusion]), REVISION_NEVER);
  assert.match(grepSpellingNever([...globals, "grep", "foo", "HEAD", "--", exclusion]), /`git -C <dir> log -S<text>`/);
  assert.match(grepSpellingNever([...globals, "--no-pager", "grep", "foo", "--", exclusion]), /takes no global option .*\(`--no-pager`\)/);
  assert.match(grepSpellingNever([...globals, "log"]), /takes no global option/);
  assert.match(grepSpellingNever("not a list"), /takes no global option/);
  assert.match(grepSpellingNever([...globals.slice(0, 4), "grep", "foo", "--", exclusion]), /^`git grep` runs only hardened/);
  assert.match(grepSpellingNever([...globals, "grep", "-O", "foo", "--", exclusion]), /opening files in a pager/);
  assert.match(grepSpellingNever([...globals, "grep", "foo", "deadbeef~2", "--", exclusion]), REVISION_NEVER);
  assert.match(grepSpellingNever([...globals, "grep", "foo", "HEAD:a.txt", "--", exclusion]), REVISION_NEVER);
  assert.match(grepSpellingNever([...globals, "grep", "foo", "--", "src"]), /always ends with/);
});

test("consentBash judges a git grep by its verbatim words, so a reversed, duplicated or misplaced hardening pair is never free", (t) => {
  const { env, checkout } = bandsFixture(t);
  const reversed = "-c core.hooksPath=/dev/null -c core.fsmonitor=false --no-lazy-fetch";
  const duplicated = `${OLD_HARDENING} -c core.hooksPath=/dev/null --no-lazy-fetch`;
  const notFree = [
    `cd ${checkout} && git ${reversed} grep foo -- ${EXCL}`,
    `git -C ${checkout} ${reversed} grep foo -- ${EXCL}`,
    `cd ${checkout} && git ${duplicated} grep foo -- ${EXCL}`,
    `cd ${checkout} && git --no-optional-locks ${HARDENING} grep foo -- ${EXCL}`,
    `cd ${checkout} && git ${OLD_HARDENING} grep foo -- ${EXCL}`,
  ];
  for (const command of notFree) assert.notDeepEqual(consentBash(command, { env }), { free: true }, command);
  assert.deepEqual(consentBash(`cd ${checkout} && git ${HARDENING} grep foo -- ${EXCL}`, { env }), { free: true });
});

test("consentBash answers free for a hardened cd-form git grep, and its glob shape says to quote only an unquoted expansion", (t) => {
  const { env, checkout } = bandsFixture(t);
  const hardening = HARDENING;
  assert.deepEqual(consentBash(`cd ${checkout} && git ${hardening} grep 'foo.*bar' -- ${EXCL}`, { env }), { free: true });
  assert.deepEqual(consentBash(`cd ${checkout} && git ${hardening} grep -n foo -- ${EXCL}`, { env }), { free: true });
  assert.match(consentBash(`cd ${checkout} && git log -- '*.md'`, { env }).shape, /^the command carries a glob or brace character \(`\* \? \[ \] \{ \}`\), so no consent/);
  assert.match(consentBash(`git -C ${checkout} show HEAD@{1}`, { env }).shape, /quote it \(`'HEAD@\{1\}'`/);
  assert.match(consentBash(`git -C ${checkout} log ^main`, { env }).shape, /quote it \(`'HEAD@\{1\}'`/);
  assert.equal(mainBashAllowed(`git -C ${checkout} show 'HEAD@{1}'`, checkoutRoots(env).roots), true);
  assert.equal(mainBashAllowed(`git -C ${checkout} show HEAD@{1}`, checkoutRoots(env).roots), false);
  assert.equal(mainBashAllowed(`git -C ${checkout} ${hardening} grep -n foo -- ${EXCL}`, checkoutRoots(env).roots), true);
  assert.equal(mainBashAllowed(`git -C ${checkout} ${OLD_HARDENING} grep -n foo`, checkoutRoots(env).roots), false);
  assert.equal(mainBashAllowed(`git -C ${checkout} grep -n foo`, checkoutRoots(env).roots), false);
  assert.equal(readonlySubagentBashAllowed(`git -C ${checkout} ${hardening} --no-optional-locks grep foo -- ${EXCL}`, checkoutRoots(env).roots), false);
});

test("scopeWords drops the anchor and the timeout, and refuses a chained scope", () => {
  assert.deepEqual(scopeWords("cd /x && timeout 30 npm test"), ["npm", "test"]);
  assert.deepEqual(scopeWords("npm run lint"), ["npm", "run", "lint"]);
  assert.equal(scopeWords("npm test && npm run build"), null);
  assert.equal(scopeWords(""), null);
});

test("an unquoted foreign blank gives no consent kind, no grant scope and no bare tokens, while a quoted one keeps its words", (t) => {
  const { env, checkout } = bandsFixture(t);
  const request = consentBash(`cd ${checkout} && npm\ftest`, { env });
  assert.equal(request.kind, undefined);
  assert.equal(typeof request.shape, "string");
  for (const blank of ["\f", "\v", " ", " ", "﻿"]) {
    assert.equal(scopeWords(`npm${blank}test`), null, JSON.stringify(blank));
    assert.equal(bareTokens(`npm${blank}test`), null, JSON.stringify(blank));
  }
  assert.deepEqual(bareTokens("npm test 'a b'"), ["npm", "test", "a b"]);
});
