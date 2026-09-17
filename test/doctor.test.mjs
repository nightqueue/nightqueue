import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { dbPath, queuePausedPath, resolvedRuntimeDir, runnerRegistryPath, secretsPath } from "../src/config/paths.mjs";
import { ensureHome } from "../src/config/store.mjs";
import { closeDb, openDb } from "../src/memory/db.mjs";
import { addJob, claimJobById } from "../src/memory/jobs.mjs";
import { saveLesson } from "../src/memory/lessons.mjs";
import { writeRunnerRecord } from "../src/queue/registry.mjs";
import { makeHostEnv, writeLegacyShim } from "../test-support/host.mjs";
import { makeDir, makeProject } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightshift.mjs", import.meta.url));
const SETUP = ["setup", "--no-path", "--no-embedding"];
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

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
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });

  const { code, report } = await diagnose(host.env);
  assert.equal(code, 0);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.filter((check) => check.status === "fail"), []);
  assert.equal(
    report.checks.find((check) => check.name === "runtime").detail,
    `v${VERSION} at ${host.runtimeCurrent} -> ${resolvedRuntimeDir(host.env)}`,
    "the diagnosis does not name the version directory `current` resolves to",
  );
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
  assert.equal(statusOf(report, "runtime"), "ok");
  assert.equal(statusOf(report, "shim nightshift"), "ok");
  assert.equal(statusOf(report, "path"), "warn");
  assert.equal(statusOf(report, "embedding"), "warn");
  assert.equal(report.checks.some((check) => check.name === "embedding audit"), false, "the audit ran on an absent prefix");
});

test("runtime, shim, path and embedding are checked, and the audit only once the prefix is there", async (t) => {
  const host = makeHostEnv(t, "doctor-install");
  const virgin = await diagnose(host.env);
  assert.equal(statusOf(virgin.report, "runtime"), "fail");
  assert.equal(statusOf(virgin.report, "shim nightshift"), "fail");
  assert.match(virgin.report.checks.find((check) => check.name === "runtime").detail, /no runtime in .*runtime$/);

  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  writeFileSync(join(host.runtimePackage, "package.json"), `${JSON.stringify({ name: "nightshift", version: "0.0.1" })}\n`);
  mkdirSync(host.embeddingDir, { recursive: true });

  const { report } = await diagnose(host.env, { spawnSyncImpl: spawnSync });
  assert.equal(statusOf(report, "runtime"), "warn");
  assert.match(report.checks.find((check) => check.name === "runtime").hint, /nightshift update/);
  assert.equal(statusOf(report, "embedding audit"), "ok");

  host.env.NIGHTSHIFT_FAKE_NPM_AUDIT = "3";
  const { report: risky } = await diagnose(host.env, { spawnSyncImpl: spawnSync });
  assert.equal(statusOf(risky, "embedding audit"), "warn");
  assert.equal(risky.checks.find((check) => check.name === "embedding audit").detail, "3 advisories in the embedding prefix");
});

test("a shim left without the execute bit fails with the command that repairs it", async (t) => {
  const host = makeHostEnv(t, "doctor-shim");
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  chmodSync(host.shim, 0o644);

  const { code, report } = await diagnose(host.env);
  assert.equal(code, 1);
  assert.equal(statusOf(report, "shim nightshift"), "fail");
  assert.match(report.checks.find((check) => check.name === "shim nightshift").hint, /chmod \+x /);
});

test("the three command names are checked, and a missing shortcut only warns", async (t) => {
  const host = makeHostEnv(t, "doctor-shortcuts");
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  const full = await diagnose(host.env);
  for (const name of ["nightshift", "nshift", "nsft"]) assert.equal(statusOf(full.report, `shim ${name}`), "ok");

  const lean = makeHostEnv(t, "doctor-no-shortcuts");
  await run([...SETUP, "--no-shortcuts"], { ...defaultContext(), env: lean.env, out: () => {}, err: () => {} });
  const { code, report } = await diagnose(lean.env);
  assert.equal(statusOf(report, "shim nightshift"), "ok");
  assert.equal(statusOf(report, "shim nshift"), "warn");
  assert.equal(statusOf(report, "shim nsft"), "warn");
  assert.match(report.checks.find((check) => check.name === "shim nshift").hint, /--no-shortcuts/);
  assert.equal(code, 0, "a missing shortcut must never fail the diagnosis");
});

test("a shim left over from the previous command name warns, with a hint that depends on who wrote it", async (t) => {
  const host = makeHostEnv(t, "doctor-legacy-shim");
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  assert.equal((await diagnose(host.env)).report.checks.some((check) => check.name === "legacy shim"), false);

  writeLegacyShim(host);
  const ours = await diagnose(host.env);
  assert.equal(statusOf(ours.report, "legacy shim"), "warn");
  assert.match(ours.report.checks.find((check) => check.name === "legacy shim").hint, /nightshift setup/);

  writeLegacyShim(host, "#!/bin/sh\necho other-tool\n");
  const foreign = await diagnose(host.env);
  assert.equal(statusOf(foreign.report, "legacy shim"), "warn");
  assert.match(foreign.report.checks.find((check) => check.name === "legacy shim").hint, /by hand$/);
  assert.equal(foreign.code, 0);
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
  for (const name of ["nshift", "nsft"]) {
    const hint = report.checks.find((check) => check.name === `shim ${name}`).hint;
    assert.equal(hint, "run `nightshift setup`", "a home with no shim at all must never be sent to turn a flag off");
  }
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
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  host.env.NIGHTSHIFT_CLAUDE_BIN = join(host.configDir, "does-not-exist");

  const { code, report } = await diagnose(host.env);
  assert.equal(code, 1);
  assert.equal(statusOf(report, "claude"), "fail");
  assert.match(report.checks.find((check) => check.name === "claude").hint, /NIGHTSHIFT_CLAUDE_BIN/);
});

test("secrets more open than 0600 and a project that moved away are reported as failures", async (t) => {
  const host = makeHostEnv(t, "doctor-fixtures");
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
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
  assert.match(report.checks.find((check) => check.name === "database").detail, /schema v8/);
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
  assert.match(check.hint, /nightshift queue resume/);
});

// The check of the report by name, for the assertions that read more than its status.
function checkOf(report, name) {
  return report.checks.find((entry) => entry.name === name);
}

test("the runner registry check reads the four states it can find, one row per runner, and removes nothing", async (t) => {
  const host = makeHostEnv(t, "doctor-runner");
  const pid = 4242;
  const row = `runner ${pid}`;
  const gone = () => {
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  };
  const anotherUser = () => {
    throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  };

  const { report: none } = await diagnose(host.env, { killImpl: gone });
  assert.equal(statusOf(none, "runner registry"), "ok");
  assert.equal(checkOf(none, "runner registry").detail, "no runner registered");

  writeRunnerRecord({ pid, startedAt: "2026-09-08T21:04:11.000Z", mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, host.env);
  const { report: alive } = await diagnose(host.env, { killImpl: () => true });
  assert.equal(statusOf(alive, row), "ok");
  assert.equal(checkOf(alive, row).detail, `running (pid ${pid}, watch every 30 s)`);

  const { report: stale } = await diagnose(host.env, { killImpl: gone });
  assert.equal(statusOf(stale, row), "warn");
  assert.equal(checkOf(stale, row).detail, `stale (pid ${pid} is gone)`);
  assert.match(checkOf(stale, row).hint, /nightshift queue run --stop/);
  assert.equal(existsSync(runnerRegistryPath(pid, host.env)), true, "the diagnosis removed the registration it only had to read");

  const { report: foreign } = await diagnose(host.env, { killImpl: anotherUser });
  assert.equal(statusOf(foreign, row), "warn");
  assert.match(checkOf(foreign, row).detail, /another user/);
  assert.match(checkOf(foreign, row).hint, /^remove /);
  assert.equal(existsSync(runnerRegistryPath(pid, host.env)), true, "the diagnosis removed the registration of another user");

  const runtimeDir = makeDir(t, "doctor-runner-runtime");
  writeRunnerRecord({ pid, startedAt: "2026-09-08T21:04:11.000Z", mode: "drain", intervalS: null, logPath: null, runtimeDir }, host.env);
  const { report: withRuntime } = await diagnose(host.env, { killImpl: () => true });
  assert.equal(statusOf(withRuntime, row), "ok");
  assert.equal(checkOf(withRuntime, row).detail, `running (pid ${pid}, runtime ${runtimeDir})`);

  const second = 5252;
  const secondRuntime = makeDir(t, "doctor-runner-runtime-second");
  writeRunnerRecord({ pid: second, startedAt: "2026-09-08T21:05:00.000Z", mode: "watch", intervalS: 5, logPath: null, runtimeDir: secondRuntime }, host.env);
  const { report: both } = await diagnose(host.env, { killImpl: () => true });
  assert.equal(checkOf(both, row).detail, `running (pid ${pid}, runtime ${runtimeDir})`);
  assert.equal(checkOf(both, `runner ${second}`).detail, `running (pid ${second}, watch every 5 s, runtime ${secondRuntime})`, "the second runner is missing its own row");
  rmSync(runnerRegistryPath(second, host.env), { force: true });

  rmSync(runtimeDir, { recursive: true, force: true });
  const { report: runtimeGone } = await diagnose(host.env, { killImpl: () => true });
  assert.equal(statusOf(runtimeGone, row), "warn");
  assert.match(checkOf(runtimeGone, row).detail, /the runtime directory of this runner is gone \(/);

  writeFileSync(runnerRegistryPath(pid, host.env), "{not json");
  const { report: unreadable } = await diagnose(host.env, { killImpl: gone });
  assert.equal(statusOf(unreadable, "runner registry"), "warn");
  assert.match(checkOf(unreadable, "runner registry").detail, /^unreadable: /);
  assert.match(checkOf(unreadable, "runner registry").hint, /^remove /);
  assert.equal(existsSync(runnerRegistryPath(pid, host.env)), true, "the diagnosis removed the registration it could not read");
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
  const userHome = makeDir(t, "doctor-stdout-user-home");
  const env = {
    ...process.env,
    HOME: userHome,
    APPDATA: join(userHome, "AppData", "Roaming"),
    NIGHTSHIFT_HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    PATH: "",
  };
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
