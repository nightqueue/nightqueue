import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runtimePackageDir, updateCheckPath } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { compareVersions, isNewerVersion, parseVersion } from "../../src/host/semver.mjs";
import { updateNoticeLine } from "../../src/host/update-notice.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");

// A home whose update check is on, with a runtime that declares the given installed version.
function makeNoticeHome(t, name, installed) {
  const env = makeHome(t, name);
  delete env.NIGHTQUEUE_NO_UPDATE_CHECK;
  const dir = runtimePackageDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "nightqueue", version: installed }, null, 2)}\n`);
  return env;
}

// Stores a check answered a moment ago, so the notice needs no network at all.
function cachePublished(env, latest) {
  ensureHome(env);
  writeFileSync(updateCheckPath(env), `${JSON.stringify({ checkedAt: new Date(NOW).toISOString(), latest }, null, 2)}\n`);
  return env;
}

// A fetch double that fails the test if it is ever called: the cache must already answer.
function forbiddenFetch() {
  return async () => {
    throw new Error("must not reach the registry: the cache was supposed to answer alone");
  };
}

// Runs the full stack (temporary HOME + cached "latest") and asserts the notice fires only when latest is genuinely above installed.
async function assertNotice(t, name, { installed, latest, expectNotice }) {
  const env = cachePublished(makeNoticeHome(t, name, installed), latest);
  const line = await updateNoticeLine({ env, fetchImpl: forbiddenFetch(), now: () => NOW });
  if (expectNotice) {
    assert.equal(line, `nightqueue ${latest} is available (installed ${installed}) - run \`nightqueue update\``, `installed=${installed} latest=${latest}`);
  } else {
    assert.equal(line, null, `installed=${installed} latest=${latest}`);
  }
}

test("numeric ordering never degrades to a naive string compare", () => {
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1, "1.10.0 must sit above 1.9.0");
  assert.equal(compareVersions("1.9.0", "1.10.0"), -1);
  assert.equal(compareVersions("0.10.0", "0.2.0"), 1, "0.10.0 must sit above 0.2.0");
  assert.equal(compareVersions("0.2.0", "0.10.0"), -1);
  assert.equal(compareVersions("10.0.0", "2.0.0"), 1, "10.0.0 must sit above 2.0.0");
  assert.equal(compareVersions("2.0.0", "10.0.0"), -1);
});

test("an identical version never produces a notice (the nag-forever failure)", async (t) => {
  await assertNotice(t, "equal-plain", { installed: "1.4.0", latest: "1.4.0", expectNotice: false });
  await assertNotice(t, "equal-build-metadata", { installed: "1.4.0", latest: "1.4.0+build.9", expectNotice: false });
  assert.equal(compareVersions("1.4.0", "1.4.0"), 0);
  assert.equal(isNewerVersion("1.4.0", "1.4.0"), false);
});

test("a latest older than installed (a yanked/rolled-back dist-tag) never produces a notice", async (t) => {
  await assertNotice(t, "downgrade", { installed: "1.4.0", latest: "1.3.9", expectNotice: false });
  await assertNotice(t, "downgrade-major", { installed: "10.0.0", latest: "2.0.0", expectNotice: false });
  assert.equal(isNewerVersion("1.3.9", "1.4.0"), false);
});

test("a genuinely newer latest still produces the notice (the comparator is not dead code)", async (t) => {
  await assertNotice(t, "real-update", { installed: "1.9.0", latest: "1.10.0", expectNotice: true });
  await assertNotice(t, "real-update-major", { installed: "2.0.0", latest: "10.0.0", expectNotice: true });
});

test("prerelease ordering follows the semver spec", () => {
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0"), -1, "a prerelease sits below its own release");
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1, "alpha sits below beta");
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.2"), -1, "numeric prerelease identifiers compare numerically");
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.9"), -1);
  assert.equal(compareVersions("1.0.0-alpha.10", "1.0.0-alpha.9"), 1, "not a naive string compare on the numeric identifier either");
  assert.equal(compareVersions("1.0.0-9", "1.0.0-alpha"), -1, "a numeric identifier always sits below an alphanumeric one");
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1, "a shorter identifier list with an equal prefix sits below the longer one");
});

test("an installed prerelease is correctly below the released latest (real upgrade-out-of-prerelease scenario)", async (t) => {
  await assertNotice(t, "prerelease-to-release", { installed: "1.0.0-rc.1", latest: "1.0.0", expectNotice: true });
  await assertNotice(t, "prerelease-stays-behind-older-release", { installed: "1.0.0-rc.1", latest: "0.9.0", expectNotice: false });
});

test("build metadata takes no part in precedence", () => {
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0+build.999"), 0);
  assert.equal(isNewerVersion("1.0.0+build.5", "1.0.0"), false);
});

test("a `v` prefix on either side is not a supported semver and never produces a notice", async (t) => {
  assert.equal(parseVersion("v1.2.3"), null);
  assert.equal(compareVersions("v1.2.3", "1.0.0"), null);
  assert.equal(isNewerVersion("v2.0.0", "1.0.0"), false, "a v-prefixed latest must not be read as newer");
  await assertNotice(t, "v-prefix-latest", { installed: "1.0.0", latest: "v2.0.0", expectNotice: false });
  await assertNotice(t, "v-prefix-installed", { installed: "v1.0.0", latest: "2.0.0", expectNotice: false });
});

test("garbage and hostile input never throws and never earns a notice", async (t) => {
  const garbageValues = ["", null, undefined, 3, "latest", "1.2", "1.2.3.4", "1.2.-3", "  ", "1.2.3\nrm -rf /"];

  for (const garbage of garbageValues) {
    assert.doesNotThrow(() => parseVersion(garbage), `parseVersion threw on ${JSON.stringify(garbage)}`);
    assert.doesNotThrow(() => compareVersions(garbage, "1.0.0"), `compareVersions threw on ${JSON.stringify(garbage)} as latest`);
    assert.doesNotThrow(() => compareVersions("1.0.0", garbage), `compareVersions threw on ${JSON.stringify(garbage)} as current`);
    assert.equal(isNewerVersion(garbage, "1.0.0"), false, `garbage ${JSON.stringify(garbage)} must never be read as a newer latest`);
  }

  await assertNotice(t, "garbage-latest-empty", { installed: "1.0.0", latest: "", expectNotice: false });
  await assertNotice(t, "garbage-latest-word", { installed: "1.0.0", latest: "latest", expectNotice: false });
  await assertNotice(t, "garbage-latest-truncated", { installed: "1.0.0", latest: "1.2", expectNotice: false });
  await assertNotice(t, "garbage-latest-4-segments", { installed: "1.0.0", latest: "1.2.3.4", expectNotice: false });
});

test("leading zeros on a numeric segment do not throw and compare as the plain number", () => {
  assert.doesNotThrow(() => compareVersions("01.2.3", "1.2.3"));
  assert.equal(compareVersions("01.2.3", "1.2.3"), 0);
});

test("surrounding whitespace is trimmed the same way on both sides", () => {
  assert.equal(compareVersions(" 1.2.3 ", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3", " 1.2.3 "), 0);
});

test("an enormous numeric segment beyond Number.MAX_SAFE_INTEGER never inverts a real order and never throws", () => {
  assert.doesNotThrow(() => compareVersions("999999999999999999999.0.0", "1.0.0"));
  assert.equal(compareVersions("999999999999999999999.0.0", "1.0.0"), 1, "an astronomically large major is still read as newer than a normal one");
  assert.equal(compareVersions("1.0.0", "999999999999999999999.0.0"), -1);
});
