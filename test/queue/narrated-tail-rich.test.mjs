import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { jobLogPath } from "../../src/config/paths.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { narrateJob } from "../../src/queue/narrated-tail.mjs";
import { ensureProject, makeHome } from "../../test-support/memory.mjs";
import { assistantEvent, attemptMarker } from "../../test-support/streams.mjs";

const BODY_CAP = 32768;

// A log whose short lines carry multibyte text and whose long answers overflow the body cap, so each one reports its line's offset.
function writeMultibyteLog(env, id) {
  const lines = [
    attemptMarker(1),
    JSON.stringify(assistantEvent("olá — ação ✓ 😀")),
    JSON.stringify(assistantEvent(`first ${"é".repeat(BODY_CAP)}`)),
    JSON.stringify(assistantEvent("çãõ again 🚀")),
    JSON.stringify(assistantEvent(`second ${"ü".repeat(BODY_CAP)}`)),
  ];
  const path = jobLogPath(id, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
  return lines;
}

// The byte offset each line of a log starts at.
function lineOffsets(lines) {
  let next = 0;
  return lines.map((line) => {
    const offset = next;
    next += Buffer.byteLength(line) + 1;
    return offset;
  });
}

// The offsets the capped bodies of a once-only rich narration point at.
async function cappedOffsets(env, id, fromOffset) {
  const events = [];
  await narrateJob({ id, env, rich: true, fromOffset, onEvent: (event) => events.push(event) });
  return events.filter((event) => event.body_truncated).map((event) => event.body_offset);
}

test("the rich once-only narration hands each line its byte offset in the log, multibyte lines included", async (t) => {
  const env = makeHome(t, "narrated-tail-rich-offsets");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  const lines = writeMultibyteLog(env, id);
  const offsets = lineOffsets(lines);
  assert.deepEqual(await cappedOffsets(env, id, 0), [offsets[2], offsets[4]]);
  assert.deepEqual(await cappedOffsets(env, id, offsets[3]), [offsets[4]]);
});

test("without rich the same narration carries no body at all", async (t) => {
  const env = makeHome(t, "narrated-tail-plain-offsets");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  writeMultibyteLog(env, id);
  const events = [];
  await narrateJob({ id, env, onEvent: (event) => events.push(event) });
  assert.equal(events.some((event) => "body" in event || event.kind === "phase"), false);
});
