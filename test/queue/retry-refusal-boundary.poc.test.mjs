import assert from "node:assert/strict";
import { test } from "node:test";
import { addJob, claimJobById, finishJob, retryJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// H3 (QA analyst, Group 2): the 500-code-point cut of `retryRefusal` /
// `jobView`'s `notice_md` (src/memory/jobs.mjs:517-527, :166, :133). Every case
// below was run against the current code; none of them broke, so this file stays
// as a boundary regression test that PASSES — it pins the exact off-by-one
// behavior so a future change to `VIEW_TEXT_LIMIT`/`truncateByCodePoint`
// composition cannot silently move it.

// A home with one project and the queue table ready.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// A gated job whose recorded notice is exactly the text given (or absent when null).
function makeGatedJob(env, notice) {
  const id = addJob({ project: "alpha", prompt: "fix" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  finishJob(id, { worker: "host:1", status: "gate", noticeMd: notice }, env);
  return id;
}

// The message of the `UserError` a bare retry (no note) on a gated job throws.
function refusalMessage(id, env) {
  try {
    retryJob(id, {}, env);
  } catch (err) {
    return err.message;
  }
  throw new Error("retryJob did not refuse a bare retry on a gated job");
}

test("a notice of exactly 500 code points is quoted whole in the refusal, no pointer", (t) => {
  const env = makeQueue(t, "retry-boundary-500");
  const notice = "a".repeat(500);
  const id = makeGatedJob(env, notice);
  const message = refusalMessage(id, env);
  assert.equal(message, `${notice}\nThis job is waiting for a decision. Re-run with --note "<your answer>".`);
});

test("a notice of 501 code points is cut at exactly 500, with the exact pointer sentence", (t) => {
  const env = makeQueue(t, "retry-boundary-501");
  const notice = "a".repeat(501);
  const id = makeGatedJob(env, notice);
  const message = refusalMessage(id, env);
  const expected = [
    `${"a".repeat(500)}...`,
    `Read the whole notice with: nightshift queue status ${id}.`,
    'This job is waiting for a decision. Re-run with --note "<your answer>".',
  ].join("\n");
  assert.equal(message, expected);
});

test("a gated job with no recorded notice never prints `null` or `undefined`", (t) => {
  const env = makeQueue(t, "retry-boundary-null");
  const id = addJob({ project: "alpha", prompt: "fix" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  finishJob(id, { worker: "host:1", status: "gate" }, env);
  const message = refusalMessage(id, env);
  assert.equal(message, 'This job is waiting for a decision. Re-run with --note "<your answer>".');
  assert.equal(/\bnull\b/i.test(message), false, message);
  assert.equal(/\bundefined\b/i.test(message), false, message);
});

test("a 500-code-point astral notice is quoted whole, and a 501-code-point one is cut without corrupting a surrogate", (t) => {
  const env = makeQueue(t, "retry-boundary-astral");
  const emoji = "\u{1F600}";

  const idExact = makeGatedJob(env, emoji.repeat(500));
  const exactMessage = refusalMessage(idExact, env);
  assert.equal(exactMessage, `${emoji.repeat(500)}\nThis job is waiting for a decision. Re-run with --note "<your answer>".`);

  const idOver = makeGatedJob(env, emoji.repeat(501));
  const overMessage = refusalMessage(idOver, env);
  const expectedOver = [
    `${emoji.repeat(500)}...`,
    `Read the whole notice with: nightshift queue status ${idOver}.`,
    'This job is waiting for a decision. Re-run with --note "<your answer>".',
  ].join("\n");
  assert.equal(overMessage, expectedOver);
  assert.equal(overMessage.includes("�"), false, "a lone surrogate half surfaced as a replacement character");
});
