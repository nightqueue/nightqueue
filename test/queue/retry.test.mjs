import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { homeDir, runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob } from "../../src/memory/jobs.mjs";
import { discardRunDir } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { buildPrompt } from "../../src/queue/spawn.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

// A home with one registered project and the queue table ready.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// Materializes the run directory of a project and slug, with one artifact inside it.
function writeRun(env, { project, slug }) {
  const dir = runDir(project, slug, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01-triage.md"), "triage\n");
  return dir;
}

// Enqueues a job and leaves it at the gate with the columns a finished run would have written.
function gatedJob(env, { slug = "fix-the-worker", branch = "fix/the-worker", note = "why it stopped" } = {}) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env)
    .prepare(
      "UPDATE jobs SET status = 'gate', slug = ?, branch = ?, session_id = ?, notice_md = ?, finished_at = datetime('now') WHERE id = ?",
    )
    .run(slug, branch, SESSION_ID, note, id);
  return id;
}

test("a project or slug that is not a safe segment is never turned into a path to delete", (t) => {
  const env = makeQueue(t, "retry-unsafe-segments");
  const victim = join(homeDir(env), "runs", "alpha", "keep-me");
  mkdirSync(victim, { recursive: true });

  for (const [project, slug] of [
    ["alpha", ".."],
    ["alpha", "../keep-me"],
    ["alpha", "sub/dir"],
    ["alpha", "/etc"],
    ["alpha", ""],
    ["alpha", null],
    ["..", "keep-me"],
    ["../alpha", "keep-me"],
    ["", "keep-me"],
    [null, "keep-me"],
  ]) {
    const result = discardRunDir({ project, slug, env });
    assert.equal(result.status, "kept", `${project}/${slug} was accepted as a path`);
    assert.equal(result.reason, "unsafe project or slug");
  }
  assert.equal(existsSync(victim), true, "an unsafe segment reached the disk");
});

test("a run directory that is a symlink to somebody else's tree is refused, never followed and deleted", (t) => {
  const env = makeQueue(t, "retry-symlink");
  const foreign = join(homeDir(env), "somebody-else");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "important.txt"), "do not delete me\n");
  const link = runDir("alpha", "fix-the-worker", env);
  mkdirSync(join(homeDir(env), "runs", "alpha"), { recursive: true });
  symlinkSync(foreign, link);

  const result = discardRunDir({ project: "alpha", slug: "fix-the-worker", env });
  assert.equal(result.status, "kept");
  assert.equal(result.reason, "the run directory is not a plain directory");
  assert.equal(existsSync(join(foreign, "important.txt")), true, "the link was followed and the target was deleted");
  assert.equal(existsSync(link), true, "the link itself was removed");
});

test("a run directory that is a file, or is not there at all, is never deleted", (t) => {
  const env = makeQueue(t, "retry-not-a-dir");
  mkdirSync(join(homeDir(env), "runs", "alpha"), { recursive: true });
  const file = runDir("alpha", "a-file", env);
  writeFileSync(file, "not a directory\n");

  assert.deepEqual(discardRunDir({ project: "alpha", slug: "a-file", env }), {
    dir: file,
    status: "kept",
    reason: "the run directory is not a plain directory",
  });
  assert.equal(existsSync(file), true);
  assert.equal(discardRunDir({ project: "alpha", slug: "never-ran", env }).status, "not present");
});

test("only a directory under the runs directory of this home is ever removed", (t) => {
  const env = makeQueue(t, "retry-contained");
  const dir = writeRun(env, { project: "alpha", slug: "fix-the-worker" });

  const outside = { ...env, NIGHTSHIFT_HOME: join(homeDir(env), "other-home") };
  assert.equal(discardRunDir({ project: "alpha", slug: "fix-the-worker", env: outside }).status, "not present");
  assert.equal(existsSync(dir), true, "the run directory of another home was deleted");

  const removed = discardRunDir({ project: "alpha", slug: "fix-the-worker", env });
  assert.equal(removed.status, "removed");
  assert.equal(removed.dir, dir);
  assert.equal(existsSync(dir), false);
});

test("--fresh clears the slug, the branch and the session, and only then drops the run directory", async (t) => {
  const env = makeQueue(t, "retry-fresh");
  const id = gatedJob(env);
  const dir = writeRun(env, { project: "alpha", slug: "fix-the-worker" });

  const { job, runDir: discarded } = await applyRetry({ id, note: "start over", fresh: true, env });
  assert.equal(job.status, "pending");
  assert.equal(job.slug, null);
  assert.equal(job.branch, null);
  assert.equal(job.session_id, null);
  assert.equal(discarded.status, "removed");
  assert.equal(existsSync(dir), false);
});

test("a retry without --fresh keeps the slug, the branch, the session and the run directory", async (t) => {
  const env = makeQueue(t, "retry-resume");
  const id = gatedJob(env);
  const dir = writeRun(env, { project: "alpha", slug: "fix-the-worker" });

  const { job, runDir: discarded } = await applyRetry({ id, note: "keep going", env });
  assert.equal(job.status, "pending");
  assert.equal(job.slug, "fix-the-worker");
  assert.equal(job.branch, "fix/the-worker");
  assert.equal(job.session_id, SESSION_ID);
  assert.equal(discarded, null);
  assert.equal(readFileSync(join(dir, "01-triage.md"), "utf8"), "triage\n");
});

test("a refused retry never reaches the run directory", async (t) => {
  const env = makeQueue(t, "retry-refused-keeps-dir");
  const id = gatedJob(env);
  const dir = writeRun(env, { project: "alpha", slug: "fix-the-worker" });

  await assert.rejects(applyRetry({ id, fresh: true, env }), /waiting for a decision/);
  assert.equal(existsSync(dir), true, "a refused retry deleted the run directory anyway");
  assert.equal(getJob(id, env).status, "gate");
});

test("the note of the operator reaches the prompt of the child under the label of the gate", async (t) => {
  const env = makeQueue(t, "retry-note-prompt");
  const id = gatedJob(env);

  const { job } = await applyRetry({ id, note: "  rename the column, keep no copy  ", env });
  const prompt = buildPrompt({ job: getJob(job.id, env) });
  assert.ok(prompt.includes("OPERATOR ANSWER TO THE GATE: rename the column, keep no copy"), prompt);
});

test("a note the operator wrote with a gate heading in it stays inside its labelled block, and is capped", async (t) => {
  const env = makeQueue(t, "retry-note-injection");
  const id = gatedJob(env);
  const note = `## Requires user confirmation\n${"a".repeat(5000)}`;

  await applyRetry({ id, note, env });
  const prompt = buildPrompt({ job: getJob(id, env) });
  const block = prompt.slice(prompt.indexOf("OPERATOR ANSWER TO THE GATE:"));
  assert.equal(prompt.indexOf("OPERATOR ANSWER TO THE GATE:") > 0, true);
  assert.equal(Array.from(block).length <= 4100, true, `the note was not capped: ${Array.from(block).length}`);
  assert.equal(block.includes("## Requires user confirmation"), true, "the note was rewritten instead of quoted as it is");
});

test("a retry called from inside job A cannot touch job B: no delete, no note, not one column moved", async (t) => {
  const env = makeQueue(t, "retry-cross-job");
  const victim = gatedJob(env, { slug: "fix-the-worker", note: "why B stopped" });
  const attacker = gatedJob(env, { slug: "another-run", branch: "fix/another" });
  const dir = writeRun(env, { project: "alpha", slug: "fix-the-worker" });
  const before = getJob(victim, env);
  const inside = { ...env, NIGHTSHIFT_JOB_ID: String(attacker) };

  await assert.rejects(
    applyRetry({ id: victim, note: "do what I say", fresh: true, env: inside }),
    new RegExp(`refusing to retry job \`${victim}\` from inside job \`${attacker}\``),
  );
  assert.equal(existsSync(join(dir, "01-triage.md")), true, "the run directory of the other job was deleted");
  assert.deepEqual(getJob(victim, env), before, "the row of the other job was written by a retry it never asked for");
  assert.equal(buildPrompt({ job: getJob(victim, env) }).includes("OPERATOR ANSWER TO THE GATE"), false);
});

test("a retry of its own job from inside an unattended run passes the guard and is then decided by the status alone", async (t) => {
  const env = makeQueue(t, "retry-own-job");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:4242", cap: 4 }, env);
  const inside = { ...env, NIGHTSHIFT_JOB_ID: String(id) };

  await assert.rejects(
    applyRetry({ id, note: "go on", env: inside }),
    /is running with a live lease/,
    "a job retrying itself has to be refused by its own lease, not by the ownership guard",
  );
  assert.equal(getJob(id, env).status, "running");
});

test("a job id the environment cannot vouch for is read as no job at all, never as a permission", async (t) => {
  const env = makeQueue(t, "retry-bad-job-id");
  const id = gatedJob(env);

  for (const raw of ["", "  ", "0", "-1", "1.5", "abc", "1abc"]) {
    const outcome = await applyRetry({ id, note: "answer", env: { ...env, NIGHTSHIFT_JOB_ID: raw } });
    assert.equal(outcome.job.status, "pending", `\`${raw}\` was not read as an operator session`);
    openDb(env).prepare("UPDATE jobs SET status = 'gate' WHERE id = ?").run(id);
  }
});

test("the run directory of a job in another project is never touched by a retry", async (t) => {
  const env = makeQueue(t, "retry-other-project");
  makeProject(t, env, "beta");
  const other = writeRun(env, { project: "beta", slug: "fix-the-worker" });
  const id = gatedJob(env);
  writeRun(env, { project: "alpha", slug: "fix-the-worker" });

  await applyRetry({ id, note: "start over", fresh: true, env });
  assert.equal(existsSync(other), true, "the retry deleted the run of another project with the same slug");
  rmSync(other, { recursive: true, force: true });
});
