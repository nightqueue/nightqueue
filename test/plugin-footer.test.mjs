import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));
const TEMPLATE = join(PLUGIN, "skills/resolve/references/pr-template.md");

// Every text file under plugin/, with its path relative to it.
function pluginFiles() {
  return readdirSync(PLUGIN, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(md|json|mjs|js|txt)$/.test(entry.name))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

// The lines of plugin/ matching a pattern, as `<file>:<line>: <text>`.
function linesMatching(pattern) {
  return pluginFiles().flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((text, index) => ({ text, index }))
      .filter(({ text }) => pattern.test(text))
      .map(({ text, index }) => `${file.slice(PLUGIN.length)}:${index + 1}: ${text}`),
  );
}

test("plugin/ never tells an agent to write the footer or the job-ref segment, a job id suffix, the run slug closing line or a `Refs` trailer", () => {
  assert.ok(pluginFiles().length > 5, "the scan found no plugin file");
  assert.deepEqual(linesMatching(/Opened by nightqueue\s*[··]/), []);
  assert.deepEqual(linesMatching(/[··]\s*J-(?:<n>|\d+\b)/), []);
  assert.deepEqual(linesMatching(/[··]\s*job\s*<id>/i), []);
  assert.deepEqual(linesMatching(/run <slug>`?\s*$|· run <slug>/), []);
  assert.deepEqual(linesMatching(/without the `#` \(`job 24`/), []);
  assert.deepEqual(linesMatching(/## The closing line/), []);
  assert.deepEqual(linesMatching(/Refs:/).filter((line) => !/Never write a `Refs:` trailer; `run (commit|publish)` adds it/.test(line)), []);
});

test("the model of the pull request template ends at `Not tested:`, and the bare `#<number>` rule is still there", () => {
  const text = readFileSync(TEMPLATE, "utf8");
  const model = text.slice(text.indexOf("The fence delimits the MODEL"));
  const fence = model.split("```")[1];
  assert.ok(fence, "the template carries no fenced model");
  const last = fence.split("\n").filter((line) => line.trim() !== "").at(-1);
  assert.match(last, /^Not tested: /);
  assert.match(text, /\*\*A bare `#<number>` anywhere\.\*\*/);
  assert.match(text, /A decision is named by its ref \(`D-1`\), never `#1`/);
  assert.match(text, /`nightqueue run pr` appends the traceability footer from the job row/);
});
