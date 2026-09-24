import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { dbPath, queuePausedPath, resolvedRuntimeDir, runnerRegistryPath, secretsPath } from "../src/config/paths.mjs";
import { ensureHome } from "../src/config/store.mjs";
import { closeDb, openDb } from "../src/memory/db.mjs";
import { acquireClose, addJob, claimJobById, failClose } from "../src/memory/jobs.mjs";
import { saveDecision } from "../src/memory/decisions.mjs";
import { saveLesson } from "../src/memory/lessons.mjs";
import { shimContent } from "../src/host/runtime.mjs";
import { writeRunnerRecord } from "../src/queue/registry.mjs";
import { recordRunFields } from "../src/queue/run-state.mjs";
import { addProject } from "../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../src/config/store.mjs";
import { makeHostEnv, readSettingsFile, writeLegacyShim, writeSettingsFixture } from "../test-support/host.mjs";
import { makeDir, makeProject, seedClosedJob, seedLegacyV8Home } from "../test-support/memory.mjs";
import { addWorktree, deadPid, lockWorktree, publishedCheckout } from "../test-support/worktrees.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));
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
  assert.equal(statusOf(report, "operator"), "ok");
  assert.equal(statusOf(report, "gh"), "ok");
  assert.equal(statusOf(report, "config"), "ok");
  assert.equal(statusOf(report, "secrets"), "ok");
  assert.equal(statusOf(report, "mcp"), "ok");
  assert.equal(statusOf(report, "hook SessionStart"), "ok");
  assert.equal(statusOf(report, "hook UserPromptSubmit"), "ok");
  assert.equal(statusOf(report, "hook SessionEnd"), "ok");
  assert.equal(statusOf(report, "hook PreToolUse"), "ok");
  assert.equal(statusOf(report, "plugin"), "ok");
  assert.equal(statusOf(report, "model"), "warn");
  assert.equal(statusOf(report, "projects"), "warn");
  assert.equal(statusOf(report, "database"), "warn");
  assert.equal(statusOf(report, "runtime"), "ok");
  assert.equal(statusOf(report, "shim nightqueue"), "ok");
  assert.equal(statusOf(report, "path"), "warn");
  assert.equal(statusOf(report, "embedding"), "warn");
  assert.equal(report.checks.some((check) => check.name === "embedding audit"), false, "the audit ran on an absent prefix");
});

test("a PreToolUse hook registered with an older tool matcher warns, pointing at setup", async (t) => {
  const host = makeHostEnv(t, "doctor-stale-matcher");
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  const settings = readSettingsFile(host.configDir);
  settings.hooks.PreToolUse[0].matcher = "Agent|Task|Bash";
  writeSettingsFixture(host.configDir, settings);

  const { code, report } = await diagnose(host.env);
  const row = report.checks.find((check) => check.name === "hook PreToolUse");
  assert.deepEqual(
    { status: row.status, detail: row.detail, hint: row.hint },
    { status: "warn", detail: "registered with an older tool matcher", hint: "run `nightqueue setup`" },
  );
  assert.equal(code, 0, "a stale matcher must never fail the diagnosis");
});

test("runtime, shim, path and embedding are checked, and the audit only once the prefix is there", async (t) => {
  const host = makeHostEnv(t, "doctor-install");
  const virgin = await diagnose(host.env);
  assert.equal(statusOf(virgin.report, "runtime"), "fail");
  assert.equal(statusOf(virgin.report, "shim nightqueue"), "fail");
  assert.match(virgin.report.checks.find((check) => check.name === "runtime").detail, /no runtime in .*runtime$/);

  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  writeFileSync(join(host.runtimePackage, "package.json"), `${JSON.stringify({ name: "nightqueue", version: "0.0.1" })}\n`);
  mkdirSync(host.embeddingDir, { recursive: true });

  const { report } = await diagnose(host.env, { spawnSyncImpl: spawnSync });
  assert.equal(statusOf(report, "runtime"), "warn");
  assert.match(report.checks.find((check) => check.name === "runtime").hint, /nightqueue update/);
  assert.equal(statusOf(report, "embedding audit"), "ok");

  host.env.NIGHTQUEUE_FAKE_NPM_AUDIT = "3";
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
  assert.equal(statusOf(report, "shim nightqueue"), "fail");
  assert.match(report.checks.find((check) => check.name === "shim nightqueue").hint, /chmod \+x /);
});

test("the three command names are checked, and a missing shortcut only warns", async (t) => {
  const host = makeHostEnv(t, "doctor-shortcuts");
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  const full = await diagnose(host.env);
  for (const name of ["nightqueue", "nq"]) assert.equal(statusOf(full.report, `shim ${name}`), "ok");

  const lean = makeHostEnv(t, "doctor-no-shortcuts");
  await run([...SETUP, "--no-shortcuts"], { ...defaultContext(), env: lean.env, out: () => {}, err: () => {} });
  const { code, report } = await diagnose(lean.env);
  assert.equal(statusOf(report, "shim nightqueue"), "ok");
  assert.equal(statusOf(report, "shim nq"), "warn");
  assert.match(report.checks.find((check) => check.name === "shim nq").hint, /--no-shortcuts/);
  assert.equal(code, 0, "a missing shortcut must never fail the diagnosis");
});

test("a shortcut shadowed by another executable earlier on PATH warns and names the winner, and the canonical name is untouched", async (t) => {
  const host = makeHostEnv(t, "doctor-shadowed-shortcut");
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  const foreign = join(host.env.NIGHTQUEUE_HOME, "foreign-bin");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "nq"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...host.env, PATH: [foreign, join(host.env.NIGHTQUEUE_HOME, "bin"), host.env.PATH].join(delimiter) };
  const { code, report } = await diagnose(env);
  assert.equal(statusOf(report, "shim nightqueue"), "ok");
  assert.equal(statusOf(report, "shim nq"), "warn");
  assert.match(report.checks.find((check) => check.name === "shim nq").detail, new RegExp(`shadowed by ${join(foreign, "nq").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(code, 0, "a shadowed shortcut must never fail the diagnosis");

  const ahead = { ...host.env, PATH: [join(host.env.NIGHTQUEUE_HOME, "bin"), foreign, host.env.PATH].join(delimiter) };
  assert.equal(statusOf((await diagnose(ahead)).report, "shim nq"), "ok", "the shim directory first on PATH wins");

  const ours = join(host.env.NIGHTQUEUE_HOME, "other-home-bin");
  mkdirSync(ours, { recursive: true });
  writeFileSync(join(ours, "nq"), shimContent({ ...host.env, NIGHTQUEUE_HOME: join(host.env.NIGHTQUEUE_HOME, "other-home") }), { mode: 0o755 });
  const sibling = { ...host.env, PATH: [ours, join(host.env.NIGHTQUEUE_HOME, "bin"), host.env.PATH].join(delimiter) };
  assert.equal(statusOf((await diagnose(sibling)).report, "shim nq"), "ok", "a shim of another nightqueue home is ours, never another tool");
});

test("a shim left over from the previous command name warns, with a hint that depends on who wrote it", async (t) => {
  const host = makeHostEnv(t, "doctor-legacy-shim");
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  assert.equal((await diagnose(host.env)).report.checks.some((check) => check.name === "legacy shim"), false);

  writeLegacyShim(host);
  const ours = await diagnose(host.env);
  assert.equal(statusOf(ours.report, "legacy shim"), "warn");
  assert.match(ours.report.checks.find((check) => check.name === "legacy shim").hint, /nightqueue setup/);

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
  assert.equal(statusOf(report, "hook PreToolUse"), "fail");
  assert.equal(statusOf(report, "plugin"), "fail");
  assert.equal(statusOf(report, "gh"), "warn");
  for (const name of ["nq"]) {
    const hint = report.checks.find((check) => check.name === `shim ${name}`).hint;
    assert.equal(hint, "run `nightqueue setup`", "a home with no shim at all must never be sent to turn a flag off");
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
  assert.deepEqual(host.calls().filter((call) => call[0] !== "--version" && call[0] !== "--help"), []);
});

// Subprocess runner that answers `claude --help` with or without the `--agent` line, delegating every other call to the fake gh runner.
function withClaudeHelp(listsAgent) {
  const fallback = withFakeGh(true);
  return (file, args, options) => {
    if (args?.[0] !== "--help") return fallback(file, args, options);
    const stdout = listsAgent ? "Options:\n  --agent <agent>  Agent for the current session\n" : "Options:\n  -p, --print\n";
    return { status: 0, stdout, stderr: "" };
  };
}

test("the operator row says how `nightqueue open` loads the agent, and a fallback only warns", async (t) => {
  const host = makeHostEnv(t, "doctor-operator");
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });

  const agent = await diagnose(host.env, { spawnSyncImpl: withClaudeHelp(true) });
  const agentRow = agent.report.checks.find((check) => check.name === "operator");
  assert.equal(agentRow.status, "ok");
  assert.match(agentRow.detail, /--agent nightqueue:nightqueue-operator/);

  const fallback = await diagnose(host.env, { spawnSyncImpl: withClaudeHelp(false) });
  const fallbackRow = fallback.report.checks.find((check) => check.name === "operator");
  assert.equal(fallbackRow.status, "warn");
  assert.match(fallbackRow.detail, /--append-system-prompt`; the agent's tool restriction does not apply/);
  assert.equal(fallbackRow.hint, "update Claude Code");
  assert.equal(fallback.code, agent.code, "a fallback changed the exit code of the diagnosis");

  const mute = (file, args, options) => (args?.[0] === "--help" ? { status: null, error: new Error("spawn ETIMEDOUT") } : withFakeGh(true)(file, args, options));
  const silent = await diagnose(host.env, { spawnSyncImpl: mute });
  assert.equal(statusOf(silent.report, "operator"), "warn");
  assert.match(silent.report.checks.find((check) => check.name === "operator").detail, /claude did not answer/);
});

test("a claude CLI that cannot run is the only failure of an otherwise clean host", async (t) => {
  const host = makeHostEnv(t, "doctor-no-claude");
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  host.env.NIGHTQUEUE_CLAUDE_BIN = join(host.configDir, "does-not-exist");

  const { code, report } = await diagnose(host.env);
  assert.equal(code, 1);
  assert.equal(statusOf(report, "claude"), "fail");
  assert.match(report.checks.find((check) => check.name === "claude").hint, /NIGHTQUEUE_CLAUDE_BIN/);
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
  assert.match(report.checks.find((check) => check.name === "database").detail, /schema v17/);
});

test("the database check warns about a v8 home and points at the command that migrates it", async (t) => {
  const host = makeHostEnv(t, "doctor-db-v8");
  seedLegacyV8Home(host.env);

  const { report } = await diagnose(host.env);
  const database = report.checks.find((check) => check.name === "database");
  assert.equal(database.status, "warn");
  assert.match(database.detail, /schema v8, expected v17/);
  assert.match(database.hint, /run `nightqueue queue status` once to migrate it/);
  assert.doesNotMatch(database.hint, /nightqueue memory stats/);
});

test("the roadmap workflow check is ok when every linked item follows its job and warns about one left behind", async (t) => {
  const host = makeHostEnv(t, "doctor-roadmap-workflow");
  const db = openDb(host.env);
  const job = addJob({ project: "alpha", prompt: "deliver it" }, host.env);
  db.prepare("INSERT INTO roadmap_items (project, title, position, status, job_id, job_status_seen) VALUES ('alpha', 'deliver it', 1, 'in_progress', ?, 'pending')").run(job.id);
  closeDb(host.env);

  const quiet = await diagnose(host.env);
  assert.equal(statusOf(quiet.report, "roadmap workflow"), "ok");

  openDb(host.env).prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(job.id);
  closeDb(host.env);
  const { report } = await diagnose(host.env);
  const check = report.checks.find((entry) => entry.name === "roadmap workflow");
  assert.equal(check.status, "warn");
  assert.equal(check.detail, `1 roadmap status out of step: #1 in_progress (job ${job.id} done, expected in_review)`);
  assert.match(check.hint, /next `nightqueue queue run` claim cycle re-syncs the ones behind a job/);
});

test("the roadmap workflow check flags an org item whose status disagrees with its project rows", async (t) => {
  const host = makeHostEnv(t, "doctor-roadmap-org-derived");
  const db = openDb(host.env);
  db.prepare("INSERT INTO roadmap_items (scope, org, title, position, status) VALUES ('org', 'acme', 'raise node', 1, 'in_progress')").run();
  db.prepare("INSERT INTO roadmap_item_projects (item_id, project, status) VALUES (1, 'api', 'done'), (1, 'app', 'in_progress')").run();
  closeDb(host.env);

  const quiet = await diagnose(host.env);
  assert.equal(statusOf(quiet.report, "roadmap workflow"), "ok");

  openDb(host.env).prepare("UPDATE roadmap_items SET status = 'todo' WHERE id = 1").run();
  closeDb(host.env);
  const { report } = await diagnose(host.env);
  const check = report.checks.find((entry) => entry.name === "roadmap workflow");
  assert.equal(check.status, "warn");
  assert.equal(check.detail, "1 roadmap status out of step: acme#1 todo (derived from its project rows: in_progress)");
  assert.match(check.hint, /re-derived at its next project row change/);
});

test("the database check fails a schema newer than this build and asks for an upgrade", async (t) => {
  const host = makeHostEnv(t, "doctor-db-newer");
  openDb(host.env).exec("PRAGMA user_version = 99");
  closeDb(host.env);

  const { report } = await diagnose(host.env);
  const database = report.checks.find((check) => check.name === "database");
  assert.equal(database.status, "fail");
  assert.match(database.detail, /schema v99, expected v17/);
  assert.match(database.hint, /upgrade nightqueue/);
});

test("the keep awake check is a plain no-op outside macOS, whatever the configured mode", async (t) => {
  const host = makeHostEnv(t, "doctor-keep-awake-other-os");
  const { report } = await diagnose(host.env, { platform: "linux" });
  const row = checkOf(report, "keep awake");
  assert.equal(row.status, "ok");
  assert.match(row.detail, /queue\.keepAwake: auto \(does nothing outside macOS\)/);
  assert.equal(row.hint, null);
});

test("the keep awake check on macOS: off is fine, found is ok, and a missing caffeinate warns with a hint", async (t) => {
  const host = makeHostEnv(t, "doctor-keep-awake-darwin");
  const overrides = { platform: "darwin" };
  // The binary is always named through the override: the PATH of the machine running the suite has a caffeinate on macOS and none on Linux.
  const found = join(host.configDir, "caffeinate");
  writeFileSync(found, "#!/bin/sh\nexit 1\n");
  chmodSync(found, 0o755);
  const missingBin = join(host.configDir, "does-not-exist");

  ensureHome(host.env);
  const config = loadConfig(host.env, { warn: () => {} });
  saveConfig({ ...config, queue: { ...config.queue, keepAwake: "off" } }, host.env);
  host.env.NIGHTQUEUE_CAFFEINATE_BIN = missingBin;
  const { report: off } = await diagnose(host.env, overrides);
  assert.equal(checkOf(off, "keep awake").status, "ok");
  assert.match(checkOf(off, "keep awake").detail, /queue\.keepAwake: off/);
  assert.match(checkOf(off, "keep awake").detail, /closed lid/);
  saveConfig({ ...config, queue: { ...config.queue, keepAwake: "auto" } }, host.env);

  const { report: missing } = await diagnose(host.env, overrides);
  const missingRow = checkOf(missing, "keep awake");
  assert.equal(missingRow.status, "warn");
  assert.match(missingRow.detail, /caffeinate not found/);
  assert.match(missingRow.hint, /NIGHTQUEUE_CAFFEINATE_BIN/);

  host.env.NIGHTQUEUE_CAFFEINATE_BIN = found;
  const { report: ok } = await diagnose(host.env, overrides);
  assert.equal(checkOf(ok, "keep awake").status, "ok");
  assert.match(checkOf(ok, "keep awake").detail, new RegExp(found.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the job environment check is ok by default (isolated) and warns once queue.inheritUserEnvironment is turned on", async (t) => {
  const host = makeHostEnv(t, "doctor-job-environment");
  const { report: isolated } = await diagnose(host.env);
  assert.equal(statusOf(isolated, "job environment"), "ok");
  assert.match(checkOf(isolated, "job environment").detail, /isolated:.*queue\.inheritUserEnvironment: false/);
  assert.equal(checkOf(isolated, "job environment").hint, null);

  ensureHome(host.env);
  const config = loadConfig(host.env, { warn: () => {} });
  saveConfig({ ...config, queue: { ...config.queue, inheritUserEnvironment: true } }, host.env);
  const { report: inherited } = await diagnose(host.env);
  assert.equal(statusOf(inherited, "job environment"), "warn");
  assert.match(checkOf(inherited, "job environment").detail, /inherited:.*queue\.inheritUserEnvironment: true/);
  assert.match(checkOf(inherited, "job environment").hint, /queue\.inheritUserEnvironment/);
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
  assert.match(check.hint, /nightqueue queue resume/);
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
  assert.match(checkOf(stale, row).hint, /nightqueue queue run --stop/);
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

// The status and detail of the closes row of a report.
function closesCheck(report) {
  const row = report.checks.find((entry) => entry.name === "closes");
  return row ? { status: row.status, detail: row.detail } : null;
}

test("the closes check reports closes in flight, failed and on a dead lease, and only once the database exists", async (t) => {
  const host = makeHostEnv(t, "doctor-closes");
  assert.equal(closesCheck((await diagnose(host.env)).report), null, "the check ran without a database");

  makeProject(t, host.env, "alpha");
  const ids = [1, 2, 3].map(() => addJob({ project: "alpha", prompt: "fix the worker" }, host.env).id);
  const db = openDb(host.env);
  for (const id of ids) db.prepare("UPDATE jobs SET status = 'done', pr_url = 'https://github.com/acme/api/pull/7' WHERE id = ?").run(id);
  closeDb(host.env);
  assert.deepEqual(closesCheck((await diagnose(host.env)).report), { status: "ok", detail: "no close in flight, failed or stalled" });

  acquireClose(ids[0], { worker: "close:host:1:aaaa", leaseS: 660 }, host.env);
  closeDb(host.env);
  assert.deepEqual(closesCheck((await diagnose(host.env)).report), { status: "ok", detail: `1 in flight (#${ids[0]} at preflight)` });

  acquireClose(ids[1], { worker: "close:host:1:bbbb", leaseS: 660 }, host.env);
  failClose(ids[1], { worker: "close:host:1:bbbb", close: { attempts: 1, steps: {}, data: {}, failed: { step: "merge", reason: "merge-without-sha" } } }, host.env);
  acquireClose(ids[2], { worker: "close:host:1:cccc", leaseS: 660 }, host.env);
  openDb(host.env).prepare("UPDATE jobs SET close_lease_until = datetime('now', '-5 seconds') WHERE id = ?").run(ids[2]);
  closeDb(host.env);
  const { report } = await diagnose(host.env);
  assert.deepEqual(closesCheck(report), {
    status: "warn",
    detail: `1 in flight (#${ids[0]} at preflight), 1 failed (#${ids[1]} at merge: merge-without-sha), 1 with a dead lease (#${ids[2]})`,
  });
  assert.equal(report.checks.find((entry) => entry.name === "closes").hint, "run again with: nightqueue queue close <id>");
});

test("the closes check warns with the migrate hint on a database without the close columns, and leaves it as it was", async (t) => {
  const host = makeHostEnv(t, "doctor-closes-old-db");
  makeProject(t, host.env, "alpha");
  addJob({ project: "alpha", prompt: "old row" }, host.env);
  const db = openDb(host.env);
  for (const column of ["close_worker", "close_status", "close", "close_lease_until"]) db.exec(`ALTER TABLE jobs DROP COLUMN ${column}`);
  closeDb(host.env);

  const { report } = await diagnose(host.env);
  const row = report.checks.find((entry) => entry.name === "closes");
  assert.equal(row.status, "warn");
  assert.match(row.hint, /nightqueue memory stats/);
  const raw = new DatabaseSync(dbPath(host.env), { readOnly: true });
  t.after(() => raw.close());
  assert.equal(raw.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "close_status"), false, "the doctor migrated the database");
});

// The report row of the host commands check.
function hostCommandsCheck(report) {
  return report.checks.find((entry) => entry.name === "host commands");
}

test("the host commands check sums the counters of the last finished jobs, warning only when a task was backgrounded or killed", async (t) => {
  const host = makeHostEnv(t, "doctor-host-commands");
  const { report: noDatabase } = await diagnose(host.env);
  assert.deepEqual(
    { status: hostCommandsCheck(noDatabase).status, detail: hostCommandsCheck(noDatabase).detail },
    { status: "ok", detail: "host commands: 0 backgrounded, 0 killed, 0 timed out in the last 20 jobs" },
  );

  makeProject(t, host.env, "alpha");
  const timedOut = addJob({ project: "alpha", prompt: "times out" }, host.env).id;
  openDb(host.env).prepare("UPDATE jobs SET status = 'done', bash_timeouts = 3 WHERE id = ?").run(timedOut);
  closeDb(host.env);
  const { report: onlyTimeouts } = await diagnose(host.env);
  assert.deepEqual(
    { status: hostCommandsCheck(onlyTimeouts).status, detail: hostCommandsCheck(onlyTimeouts).detail },
    { status: "ok", detail: "host commands: 0 backgrounded, 0 killed, 3 timed out in the last 20 jobs" },
  );

  const killedJob = addJob({ project: "alpha", prompt: "gets killed" }, host.env).id;
  openDb(host.env).prepare("UPDATE jobs SET status = 'failed', tasks_killed = 1 WHERE id = ?").run(killedJob);
  closeDb(host.env);
  const { report: withKill } = await diagnose(host.env);
  assert.deepEqual(
    { status: hostCommandsCheck(withKill).status, detail: hostCommandsCheck(withKill).detail },
    { status: "warn", detail: "host commands: 0 backgrounded, 1 killed, 3 timed out in the last 20 jobs" },
  );
});

// The status and detail of the orchestrator check.
function orchestratorCheck(report) {
  const row = report.checks.find((entry) => entry.name === "orchestrator");
  return { status: row?.status, detail: row?.detail };
}

// Finishes a job straight in the database with the given orchestrator counters.
function finishedWithOrchestrator(env, counters) {
  const id = addJob({ project: "alpha", prompt: "measured" }, env).id;
  openDb(env)
    .prepare("UPDATE jobs SET status = 'done', orch_turns = ?, orch_reads = ?, orch_bash = ?, orch_bash_explore = ?, orch_ctx_last = ? WHERE id = ?")
    .run(counters.turns, counters.reads, counters.bash, counters.explore, counters.context, id);
  closeDb(env);
  return id;
}

test("the orchestrator check sums the counters of the last 20 finished jobs, warning once the orchestrator read the repository or explored", async (t) => {
  const host = makeHostEnv(t, "doctor-orchestrator");
  const { report: noDatabase } = await diagnose(host.env);
  assert.deepEqual(orchestratorCheck(noDatabase), {
    status: "ok",
    detail: "orchestrator: 0 turns, 0 reads outside the run, 0 Bash (0 exploration), last context 0 (avg 0) in the last 20 jobs (0 measured)",
  });

  makeProject(t, host.env, "alpha");
  const unmeasured = addJob({ project: "alpha", prompt: "finished before the counters" }, host.env).id;
  openDb(host.env).prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(unmeasured);
  closeDb(host.env);
  finishedWithOrchestrator(host.env, { turns: 10, reads: 0, bash: 4, explore: 0, context: 100000 });
  finishedWithOrchestrator(host.env, { turns: 20, reads: 0, bash: 6, explore: 0, context: 150000 });
  const { report: healthy } = await diagnose(host.env);
  assert.deepEqual(orchestratorCheck(healthy), {
    status: "ok",
    detail: "orchestrator: 30 turns, 0 reads outside the run, 10 Bash (0 exploration), last context 250000 (avg 125000) in the last 20 jobs (2 measured)",
  });

  finishedWithOrchestrator(host.env, { turns: 49, reads: 4, bash: 35, explore: 17, context: 195000 });
  const { report: regressed } = await diagnose(host.env);
  assert.deepEqual(orchestratorCheck(regressed), {
    status: "warn",
    detail: "orchestrator: 79 turns, 4 reads outside the run, 45 Bash (17 exploration), last context 445000 (avg 148333) in the last 20 jobs (3 measured)",
  });

  for (let index = 0; index < 20; index += 1) finishedWithOrchestrator(host.env, { turns: 1, reads: 0, bash: 0, explore: 0, context: 10 });
  const { report: sampled } = await diagnose(host.env);
  assert.deepEqual(orchestratorCheck(sampled), {
    status: "ok",
    detail: "orchestrator: 20 turns, 0 reads outside the run, 0 Bash (0 exploration), last context 200 (avg 10) in the last 20 jobs (20 measured)",
  });
});

test("the orchestrator check reads a database without the counter columns as zero and never writes it", async (t) => {
  const host = makeHostEnv(t, "doctor-orchestrator-old-db");
  makeProject(t, host.env, "alpha");
  const id = addJob({ project: "alpha", prompt: "old row" }, host.env).id;
  const db = openDb(host.env);
  db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(id);
  for (const column of ["orch_turns", "orch_reads", "orch_bash", "orch_bash_explore", "orch_ctx_last"]) db.exec(`ALTER TABLE jobs DROP COLUMN ${column}`);
  closeDb(host.env);

  const { report } = await diagnose(host.env);
  assert.deepEqual(orchestratorCheck(report), {
    status: "ok",
    detail: "orchestrator: 0 turns, 0 reads outside the run, 0 Bash (0 exploration), last context 0 (avg 0) in the last 20 jobs (0 measured)",
  });
  const raw = new DatabaseSync(dbPath(host.env), { readOnly: true });
  t.after(() => raw.close());
  assert.equal(raw.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "orch_turns"), false, "the doctor migrated the database");
});

// A decision proposed by the given job, stamped straight in the database.
function proposedByJob(env, { title, jobId }) {
  const saved = saveDecision({ project: "alpha", title, context: "why", decision: "what", status: "proposed" }, env);
  openDb(env).prepare("UPDATE decisions SET job_id = ? WHERE id = ?").run(jobId, saved.id);
  return saved;
}

// The report row of the decision proposals check.
function proposalsCheck(report) {
  return report.checks.find((entry) => entry.name === "decision proposals");
}

test("the decision proposals check warns on a proposal of a closed job, never on one of an open job, and only once the database exists", async (t) => {
  const host = makeHostEnv(t, "doctor-proposals");
  const { report: noDatabase } = await diagnose(host.env);
  assert.equal(proposalsCheck(noDatabase), undefined, "the check ran without a database");

  makeProject(t, host.env, "alpha");
  const open = addJob({ project: "alpha", prompt: "still open" }, host.env).id;
  proposedByJob(host.env, { title: "the open job proposes this", jobId: open });
  closeDb(host.env);
  const { report: none } = await diagnose(host.env);
  assert.deepEqual(
    { status: proposalsCheck(none).status, detail: proposalsCheck(none).detail },
    { status: "ok", detail: "no proposal left open on a closed job" },
  );

  const closed = seedClosedJob(host.env, { project: "alpha", prompt: "closed one" });
  const first = proposedByJob(host.env, { title: "the closed job proposes this", jobId: closed });
  closeDb(host.env);
  const { report: one } = await diagnose(host.env);
  assert.equal(proposalsCheck(one).status, "warn");
  assert.equal(proposalsCheck(one).detail, `1 proposed decision of closed jobs: #${first.number} (job ${closed})`);
  assert.match(proposalsCheck(one).hint, /nightqueue queue close <id> --decisions accept\|reject/);

  const second = proposedByJob(host.env, { title: "and a second one from it", jobId: closed });
  closeDb(host.env);
  const { report: two } = await diagnose(host.env);
  assert.equal(
    proposalsCheck(two).detail,
    `2 proposed decisions of closed jobs: #${first.number} (job ${closed}), #${second.number} (job ${closed})`,
  );
});

test("the decision proposals check warns with the migrate hint on a database without decisions.job_id, and leaves it as it was", async (t) => {
  const host = makeHostEnv(t, "doctor-proposals-v10");
  makeProject(t, host.env, "alpha");
  openDb(host.env).exec("DROP INDEX decisions_job_idx; ALTER TABLE decisions DROP COLUMN job_id; PRAGMA user_version = 10;");
  closeDb(host.env);

  const { report } = await diagnose(host.env);

  assert.equal(proposalsCheck(report).status, "warn");
  assert.match(proposalsCheck(report).hint, /nightqueue memory stats/);
  const raw = new DatabaseSync(dbPath(host.env), { readOnly: true });
  t.after(() => raw.close());
  const columns = raw.prepare("SELECT name FROM pragma_table_info('decisions')").all().map((row) => row.name);
  assert.equal(columns.includes("job_id"), false, "the diagnosis migrated the database");
});

test("--json is the only thing on stdout of the real process, and the exit code follows the report", (t) => {
  const home = join(makeDir(t, "doctor-stdout"), "home");
  const configDir = makeDir(t, "doctor-stdout-config");
  const userHome = makeDir(t, "doctor-stdout-user-home");
  const env = {
    ...process.env,
    HOME: userHome,
    APPDATA: join(userHome, "AppData", "Roaming"),
    NIGHTQUEUE_HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    PATH: "",
  };
  delete env.NIGHTQUEUE_CLAUDE_BIN;

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

// Registers a real published checkout as project `alpha` of the home, returning the resolved path the config records.
function registerRealCheckout(t, env, name) {
  const checkout = realpathSync(publishedCheckout(t, name).checkout);
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path: checkout, name: "alpha" }).config, env);
  return checkout;
}

test("doctor names each leftover under .claude/worktrees with its cleanup command, skips what an open job or a live session holds, and deletes nothing", async (t) => {
  const host = makeHostEnv(t, "doctor-worktrees");
  const checkout = registerRealCheckout(t, host.env, "doctor-worktrees");
  const orphan = join(checkout, ".claude", "worktrees", "orphan");
  mkdirSync(orphan, { recursive: true });
  const ownerless = addWorktree(checkout, "ownerless");
  const staleLocked = addWorktree(checkout, "stale-locked");
  const stalePid = deadPid();
  lockWorktree(checkout, staleLocked.path, stalePid);
  const liveLocked = addWorktree(checkout, "live-locked");
  lockWorktree(checkout, liveLocked.path, process.pid);
  const gated = addWorktree(checkout, "gated");
  const closed = addWorktree(checkout, "closed");
  const { id: gatedId } = addJob({ project: "alpha", prompt: "work of gated-run" }, host.env);
  openDb(host.env).prepare("UPDATE jobs SET status = 'gate', slug = 'gated-run' WHERE id = ?").run(gatedId);
  seedClosedJob(host.env, { project: "alpha", prompt: "work of closed-run", slug: "closed-run" });
  for (const [slug, path] of [["gated-run", gated.path], ["closed-run", closed.path]]) {
    recordRunFields({ project: "alpha", slug, fields: { worktree: path }, env: host.env });
  }
  closeDb(host.env);

  const { report } = await diagnose(host.env);

  const rows = report.checks.filter((entry) => entry.name.startsWith("worktree"));
  const quoted = (path) => `'${path}'`;
  const remove = (path) => `git -C ${quoted(checkout)} worktree remove ${quoted(path)}`;
  assert.deepEqual(
    rows.sort((a, b) => a.name.localeCompare(b.name)),
    [
      check("worktree alpha/closed", "warn", "left over: registered in git, no open job owns it", remove(closed.path)),
      check("worktree alpha/orphan", "warn", "left over: not registered in git (orphaned), no open job owns it", `rm -rf ${quoted(orphan)}`),
      check("worktree alpha/ownerless", "warn", "left over: registered in git, no open job owns it", remove(ownerless.path)),
      check(
        "worktree alpha/stale-locked",
        "warn",
        `left over: registered in git and locked (claude agent agent-1 (pid ${stalePid})), no open job owns it`,
        `git -C ${quoted(checkout)} worktree unlock ${quoted(staleLocked.path)} && ${remove(staleLocked.path)}`,
      ),
    ],
  );
  assert.equal(report.checks.some((entry) => entry.name.startsWith("worktree") && entry.status === "fail"), false, "a leftover failed the diagnosis");
  for (const path of [orphan, ownerless.path, staleLocked.path, liveLocked.path, gated.path, closed.path]) {
    assert.equal(existsSync(path), true, `the diagnosis deleted ${path}`);
  }
});

test("doctor says so when the owner of a worktree cannot be known, or git cannot list the worktrees of a checkout", async (t) => {
  const unreadable = makeHostEnv(t, "doctor-worktrees-unreadable");
  const checkout = registerRealCheckout(t, unreadable.env, "doctor-worktrees-unreadable");
  addWorktree(checkout, "some-run");
  ensureHome(unreadable.env);
  writeFileSync(dbPath(unreadable.env), "this is not a database");
  const { report } = await diagnose(unreadable.env);
  const row = checkOf(report, "worktrees");
  assert.equal(row.status, "warn");
  assert.match(row.detail, /^the queue cannot be read \(.+\), so the owner of a worktree is unknown$/);
  assert.equal(report.checks.some((entry) => entry.name.startsWith("worktree ")), false, "a worktree was reported with an unknown owner");

  const noGit = makeHostEnv(t, "doctor-worktrees-no-git");
  const fake = realpathSync(makeProject(t, noGit.env, "alpha"));
  mkdirSync(join(fake, ".claude", "worktrees", "some-run"), { recursive: true });
  const { report: gitless } = await diagnose(noGit.env);
  assert.deepEqual(checkOf(gitless, "worktrees alpha"), check("worktrees alpha", "warn", "git could not list the worktrees of the checkout", `inspect ${fake}`));
  assert.equal(existsSync(join(fake, ".claude", "worktrees", "some-run")), true);
});

// One report row, in the shape the diagnosis prints.
function check(name, status, detail, hint) {
  return { name, status, detail, hint };
}
