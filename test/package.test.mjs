import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parsePackOutput } from "../src/host/npm.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const PACKED_DIRS = ["bin", "src", "plugin", ".claude-plugin"];
const DEV_PREFIXES = ["test/", "test-support/", "docs/", "scripts/", ".claude/", ".github/"];
const MAX_UNPACKED_BYTES = 2 * 1024 * 1024;

// Description of the tarball npm would publish, or null when npm is not installed on this machine.
function packedTarball() {
  const args = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const result = spawnSync("npm", args, { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  if (result.error || result.status !== 0) return null;
  const entry = parsePackOutput(result.stdout);
  if (!entry || !Array.isArray(entry.files)) return null;
  return { files: entry.files.map((file) => file.path), unpackedSize: entry.unpackedSize };
}

// Files git tracks under the directories the package publishes, or null when git does not answer.
function trackedFiles() {
  const result = spawnSync("git", ["ls-files", ...PACKED_DIRS], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  if (result.error || result.status !== 0) return null;
  const files = result.stdout.split("\n").filter(Boolean);
  return files.length ? files : null;
}

test("`nightqueue` is the only command name npm installs and the embedding library is not a dependency", () => {
  // npm strips a bin path that starts with `./` at publish time ("script name was invalid and removed"),
  // which would publish a package with no command at all: the path stays bare.
  assert.equal(MANIFEST.name, "@nightqueue/nq");
  assert.deepEqual(MANIFEST.bin, { nightqueue: "bin/nightqueue.mjs" });
  assert.equal(MANIFEST.optionalDependencies, undefined);
  assert.equal(Object.hasOwn(MANIFEST.dependencies, "@huggingface/transformers"), false);
  assert.deepEqual(MANIFEST.files, [".claude-plugin", "bin", "plugin", "src", "README.md", "LICENSE", "CHANGELOG.md"]);
});

test("the manifest carries the metadata a published package needs, and the engine and the dependencies it always had", () => {
  assert.equal(MANIFEST.homepage, "https://nightqueue.github.io");
  assert.deepEqual(MANIFEST.repository, { type: "git", url: "git+https://github.com/nightqueue/nightqueue.git" });
  assert.deepEqual(MANIFEST.bugs, { url: "https://github.com/nightqueue/nightqueue/issues" });
  assert.deepEqual(MANIFEST.publishConfig, { access: "public" });
  assert.ok(MANIFEST.keywords.includes("claude-code"), MANIFEST.keywords.join(", "));
  assert.deepEqual(MANIFEST.engines, { node: ">=22" });
  assert.deepEqual(Object.keys(MANIFEST.dependencies), ["@modelcontextprotocol/sdk", "zod"]);
});

test("the tarball carries the CLI, the plugin and the manifest, and no test at all", (t) => {
  const tarball = packedTarball();
  if (!tarball) return t.skip("npm did not answer `pack --dry-run`");
  for (const expected of [
    "package.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "bin/nightqueue.mjs",
    "src/cli/index.mjs",
    ".claude-plugin/marketplace.json",
    "plugin/.claude-plugin/plugin.json",
    "plugin/skills/resolve/SKILL.md",
    "plugin/skills/queue/SKILL.md",
  ]) {
    assert.ok(tarball.files.includes(expected), `${expected} is missing from the tarball`);
  }
  assert.equal(tarball.files.includes("bin/shift.mjs"), false, "the tarball still carries the entry of the previous command name");
  assert.deepEqual(tarball.files.filter((path) => DEV_PREFIXES.some((prefix) => path.startsWith(prefix))), []);
});

test("every versioned file of the published directories is in the tarball", (t) => {
  const tarball = packedTarball();
  if (!tarball) return t.skip("npm did not answer `pack --dry-run`");
  const tracked = trackedFiles();
  if (!tracked) return t.skip("git did not answer `ls-files`");
  const packed = new Set(tarball.files);
  for (const file of tracked) {
    assert.ok(packed.has(file), `${file} is versioned under ${PACKED_DIRS.join(", ")} and is missing from the tarball`);
  }
});

test("the unpacked package stays under two megabytes", (t) => {
  const tarball = packedTarball();
  if (!tarball) return t.skip("npm did not answer `pack --dry-run`");
  const { unpackedSize } = tarball;
  assert.ok(Number.isFinite(unpackedSize), "npm reported no unpacked size");
  assert.ok(unpackedSize < MAX_UNPACKED_BYTES, `the unpacked package is ${unpackedSize} bytes, over the ${MAX_UNPACKED_BYTES} allowed`);
});
