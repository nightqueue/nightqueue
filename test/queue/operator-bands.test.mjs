import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { test } from "node:test";
import { homeDir, secretsPath } from "../../src/config/paths.mjs";
import { consentBash, neverBashReason, neverWriteReason, scopeWords } from "../../src/queue/operator-bands.mjs";
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

test("scopeWords drops the anchor and the timeout, and refuses a chained scope", () => {
  assert.deepEqual(scopeWords("cd /x && timeout 30 npm test"), ["npm", "test"]);
  assert.deepEqual(scopeWords("npm run lint"), ["npm", "run", "lint"]);
  assert.equal(scopeWords("npm test && npm run build"), null);
  assert.equal(scopeWords(""), null);
});
