import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { dbPath, homeDir } from "../../src/config/paths.mjs";
import { registerCheckout } from "../../test-support/memory.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { getJob } from "../../src/memory/jobs.mjs";
import * as registry from "../../src/memory/registry.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

// The question `queue add` asks before it registers the repository of the current directory.
const question = (cwd, name, key) =>
  `No project registered for ${cwd}. Register it as \`${name}\` (key ${key}) in org \`default\` and queue the job? [Y/n] `;

// The key the offer suggests for a name on this home right now.
function offeredKey(env, name) {
  return registry.suggestFreeKey(openDb(env), name, "project");
}

// The key the registry holds for a project of a home.
function registeredKey(env, name) {
  return registry.projectByName(openDb(env), name)?.key;
}

// A directory that looks like a git repository, without calling git.
function makeRepo(t, name) {
  const dir = makeDir(t, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

// A repository whose root basename is exactly the given name, so the derived name collides on purpose.
function makeRepoNamed(t, name) {
  const dir = join(makeDir(t, "register-named"), name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

// The name the offer derives from a repository root: its basename, lowercased.
function derivedName(path) {
  return basename(path).toLowerCase();
}

// Terminal double that answers the question with the given line, or no terminal at all when the answer is null.
function terminal(answer) {
  if (answer === null) return { stdin: { isTTY: false }, stdout: new PassThrough(), written: [] };
  const stdin = Readable.from([answer]);
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const written = [];
  stdout.on("data", (chunk) => written.push(String(chunk)));
  return { stdin, stdout, written };
}

// Context that captures the output of the CLI and drives the question with a terminal double.
function makeCtx(env, { cwd, answer = null } = {}) {
  const out = [];
  const err = [];
  const tty = terminal(answer);
  const ctx = {
    ...defaultContext(),
    env,
    cwd,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: tty.stdin,
    stdout: tty.stdout,
  };
  return { ctx, out, err, asked: () => tty.written.join("") };
}

// The checkout path the registry holds for a project of a home, or undefined when it holds none.
function registeredPath(env, name) {
  if (!existsSync(dbPath(env))) return undefined;
  return registry.projectByName(openDb(env), name)?.path ?? undefined;
}

// Names of the registered projects of a home, whether or not it was ever written to.
function registeredNames(env) {
  if (!existsSync(dbPath(env))) return [];
  return registry.listProjects(openDb(env)).map((project) => project.name).sort();
}

// Registers a repository under the given name, so the derivation of another one collides with it.
function preregister(t, env, name) {
  const path = makeRepo(t, `taken-${name}`);
  registerCheckout(env, { path, name });
  return path;
}

test("queue add registers the repository of the current directory after one question, on Enter and on `y`", async (t) => {
  const env = makeHome(t, "register-yes");
  const repo = makeRepo(t, "register-yes-repo");
  const name = derivedName(repo);

  const key = offeredKey(env, name);
  const first = makeCtx(env, { cwd: repo, answer: "\n" });
  assert.equal(await run(["queue", "add", "fix", "the", "worker"], first.ctx), 0, first.err.join("\n"));
  assert.equal(first.asked(), question(repo, name, key));
  const path = registeredPath(env, name);
  assert.ok(path, `\`${name}\` is missing from the registry`);
  assert.ok(first.out.includes(`registered project \`${name}\` (${path}) with key ${key}`), first.out.join("\n"));
  assert.equal(registeredKey(env, name), key);
  assert.equal(first.out.some((line) => line.includes("resolved from the current directory")), false, first.out.join("\n"));
  assert.equal(getJob(1, env).prompt, "fix the worker");
  assert.equal(getJob(1, env).project, name);

  const other = makeRepo(t, "register-yes-other");
  const otherKey = offeredKey(env, derivedName(other));
  const second = makeCtx(env, { cwd: other, answer: "y\n" });
  assert.equal(await run(["queue", "add", "fix", "the", "parser"], second.ctx), 0, second.err.join("\n"));
  assert.equal(second.asked(), question(other, derivedName(other), otherKey));
  assert.equal(getJob(2, env).project, derivedName(other));
});

test("queue add answered with `n` keeps today's error, registers nothing and queues nothing", async (t) => {
  const env = makeHome(t, "register-no");
  const repo = makeRepo(t, "register-no-repo");
  const { ctx, err, asked } = makeCtx(env, { cwd: repo, answer: "n\n" });

  const key = offeredKey(env, derivedName(repo));
  assert.equal(await run(["queue", "add", "fix the worker"], ctx), 1);
  assert.equal(asked(), question(repo, derivedName(repo), key));
  assert.match(err.join("\n"), /no project registered for .*; run `nightqueue init` here, or pass the project NAME/);
  assert.deepEqual(registeredNames(env), []);
  assert.equal(getJob(1, env), null);
});

test("`--yes` registers with no question, and no terminal without it keeps today's error", async (t) => {
  const env = makeHome(t, "register-yes-flag");
  const repo = makeRepo(t, "register-yes-flag-repo");
  const name = derivedName(repo);

  const forced = makeCtx(env, { cwd: repo });
  assert.equal(await run(["queue", "add", "fix the worker", "--yes"], forced.ctx), 0, forced.err.join("\n"));
  assert.equal(forced.asked(), "");
  assert.deepEqual(registeredNames(env), [name]);
  assert.equal(getJob(1, env).project, name);

  const other = makeRepo(t, "register-yes-flag-other");
  const leading = makeCtx(env, { cwd: other });
  assert.equal(await run(["queue", "add", "--yes", "fix", "the", "parser"], leading.ctx), 0, leading.err.join("\n"));
  assert.equal(getJob(2, env).prompt, "fix the parser");
  assert.deepEqual(registeredNames(env), [name, derivedName(other)].sort());

  const third = makeRepo(t, "register-yes-flag-third");
  const escaped = makeCtx(env, { cwd: third });
  assert.equal(await run(["queue", "add", "--", "explain", "--yes", "to", "me"], escaped.ctx), 1, "`--yes` inside the prompt registered a project");
  assert.equal(escaped.asked(), "");
  assert.match(escaped.err.join("\n"), /no project registered for .*; run `nightqueue init` here/);

  const silent = makeCtx(env, { cwd: third });
  assert.equal(await run(["queue", "add", "fix the linter"], silent.ctx), 1);
  assert.equal(silent.asked(), "");
  assert.match(silent.err.join("\n"), /no project registered for .*; run `nightqueue init` here/);
  assert.deepEqual(registeredNames(env), [name, derivedName(other)].sort());
  assert.equal(getJob(3, env), null);
});

test("queue add outside any repository asks nothing and keeps today's error", async (t) => {
  const env = makeHome(t, "register-bare");
  const bare = makeDir(t, "register-bare-cwd");

  for (const argv of [["queue", "add", "fix the worker"], ["queue", "add", "fix the worker", "--yes"]]) {
    const { ctx, err, asked } = makeCtx(env, { cwd: bare, answer: "\n" });
    assert.equal(await run(argv, ctx), 1, argv.join(" "));
    assert.equal(asked(), "", argv.join(" "));
    assert.match(err.join("\n"), /no project registered for .*; run `nightqueue init` here/);
  }
  assert.deepEqual(registeredNames(env), []);
  assert.equal(getJob(1, env), null);
});

test("queue add offers the next free name when the derived one is already taken", async (t) => {
  const env = makeHome(t, "register-collision");
  const repo = makeRepo(t, "register-collision-repo");
  const name = derivedName(repo);
  const taken = preregister(t, env, name);

  const key = offeredKey(env, `${name}-2`);
  const second = makeCtx(env, { cwd: repo, answer: "\n" });
  assert.equal(await run(["queue", "add", "fix the worker"], second.ctx), 0, second.err.join("\n"));
  assert.equal(second.asked(), question(repo, `${name}-2`, key));
  assert.equal(getJob(1, env).project, `${name}-2`);
  assert.equal(basename(registeredPath(env, name)), basename(taken), "the entry that was already there moved");

  const third = makeCtx(env, { cwd: makeRepoNamed(t, name), answer: "\n" });
  assert.equal(await run(["queue", "add", "fix the parser"], third.ctx), 0, third.err.join("\n"));
  assert.ok(third.asked().includes(`Register it as \`${name}-3\``), third.asked());
  assert.equal(getJob(2, env).project, `${name}-3`);
  assert.deepEqual(registeredNames(env), [name, `${name}-2`, `${name}-3`]);
});

test("queue add inside an unattended job refuses to register, and still queues against a registered project", async (t) => {
  const env = makeHome(t, "register-inside-job");
  env.NIGHTQUEUE_JOB_ID = "7";
  const repo = makeRepo(t, "register-inside-job-repo");

  for (const argv of [["queue", "add", "fix the worker", "--yes"], ["queue", "add", "fix the worker"]]) {
    const { ctx, err, asked } = makeCtx(env, { cwd: repo, answer: "\n" });
    assert.equal(await run(argv, ctx), 1, argv.join(" "));
    assert.equal(asked(), "", argv.join(" "));
    assert.match(err.join("\n"), /refusing to register .* from inside job `7`: an unattended run never registers a project/);
  }
  assert.equal(existsSync(join(homeDir(env), "config.json")), false, "the refusal wrote config.json");
  assert.deepEqual(registeredNames(env), []);
  assert.equal(getJob(1, env), null);

  const alpha = makeProject(t, env, "alpha");
  const byName = makeCtx(env, { cwd: repo });
  assert.equal(await run(["queue", "add", "alpha", "fix", "the", "parser"], byName.ctx), 0, byName.err.join("\n"));
  assert.equal(getJob(1, env).project, "alpha");

  const byPath = makeCtx(env, { cwd: alpha });
  assert.equal(await run(["queue", "add", "fix the linter"], byPath.ctx), 0, byPath.err.join("\n"));
  assert.equal(getJob(2, env).project, "alpha");
  assert.deepEqual(registeredNames(env), ["alpha"]);
});

test("queue add registers the repository root when the current directory is inside it", async (t) => {
  const env = makeHome(t, "register-subdir");
  const repo = makeRepo(t, "register-subdir-repo");
  const inside = join(repo, "src", "api");
  mkdirSync(inside, { recursive: true });
  const name = derivedName(repo);
  const key = offeredKey(env, name);
  const { ctx, out, err, asked } = makeCtx(env, { cwd: inside, answer: "\n" });

  assert.equal(await run(["queue", "add", "fix the worker"], ctx), 0, err.join("\n"));
  assert.equal(asked(), question(inside, name, key));
  const path = registeredPath(env, name);
  assert.equal(basename(path), basename(repo), `the registered path is not the repository root: ${path}`);
  assert.ok(out.includes(`registered project \`${name}\` (${path}) with key ${key}`), out.join("\n"));
  assert.equal(getJob(1, env).project, name);
});

test("queue add --key names the key in the question and registers the project under it", async (t) => {
  const env = makeHome(t, "register-key-flag");
  const repo = makeRepo(t, "register-key-flag-repo");
  const name = derivedName(repo);

  const asked = makeCtx(env, { cwd: repo, answer: "\n" });
  assert.equal(await run(["queue", "add", "--key", "rk1", "fix the worker"], asked.ctx), 0, asked.err.join("\n"));
  assert.equal(asked.asked(), question(repo, name, "RK1"));
  assert.equal(registeredKey(env, name), "RK1");

  const other = makeRepo(t, "register-key-flag-other");
  const forced = makeCtx(env, { cwd: other });
  assert.equal(await run(["queue", "add", "--yes", "--key", "RK2", "fix the parser"], forced.ctx), 0, forced.err.join("\n"));
  assert.equal(registeredKey(env, derivedName(other)), "RK2");

  const third = makeRepo(t, "register-key-flag-third");
  const taken = makeCtx(env, { cwd: third });
  assert.equal(await run(["queue", "add", "--yes", "--key", "RK1", "fix the linter"], taken.ctx), 1);
  assert.match(taken.err.join("\n"), /key `RK1` is taken: it is the key of project/);

  const invalid = makeCtx(env, { cwd: third });
  assert.equal(await run(["queue", "add", "--yes", "--key", "9x", "fix the linter"], invalid.ctx), 1);
  assert.match(invalid.err.join("\n"), /key `9x` is invalid/);
  assert.equal(getJob(3, env), null);
});
