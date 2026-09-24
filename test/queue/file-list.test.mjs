import assert from "node:assert/strict";
import { test } from "node:test";
import { listedFiles, recordedFiles } from "../../src/queue/file-list.mjs";

const ARTIFACT = [
  "# Implementation",
  "",
  "<!-- ## Modified files",
  "src/commented.mjs -->",
  "",
  "```md",
  "## Modified files",
  "src/fenced.mjs",
  "```",
  "",
  "## Modified files",
  "- `src/a.mjs`",
  "src/b.mjs",
  "<!-- src/hidden.mjs -->",
  "~~~",
  "src/tilde.mjs",
  "~~~",
  "the prose an agent leaves",
  "",
  "## Done",
  "src/not-listed.mjs",
].join("\n");

test("recordedFiles reads the list from the prose only, skipping HTML comments and fenced code", () => {
  assert.deepEqual(recordedFiles(ARTIFACT), ["src/a.mjs", "src/b.mjs"]);
  assert.deepEqual(recordedFiles(undefined), []);
  assert.deepEqual(recordedFiles("no list here"), []);
});

test("listedFiles, the parser `run commit` stages from, keeps its behavior after the move", () => {
  assert.deepEqual(listedFiles("## Modified files\n- `src/a.mjs`\n* src/b.mjs\nsome prose here\n## Done\nsrc/c.mjs"), ["src/a.mjs", "src/b.mjs"]);
});
