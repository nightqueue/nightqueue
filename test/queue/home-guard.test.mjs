import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { homeDir } from "../../src/config/paths.mjs";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { JOB_CLAUDE_DIR_ENV, JOB_HOME_ENV, refuseHomeWriteInsideJob } from "../../src/queue/home-guard.mjs";
import { makeHostEnv } from "../../test-support/host.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const JOB = 9;

// The refusal the operator's own home always answers with from inside a job.
function homeRefusal(id) {
  return `refused: this command would change the operator's nightqueue home from inside job #${id}; verify against a temporary home (NIGHTQUEUE_HOME=$(mktemp -d)) instead`;
}

// The refusal the operator's own Claude settings answer with from inside a job.
function hostRefusal(id) {
  return `refused: this command would change the operator's Claude settings from inside job #${id}; verify against a temporary host (CLAUDE_CONFIG_DIR=$(mktemp -d)) too`;
}

// Context that captures the output and never asks a terminal anything.
function makeCtx(env, overrides = {}) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: { isTTY: false },
    stdout: new PassThrough(),
    ...overrides,
  };
  return { ctx, out, err };
}

// A directory that looks like a git repository, without calling git.
function makeRepo(t, name) {
  const dir = makeDir(t, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

// Environment of a child the runner spawned: the job it runs plus the home and the host that are the operator's.
function insideJob(env, { home, configDir }) {
  return { ...env, NIGHTQUEUE_JOB_ID: String(JOB), [JOB_HOME_ENV]: home, [JOB_CLAUDE_DIR_ENV]: configDir };
}

const GUARDED = [
  ["queue", "add", "alpha", "an acceptance test job created from inside a verifier"],
  ["queue", "cancel", "1"],
  ["queue", "pause"],
  ["project", "add", "/tmp"],
  ["org", "add", "acme"],
  ["connection", "add", "gh", "--type", "github"],
  ["embed", "install"],
  ["init"],
  ["setup"],
  ["update"],
];

test("every command that writes the home is refused from inside the job that pinned it, and writes nothing at all", async (t) => {
  const host = makeHostEnv(t, "home-guard-refused");
  const env = insideJob(host.env, { home: host.home, configDir: host.configDir });

  for (const argv of GUARDED) {
    const { ctx, out, err } = makeCtx(env);
    assert.equal(await run(argv, ctx), 1, argv.join(" "));
    assert.deepEqual(err, [`nightqueue: ${homeRefusal(JOB)}`], argv.join(" "));
    assert.deepEqual(out, [], argv.join(" "));
  }

  assert.equal(existsSync(host.home), false, "a refused command created the home of the operator");
  assert.equal(existsSync(`${host.home}.lock`), false, "a refused command created the write lock in the home of the operator");
});

test("a reading command and a help flag are never refused, and neither is a session with no job", async (t) => {
  const home = makeHome(t, "home-guard-reads");
  const env = { ...home, NIGHTQUEUE_JOB_ID: String(JOB), [JOB_HOME_ENV]: homeDir(home) };

  for (const argv of [["queue", "status"], ["project", "list"], ["queue", "add", "--help"]]) {
    const { ctx, err } = makeCtx(env);
    assert.equal(await run(argv, ctx), 0, `${argv.join(" ")}: ${err.join("\n")}`);
  }

  const operator = makeCtx(home);
  assert.equal(await run(["org", "add", "acme"], operator.ctx), 0, operator.err.join("\n"));
});

const HELP_DECOYS = [
  ["queue", "add", "alpha", "an acceptance job", "--help", "for the verifier"],
  ["queue", "add", "--help", "an acceptance job for the verifier"],
  ["project", "add", "/tmp", "--help"],
];

test("a help flag the command would read as free text never carries a write past the guard", async (t) => {
  const host = makeHostEnv(t, "home-guard-help-decoy");
  const env = insideJob(host.env, { home: host.home, configDir: host.configDir });

  for (const argv of HELP_DECOYS) {
    const { ctx, out, err } = makeCtx(env);
    assert.equal(await run(argv, ctx), 1, argv.join(" "));
    assert.deepEqual(err, [`nightqueue: ${homeRefusal(JOB)}`], argv.join(" "));
    assert.deepEqual(out, [], argv.join(" "));
  }

  assert.equal(existsSync(host.home), false, "a decoy help flag wrote the home of the operator");
});

test("a temporary home is allowed inside the same job, and init only runs once the host is temporary too", async (t) => {
  const host = makeHostEnv(t, "home-guard-temp");
  const repo = makeRepo(t, "home-guard-temp-repo");
  const tempHome = join(makeDir(t, "home-guard-temp-home"), "home");
  const onHostOfTheOperator = { ...insideJob(host.env, { home: host.home, configDir: host.configDir }), NIGHTQUEUE_HOME: tempHome };
  t.after(() => closeDb(onHostOfTheOperator));

  const refused = makeCtx(onHostOfTheOperator);
  assert.equal(await run(["init", "--no-path", repo, "--no-gh"], refused.ctx), 1);
  assert.deepEqual(refused.err, [`nightqueue: ${hostRefusal(JOB)}`]);
  assert.equal(existsSync(tempHome), false, "a refused init still created the temporary home");

  const isolated = { ...onHostOfTheOperator, CLAUDE_CONFIG_DIR: makeDir(t, "home-guard-temp-config") };
  const installed = makeCtx(isolated);
  assert.equal(await run(["init", "--no-path", repo, "--name", "api", "--no-gh"], installed.ctx), 0, installed.err.join("\n"));
  assert.equal(JSON.parse(readFileSync(join(tempHome, "config.json"), "utf8")).projects.api.org, "default");

  const queued = makeCtx(isolated);
  assert.equal(await run(["queue", "add", "api", "verify the acceptance of this change"], queued.ctx), 0, queued.err.join("\n"));
  assert.equal(getJob(1, isolated).project, "api");
  assert.equal(existsSync(host.home), false, "the home of the operator was written by a run isolated in a temporary one");
});

test("a job spawned by a runner that pinned nothing is refused whenever it aims at the default home", (t) => {
  const legacy = { NIGHTQUEUE_JOB_ID: "7" };
  assert.throws(() => refuseHomeWriteInsideJob(legacy), new RegExp(`from inside job #7`));
  assert.throws(() => refuseHomeWriteInsideJob({ ...legacy, NIGHTQUEUE_HOME: "   " }), /verify against a temporary home/);

  const temporary = { ...legacy, NIGHTQUEUE_HOME: makeDir(t, "home-guard-legacy") };
  assert.equal(refuseHomeWriteInsideJob(temporary), undefined);
  assert.equal(refuseHomeWriteInsideJob({ NIGHTQUEUE_HOME: temporary.NIGHTQUEUE_HOME }), undefined);
});

test("a job answering its own gate against the home of the runner is never refused", async (t) => {
  const home = makeHome(t, "home-guard-own-retry");
  makeProject(t, home, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, home).id;
  openDb(home).prepare("UPDATE jobs SET status = 'gate', notice_md = ? WHERE id = ?").run("why it stopped", id);
  const env = { ...home, NIGHTQUEUE_JOB_ID: String(id), [JOB_HOME_ENV]: homeDir(home) };

  const own = makeCtx(env);
  assert.equal(await run(["queue", "retry", String(id), "--note", "go on"], own.ctx), 0, own.err.join("\n"));
  assert.equal(getJob(id, env).status, "pending");

  const other = addJob({ project: "alpha", prompt: "fix the parser" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'gate' WHERE id = ?").run(other);
  const cross = makeCtx(env);
  assert.equal(await run(["queue", "retry", String(other), "--note", "go on"], cross.ctx), 1);
  assert.match(cross.err.join("\n"), new RegExp(`refusing to retry job \`${other}\` from inside job \`${id}\``));
});
