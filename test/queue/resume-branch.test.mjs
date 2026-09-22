import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { decideResume, readRunState, resumeHandoff } from "../../src/queue/resume.mjs";
import { recordPhaseDone, recordRunFields } from "../../src/queue/run-state.mjs";
import { buildPrompt } from "../../src/queue/spawn.mjs";
import { releaseJobWorktree } from "../../src/queue/worktree.mjs";
import { makeHome } from "../../test-support/memory.mjs";
import { addWorktree, git, gitVars, publishedCheckout } from "../../test-support/worktrees.mjs";

const SLUG = "resume-branch";
const PUBLISHED = `feat/${SLUG}`;
const PR = "https://github.com/acme/api/pull/42";

// A run whose worktree `run pr` renamed and pushed under its published name, recorded the way `run pr` records it now.
function publishedRun(t, name) {
  const { checkout } = publishedCheckout(t, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path: checkout, name: "alpha" }).config, env);
  const worktree = addWorktree(checkout, `feat+${SLUG}`, { push: false });
  git(["-C", worktree.path, "branch", "-m", worktree.branch, PUBLISHED]);
  git(["-C", worktree.path, "push", "-q", "-u", "origin", PUBLISHED]);
  const fields = recordRunFields({ project: "alpha", slug: SLUG, fields: { worktree: worktree.path, branch: PUBLISHED, type: "feature/refactor" }, env });
  assert.equal(fields.status, "written", `setup: ${fields.reason}`);
  const phase = recordPhaseDone({ project: "alpha", slug: SLUG, phase: "triage", artifact: "01-triage.md", verdict: "ok", env });
  assert.equal(phase.status, "written", `setup: ${phase.reason}`);
  return { env, worktree: worktree.path };
}

test("a run whose branch was recorded under its published name still resumes in its worktree, and the handoff names the real branch", (t) => {
  const { env, worktree } = publishedRun(t, "resume-branch-handoff");
  const job = { id: 7, project: "alpha", slug: SLUG, prompt: "do the thing" };
  const state = readRunState({ project: "alpha", slug: SLUG, env });
  const resume = decideResume({ state });

  assert.equal(resume.reuseWorktree, true);
  const handoff = resumeHandoff({ job, resume, state, env });
  assert.equal(handoff.branch, PUBLISHED);
  assert.equal(handoff.worktree, worktree);
  assert.match(buildPrompt({ job, handoff, openPrs: [], env }), new RegExp(`\\nBranch: ${PUBLISHED}\\n`));
});

test("releasing the worktree of a job whose branch was renamed finds it by its path, never by the pre-rename name", async (t) => {
  const { env, worktree } = publishedRun(t, "resume-branch-release");

  const released = await releaseJobWorktree({ job: { project: "alpha", slug: SLUG, pr_url: PR }, env });

  assert.deepEqual(released, { path: worktree, status: "removed" });
  assert.equal(existsSync(worktree), false);
});
