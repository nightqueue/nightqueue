import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gitConfigGuardDir, jobLogPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, failureStream, recordedDone, recordedTermination, SLUG } from "../../test-support/streams.mjs";
import { addWorktree, git, gitVars, publishedCheckout } from "../../test-support/worktrees.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const PLANTER = fileURLToPath(new URL("../../test-support/config-planter.mjs", import.meta.url));

// A git double for the preflight: a clean checkout of the default branch; the worktree and config calls use the real git.
function preflightGit({ args }) {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return `${answers[args[0]] ?? ""}\n`;
}

// Every value of one key of the checkout's shared config, an empty list when absent.
function valuesOf(checkout, key) {
  const answered = spawnSync("git", ["-C", checkout, "config", "--get-all", key], { encoding: "utf8", env: { ...process.env, ...gitVars() } });
  return answered.status === 0 ? answered.stdout.split("\n").slice(0, -1) : [];
}

// A home whose project is a real checkout with two keys set before the claim, and one job whose fake session plants two more.
function makePlantedRun(t, name, attempt) {
  const { checkout } = publishedCheckout(t, name);
  git(["-C", checkout, "config", "core.hooksPath", ".githooks"]);
  git(["-C", checkout, "config", "filter.keep.clean", "cat"]);
  const worktree = addWorktree(checkout, `feat+${name}`);
  const env = { ...makeHome(t, name), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  useFakeClaude(env, makeDir(t, `${name}-plan`), [{ ...attempt, exec: [PLANTER, checkout] }]);
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: SLUG, fields: { worktree: worktree.path }, env });
  return { env, id, checkout };
}

// Asserts the planted keys are gone, the key from before the claim stays, and the job log and `queue status` carry one line per key.
function assertRestored(run) {
  assert.deepEqual(valuesOf(run.checkout, "filter.x.clean"), [], "the planted filter outlived the attempt");
  assert.deepEqual(valuesOf(run.checkout, "core.hooksPath"), [".githooks"], "the changed hooksPath was not restored");
  assert.deepEqual(valuesOf(run.checkout, "filter.keep.clean"), ["cat"], "a key from before the claim was touched");
  const lines = readFileSync(jobLogPath(run.id, run.env), "utf8").split("\n").filter((line) => line.startsWith("git config: "));
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.ok(lines.some((line) => line.startsWith("git config: removed filter.x.clean")), lines.join("\n"));
  assert.ok(lines.some((line) => line.startsWith("git config: restored core.hookspath")), lines.join("\n"));
  const status = spawnSync(process.execPath, [CLI, "queue", "status", String(run.id)], { env: run.env, encoding: "utf8" });
  assert.match(status.stdout, /^git_config$/m, status.stdout + status.stderr);
  assert.match(status.stdout, /^ {2}#1 git config: removed filter\.x\.clean/m, status.stdout);
  assert.match(status.stdout, /^ {2}#1 git config: restored core\.hookspath/m, status.stdout);
  const left = existsSync(gitConfigGuardDir(run.env)) ? readdirSync(gitConfigGuardDir(run.env)).filter((file) => file.endsWith(".json")) : [];
  const holders = left.flatMap((file) => JSON.parse(readFileSync(join(gitConfigGuardDir(run.env), file), "utf8")).holders);
  assert.deepEqual(holders, [], "the snapshot kept a holder after its attempt ended");
}

for (const { ending, status, attempt } of [
  { ending: "done", status: "done", attempt: { stdout: doneStream(), runState: recordedDone(), exitCode: 0 } },
  { ending: "cancelled", status: "cancelled", attempt: { stdout: doneStream({ prUrl: null }), runState: recordedTermination(), exitCode: 0 } },
  { ending: "failed", status: "failed", attempt: { stdout: failureStream(), exitCode: 1 } },
]) {
  test(`an attempt that ends ${ending} restores the driver keys it planted in the shared config`, async (t) => {
    const run = makePlantedRun(t, `rgc-${ending}`, attempt);

    const cycle = await runCycle({ jobId: run.id, env: run.env, deps: { gitImpl: preflightGit, sleepImpl: async () => {} } });

    assert.equal(cycle.processed[0]?.status, status, JSON.stringify(cycle.processed));
    assert.equal(getJob(run.id, run.env).status, status);
    assertRestored(run);
  });
}
