import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { ghAccountStatus, ghAuthStatus, parseGhAccount, parseGhLogin } from "../../src/host/gh.mjs";
import { FAKE_GH_LOGIN, makeHostEnv } from "../../test-support/host.mjs";

// An in-process execFile double answering one scripted result; no binary is ever spawned.
function fakeExecFile({ err = null, stdout = "", stderr = "" } = {}) {
  return (file, args, options, callback) => setImmediate(() => callback(err, stdout, stderr));
}

test("parseGhAccount reads the host and the login of both gh formats and of an enterprise host", () => {
  assert.deepEqual(parseGhAccount("github.com\n  ✓ Logged in to github.com account octocat (keyring)\n"), { host: "github.com", login: "octocat" });
  assert.deepEqual(parseGhAccount("  Logged in to github.com as octo-cat (oauth_token)"), { host: "github.com", login: "octo-cat" });
  assert.deepEqual(parseGhAccount("Logged in to ghe.acme.io account dev1 (GH_ENTERPRISE_TOKEN)"), { host: "ghe.acme.io", login: "dev1" });
  assert.equal(parseGhAccount("You are not logged into any GitHub hosts"), null);
  assert.equal(parseGhAccount(undefined), null);
  assert.equal(parseGhLogin("Logged in to ghe.acme.io account dev1"), "dev1");
});

test("ghAccountStatus answers the account of an authenticated gh, on the host it reports", async (t) => {
  const host = makeHostEnv(t, "gh-account-ok");
  host.env.NIGHTQUEUE_FAKE_GH_STATE = "authenticated";
  host.env.NIGHTQUEUE_FAKE_GH_HOST = "ghe.acme.io";
  assert.deepEqual(await ghAccountStatus({ env: host.env }), { installed: true, authenticated: true, login: FAKE_GH_LOGIN, host: "ghe.acme.io" });
});

test("ghAccountStatus answers a logged-out gh and a missing binary without throwing", async (t) => {
  const host = makeHostEnv(t, "gh-account-out");
  assert.deepEqual(await ghAccountStatus({ env: host.env }), { installed: true, authenticated: false, login: null, host: null });
  const missing = { ...host.env, NIGHTQUEUE_GH_BIN: join(host.configDir, "does-not-exist") };
  assert.deepEqual(await ghAccountStatus({ env: missing }), { installed: false, authenticated: false, login: null, host: null });
});

test("a fake gh auth login flips the status the next probe reads", async (t) => {
  const host = makeHostEnv(t, "gh-account-login");
  host.env.NIGHTQUEUE_FAKE_GH_STATE_FILE = join(host.configDir, "gh-state");
  assert.equal((await ghAccountStatus({ env: host.env })).authenticated, false);
  const login = spawnSync(host.env.NIGHTQUEUE_GH_BIN, ["auth", "login", "--web"], { env: host.env, encoding: "utf8" });
  assert.equal(login.status, 0, login.stderr);
  assert.equal((await ghAccountStatus({ env: host.env })).authenticated, true);
});

test("ghAccountStatus never answers the raw output, so a printed token cannot leak", async () => {
  const stdout = "github.com\n  Logged in to github.com account octocat (keyring)\n  Token: gho_SECRET\n";
  const status = await ghAccountStatus({ env: {}, execFileImpl: fakeExecFile({ stdout }) });
  assert.deepEqual(status, { installed: true, authenticated: true, login: "octocat", host: "github.com" });
  assert.equal(JSON.stringify(status).includes("gho_SECRET"), false);
  const failed = await ghAccountStatus({ env: {}, execFileImpl: fakeExecFile({ err: Object.assign(new Error("exit 1"), { code: 1 }), stderr: "Token: gho_SECRET" }) });
  assert.deepEqual(failed, { installed: true, authenticated: false, login: null, host: null });
});

const TWO_ACCOUNTS = [
  "github.com",
  "  ✓ Logged in to github.com account old-user (keyring)",
  "  - Active account: false",
  "",
  "  ✓ Logged in to github.com account real-user (keyring)",
  "  - Active account: true",
  "",
].join("\n");

test("the active account wins over an earlier inactive one, in both the parser and the async probe", async () => {
  assert.deepEqual(parseGhAccount(TWO_ACCOUNTS), { host: "github.com", login: "real-user" });
  assert.equal(parseGhLogin(TWO_ACCOUNTS), "real-user");
  const status = await ghAccountStatus({ env: {}, execFileImpl: fakeExecFile({ stdout: TWO_ACCOUNTS }) });
  assert.deepEqual(status, { installed: true, authenticated: true, login: "real-user", host: "github.com" });
});

test("a failed inactive account does not unauthenticate a logged-in active one, even when gh exits 1", async () => {
  const stdout = "github.com\n  ✓ Logged in to github.com account real-user (keyring)\n  - Active account: true\n\n  X Failed to log in to github.com account stale-user (keyring)\n  - Active account: false\n";
  const err = Object.assign(new Error("exit 1"), { code: 1 });
  const status = await ghAccountStatus({ env: {}, execFileImpl: fakeExecFile({ err, stdout }) });
  assert.deepEqual(status, { installed: true, authenticated: true, login: "real-user", host: "github.com" });
});

test("a failed active account is not authenticated even when another account is logged in", async () => {
  const stdout = "github.com\n  ✓ Logged in to github.com account old-user (keyring)\n  - Active account: false\n\n  X Failed to log in to github.com account real-user (keyring)\n  - Active account: true\n";
  const err = Object.assign(new Error("exit 1"), { code: 1 });
  const status = await ghAccountStatus({ env: {}, execFileImpl: fakeExecFile({ err, stdout }) });
  assert.deepEqual(status, { installed: true, authenticated: false, login: "real-user", host: "github.com" });
});

test("a killed or timed-out gh probe answers authenticated null, never false", async () => {
  const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
  assert.equal((await ghAccountStatus({ env: {}, execFileImpl: fakeExecFile({ err: killed }) })).authenticated, null);
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" });
  assert.equal((await ghAccountStatus({ env: {}, execFileImpl: fakeExecFile({ err: aborted }) })).authenticated, null);
});

test("a real gh that outlives the timeout answers authenticated null", async (t) => {
  const host = makeHostEnv(t, "gh-account-timeout");
  host.env.NIGHTQUEUE_FAKE_GH_STATE = "authenticated";
  host.env.NIGHTQUEUE_FAKE_GH_SLEEP_MS = "2000";
  const status = await ghAccountStatus({ env: host.env, timeoutMs: 200 });
  assert.deepEqual([status.installed, status.authenticated], [true, null]);
});

test("the fake gh two-account fixture reports the active account, also through the sync init path", async (t) => {
  const host = makeHostEnv(t, "gh-account-two");
  Object.assign(host.env, { NIGHTQUEUE_FAKE_GH_STATE: "authenticated", NIGHTQUEUE_FAKE_GH_OTHER_LOGIN: "old-user" });
  assert.deepEqual(await ghAccountStatus({ env: host.env }), { installed: true, authenticated: true, login: FAKE_GH_LOGIN, host: "github.com" });
  assert.deepEqual(ghAuthStatus({ env: host.env }), { authenticated: true, login: FAKE_GH_LOGIN, host: "github.com", missing: false });
  host.env.NIGHTQUEUE_FAKE_GH_OTHER_FAILED = "1";
  assert.deepEqual(ghAuthStatus({ env: host.env }), { authenticated: true, login: FAKE_GH_LOGIN, host: "github.com", missing: false });
});

test("the sync probe reads a timed-out gh as unavailable", () => {
  const timedOut = ghAuthStatus({ env: {}, spawnSyncImpl: () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "", error: Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" }) }) });
  assert.deepEqual(timedOut, { authenticated: null, login: null, host: null, missing: false });
});
