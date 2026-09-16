import assert from "node:assert/strict";
import { test } from "node:test";
import { noticeNarration } from "../../src/queue/narrate.mjs";

// H2 (QA analyst, Group 2): the 400-code-point cut of `noticeNarration` /
// `noticeClipped` (src/queue/narrate.mjs:229-246). Every case below was run against
// the current code; none of them broke, so this file stays as a boundary
// regression test that PASSES — it pins the exact off-by-one behavior so a future
// change to `NOTICE_LIMIT`/`truncateByCodePoint` composition cannot silently move it.

test("a notice of exactly 400 code points is narrated whole, with no pointer and no ellipsis", () => {
  const notice = "a".repeat(400);
  const result = noticeNarration(notice, { jobId: 7 });
  assert.equal(result, `notice\n    ${notice}`);
  assert.equal(result.includes("..."), false);
  assert.equal(result.includes("read the whole notice"), false);
});

test("a notice of 401 code points is cut at exactly 400, with the pointer attached", () => {
  const notice = "a".repeat(401);
  const result = noticeNarration(notice, { jobId: 7 });
  assert.equal(result, `notice\n    ${"a".repeat(400)}...\n    read the whole notice with: nightshift queue status 7`);
});

test("a 401-code-point notice built from astral pairs is cut without corrupting a surrogate", () => {
  const emoji = "\u{1F600}";
  const notice = emoji.repeat(401);
  const result = noticeNarration(notice, { jobId: 7 });
  assert.equal(result, `notice\n    ${emoji.repeat(400)}...\n    read the whole notice with: nightshift queue status 7`);
  assert.equal(result.includes("�"), false, "a lone surrogate half surfaced as a replacement character");
});

test("a whitespace-only notice narrates as an empty body, never crashes, no pointer", () => {
  const result = noticeNarration("   \n   ", { jobId: 7 });
  assert.equal(result, "notice\n    ");
  assert.equal(result.includes("read the whole notice"), false);
});

test("a job id of 0 still gets its pointer, because the guard is `jobId === null`, not falsy", () => {
  const notice = "a".repeat(401);
  const result = noticeNarration(notice, { jobId: 0 });
  assert.equal(result.endsWith("read the whole notice with: nightshift queue status 0"), true, result);
});
