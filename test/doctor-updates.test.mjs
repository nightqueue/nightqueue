import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { assertIsolatedEnv, makeHostEnv } from "../test-support/host.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const SETUP = ["setup", "--no-path", "--no-embedding"];

// Runs the diagnosis in process against an isolated host and returns the parsed report plus the exit code.
async function diagnose(env, argv) {
  const out = [];
  const ctx = { ...defaultContext(), env: assertIsolatedEnv(env), out: (line) => out.push(line), err: () => {} };
  const code = await run(["doctor", "--json", ...argv], ctx);
  assert.equal(out.length, 1, out.join("\n"));
  return { code, report: JSON.parse(out[0]) };
}

// The registry check of one report, or null when the diagnosis did not run it.
function registryCheck(report) {
  return report.checks.find((entry) => entry.name === "registry") ?? null;
}

// Calls the run made to `npm view`, which is the only question this package asks the registry.
function viewCalls(host) {
  return host.npmCalls().filter((call) => call[0] === "view");
}

// Installs the runtime into an isolated host, so the diagnosis has a version to compare.
async function setupHost(t, name) {
  const host = makeHostEnv(t, name);
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  return host;
}

test("doctor without --check-updates never asks the registry anything", async (t) => {
  const host = await setupHost(t, "doctor-updates-offline");
  const { report } = await diagnose(host.env, []);
  assert.equal(registryCheck(report), null, "the diagnosis ran the registry check without being asked for it");
  assert.deepEqual(viewCalls(host), [], "the diagnosis reached the registry without --check-updates");
});

test("--check-updates compares the installed runtime with the newest published version", async (t) => {
  const host = await setupHost(t, "doctor-updates-newest");
  const { report } = await diagnose(host.env, ["--check-updates"]);
  assert.deepEqual(registryCheck(report), {
    name: "registry",
    status: "ok",
    detail: `v${VERSION} is the newest published`,
    hint: null,
  });
  assert.deepEqual(viewCalls(host), [["view", "nightqueue@latest", "version", "--json"]]);
});

test("a newer published version is a warning pointing at update, never a failure", async (t) => {
  const host = await setupHost(t, "doctor-updates-behind");
  const offline = await diagnose(host.env, []);
  host.env.NIGHTQUEUE_FAKE_NPM_LATEST = "9.9.9";

  const { code, report } = await diagnose(host.env, ["--check-updates"]);
  const check = registryCheck(report);
  assert.equal(check.status, "warn");
  assert.equal(check.detail, `v9.9.9 published, v${VERSION} installed`);
  assert.equal(check.hint, "run `nightqueue update`");
  assert.equal(code, offline.code, "the registry check changed the exit code of the diagnosis");
});

test("a registry that does not answer is a warning carrying the message of npm, and the exit code stays local", async (t) => {
  const host = await setupHost(t, "doctor-updates-offline-registry");
  const offline = await diagnose(host.env, []);
  host.env.NIGHTQUEUE_FAKE_NPM_EXIT = "1";

  const { code, report } = await diagnose(host.env, ["--check-updates"]);
  const check = registryCheck(report);
  assert.equal(check.status, "warn");
  assert.match(check.detail, /NIGHTQUEUE_FAKE_NPM_EXIT=1/);
  assert.match(check.hint, /view nightqueue@latest version --json$/);
  assert.equal(code, offline.code, "a registry that is down turned a local diagnosis into another exit code");
  assert.deepEqual(report.checks.filter((entry) => entry.name === "registry" && entry.status === "fail"), []);
});
