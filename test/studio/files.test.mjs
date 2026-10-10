import assert from "node:assert/strict";
import { test } from "node:test";
import { countsCell, drawerStep, fileKind, filesTitle, KIND_META, pathParts, proportionBar } from "../../studio/src/lib/files.ts";

test("a path splits into its directory with the final slash and its name", () => {
  assert.deepEqual(pathParts("src/config/schema.mjs"), { dir: "src/config/", name: "schema.mjs" });
  assert.deepEqual(pathParts("README.md"), { dir: "", name: "README.md" });
});

test("the counts cell signs and separates thousands, a side absent when it is null or zero", () => {
  assert.deepEqual(countsCell({ added: 1234, deleted: 56 }), { adds: "+1,234", dels: "−56" });
  assert.deepEqual(countsCell({ added: 3, deleted: 0 }), { adds: "+3", dels: null });
  assert.deepEqual(countsCell({ added: null, deleted: 7 }), { adds: null, dels: "−7" });
  assert.deepEqual(countsCell({ added: null, deleted: null }), { adds: null, dels: null });
  assert.deepEqual(countsCell({ added: Number.NaN, deleted: -2 }), { adds: null, dels: null });
});

test("each kind has its English label, an untracked entry without a kind is new, and the title counts the files", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(KIND_META).map(([kind, meta]) => [kind, meta.label])), { new: "new file", mod: "modified", del: "deleted", ren: "renamed" });
  assert.equal(fileKind({ kind: "ren" }), "ren");
  assert.equal(fileKind({ kind: null, untracked: true }), "new");
  assert.equal(fileKind({ kind: "bogus" }), null);
  assert.equal(filesTitle(12), "Files · 12 changed");
});

test("the proportion bar fills its width, a gap only when both sides are drawn, nothing when nothing was counted", () => {
  const both = proportionBar(30, 10);
  assert.equal(both.add + both.del + 2, 120);
  assert.equal(both.add, 89);
  assert.deepEqual(proportionBar(5, 0), { add: 120, del: 0 });
  assert.deepEqual(proportionBar(null, 4), { add: 0, del: 120 });
  assert.deepEqual(proportionBar(0, 0), { add: 0, del: 0 });
  assert.deepEqual(proportionBar(null, null), { add: 0, del: 0 });
  const lopsided = proportionBar(100_000, 1);
  assert.deepEqual([lopsided.del >= 1, lopsided.add + lopsided.del], [true, 118]);
});

test("the drawer keys move up and down within the list, Esc closes, and anything else does nothing", () => {
  assert.equal(drawerStep("ArrowUp", 0, 3), null);
  assert.deepEqual(drawerStep("ArrowUp", 2, 3), { move: 1 });
  assert.deepEqual(drawerStep("ArrowDown", 0, 3), { move: 1 });
  assert.equal(drawerStep("ArrowDown", 2, 3), null);
  assert.deepEqual(drawerStep("Escape", 1, 3), { close: true });
  assert.equal(drawerStep("j", 1, 3), null);
  assert.equal(drawerStep("ArrowDown", 0, 1), null);
});
