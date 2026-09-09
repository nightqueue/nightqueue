#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stepLine } from "../src/cli/report.mjs";
import { npmCommandLine, runNpm } from "../src/host/npm.mjs";
import { versionMismatches } from "./versions.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACK_ARGS = ["pack", "--dry-run", "--json", "--ignore-scripts", ROOT];

// Content of one file of the repository root, as a declared failure when it cannot be read.
function readRootFile(name) {
  try {
    return readFileSync(join(ROOT, name), "utf8");
  } catch (err) {
    throw new Error(`cannot read ${name}: ${err?.message ?? String(err)}`);
  }
}

// Version the manifest declares, which is the one every other file has to agree with.
function manifestVersion(text) {
  const version = JSON.parse(text)?.version;
  if (typeof version !== "string" || !version) throw new Error("package.json declares no version");
  return version;
}

// Name the manifest declares, which is the identity npm has to publish and the one the installed layout is built from.
function manifestName(text) {
  const name = JSON.parse(text)?.name;
  if (typeof name !== "string" || !name) throw new Error("package.json declares no name");
  return name;
}

// Tarball one `npm pack --dry-run --json` call described, as a declared failure when the output is not the array npm documents.
function packedTarball(stdout) {
  const entry = JSON.parse(stdout)?.[0];
  if (!entry?.name || !entry?.filename || !Number.isFinite(entry?.unpackedSize)) throw new Error("npm pack printed no tarball description");
  return entry;
}

// Checks that the manifest, the changelog and the license declare the same version, and returns the one they agree on.
function checkVersions() {
  const manifest = manifestVersion(readRootFile("package.json"));
  const problems = versionMismatches({
    manifest,
    changelog: readRootFile("CHANGELOG.md"),
    license: readRootFile("LICENSE"),
  });
  if (problems.length) throw new Error(problems.join("\n"));
  return manifest;
}

// Checks that npm can still build the tarball without correcting the manifest, and returns its name and its unpacked size.
// A "was invalid and removed" warning means npm publishes a manifest that differs from the one in the repository -
// for `bin` that ships a package with no command at all - so any such warning fails the check.
function checkPack() {
  const result = runNpm(PACK_ARGS, { env: process.env });
  if (!result.ok) throw new Error(`${result.stderr.trim() || `exit ${result.status}`}\nrun \`${npmCommandLine(PACK_ARGS)}\` by hand`);
  const corrected = result.stderr.split("\n").filter((line) => /auto-corrected|was invalid and removed/i.test(line));
  if (corrected.length) throw new Error(`npm would correct package.json at publish time:\n${corrected.join("\n")}\nrun \`npm pkg fix\`, review the diff and commit it`);
  const { name, filename, unpackedSize } = packedTarball(result.stdout);
  const declared = manifestName(readRootFile("package.json"));
  if (name !== declared) throw new Error(`npm would publish ${name}, package.json declares ${declared}`);
  return `${name}, ${filename}, ${unpackedSize} bytes unpacked`;
}

// Runs the release checklist, printing one line per check and exiting 1 on the first thing that would make a bad publish.
function main() {
  try {
    process.stdout.write(`${stepLine("versions", "ok", checkVersions())}\n`);
    process.stdout.write(`${stepLine("pack", "ok", checkPack())}\n`);
  } catch (err) {
    process.stderr.write(`release:check failed\n${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}

main();
