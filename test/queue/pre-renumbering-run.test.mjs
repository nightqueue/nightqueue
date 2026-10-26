import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob } from "../../src/memory/jobs.mjs";
import { PRE_RENUMBERING_REFUSAL } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { argValue, fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream } from "../../test-support/streams.mjs";

const SLUG = "fix-the-worker";
const PHASES = ["triage", "explore", "architecture", "implementation"];

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit({ args }) {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  if (!(args[0] in answers)) throw new Error(`git ${args[0]} failed`);
  return `${answers[args[0]]}\n`;
}

// Runs one cycle over the job with the git reads and the worktree faked.
function cycle(env, id) {
  return runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit } });
}

// The incident state: a job left `running` by a dead runner, whose resumable run directory holds the given artifacts.
function incident(t, name, files) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), [{ stdout: doneStream(), exitCode: 0 }]);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker", maxAttempts: 3 }, env).id;
  const dir = runDir(projectId, SLUG, env);
  mkdirSync(dir, { recursive: true });
  const phases = PHASES.map((phase, at) => ({ phase, artifact: `0${at + 1}-${phase}.md`, verdict: "ok", at: `2026-01-0${at + 1}T00:00:00Z` }));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ schemaVersion: 1, slug: SLUG, project: "alpha", resumeCount: 0, phases }));
  for (const file of files) writeFileSync(join(dir, file), `## Round 1\n${file}\n`);
  const db = openDb(env);
  db.prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  assert.ok(claimJobById(id, { worker: "elsewhere:1", cap: null }, env), "the incident claim failed");
  db.prepare("UPDATE jobs SET lease_until = datetime('now', '-3600 seconds') WHERE id = ?").run(id);
  return { env, id, dir, planPath };
}

// Every file of a directory with its bytes, to prove nothing in it changed.
function snapshot(dir) {
  return Object.fromEntries(readdirSync(dir).sort().map((file) => [file, readFileSync(join(dir, file), "utf8")]));
}

for (const stale of ["06-runtime.md", "05a-qa-analyst.md"]) {
  test(`a swept job whose run directory holds ${stale} is gated pre-renumbering-run without a spawn, and only a fresh retry starts it over`, async (t) => {
    const { env, id, dir, planPath } = incident(t, `pre-renumbering-${stale.slice(0, 3)}`, [stale]);
    const before = snapshot(dir);
    const report = await cycle(env, id);
    assert.deepEqual(report.processed, [{ id, status: "gated", code: "pre-renumbering-run" }]);
    const gated = getJob(id, env);
    assert.deepEqual({ status: gated.status, code: gated.blocked_code }, { status: "gate", code: "pre-renumbering-run" });
    assert.match(gated.notice_md, /^pre-renumbering-run: run started before the renumbering/);
    assert.match(gated.notice_md, /--fresh/);
    assert.doesNotMatch(gated.notice_md, /\(no note needed\)/);
    assert.equal(fakeCalls(planPath).length, 0, "the runner spawned a pre-renumbering run");
    assert.deepEqual(snapshot(dir), before);

    await assert.rejects(applyRetry({ id, env }), (error) => error.message === PRE_RENUMBERING_REFUSAL);
    assert.deepEqual(getJob(id, env), gated);
    const fresh = await applyRetry({ id, fresh: true, env });
    assert.equal(fresh.job.status, "pending");
    assert.equal(existsSync(dir), false);
    await cycle(env, id);
    assert.equal(fakeCalls(planPath).length, 1, "the fresh retry never reached the agent");
  });
}

test("a swept job whose run directory holds only the new artifacts resumes as before", async (t) => {
  const { env, id, planPath } = incident(t, "pre-renumbering-control", ["05-qa.md", "07-runtime.md"]);
  await cycle(env, id);
  assert.equal(fakeCalls(planPath).length, 1);
  assert.match(argValue(fakeCalls(planPath)[0].argv, "-p"), /Resume from phase: qa/);
  assert.notEqual(getJob(id, env).blocked_code, "pre-renumbering-run");
});

test("`run start` on a run directory of the old numbering refuses with one line and writes nothing", async (t) => {
  const { env, dir } = incident(t, "pre-renumbering-start", ["06-runtime.md"]);
  const before = snapshot(dir);
  const out = [];
  const err = [];
  const io = { env, cwd: process.cwd(), out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } };
  const code = await run(["run", "start", "--project", "alpha", "--slug", SLUG], io).catch((error) => {
    err.push(error.message);
    return 1;
  });
  assert.equal(code, 1);
  assert.deepEqual(err, [`nightqueue: ${PRE_RENUMBERING_REFUSAL}`]);
  assert.deepEqual(out, []);
  assert.deepEqual(snapshot(dir), before);
});
