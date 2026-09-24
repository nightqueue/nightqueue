import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, LEASE_GRACE_S } from "../../src/memory/jobs.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

// Registers a real (and empty) git repository as a project of the home.
function makeGitProject(t, env, name) {
  const path = makeDir(t, `repo-${name}`);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", path]);
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path, name }).config, env);
  return path;
}

// A home with a registered git project and the fake `claude` the runner would spawn.
function makeCliHome(t, name) {
  const env = makeHome(t, name);
  makeGitProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, `${name}-plan`), [{ stdout: doneStream(), exitCode: 0 }]);
  return env;
}

function enqueue(env, prompt = "fix the worker") {
  return addJob({ project: "alpha", prompt }, env).id;
}

// Expires a job's lease well past the grace window, the same runtime-derived shape `doctor` treats as orphaned.
function orphanLease(env, id) {
  const staleSeconds = LEASE_GRACE_S * 2;
  openDb(env).prepare(`UPDATE jobs SET lease_until = datetime('now', '-${staleSeconds} seconds') WHERE id = ?`).run(id);
}

test("queue status does not go silent on a backlog sitting behind an orphaned running job", (t) => {
  const env = makeCliHome(t, "cli-status-orphan-hint");
  const orphaned = enqueue(env, "fix the worker");
  claimJobById(orphaned, { worker: "host:4242", cap: 4 }, env);
  orphanLease(env, orphaned);
  enqueue(env, "fix the parser");

  const result = runCli(env, ["queue", "status"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /running=1/, "the fixture did not land the orphaned job in `running`");
  assert.ok(
    result.stdout.includes("start the batch"),
    `queue status stayed silent about the pending job behind a lease dead for ${LEASE_GRACE_S * 2}s: ${result.stdout}`,
  );
});
