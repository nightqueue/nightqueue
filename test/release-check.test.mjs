import assert from "node:assert/strict";
import { test } from "node:test";
import { changelogVersion, licenseVersion, versionMismatches } from "../scripts/versions.mjs";

const CHANGELOG = ["# Changelog", "", "## 0.1.0 - 2026-09-09", "", "### Added", "- the first release", ""].join("\n");
const LICENSE = ["Parameters", "", "Licensor:             Maykon Vinicius", "Licensed Work:        nightshift 0.1.0", ""].join("\n");

test("the top entry of the changelog is the first heading with a version and a date", () => {
  assert.equal(changelogVersion(CHANGELOG), "0.1.0");
  assert.equal(changelogVersion(`${CHANGELOG}\n## 0.0.9 - 2026-08-01\n`), "0.1.0");
  assert.equal(changelogVersion("# Changelog\n\n## Unreleased\n\n## 0.1.0 - 2026-09-09\n"), "0.1.0");
});

test("a changelog whose top entry does not carry a version and a date parses as none", () => {
  assert.equal(changelogVersion("# Changelog\n\n## v0.1.0 (2026-09-09)\n"), null);
  assert.equal(changelogVersion(""), null);
  assert.equal(changelogVersion(null), null);
});

test("the licensed work line is where the license declares its version", () => {
  assert.equal(licenseVersion(LICENSE), "0.1.0");
  assert.equal(licenseVersion("Licensed Work:        another-package 0.1.0\n"), null);
  assert.equal(licenseVersion(""), null);
});

test("three files that agree on the version leave nothing to report", () => {
  assert.deepEqual(versionMismatches({ manifest: "0.1.0", changelog: CHANGELOG, license: LICENSE }), []);
});

test("every file that disagrees with the manifest is reported, naming both versions", () => {
  const problems = versionMismatches({ manifest: "0.2.0", changelog: CHANGELOG, license: LICENSE });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^CHANGELOG\.md declares 0\.1\.0, package\.json declares 0\.2\.0$/);
  assert.match(problems[1], /^LICENSE declares 0\.1\.0, package\.json declares 0\.2\.0$/);
});

test("a version that could not be parsed is a divergence carrying the expected format, never a match", () => {
  const problems = versionMismatches({ manifest: "0.1.0", changelog: "# Changelog\n", license: "Parameters\n" });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^CHANGELOG\.md declares no version; expected a line `## <version> - YYYY-MM-DD`$/);
  assert.match(problems[1], /^LICENSE declares no version; expected a line `Licensed Work: {8}nightshift <version>`$/);
});
