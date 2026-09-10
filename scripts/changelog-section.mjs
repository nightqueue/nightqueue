#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { changelogSection } from "./versions.mjs";

const CHANGELOG = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

// Content of the changelog of the repository, as a declared failure when it cannot be read.
function readChangelog() {
  try {
    return readFileSync(CHANGELOG, "utf8");
  } catch (err) {
    throw new Error(`cannot read CHANGELOG.md: ${err?.message ?? String(err)}`);
  }
}

// Prints the changelog section of the version given as the only argument, which is the body the release notes carry.
function main(version) {
  try {
    if (!version) throw new Error("usage: node scripts/changelog-section.mjs <version>");
    const section = changelogSection(readChangelog(), version);
    if (section === null) throw new Error(`CHANGELOG.md carries no \`## ${version}\` entry`);
    process.stdout.write(`${section}\n`);
  } catch (err) {
    process.stderr.write(`${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}

main(process.argv[2]);
