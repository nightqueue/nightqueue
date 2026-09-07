import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { dbPath, queuePausedPath, secretsPath } from "../src/config/paths.mjs";
import { ensureHome } from "../src/config/store.mjs";
import { closeDb, openDb } from "../src/memory/db.mjs";
import { addJob, claimJobById } from "../src/memory/jobs.mjs";
import { saveLesson } from "../src/memory/lessons.mjs";
import { makeHostEnv } from "../test-support/host.mjs";
import { makeDir, makeProject } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/shift.mjs", import.meta.url));

// Subprocess runner that answers for `gh` instead of asking the real one, keeping the diagnosis hermetic.
function withFakeGh(authenticated) {
  return (file, args, options) => {
    if (file !== "gh") return spawnSync(file, args, options);
    return authenticated ? { status: 0, stdout: "Logged in", stderr: "" } : { status: 1, stdout: "", stderr: "no token" };
  };
}

// Runs the diagnosis in process and returns the parsed report plus the exit code.
async function diagnose(env, overrides = {}) {
  const out = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: () => {},
    spawnSyncImpl: withFakeGh(true),
    ...overrides,
  };
  const code = await run(["doctor", "--json"], ctx);
  assert.equal(out.length, 1, out.join("\n"));
  return { code, report: JSON.parse(out[0]), lines: out };
}

// Status of one check of the report.
function statusOf(report, name) {
  const found = report.checks.find((check) => check.name === name);
  assert.ok(found, `no check named ${name} in ${report.checks.map((check) => check.name).join(", ")}`);
  return found.status;
}

test("a host that went through setup has no failing check", async (t) => {
  const host = makeHostEnv(t, "doctor-ok");
  await run(["setup", "--no-model"], { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });

  const { code, report } = await diagnose(host.env);
  assert.equal(code, 0);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.filter((check) => check.status === "fail"), []);
  assert.equal(statusOf(report, "node"), "ok");
  assert.equal(statusOf(report, "claude"), "ok");
  assert.equal(statusOf(report, "gh"), "ok");
  assert.equal(statusOf(report, "config"), "ok");
  assert.equal(statusOf(report, "secrets"), "ok");
  assert.equal(statusOf(report, "mcp"), "ok");
  assert.equal(statusOf(report, "hook SessionStart"), "ok");
  assert.equal(statusOf(report, "hook UserPromptSubmit"), "ok");
  assert.equal(statusOf(report, "hook SessionEnd"), "ok");
  assert.equal(statusOf(report, "plugin"), "ok");
  assert.equal(statusOf(report, "model"), "warn");
  assert.equal(statusOf(report, "projects"), "warn");
  assert.equal(statusOf(report, "database"), "warn");
});

test("a home that never went through setup fails and exits 1", async (t) => {
  const host = makeHostEnv(t, "doctor-virgin");
  const { code, report } = await diagnose(host.env, { spawnSyncImpl: withFakeGh(false) });

  assert.equal(code, 1);
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "config"), "fail");
  assert.equal(statusOf(report, "secrets"), "fail");
  assert.equal(statusOf(report, "mcp"), "fail");
  assert.equal(statusOf(report, "hook SessionStart"), "fail");
  assert.equal(statusOf(report, "hook UserPromptSubmit"), "fail");
  assert.equal(statusOf(report, "hook SessionEnd"), "fail");
  assert.equal(statusOf(report, "plugin"), "fail");
  assert.equal(statusOf(report, "gh"), "warn");
  for (const check of report.checks) {
    if (check.status !== "ok") assert.ok(check.hint, `check ${check.name} has no hint`);
  }
});

test("the diagnosis writes nothing at all: no database, no settings, no home", async (t) => {
  const host = makeHostEnv(t, "doctor-readonly");
  await diagnose(host.env);
  assert.equal(existsSync(dbPath(host.env)), false);
  assert.equal(existsSync(host.settingsPath), false);
  assert.deepEqual(host.calls().filter((call) => call[0] !== "--version"), []);
});

test("a claude CLI that cannot run is the only failure of an otherwise clean host", async (t) => {
  const host = makeHostEnv(t, "doctor-no-claude");
  await run(["setup", "--no-model"], { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  host.env.NIGHTSHIFT_CLAUDE_BIN = join(host.configDir, "does-not-exist");

  const { code, report } = await diagnose(host.env);
  assert.equal(code, 1);
  assert.equal(statusOf(report, "claude"), "fail");
  assert.match(report.checks.find((check) => check.name === "claude").hint, /NIGHTSHIFT_CLAUDE_BIN/);
});

test("secrets more open than 0600 and a project that moved away are reported as failures", async (t) => {
  const host = makeHostEnv(t, "doctor-fixtures");
  await run(["setup", "--no-model"], { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  chmodSync(secretsPath(host.env), 0o644);
  const repo = makeProject(t, host.env, "alpha");
  const gone = makeProject(t, host.env, "beta");
  rmSync(gone, { recursive: true, force: true });

  const { code, report } = await diagnose(host.env);
  assert.equal(code, 1);
  assert.equal(statusOf(report, "secrets"), "fail");
  assert.equal(statusOf(report, "project beta"), "fail");
  assert.equal(statusOf(report, "project alpha"), "warn");
  assert.match(report.checks.find((check) => check.name === "project alpha").detail, /git did not answer|uncommitted/);
  assert.ok(existsSync(repo));
});

test("the database check reads the schema version of an existing database", async (t) => {
  const host = makeHostEnv(t, "doctor-db");
  saveLesson(
    {
      project: null,
      title: "the worker leaks a file descriptor",
      root_cause: "the early return skipped the close",
      solution: "close it in a finally block",
      prevention: "always close the descriptor in a finally block",
    },
    host.env,
  );
  closeDb(host.env);

  const { report } = await diagnose(host.env);
  assert.equal(statusOf(report, "database"), "ok");
  assert.match(report.checks.find((check) => check.name === "database").detail, /schema v2/);
});

test("the queue check reads the pause sentinel of the home, and a paused queue is a warning", async (t) => {
  const host = makeHostEnv(t, "doctor-queue-pause");
  const { report: running } = await diagnose(host.env);
  assert.equal(statusOf(running, "queue"), "ok");

  ensureHome(host.env);
  writeFileSync(queuePausedPath(host.env), "");

  const { report: paused } = await diagnose(host.env);
  assert.equal(statusOf(paused, "queue"), "warn");
  const check = paused.checks.find((entry) => entry.name === "queue");
  assert.equal(check.detail, "paused");
  assert.match(check.hint, /shift queue resume/);
});

test("the queue jobs check counts the jobs whose runner died, and only once the database exists", async (t) => {
  const host = makeHostEnv(t, "doctor-queue-jobs");
  const { report: noDatabase } = await diagnose(host.env);
  assert.equal(noDatabase.checks.some((entry) => entry.name === "queue jobs"), false, "the check ran without a database");

  makeProject(t, host.env, "alpha");
  const { id } = addJob({ project: "alpha", prompt: "fix the worker" }, host.env);
  claimJobById(id, { worker: "host:6666", cap: 4 }, host.env);
  closeDb(host.env);
  const { report: live } = await diagnose(host.env);
  assert.equal(statusOf(live, "queue jobs"), "ok");

  openDb(host.env).prepare("UPDATE jobs SET lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(id);
  closeDb(host.env);

  const { report: orphaned } = await diagnose(host.env);
  assert.equal(statusOf(orphaned, "queue jobs"), "warn");
  assert.equal(orphaned.checks.find((entry) => entry.name === "queue jobs").detail, "1 orphaned");
  assert.deepEqual(orphaned.checks.filter((entry) => entry.name.startsWith("queue") && entry.status === "fail"), []);
});

test("--json is the only thing on stdout of the real process, and the exit code follows the report", (t) => {
  const home = join(makeDir(t, "doctor-stdout"), "home");
  const configDir = makeDir(t, "doctor-stdout-config");
  const env = { ...process.env, NIGHTSHIFT_HOME: home, CLAUDE_CONFIG_DIR: configDir, PATH: "" };
  delete env.NIGHTSHIFT_CLAUDE_BIN;

  const json = spawnSync(process.execPath, [CLI, "doctor", "--json"], { env, encoding: "utf8" });
  assert.equal(json.status, 1);
  const report = JSON.parse(json.stdout);
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "gh"), "warn");

  const text = spawnSync(process.execPath, [CLI, "doctor"], { env, encoding: "utf8" });
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^fail {2}config {16}config\.json not found/m);
  assert.equal(existsSync(join(configDir, "settings.json")), false);
});
