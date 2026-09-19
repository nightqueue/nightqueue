import assert from "node:assert/strict";
import { test } from "node:test";
import { runSessionStart } from "../../src/hooks/session-start.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// Stores one lesson of the project with a realistic-length title and prevention text.
function addLesson(env, { title, prevention }) {
  return saveLesson({ project: "alpha", title, root_cause: `${title} happened during a run`, solution: "fix it at the source", prevention }, env).id;
}

// Stores one accepted decision of the project with a realistic-length title.
function addDecision(env, { title, decision }) {
  return saveDecision({ project: "alpha", title, context: `${title} had to be settled`, decision, status: "accepted" }, env);
}

// A title built from real words, spread across the [min, max] char range the way real ADR titles vary in length.
function realisticTitle(i, min, max) {
  const phrases = [
    "the queue runner claims a job lease before writing any state to the worktree so a crash never leaves two runners on the same job",
    "worktree paths always resolve under the queue home directory, never the repository the operator opened the terminal in",
    "decision numbers are scoped per owner, never global, so a project and its org never collide on the same integer",
    "the session start hook reads from the same store the CLI writes to, no separate cache that can drift out of sync",
    "a lesson is only marked injected after the block that carries it was actually returned to the caller, not before",
    "the roadmap prompt and the session hook share one query for accepted titles so the two never disagree about scope",
    "supersede is refused inside a queue job because a running job cannot see decisions another parallel job just wrote",
    "the gate reviews every overlapping proposed or accepted decision of the same owner before a save is allowed to land",
  ];
  const phrase = phrases[i % phrases.length];
  const suffix = ` (case ${i})`;
  const span = max - min;
  const target = min + (span > 0 ? (i * 17) % (span + 1) : 0);
  const text = `${phrase}${suffix}`;
  return text.length >= target ? text.slice(0, target) : `${text} ${"and it holds under load".repeat(3)}`.slice(0, target);
}

// A prevention text built from real words, 150-400 chars, the way a real lesson's prevention field reads.
function realisticPrevention(i) {
  const base =
    "check the exact call site that builds the value before trusting the type declared in the interface; " +
    "a schemaless store or an external API can return a boolean encoded as the string 'false', which is truthy in JavaScript, " +
    "so require an explicit comparison against the real value instead of relying on coercion at the boundary of the function. ";
  const target = 150 + ((i * 23) % 251);
  const repeated = base.repeat(3);
  return repeated.length >= target ? repeated.slice(0, target) : repeated;
}

// Seeds a project with N accepted decisions (title chars in [titleMin, titleMax]) plus 12 realistic lessons, and returns the session block.
async function buildBlock(t, name, decisionCount, titleMin, titleMax) {
  const env = makeHome(t, name);
  const repo = makeProject(t, env, "alpha");
  for (let i = 0; i < decisionCount; i += 1) {
    addDecision(env, {
      title: realisticTitle(i, titleMin, titleMax),
      decision: `keep this rule in effect for case ${i}, it was settled after a real incident`,
    });
  }
  for (let i = 0; i < 12; i += 1) {
    addLesson(env, {
      title: `a real mistake number ${i} that cost a retry during a past run`,
      prevention: realisticPrevention(i),
    });
  }
  return runSessionStart({ input: { session_id: "s1", cwd: repo }, env });
}

// Documents today's actual scale (this very project carries ~23-24 accepted/proposed decisions per the plan's own measurement):
// at that size the budget still leaves room for lessons, even with titles spanning the full 60-200 char range.
test("at today's realistic decision-log size (23 decisions, titles 60-200 chars) lessons still survive the budget", async (t) => {
  const block = await buildBlock(t, "hook-start-budget-today", 23, 60, 200);
  assert.ok(block.length <= 9000, `the block is ${block.length} characters long`);
  assert.match(block, /\[L\d+\]/, "no lesson line survived even at today's realistic corpus size");
});

// Once the SAME project keeps accumulating accepted decisions (a plausible near-term future, not a synthetic extreme:
// titles stay inside the real 60-200 char range, only the ROW COUNT grows the way a living decision log does),
// the unbounded "## Standing decisions" section eventually consumes the whole 9000-char budget on its own,
// and every lesson line -- including the footer instruction to call lesson_recall -- is silently dropped.
test("once the decision log grows past ~39 rows with realistic long titles, every lesson is silently dropped from the budget", async (t) => {
  const block = await buildBlock(t, "hook-start-budget-grown", 40, 160, 200);
  assert.ok(block.length <= 9000, `the block is ${block.length} characters long`);
  assert.match(
    block,
    /\[L\d+\]/,
    `with 40 accepted decisions (titles 160-200 chars, still inside the realistic 60-200 range) and 12 realistic lessons, ` +
      `the "## Standing decisions" section alone consumed the whole 9000-char budget and no lesson line survived ` +
      `(block length ${block.length}); the plan's own claim that "lessons survive the budget" does not hold as the log grows`,
  );
});
