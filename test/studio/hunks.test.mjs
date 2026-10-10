import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DIFF_LINES, parseHunks } from "../../src/studio/hunks.mjs";

const EDIT = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,3 +1,3 @@ fn top",
  " one",
  "-two",
  "+TWO",
  " three",
  "",
].join("\n");

test("a hunk numbers its lines: context on both sides, a removal on the old side only, an addition on the new side only", () => {
  const { hunks, binary } = parseHunks(EDIT);
  assert.equal(binary, false);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].header, "@@ -1,3 +1,3 @@ fn top");
  assert.deepEqual(hunks[0].lines, [
    { type: "ctx", old: 1, new: 1, text: "one" },
    { type: "del", old: 2, text: "two" },
    { type: "add", new: 2, text: "TWO" },
    { type: "ctx", old: 3, new: 3, text: "three" },
  ]);
  assert.equal("new" in hunks[0].lines[1], false, "a removal carries a `new` key");
  assert.equal("old" in hunks[0].lines[2], false, "an addition carries an `old` key");
});

test("a removed `-- a` and an added `++ b` inside a hunk are lines, never file headers", () => {
  const { hunks } = parseHunks(["--- a/x", "+++ b/x", "@@ -5,1 +5,1 @@", "--- a", "+++ b", ""].join("\n"));
  assert.deepEqual(hunks[0].lines, [
    { type: "del", old: 5, text: "-- a" },
    { type: "add", new: 5, text: "++ b" },
  ]);
});

test("an omitted count means one line, a missing-newline marker is dropped, and two files give two hunks", () => {
  const text = ["@@ -0,0 +1 @@", "+only", "\\ No newline at end of file", "diff --git a/b b/b", "@@ -2 +2 @@", "-x", "\\ No newline at end of file", "+y", ""].join("\n");
  const { hunks } = parseHunks(text);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].lines.map((line) => line.type), ["add"]);
  assert.deepEqual(hunks[1].lines.map((line) => [line.type, line.old, line.new]), [["del", 2, undefined], ["add", undefined, 2]]);
});

test("a binary file has no hunk and is flagged, and no text at all answers nothing", () => {
  assert.deepEqual(parseHunks("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n"), { hunks: [], binary: true, capped: false });
  assert.deepEqual(parseHunks(null), { hunks: [], binary: false, capped: false });
  assert.deepEqual(parseHunks(""), { hunks: [], binary: false, capped: false });
});

test("a diff cut short of its header's counts gives only the lines present, never one for the final newline", () => {
  const { hunks } = parseHunks("@@ -1,5 +1,5 @@\n a\n b\n");
  assert.deepEqual(hunks[0].lines.map((line) => line.text), ["a", "b"]);
});

test("lines stop at the 2000-line cap across hunks and the answer says so; exactly the cap is not capped", () => {
  assert.equal(MAX_DIFF_LINES, 2000);
  const added = (count) => `@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, () => "+x").join("\n")}\n`;
  const over = parseHunks(added(MAX_DIFF_LINES + 1));
  assert.equal(over.hunks[0].lines.length, MAX_DIFF_LINES);
  assert.equal(over.capped, true);
  const exact = parseHunks(added(MAX_DIFF_LINES));
  assert.equal(exact.capped, false);
  const split = parseHunks(`${added(3)}@@ -10,2 +10,2 @@\n a\n b\n`, 3);
  assert.deepEqual([split.hunks.length, split.capped], [1, true]);
  assert.equal(parseHunks(EDIT).capped, false);
});
