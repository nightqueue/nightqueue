import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnifiedDiff } from "../../studio/src/lib/diff.ts";

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

test("a hunk numbers its lines: context on both sides, a removal on the old side, an addition on the new", () => {
  const { hunks, binary } = parseUnifiedDiff(EDIT);
  assert.equal(binary, false);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].header, "@@ -1,3 +1,3 @@ fn top");
  assert.deepEqual(hunks[0].lines, [
    { kind: "ctx", text: "one", oldNo: 1, newNo: 1 },
    { kind: "del", text: "two", oldNo: 2, newNo: null },
    { kind: "add", text: "TWO", oldNo: null, newNo: 2 },
    { kind: "ctx", text: "three", oldNo: 3, newNo: 3 },
  ]);
});

test("a removed `-- a` and an added `++ b` inside a hunk are lines, never file headers", () => {
  const { hunks } = parseUnifiedDiff(["--- a/x", "+++ b/x", "@@ -5,1 +5,1 @@", "--- a", "+++ b", ""].join("\n"));
  assert.deepEqual(hunks[0].lines, [
    { kind: "del", text: "-- a", oldNo: 5, newNo: null },
    { kind: "add", text: "++ b", oldNo: null, newNo: 5 },
  ]);
});

test("an omitted count means one line, a missing final newline is a meta row, and two files give two hunks", () => {
  const text = ["@@ -0,0 +1 @@", "+only", "\\ No newline at end of file", "diff --git a/b b/b", "@@ -2 +2 @@", "-x", "+y", ""].join("\n");
  const { hunks } = parseUnifiedDiff(text);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].lines.map((line) => line.kind), ["add", "meta"]);
  assert.deepEqual(hunks[1].lines.map((line) => [line.kind, line.oldNo, line.newNo]), [["del", 2, null], ["add", null, 2]]);
});

test("a binary file has no hunk and is flagged, and no text at all answers nothing", () => {
  assert.deepEqual(parseUnifiedDiff("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n"), { hunks: [], binary: true });
  assert.deepEqual(parseUnifiedDiff(null), { hunks: [], binary: false });
  assert.deepEqual(parseUnifiedDiff(""), { hunks: [], binary: false });
});
