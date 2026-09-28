import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobLogPath, runDir } from "../../src/config/paths.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { provisionalSlug } from "../../src/queue/spawn.mjs";
import { openStore } from "../../src/store/open.mjs";
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

// A run that opens a pull request without ever naming its own slug, so the job keeps whatever
// `withRunSlug` bound it to before the spawn (no mid-run `QUEUE_SLUG:` rebind in the way).
function unnamedDoneStream() {
  return toNdjson([systemInitEvent(), assistantEvent(noticeText(), { messageId: "msg_notice" }), resultEvent({ text: `Done. Pull request: ${PR_URL}` })]);
}

test("Group B: a run directory already on disk before the job's exclusive mkdir is skipped, logged and never adopted", async (t) => {
  const env = makeHome(t, "run-slug-dir-race-qa");
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, "run-slug-dir-race-qa-plan"), [{ stdout: unnamedDoneStream(), exitCode: 0 }]);
  const jobId = addJob({ project: "alpha", prompt: "Investigate the slug directory race window left by a concurrent writer" }, env).id;

  // The run directory is claimed by an exclusive, non-recursive mkdir before the bind, so the only window left is a
  // directory that already exists when the job's mkdir runs. Every `bindRunSlug` call is recorded with whether its
  // directory was there and empty, which is what a directory the job created itself looks like at bind time.
  const racedSlug = provisionalSlug(getJob(jobId, env));
  const racedDir = runDir("alpha", racedSlug, env);
  mkdirSync(racedDir, { recursive: true });
  const poisonPath = join(racedDir, "poison-from-a-concurrent-writer.txt");
  const poison = "written by a party outside the runtime, before the job's mkdir ran\n";
  writeFileSync(poisonPath, poison);
  const store = openStore(env);
  const realBindRunSlug = store.jobs.bindRunSlug;
  const binds = [];
  store.jobs.bindRunSlug = async (id, spec) => {
    const dir = runDir("alpha", spec.candidates[0], env);
    binds.push({ slug: spec.candidates[0], freshlyCreated: existsSync(dir) && readdirSync(dir).length === 0 });
    return realBindRunSlug(id, spec);
  };

  await runCycle({ jobId, env, deps: { gitImpl: fakeGit() } });

  const row = getJob(jobId, env);
  assert.notEqual(row.slug, racedSlug, "the job bound the slug whose directory existed before its mkdir");
  assert.equal(binds.some((bind) => bind.slug === racedSlug), false, "the job tried to bind the slug whose directory was already on disk");
  assert.deepEqual(binds[0], { slug: row.slug, freshlyCreated: true }, "the job's run dir was not a directory it had just created itself");
  assert.notEqual(runDir("alpha", row.slug, env), racedDir, "the job's run dir is the planted directory");
  assert.equal(readFileSync(poisonPath, "utf8"), poison, "the foreign file was modified");
  assert.deepEqual(readdirSync(racedDir), ["poison-from-a-concurrent-writer.txt"], "the job wrote into the planted directory");
  assert.equal(existsSync(join(runDir("alpha", row.slug, env), "poison-from-a-concurrent-writer.txt")), false, "the foreign file appears in the job's own run dir");
  assert.match(
    readFileSync(jobLogPath(jobId, env), "utf8"),
    new RegExp(`the run directory \`${racedSlug}\` already exists on disk and was not created by this run: the job does not take it`),
    "the job log does not name the directory it skipped",
  );
});
