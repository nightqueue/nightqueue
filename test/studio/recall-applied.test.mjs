import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { jobRecalls } from "../../src/queue/recalls.mjs";
import { saveRunState } from "../../src/queue/resume.mjs";
import { appliedRefs, withApplied } from "../../src/studio/recall-applied.mjs";
import { FIXED_PROJECT_ID, makeDir, makeHome } from "../../test-support/memory.mjs";
import { attemptMarker, toolResultEvent, toolUseEvent } from "../../test-support/streams.mjs";
import { addWorktree, git, publishedCheckout } from "../../test-support/worktrees.mjs";

const SLUG = "fix-the-worker";
const JOB = { project_id: FIXED_PROJECT_ID, slug: SLUG };

// A recall asked at a phase (null for the orchestrator) whose hits carry the given refs.
function recallAt(phase, refs, extra = {}) {
  return { phase, hits: refs.map((ref) => ({ ref, title: ref, score: null, ...extra })) };
}

// A run directory holding the given artifacts, by file name.
function runWith(env, artifacts) {
  const dir = runDir(FIXED_PROJECT_ID, SLUG, env);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(artifacts)) writeFileSync(join(dir, name), text);
  return dir;
}

// A job worktree off a published `main` with one commit whose message cites the given text.
function worktreeCiting(t, message) {
  const { checkout } = publishedCheckout(t, "applied");
  const { path } = addWorktree(checkout, "job", { push: false });
  writeFileSync(join(path, "a.txt"), "one\n");
  git(["-C", path, "add", "a.txt"]);
  git(["-C", path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return path;
}

// A phase_prompt call of the orchestrator for the architect, answering the given decisions and lessons.
function architectPrompt(id, { decisions, lessons }) {
  const prompt = ["## Brief", "- D-58 named by the brief", "## Applicable lessons", ...lessons.map((ref) => `- [${ref}] lesson`), "## Standing decisions", ...decisions.map((ref) => `- ${ref} decision`)].join("\n");
  return [toolUseEvent({ name: "mcp__nightqueue__phase_prompt", id, input: { target: "architect" } }), toolResultEvent({ toolUseId: id, content: [{ type: "text", text: JSON.stringify({ prompt, check: "03" }) }] })];
}

test("each hit lists every artifact citing it, in file order, and the distinct applied refs count once across blocks", async (t) => {
  const env = makeHome(t, "applied-per-hit");
  runWith(env, { "04-implementation.md": "kept D-3", "03-plan.md": "D-3 and L5", "06-verification.md": "nothing" });
  const recalls = [recallAt(3, ["D-3", "L5", "L6"]), recallAt(4, ["D-3"])];
  const applied = await appliedRefs({ job: JOB, recalls, env });
  assert.deepEqual(applied, [[["03-plan.md", "04-implementation.md"], ["03-plan.md"], []], [["04-implementation.md"]]]);
  const answer = withApplied(recalls, applied);
  assert.deepEqual(
    answer.recalls.map((recall) => recall.applied),
    [["D-3", "L5"], ["D-3"]],
  );
  assert.deepEqual(answer.recalls[0].hits[2], { ref: "L6", title: "L6", score: null, applied: [] });
  assert.equal(answer.applied_total, 2);
});

test("a job's three architect phase prompts read as one context block whose five cited decisions are applied", async (t) => {
  const env = makeHome(t, "applied-j150");
  runWith(env, {
    "02-explore.md": "D-60 too early for the architect",
    "03-plan.md": "Unrelated to D-58, D-24, D-7, D-15 and D-57.",
    "04-implementation.md": "Kept D-58.",
  });
  const log = [
    attemptMarker(1),
    ...architectPrompt("p1", { decisions: ["D-7", "D-15", "D-24", "D-60"], lessons: ["L1"] }),
    attemptMarker(2),
    ...architectPrompt("p2", { decisions: ["D-24", "D-57", "D-58"], lessons: ["L2"] }),
    ...architectPrompt("p3", { decisions: ["D-58", "D-61"], lessons: ["L1"] }),
  ]
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  const recalls = await jobRecalls(log);
  assert.deepEqual(
    recalls.map((recall) => [recall.kind, recall.phase, recall.agent, recall.calls]),
    [["context", 3, "architect", 3]],
  );
  const answer = withApplied(recalls, await appliedRefs({ job: JOB, recalls, env }));
  const cited = Object.fromEntries(answer.recalls[0].hits.filter((hit) => hit.applied.length > 0).map((hit) => [hit.ref, hit.applied]));
  assert.deepEqual(cited, {
    "D-7": ["03-plan.md"],
    "D-15": ["03-plan.md"],
    "D-24": ["03-plan.md"],
    "D-57": ["03-plan.md"],
    "D-58": ["03-plan.md", "04-implementation.md"],
  });
  assert.equal(answer.applied_total, 5);
});

test("a hit is applied when an artifact of its phase or later cites its ref; the orchestrator's recalls see every artifact", async (t) => {
  const env = makeHome(t, "applied-artifacts");
  runWith(env, { "00-brief.md": "L5 D-3 everywhere", "01-triage.md": "follow L5 here", "03-plan.md": "keep D-3 in mind." });
  const applied = await appliedRefs({ job: JOB, recalls: [recallAt(3, ["L5", "D-3"]), recallAt(null, ["L5", "D-3"])], env });
  assert.deepEqual(applied, [
    [[], ["03-plan.md"]],
    [["01-triage.md"], ["03-plan.md"]],
  ]);
});

test("a ref only matches as a whole token, and a fallback hit is never applied", async (t) => {
  const env = makeHome(t, "applied-tokens");
  runWith(env, { "01-triage.md": "see L50 and D-34 and src/queue/x.mjs.bak and libsrc/a.mjs and /L9", "02-explore.md": "L7 matters" });
  const recalls = [recallAt(null, ["L5", "D-3", "src/queue/x.mjs", "src/a.mjs", "L9"]), recallAt(null, ["L7"], { via: "fallback" })];
  assert.deepEqual(await appliedRefs({ job: JOB, recalls, env }), [[[], [], [], [], []], [[]]]);
});

test("a path ref is applied when cited as an absolute, ./ or a/ diff path", async (t) => {
  for (const [index, text] of ["Changed /Users/me/repo/src/studio/diffstat.mjs today", "Changed ./src/studio/diffstat.mjs today", "diff --git a/src/studio/diffstat.mjs b/src/studio/diffstat.mjs"].entries()) {
    const env = makeHome(t, `applied-path-${index}`);
    runWith(env, { "04-implementation.md": text });
    assert.deepEqual(await appliedRefs({ job: JOB, recalls: [recallAt(4, ["src/studio/diffstat.mjs"])], env }), [[["04-implementation.md"]]], text);
  }
});

test("a lettered artifact such as 05a- counts as its phase's artifact", async (t) => {
  const env = makeHome(t, "applied-lettered");
  runWith(env, { "05a-qa-analyst.md": "follow L5 here", "04b-notes.md": "and D-3" });
  assert.deepEqual(await appliedRefs({ job: JOB, recalls: [recallAt(5, ["L5", "D-3"])], env }), [[["05a-qa-analyst.md"], []]]);
});

test("a missing run directory, an unsafe slug or no recall answers nothing applied, never a throw", async (t) => {
  const env = makeHome(t, "applied-missing");
  assert.deepEqual(await appliedRefs({ job: JOB, recalls: [recallAt(null, ["L5"])], env }), [[[]]]);
  assert.deepEqual(await appliedRefs({ job: { project_id: FIXED_PROJECT_ID, slug: "../escape" }, recalls: [recallAt(null, ["L5"])], env }), [[[]]]);
  assert.deepEqual(await appliedRefs({ job: JOB, recalls: null, env }), []);
});

test("a ref cited in a commit message of the job's worktree is applied, without running a repo-configured fsmonitor", async (t) => {
  const env = makeHome(t, "applied-commits");
  const path = worktreeCiting(t, "fix: guard the worker (L5)");
  saveRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env, state: { worktree: path } });
  const scratch = makeDir(t, "applied-fsmonitor-scratch");
  const marker = join(scratch, "ran");
  const hook = join(scratch, "hook.sh");
  writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\nprintf '\\0'\n`);
  chmodSync(hook, 0o755);
  git(["-C", path, "config", "core.fsmonitor", hook]);
  const applied = await appliedRefs({ job: JOB, recalls: [recallAt(4, ["L5", "L6"])], env });
  assert.deepEqual(applied, [[["commits"], []]]);
  assert.equal(existsSync(marker), false, "the applied read ran the repo-configured fsmonitor");
});
