import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// Files the published tarball would carry, or null when npm is not installed on this machine.
function packedFiles() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout)[0].files.map((entry) => entry.path);
  } catch {
    return null;
  }
}

test("`nightshift` is the only command name npm installs and the embedding library is not a dependency", () => {
  assert.deepEqual(MANIFEST.bin, { nightshift: "./bin/nightshift.mjs" });
  assert.equal(MANIFEST.optionalDependencies, undefined);
  assert.equal(Object.hasOwn(MANIFEST.dependencies, "@huggingface/transformers"), false);
  assert.deepEqual(MANIFEST.files, [".claude-plugin", "bin", "plugin", "src", "README.md", "LICENSE"]);
});

test("the tarball carries the CLI, the plugin and the manifest, and no test at all", (t) => {
  const files = packedFiles();
  if (!files) return t.skip("npm did not answer `pack --dry-run`");
  for (const expected of [
    "package.json",
    "README.md",
    "LICENSE",
    "bin/nightshift.mjs",
    "src/cli/index.mjs",
    ".claude-plugin/marketplace.json",
    "plugin/.claude-plugin/plugin.json",
    "plugin/skills/resolve/SKILL.md",
  ]) {
    assert.ok(files.includes(expected), `${expected} is missing from the tarball`);
  }
  assert.equal(files.includes("bin/shift.mjs"), false, "the tarball still carries the entry of the previous command name");
  assert.deepEqual(files.filter((path) => path.startsWith("test/") || path.startsWith("test-support/")), []);
});
