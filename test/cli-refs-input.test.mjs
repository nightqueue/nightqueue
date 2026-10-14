import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addJob, getJob, listJobs } from "../src/memory/jobs.mjs";
import { ensureProject, makeDir, makeHome, makeProject, seedDoneJob } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
}

// Runs a command that must succeed, and answers its stdout.
function ok(env, args, cwd) {
  const result = runCli(env, args, cwd);
  assert.equal(result.status, 0, `\`${args.join(" ")}\` failed: ${result.stderr}`);
  return result.stdout;
}

// Runs a command that must fail, and answers its stderr.
function refused(env, args, cwd) {
  const result = runCli(env, args, cwd);
  assert.equal(result.status, 1, `\`${args.join(" ")}\` did not fail: ${result.stdout}`);
  return result.stderr;
}

// A home with alpha (AP, the cwd) and beta (BT) in org acme (AM), then alpha renamed to NQ and acme to AC.
function makeRefsHome(t, name) {
  const env = makeHome(t, name);
  const cwd = makeProject(t, env, "alpha", { org: "acme" });
  makeProject(t, env, "beta", { org: "acme" });
  ok(env, ["project", "key", "alpha", "NQ"], cwd);
  ok(env, ["org", "key", "acme", "AC"], cwd);
  return { env, cwd, elsewhere: makeDir(t, `${name}-elsewhere`) };
}

test("`nightqueue issues` is an unknown command and `queue add --issue` an unknown option, and nothing is queued", (t) => {
  const { env, cwd, elsewhere } = makeRefsHome(t, "cli-refs-items");

  assert.match(refused(env, ["issues"], elsewhere), /unknown command `issues`/);
  assert.match(refused(env, ["issues", "show", "NQ-1"], elsewhere), /unknown command `issues`/);
  assert.match(refused(env, ["queue", "add", "--issue", "AP-1"], cwd), /Unknown option '--issue'/);
  assert.match(refused(env, ["queue", "add", "fix the crash", "--issue"], cwd), /Unknown option '--issue'/);
  assert.deepEqual(listJobs({}, env), [], "a refused `queue add` queued a job");
});

test("`nightqueue decision` is an unknown command, whatever its subcommand", (t) => {
  const { env, cwd } = makeRefsHome(t, "cli-refs-decisions");

  for (const sub of ["list", "show", "export", "import", "update"]) {
    assert.match(refused(env, ["decision", sub, "D-1"], cwd), /unknown command `decision`/, sub);
  }
});

test("every queue command that names a job takes its ref or its plain id, and refuses anything else", (t) => {
  const env = makeHome(t, "cli-refs-jobs");
  const cwd = makeProject(t, env, "alpha");
  const { id } = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env);

  assert.match(ok(env, ["queue", "status", `J-${id}`, "--json"], cwd), new RegExp(`"id":${id}`));
  assert.match(ok(env, ["queue", "status", String(id), "--json"], cwd), new RegExp(`"id":${id}`));
  for (const args of [
    ["queue", "status", "AP-1"],
    ["queue", "run", "--job", "J-x"],
    ["queue", "close", "D-1"],
    ["queue", "repair", "one"],
    ["queue", "log", "J-"],
    ["queue", "session", "NQ-1"],
  ]) {
    assert.match(refused(env, args, cwd), /expected a job ref \(`J-<id>`\) or a job id, got `/, args.join(" "));
  }
  assert.match(refused(env, ["queue", "log", `J-${id}`], cwd), new RegExp(`no log for job \`${id}\``));
  assert.match(refused(env, ["queue", "close", `j-${id}`], cwd), /pending/);
  ok(env, ["queue", "cancel", `J-${id}`], cwd);
  assert.equal(getJob(id, env).status, "cancelled");
  ok(env, ["queue", "retry", `J-${id}`], cwd);
  assert.equal(getJob(id, env).status, "pending");
});

test("queue status <PR URL> finds the one job that opened it, and refuses none, several and a URL that is no pull request", (t) => {
  const env = makeHome(t, "cli-refs-pr-url");
  const cwd = makeProject(t, env, "alpha");
  const one = seedDoneJob(env, { prUrl: "https://github.com/Acme/api/pull/7" });
  seedDoneJob(env, { prUrl: "https://github.com/acme/api/pull/77" });
  const twins = [seedDoneJob(env, { prUrl: "https://github.com/acme/api/pull/9" }), seedDoneJob(env, { prUrl: "https://github.com/acme/api/pull/9/files" })];

  for (const url of ["https://github.com/Acme/api/pull/7", "https://github.com/acme/api/pull/7/", "https://github.com/acme/api/pull/7/files"]) {
    assert.equal(JSON.parse(ok(env, ["queue", "status", url, "--json"], cwd)).job.id, one, url);
  }
  assert.match(
    refused(env, ["queue", "status", "https://github.com/acme/api/pull/9"], cwd),
    new RegExp(`was opened by more than one job: J-${twins[0]}, J-${twins[1]}; pass one of them`),
  );
  assert.match(refused(env, ["queue", "status", "https://github.com/acme/api/pull/8"], cwd), /no job opened `https:\/\/github.com\/acme\/api\/pull\/8`/);
  assert.match(refused(env, ["queue", "status", "https://example.com/acme/api/pull/7"], cwd), /not a GitHub pull request URL: `https:\/\/example.com\/acme\/api\/pull\/7`/);
});
