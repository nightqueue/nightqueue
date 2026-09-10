import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, isNewerVersion, parseVersion } from "../../src/host/semver.mjs";

test("compareVersions orders major, minor and patch numerically", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("0.1.9", "0.2.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1, "the numbers were compared as text");
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
});

test("a prerelease sits below the release it precedes, and its identifiers keep the semver order", () => {
  assert.equal(compareVersions("0.2.0-rc.1", "0.2.0"), -1);
  assert.equal(compareVersions("0.2.0", "0.2.0-rc.1"), 1);
  assert.equal(compareVersions("0.2.0-rc.2", "0.2.0-rc.1"), 1);
  assert.equal(compareVersions("0.2.0-rc.10", "0.2.0-rc.2"), 1);
  assert.equal(compareVersions("0.2.0-alpha", "0.2.0-beta"), -1);
  assert.equal(compareVersions("0.2.0-1", "0.2.0-alpha"), -1, "a numeric identifier must sit below an alphanumeric one");
  assert.equal(compareVersions("0.2.0-rc.1.1", "0.2.0-rc.1"), 1);
  assert.equal(compareVersions("0.2.0+build.5", "0.2.0"), 0, "the build metadata took part in the order");
});

test("anything that is not a semver compares to null and is never newer", () => {
  for (const bad of ["", "next", "1.2", "1.2.3.4", "v1.2.3", null, undefined, 3]) {
    assert.equal(parseVersion(bad), null, String(bad));
    assert.equal(compareVersions(bad, "0.1.0"), null, String(bad));
    assert.equal(compareVersions("0.1.0", bad), null, String(bad));
    assert.equal(isNewerVersion(bad, "0.1.0"), false, String(bad));
    assert.equal(isNewerVersion("0.2.0", bad), false, String(bad));
  }
});

test("isNewerVersion is true only when the published version is above the installed one", () => {
  assert.equal(isNewerVersion("0.2.0", "0.1.0"), true);
  assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("0.0.9", "0.1.0"), false, "a rollback of the dist-tag announced an update");
});
