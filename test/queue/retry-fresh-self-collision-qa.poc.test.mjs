import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { homeDir, jobLogPath, runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { assistantEvent, noticeText, PR_URL, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => {
    const answer = answers[args[0]];
    if (answer === undefined) throw new Error(`git ${args[0]} failed`);
    return `${answer}\n`;
  };
}

// A run that opens a pull request without ever naming itself, so the job keeps whatever slug the runtime bound before the spawn.
function unnamedDoneStream() {
  return toNdjson([systemInitEvent(), assistantEvent(noticeText(), { messageId: "msg_notice" }), resultEvent({ text: `Done. Pull request: ${PR_URL}` })]);
}

// Enqueues a job and leaves it at the gate, as a runner that stopped to ask a question would.
function gatedJob(env, { slug = "fix-the-worker" } = {}) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env)
    .prepare("UPDATE jobs SET status = 'gate', slug = ?, notice_md = 'why it stopped', finished_at = datetime('now') WHERE id = ?")
    .run(slug, id);
  return id;
}

test("a job whose own run dir survives --fresh as an unremovable symlink moves to -2 and says in its log which directory it skipped", async (t) => {
  const env = makeHome(t, "retry-fresh-self-collision");
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, "retry-fresh-self-collision-plan"), [{ stdout: unnamedDoneStream(), exitCode: 0 }]);

  const id = gatedJob(env, { slug: "fix-the-worker" });

  // The leaf of the run dir is a symlink into a foreign tree: `discardRunDir` refuses it deterministically
  // ("the run directory is not a plain directory"), the same trigger the sibling unit test in
  // test/queue/retry.test.mjs uses for `discardRunDir` in isolation.
  const foreign = join(homeDir(env), "somebody-else");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "important.txt"), "do not delete me\n");
  mkdirSync(join(homeDir(env), "runs", "alpha"), { recursive: true });
  const link = runDir("alpha", "fix-the-worker", env);
  symlinkSync(foreign, link);

  const { runDir: discarded } = await applyRetry({ id, note: "start over", fresh: true, env });
  assert.equal(discarded.status, "kept", "setup failed: the symlink was actually removed by --fresh");
  assert.equal(getJob(id, env).slug, null, "setup failed: --fresh did not clear the slug column");
  assert.equal(existsSync(link), true, "setup failed: the symlink disappeared before the job ran again");

  await runCycle({ jobId: id, env, deps: { gitImpl: fakeGit() } });

  const row = getJob(id, env);
  assert.equal(row.status, "done", `the job did not complete after its own leftover blocked --fresh's cleanup (status=${row.status})`);
  assert.equal(
    row.slug,
    "fix-the-worker-2",
    "the job must move off the leftover `--fresh` could not remove (the runtime never vouched for it) onto the next free variant",
  );
  assert.match(
    readFileSync(jobLogPath(id, env), "utf8"),
    /the run directory `fix-the-worker` already exists on disk and was not created by this run: the job does not take it/,
    "the job moved off its own leftover with nothing in the job log pointing back at the skipped directory",
  );
});
