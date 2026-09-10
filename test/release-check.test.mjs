import assert from "node:assert/strict";
import { test } from "node:test";
import { changelogSection, changelogVersion, licenseVersion, versionMismatches } from "../scripts/versions.mjs";

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

const FULL_CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "- something that has not shipped",
  "",
  "## 0.2.0 - 2026-10-01",
  "",
  "### Added",
  "- the second release",
  "",
  "## 0.1.0 - 2026-09-09",
  "",
  "### Added",
  "- the first release",
  "",
].join("\n");

test("the section of a version is the text under its heading, stopping at the next one", () => {
  assert.equal(changelogSection(FULL_CHANGELOG, "0.2.0"), "### Added\n- the second release");
  assert.equal(changelogSection(FULL_CHANGELOG, "0.1.0"), "### Added\n- the first release");
  assert.equal(changelogSection(CHANGELOG, "0.1.0"), "### Added\n- the first release");
});

test("an `## Unreleased` heading is a section of its own and never leaks into the one below it", () => {
  assert.equal(changelogSection(FULL_CHANGELOG, "Unreleased"), "- something that has not shipped");
  assert.equal(changelogSection(FULL_CHANGELOG, "0.2.0").includes("has not shipped"), false);
});

test("a version the changelog does not carry has no section at all", () => {
  assert.equal(changelogSection(FULL_CHANGELOG, "9.9.9"), null);
  assert.equal(changelogSection(FULL_CHANGELOG, "0.2"), null);
  assert.equal(changelogSection(FULL_CHANGELOG, ""), null);
  assert.equal(changelogSection(FULL_CHANGELOG, undefined), null);
  assert.equal(changelogSection(null, "0.1.0"), null);
});
