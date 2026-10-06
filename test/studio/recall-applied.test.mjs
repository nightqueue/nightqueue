import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { saveRunState } from "../../src/queue/resume.mjs";
import { appliedRefs } from "../../src/studio/recall-applied.mjs";
import { FIXED_PROJECT_ID, makeDir, makeHome } from "../../test-support/memory.mjs";
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

test("a hit is applied when an artifact of its phase or later cites its ref; the orchestrator's recalls see every artifact", async (t) => {
  const env = makeHome(t, "applied-artifacts");
  runWith(env, { "00-brief.md": "L5 D-3 everywhere", "01-triage.md": "follow L5 here", "03-plan.md": "keep D-3 in mind." });
  const applied = await appliedRefs({ job: JOB, recalls: [recallAt(3, ["L5", "D-3"]), recallAt(null, ["L5", "D-3"])], env });
  assert.deepEqual(applied, [["D-3"], ["L5", "D-3"]]);
});

test("a ref only matches as a whole token, and a fallback hit is never applied", async (t) => {
  const env = makeHome(t, "applied-tokens");
  runWith(env, { "01-triage.md": "see L50 and D-34 and src/queue/x.mjs.bak and libsrc/a.mjs and /L9", "02-explore.md": "L7 matters" });
  const recalls = [recallAt(null, ["L5", "D-3", "src/queue/x.mjs", "src/a.mjs", "L9"]), recallAt(null, ["L7"], { via: "fallback" })];
  assert.deepEqual(await appliedRefs({ job: JOB, recalls, env }), [[], []]);
});

test("a path ref is applied when cited as an absolute, ./ or a/ diff path", async (t) => {
  for (const [index, text] of ["Changed /Users/me/repo/src/studio/diffstat.mjs today", "Changed ./src/studio/diffstat.mjs today", "diff --git a/src/studio/diffstat.mjs b/src/studio/diffstat.mjs"].entries()) {
    const env = makeHome(t, `applied-path-${index}`);
    runWith(env, { "04-implementation.md": text });
    assert.deepEqual(await appliedRefs({ job: JOB, recalls: [recallAt(4, ["src/studio/diffstat.mjs"])], env }), [["src/studio/diffstat.mjs"]], text);
  }
});

test("a lettered artifact such as 05a- counts as its phase's artifact", async (t) => {
  const env = makeHome(t, "applied-lettered");
  runWith(env, { "05a-qa-analyst.md": "follow L5 here", "04b-notes.md": "and D-3" });
  assert.deepEqual(await appliedRefs({ job: JOB, recalls: [recallAt(5, ["L5", "D-3"])], env }), [["L5"]]);
});

test("a missing run directory, an unsafe slug or no recall answers nothing applied, never a throw", async (t) => {
  const env = makeHome(t, "applied-missing");
  assert.deepEqual(await appliedRefs({ job: JOB, recalls: [recallAt(null, ["L5"])], env }), [[]]);
  assert.deepEqual(await appliedRefs({ job: { project_id: FIXED_PROJECT_ID, slug: "../escape" }, recalls: [recallAt(null, ["L5"])], env }), [[]]);
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
  assert.deepEqual(applied, [["L5"]]);
  assert.equal(existsSync(marker), false, "the applied read ran the repo-configured fsmonitor");
});
