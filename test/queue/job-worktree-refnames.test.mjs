import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { jobWorktreePath } from "../../src/config/paths.mjs";
import { runGitAsync } from "../../src/host/git.mjs";
import { prepareJobWorktree, WORKTREE_FAILED, worktreeSlotFree } from "../../src/queue/job-worktree.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { FIXED_PROJECT_ID, makeDir, makeHome } from "../../test-support/memory.mjs";
import { git, gitVars, localBranches, registeredWorktrees } from "../../test-support/worktrees.mjs";

const SLUG = "start-the-work";
const NEVER = "does not exist and never can: git does not accept that name; nothing was changed; cancel this job and queue the work on a valid branch";

// A fresh home and repository for one placement.
function fixture(t, name) {
  return { env: { ...makeHome(t, name), ...gitVars() }, checkout: initGitRepo(makeDir(t, `${name}-repo`)) };
}

// The placement of a job queued on the given start branch, or of a plain one when there is none.
async function prepare({ env, checkout }, { startBranch = null, gitImpl = runGitAsync } = {}) {
  const job = { id: 7, project_id: FIXED_PROJECT_ID, slug: SLUG, start_branch: startBranch, start_worktree: null };
  const logged = [];
  const placed = await prepareJobWorktree({ job, checkout, baseBranch: "main", env, gitImpl, log: (line) => logged.push(line) });
  return { ...placed, logged };
}

// A git double answering the given commands with the given exit codes, the real git for the others.
function gitAnswering(answers) {
  return (call) => {
    const exitCode = answers[call.args[0]];
    return exitCode === undefined ? runGitAsync(call) : Promise.resolve({ ok: false, stdout: "", stderr: "fatal: odd", exitCode });
  };
}

for (const name of ["a..b", "x.lock", "-x", "a b", "@{u}"]) {
  test(`a start branch ${JSON.stringify(name)} is refused once, quoted, never as a retry, and nothing is created`, async (t) => {
    const place = fixture(t, `refname-${name.replace(/\W/g, "_")}`);

    const refused = await prepare(place, { startBranch: name });

    assert.equal(refused.code, WORKTREE_FAILED);
    assert.equal(refused.message, `the branch \`${name}\` ${NEVER}`);
    assert.doesNotMatch(refused.message, /retry/);
    assert.equal(refused.fresh, undefined);
    assert.deepEqual(registeredWorktrees(place.checkout), []);
    assert.equal(existsSync(jobWorktreePath(FIXED_PROJECT_ID, SLUG, place.env)), false);
  });
}

test("a lookup answered 128 for a name git says it cannot parse gives the same refusal, not a retry", async (t) => {
  const refused = await prepare(fixture(t, "refname-format-1"), { startBranch: "feat/x", gitImpl: gitAnswering({ "rev-parse": 128, "check-ref-format": 1 }) });

  assert.equal(refused.code, WORKTREE_FAILED);
  assert.ok(refused.message.includes(`the branch \`feat/x\` ${NEVER}`), refused.message);
  assert.doesNotMatch(refused.message, /retry/);
});

test("a lookup answered 128 with the format check unanswered too stays a read failure to retry", async (t) => {
  const refused = await prepare(fixture(t, "refname-format-128"), { startBranch: "feat/x", gitImpl: gitAnswering({ "rev-parse": 128, "check-ref-format": 128 }) });

  assert.equal(refused.code, WORKTREE_FAILED);
  assert.match(refused.message, /git could not read refs\/heads\/feat\/x in .*; retry/);
});

test("a rung git says it cannot parse stops the ladder at once instead of being skipped", async (t) => {
  const place = fixture(t, "refname-rung");
  git(["-C", place.checkout, "branch", `worktree-${SLUG}`]);
  const asked = [];
  const gitImpl = (call) => {
    if (call.args[0] === "check-ref-format") return Promise.resolve({ ok: false, stdout: "", stderr: "", exitCode: 1 });
    if (call.args[0] === "rev-parse" && String(call.args[3]).includes(`worktree-${SLUG}-`)) {
      asked.push(call.args[3]);
      return Promise.resolve({ ok: false, stdout: "", stderr: "fatal: odd", exitCode: 128 });
    }
    return runGitAsync(call);
  };

  const refused = await prepare(place, { gitImpl });

  assert.equal(refused.code, WORKTREE_FAILED);
  assert.match(refused.message, new RegExp(`the branch \`worktree-${SLUG}-2\` does not exist and never can`));
  assert.equal(asked.some((ref) => ref.includes(`worktree-${SLUG}-3`)), false, asked.join(", "));
  assert.deepEqual(localBranches(place.checkout).filter((branch) => branch.startsWith(`worktree-${SLUG}-`)), []);
});

test("the slot check logs a name git cannot parse and answers not free, never throwing", async (t) => {
  const { env, checkout } = fixture(t, "refname-slot");
  const logged = [];

  const free = await worktreeSlotFree({ projectId: FIXED_PROJECT_ID, slug: SLUG, checkout, env, gitImpl: gitAnswering({ "rev-parse": 128, "check-ref-format": 1 }), log: (line) => logged.push(line) });

  assert.equal(free, false);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /never can/);
});
