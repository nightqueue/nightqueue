import assert from "node:assert/strict";
import { test } from "node:test";
import { clampDockWidth } from "../../studio/src/lib/dock-geometry.ts";

test("a dock width is bounded to 70 % of the viewport, so a narrower window narrows the same chosen width", () => {
  assert.equal(clampDockWidth(1800, 2000), 1400);
  assert.equal(clampDockWidth(1800, 900), 630);
});

test("the minimum width holds on a small viewport, never wider than the viewport itself", () => {
  assert.equal(clampDockWidth(100, 400), 320);
  assert.equal(clampDockWidth(1000, 400), 320);
  assert.equal(clampDockWidth(1000, 300), 300);
});

test("a non-finite width falls back to the default, and widths are rounded", () => {
  assert.equal(clampDockWidth(Number.NaN, 2000), 560);
  assert.equal(clampDockWidth(Number.POSITIVE_INFINITY, 2000), 560);
  assert.equal(clampDockWidth(500.6, 2000), 501);
});
