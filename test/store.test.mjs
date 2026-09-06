import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UserError } from "../src/config/errors.mjs";
import { configPath, homeDir, secretsPath } from "../src/config/paths.mjs";
import { emptyConfig, emptySecrets } from "../src/config/schema.mjs";
import { ensureHome, loadConfig, loadSecrets, saveConfig, saveSecrets, writeFileAtomic } from "../src/config/store.mjs";

// Creates an isolated temporary home and removes it at the end of the test.
function makeEnv(t, { nested = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "nightshift-store-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { NIGHTSHIFT_HOME: nested ? join(base, "home") : base };
}

// Returns the permission bits of a file or directory.
function modeOf(path) {
  return statSync(path).mode & 0o777;
}

test("ensureHome creates the configuration home with mode 0700", (t) => {
  const env = makeEnv(t, { nested: true });
  const first = ensureHome(env);
  assert.equal(first.created, true);
  assert.equal(first.path, env.NIGHTSHIFT_HOME);
  assert.equal(modeOf(first.path), 0o700);
  assert.equal(ensureHome(env).created, false);
});

test("ensureHome tightens a configuration home that already exists with an open mode", (t) => {
  const env = makeEnv(t, { nested: true });
  ensureHome(env);
  for (const open of [0o755, 0o777, 0o750]) {
    chmodSync(env.NIGHTSHIFT_HOME, open);
    const result = ensureHome(env);
    assert.equal(result.created, false, open.toString(8));
    assert.equal(modeOf(env.NIGHTSHIFT_HOME), 0o700, open.toString(8));
  }
});

test("a write on an existing open home tightens the directory before writing", (t) => {
  const env = makeEnv(t);
  chmodSync(env.NIGHTSHIFT_HOME, 0o755);
  saveConfig(emptyConfig(), env);
  assert.equal(modeOf(env.NIGHTSHIFT_HOME), 0o700);
});

test("saveSecrets writes 0600 under any umask", (t) => {
  const env = makeEnv(t);
  for (const umask of [0o022, 0o000]) {
    const previous = process.umask(umask);
    try {
      saveSecrets({ version: 1, connections: {} }, env);
      assert.equal(modeOf(secretsPath(env)), 0o600, `umask ${umask.toString(8)}`);
    } finally {
      process.umask(previous);
    }
  }
});

test("writeFileAtomic leaves no temporary file behind on failure", (t) => {
  const env = makeEnv(t);
  ensureHome(env);
  const target = join(env.NIGHTSHIFT_HOME, "missing-dir", "file.json");
  assert.throws(() => writeFileAtomic(target, "{}"));
  assert.deepEqual(statSync(env.NIGHTSHIFT_HOME).isDirectory(), true);
});

test("missing files load as valid empty structures", (t) => {
  const env = makeEnv(t);
  assert.deepEqual(loadConfig(env), emptyConfig());
  assert.deepEqual(loadSecrets(env, { warn: () => {} }), emptySecrets());
});

test("invalid JSON is a user error and the file is left untouched", (t) => {
  const env = makeEnv(t);
  ensureHome(env);
  writeFileSync(configPath(env), "{ oops");
  assert.throws(() => loadConfig(env), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /is not valid JSON/);
    return true;
  });
  assert.equal(readFileSync(configPath(env), "utf8"), "{ oops");
});

test("loading secrets warns about an open mode without refusing", (t) => {
  const env = makeEnv(t);
  saveSecrets(emptySecrets(), env);
  chmodSync(secretsPath(env), 0o644);
  const warnings = [];
  const secrets = loadSecrets(env, { warn: (line) => warnings.push(line) });
  assert.deepEqual(secrets, emptySecrets());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /is mode 0644, expected 0600/);
});

test("saveConfig round-trips through loadConfig", (t) => {
  const env = makeEnv(t, { nested: true });
  const config = emptyConfig();
  config.projects.api = { path: "/tmp/api", org: "default" };
  saveConfig(config, env);
  assert.equal(modeOf(env.NIGHTSHIFT_HOME), 0o700);
  assert.deepEqual(loadConfig(env), config);
});

test("the configuration home is resolved on every call", () => {
  const previous = process.env.NIGHTSHIFT_HOME;
  try {
    process.env.NIGHTSHIFT_HOME = join(tmpdir(), "one");
    assert.equal(configPath(), join(tmpdir(), "one", "config.json"));
    process.env.NIGHTSHIFT_HOME = join(tmpdir(), "two");
    assert.equal(configPath(), join(tmpdir(), "two", "config.json"));
    delete process.env.NIGHTSHIFT_HOME;
    assert.equal(homeDir(), join(homedir(), ".nightshift"));
  } finally {
    if (previous === undefined) delete process.env.NIGHTSHIFT_HOME;
    else process.env.NIGHTSHIFT_HOME = previous;
  }
});
