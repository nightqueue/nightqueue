import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { closeDb } from "../src/memory/db.mjs";
import { makeHostEnv } from "../test-support/host.mjs";
import { ensureProject } from "../test-support/memory.mjs";
import { setIntegrations } from "../test-support/origin-provider.mjs";

const SETUP = ["setup", "--no-path", "--no-embedding"];

// Subprocess runner that answers for gh and, when given an answer, for eas; otherwise the missing eas path fails with ENOENT.
function withFakes(env, easAnswer) {
  return (file, args, options) => {
    if (file === "gh") return { status: 0, stdout: "Logged in", stderr: "" };
    if (file === env.NIGHTQUEUE_EAS_BIN && easAnswer) return easAnswer;
    return spawnSync(file, args, options);
  };
}

// Runs the diagnosis in process and answers the eas line of its report.
async function easLine(env, easAnswer = null) {
  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {}, spawnSyncImpl: withFakes(env, easAnswer) };
  await run(["doctor", "--json"], ctx);
  const found = JSON.parse(out[0]).checks.find((check) => check.name === "eas");
  assert.ok(found, "the report has no eas line");
  return { status: found.status, detail: found.detail, hint: found.hint };
}

// An isolated host that went through setup.
async function setUpHost(t, name) {
  const host = makeHostEnv(t, name);
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  return host;
}

test("a logged-in eas is ok with its account, and the probe gets no NIGHTQUEUE_ variable", async (t) => {
  const host = await setUpHost(t, "doctor-eas-in");
  let seenEnv = null;
  const ctx = { ...defaultContext(), env: host.env, out: () => {}, err: () => {} };
  ctx.spawnSyncImpl = (file, args, options) => {
    if (file === host.env.NIGHTQUEUE_EAS_BIN) {
      seenEnv = options.env;
      return { status: 0, stdout: "alice (authenticated using EXPO_TOKEN)\n", stderr: "" };
    }
    return withFakes(host.env, null)(file, args, options);
  };
  await run(["doctor", "--json"], ctx);
  assert.equal(Object.keys(seenEnv).some((key) => key.startsWith("NIGHTQUEUE_")), false);
  assert.deepEqual(await easLine(host.env, { status: 0, stdout: "alice\n", stderr: "" }), { status: "ok", detail: "logged in as alice", hint: null });
});

test("an installed but logged-out eas warns with the eas login hint", async (t) => {
  const host = await setUpHost(t, "doctor-eas-out");
  const line = await easLine(host.env, { status: 1, stdout: "", stderr: "Not logged in" });
  assert.deepEqual(line, { status: "warn", detail: "not logged in", hint: "run `eas login`" });
});

test("an eas whoami that timed out or was killed warns that it did not answer, never that eas is logged out", async (t) => {
  const host = await setUpHost(t, "doctor-eas-silent");
  const answers = [
    { error: { code: "ETIMEDOUT" }, status: null, stdout: "", stderr: "" },
    { status: null, signal: "SIGTERM", stdout: "", stderr: "" },
  ];
  for (const answer of answers) {
    const line = await easLine(host.env, answer);
    assert.deepEqual(line, { status: "warn", detail: "eas whoami did not answer", hint: "run `eas whoami` to see why" }, JSON.stringify(answer));
  }
});

test("a missing eas is ok when no project publishes Expo OTA, even with no database", async (t) => {
  const bare = makeHostEnv(t, "doctor-eas-bare");
  const expected = { status: "ok", detail: "not installed (needed only to publish Expo OTA updates)", hint: null };
  assert.deepEqual(await easLine(bare.env), expected);
  const host = await setUpHost(t, "doctor-eas-none");
  const off = ensureProject(host.env, "off");
  ensureProject(host.env, "unset");
  setIntegrations(host.env, off, { expo: { ota: false } });
  closeDb(host.env);
  assert.deepEqual(await easLine(host.env), expected);
});

test("a missing eas warns and names every project with expo.ota=true", async (t) => {
  const host = await setUpHost(t, "doctor-eas-needed");
  setIntegrations(host.env, ensureProject(host.env, "web"), { expo: { ota: true } });
  setIntegrations(host.env, ensureProject(host.env, "app"), { expo: { ota: true } });
  setIntegrations(host.env, ensureProject(host.env, "api"), { expo: { ota: false } });
  closeDb(host.env);
  assert.deepEqual(await easLine(host.env), {
    status: "warn",
    detail: "not installed - needed to publish Expo OTA for app, web",
    hint: "install eas-cli (`npm install -g eas-cli`), then run `eas login`",
  });
});
