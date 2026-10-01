import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getDecision, getDecisionByNumber, saveDecision } from "../src/memory/decisions.mjs";
import { addJob, getJob } from "../src/memory/jobs.mjs";
import { getIssue, saveIssue } from "../src/memory/issues.mjs";
import { ensureProject, makeDir, makeHome, makeProject, orgIdOf, projectIdOf, seedDoneJob } from "../test-support/memory.mjs";

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

// A decision of an owner, with only the text every decision needs.
function decision(owner, title) {
  return { ...owner, title, context: `context of ${title}`, decision: `decision of ${title}`, status: "accepted" };
}

// A home with alpha (AP, the cwd) and beta (BT) in org acme (AM), each owner holding decisions and alpha an item, then alpha renamed to NQ and acme to AC.
function makeRefsHome(t, name) {
  const env = makeHome(t, name);
  const cwd = makeProject(t, env, "alpha", { org: "acme" });
  makeProject(t, env, "beta", { org: "acme" });
  const alpha = { projectId: projectIdOf(env, "alpha") };
  saveDecision(decision(alpha, "alpha pins sqlite"), env);
  saveDecision(decision(alpha, "alpha logs as json"), env);
  saveDecision(decision({ projectId: projectIdOf(env, "beta") }, "beta ships weekly"), env);
  saveDecision(decision({ orgId: orgIdOf(env, "acme") }, "every repo runs one node"), env);
  const item = saveIssue({ type: "bug", ...alpha, title: "alpha crashes" }, env);
  ok(env, ["project", "key", "alpha", "NQ"], cwd);
  ok(env, ["org", "key", "acme", "AC"], cwd);
  return { env, cwd, elsewhere: makeDir(t, `${name}-elsewhere`), item };
}

test("issues show and queue add --issue take an item ref, old key included, and refuse an integer", (t) => {
  const { env, cwd, elsewhere, item } = makeRefsHome(t, "cli-refs-items");

  for (const ref of ["NQ-1", "AP-1", "nq-1"]) {
    assert.equal(ok(env, ["issues", "show", ref], elsewhere).split("\n")[0], "NQ-1 [bug] todo p5", ref);
  }
  assert.match(refused(env, ["issues", "show", String(item.id)], elsewhere), /expected an issue ref \(`<KEY>-<number>`\), got `1`/);
  assert.match(refused(env, ["issues", "show", "NQ-7"], elsewhere), /unknown issue `NQ-7`/);

  assert.match(refused(env, ["queue", "add", "--issue", "1"], cwd), /expected an issue ref \(`<KEY>-<number>`\), got `1`/);
  assert.match(ok(env, ["queue", "add", "--issue", "AP-1"], elsewhere), /issue NQ-1 of `alpha` is now `in_progress`/);
  assert.equal(getIssue(item.id, env).status, "in_progress");
});

test("decision show, export and update take a number, `D-<n>` or `<KEY>/D-<n>`, old keys included", (t) => {
  const { env, cwd, elsewhere } = makeRefsHome(t, "cli-refs-decisions");

  assert.match(ok(env, ["decision", "show", "D-1"], cwd), /alpha pins sqlite/);
  assert.match(ok(env, ["decision", "show", "2"], cwd), /alpha logs as json/);
  assert.match(ok(env, ["decision", "show", "AP/D-2"], elsewhere), /alpha logs as json/);
  assert.match(ok(env, ["decision", "show", "nq/d-1", "--project", "alpha"], elsewhere), /alpha pins sqlite/);
  assert.match(ok(env, ["decision", "show", "AM/D-1"], elsewhere), /every repo runs one node[\s\S]*org: acme/);
  assert.match(ok(env, ["decision", "show", "D-1", "--project", "beta"], elsewhere), /beta ships weekly/);
  assert.match(refused(env, ["decision", "show", "D-1"], elsewhere), /no project registered for .*pass --project <name>/);
  assert.match(refused(env, ["decision", "show", "NQ/D-1", "--project", "beta"], elsewhere), /`NQ\/D-1` is a decision of `alpha`, not of `beta`; drop --project\/--org/);
  assert.match(refused(env, ["decision", "show", "NQ/D-9"], elsewhere), /unknown decision `NQ\/D-9`/);
  assert.match(refused(env, ["decision", "show", "J-1"], cwd), /`<number>` expects a positive integer, got `J-1`/);

  const dir = makeDir(t, "cli-refs-export");
  const path = ok(env, ["decision", "export", "AC/D-1", "--dir", dir], elsewhere).trim();
  assert.ok(readFileSync(path, "utf8").includes("Decision AC/D-1 in the acme store."), readFileSync(path, "utf8"));

  assert.match(refused(env, ["decision", "update", "NQ/D-1", "--status", "superseded", "--superseded-by", "BT/D-1"], elsewhere), /belongs to project `beta`, not project `alpha`/);
  ok(env, ["decision", "update", "AP/D-1", "--status", "superseded", "--superseded-by", "D-2"], elsewhere);
  assert.equal(getDecisionByNumber({ projectId: projectIdOf(env, "alpha"), number: 1 }, env).superseded_by, 2);
  ok(env, ["decision", "update", "BT/D-1", "--status", "rejected"], elsewhere);
  assert.equal(getDecision(3, env).status, "rejected");
});

test("decision import names candidates by number or by a ref of the same owner, and refuses a ref of another owner", (t) => {
  const { env, cwd } = makeRefsHome(t, "cli-refs-import");
  const file = join(makeDir(t, "cli-refs-import-file"), "overlap.md");
  writeFileSync(file, "# alpha pins sqlite forever\n\nStatus: Accepted (2026-02-02).\n\n## Context\n\nc\n\n## Decision\n\nd\n");

  assert.match(refused(env, ["decision", "import", file, "--unrelated", "AC/D-1"], cwd), /`AC\/D-1` is not a decision of project `alpha`/);
  assert.match(refused(env, ["decision", "import", file, "--unrelated", "NQ-1"], cwd), /`--unrelated` expects a decision number or ref/);
  assert.match(ok(env, ["decision", "import", file, "--unrelated", "NQ/D-1,2"], cwd), /imported as D-3/);
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
