import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { readSecret } from "../src/cli/prompt.mjs";
import { closeDb } from "../src/memory/db.mjs";
import { saveLesson } from "../src/memory/lessons.mjs";
import { assertIsolatedEnv, isolatedHostVars } from "../test-support/host.mjs";

const CLI = fileURLToPath(new URL("../bin/nightshift.mjs", import.meta.url));
const SENTINEL = "s3cr3t-sentinel-do-not-print";
const HOST_DIR = mkdtempSync(join(tmpdir(), "nightshift-cli-host-"));
const HOST_VARS = isolatedHostVars(HOST_DIR);

after(() => rmSync(HOST_DIR, { recursive: true, force: true }));

// Creates a temporary directory removed at the end of the test.
function makeDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `nightshift-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Creates a real git repository, without network or commits.
function makeRepo(t, name) {
  const dir = makeDir(t, name);
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

// Runs the CLI in its own process, with an isolated configuration home.
function runCli(home, args, { input = "", cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: assertIsolatedEnv({ ...process.env, ...HOST_VARS, NIGHTSHIFT_HOME: home }),
    input,
    cwd,
    encoding: "utf8",
  });
}

// Builds a CLI context that captures the output instead of writing to the terminal, always isolated from the real host.
function makeContext(home, overrides = {}) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env: assertIsolatedEnv({ ...HOST_VARS, NIGHTSHIFT_HOME: home }),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { write: () => {} },
    ...overrides,
  };
  return { ctx, out, err };
}

test("--help lists every command and exits 0", () => {
  const result = runCli(tmpdir(), ["--help"]);
  assert.equal(result.status, 0);
  const commands = [
    "setup",
    "doctor",
    "init",
    "update",
    "org",
    "project",
    "connection",
    "mcp",
    "hook",
    "reflect",
    "embed",
    "memory",
    "queue",
    "version",
  ];
  for (const command of commands) {
    assert.match(result.stdout, new RegExp(`^  ${command}`, "m"));
  }
  assert.equal(runCli(tmpdir(), []).status, 0);
});

test("--version and version print the package version and exit 0", () => {
  const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  const flag = runCli(tmpdir(), ["--version"]);
  assert.equal(flag.status, 0);
  assert.equal(flag.stdout.trim(), packageJson.version);
  const subcommand = runCli(tmpdir(), ["version"]);
  assert.equal(subcommand.status, 0);
  assert.equal(subcommand.stdout.trim(), packageJson.version);
  const withExtraArg = runCli(tmpdir(), ["version", "extra"]);
  assert.equal(withExtraArg.status, 1);
  assert.match(withExtraArg.stderr, /unexpected argument/);
});

test("setup is idempotent file by file", (t) => {
  const home = join(makeDir(t, "setup"), "home");
  const first = runCli(home, ["setup"]);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /^home: created \(.*, 0700\)$/m);
  assert.match(first.stdout, /^config\.json: created \(org `default`\)$/m);
  assert.match(first.stdout, /^secrets\.json: created \(0600\)$/m);
  const before = ["config.json", "secrets.json"].map((file) => readFileSync(join(home, file), "utf8"));
  const second = runCli(home, ["setup"]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /^home: already present/m);
  assert.match(second.stdout, /^config\.json: already present$/m);
  assert.match(second.stdout, /^secrets\.json: already present$/m);
  assert.deepEqual(["config.json", "secrets.json"].map((file) => readFileSync(join(home, file), "utf8")), before);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, "secrets.json")).mode & 0o777, 0o600);
});

test("init registers the repository in the default org", (t) => {
  const home = join(makeDir(t, "init-home"), "home");
  const repo = makeRepo(t, "init-repo");
  const result = runCli(home, ["init", repo, "--name", "api", "--no-gh"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^home: created \(.*, 0700\)$/m, "init did not run the setup before registering the project");
  assert.match(result.stdout, /^config\.json: created \(org `default`\)$/m);
  assert.match(result.stdout, /^secrets\.json: created \(0600\)$/m);
  assert.ok(
    result.stdout.indexOf("home: created") < result.stdout.indexOf("registered project `api`"),
    "the project was registered before the host was set up",
  );
  assert.match(result.stdout, /registered project `api` -> .* \(org `default`\)/);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(config.projects.api.org, "default");
  const again = runCli(home, ["init", repo, "--name", "api", "--no-gh"]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /^home: already present/m);
  assert.match(again.stdout, /already registered/);
});

test("a write command works on a home that never went through setup", (t) => {
  const home = join(makeDir(t, "virgin"), "home");
  const result = runCli(home, ["org", "add", "acme"]);
  assert.equal(result.status, 0);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).orgs), ["default", "acme"]);
});

test("the secret never shows up in any output, in any format", (t) => {
  const home = makeDir(t, "sweep-home");
  const repo = makeRepo(t, "sweep-repo");
  const runs = [
    runCli(home, ["setup"]),
    runCli(home, ["init", repo, "--name", "api", "--no-gh"]),
    runCli(home, ["connection", "add", "gh", "--type", "github"], { input: `${SENTINEL}\n` }),
    runCli(home, ["connection", "add", "gh", "--type", "github"], { input: `${SENTINEL}\n` }),
    runCli(home, ["connection", "list"]),
    runCli(home, ["connection", "list", "--json"]),
    runCli(home, ["connection", "bind", "gh", "--org", "ghost"]),
    runCli(home, ["connection", "bind", "gh", "--org", "default"]),
    runCli(home, ["connection", "test", "gh", "--org", "default"]),
    runCli(home, ["org", "list"]),
    runCli(home, ["org", "list", "--json"]),
    runCli(home, ["project", "list"]),
    runCli(home, ["project", "list", "--json"]),
    runCli(home, ["connection", "remove", "gh"]),
    runCli(home, ["bogus"]),
  ];
  for (const [index, result] of runs.entries()) {
    assert.equal(`${result.stdout}${result.stderr}`.includes(SENTINEL), false, `run ${index}`);
  }
  assert.equal(runs[2].status, 0);
  assert.match(runs[3].stderr, /connection `gh` already exists/);
  assert.equal(runs[3].status, 1);
  assert.match(runs[6].stderr, /unknown org `ghost`/);
  assert.equal(runs[14].status, 1);
});

test("the stored secret lives in secrets.json, which stays 0600", (t) => {
  const home = makeDir(t, "secret-home");
  runCli(home, ["setup"]);
  const added = runCli(home, ["connection", "add", "gh", "--type", "github"], { input: `${SENTINEL}\n` });
  assert.equal(added.status, 0);
  assert.match(added.stdout, /stored connection `gh` \(github\) and bound it to org `default`/);
  const secretsFile = join(home, "secrets.json");
  assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(secretsFile, "utf8").includes(SENTINEL), true);
  const listed = JSON.parse(runCli(home, ["connection", "list", "--json"]).stdout);
  assert.deepEqual(listed, { connections: [{ name: "gh", type: "github", present: true, orgs: ["default"] }] });
  assert.equal(runCli(home, ["connection", "remove", "gh"]).status, 0);
  assert.equal(readFileSync(secretsFile, "utf8").includes(SENTINEL), false);
});

test("connection add warns when the org slot is already taken", (t) => {
  const home = makeDir(t, "slot-home");
  runCli(home, ["setup"]);
  runCli(home, ["connection", "add", "gh", "--type", "github"], { input: "one\n" });
  const second = runCli(home, ["connection", "add", "gh2", "--type", "github"], { input: "two\n" });
  assert.equal(second.status, 0);
  assert.match(second.stderr, /already uses `gh` for github; run `nightshift connection bind gh2 --org default` to switch/);
  const bound = runCli(home, ["connection", "bind", "gh2", "--org", "default"]);
  assert.match(bound.stdout, /bound `gh2` to org `default` \(github\) \(replaced `gh`\)/);
});

test("a JSON listing survives being piped, with warnings kept on stderr", (t) => {
  const home = makeDir(t, "json-home");
  runCli(home, ["setup"]);
  const repos = [];
  for (let index = 0; index < 50; index += 1) {
    const repo = join(makeDir(t, "json-repo"), `p${index}`);
    mkdirSync(join(repo, ".git"), { recursive: true });
    repos.push(repo);
    runCli(home, ["project", "add", repo, "--name", `p${index}`]);
  }
  execFileSync("chmod", ["644", join(home, "secrets.json")]);
  const result = runCli(home, ["project", "list", "--json"]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).projects.length, 50);
  const connections = runCli(home, ["connection", "list", "--json"]);
  assert.match(connections.stderr, /is mode 0644, expected 0600/);
  assert.deepEqual(JSON.parse(connections.stdout), { connections: [] });
});

test("unknown options are rejected instead of silently accepted", (t) => {
  const home = makeDir(t, "opts-home");
  runCli(home, ["setup"]);
  runCli(home, ["org", "add", "acme"]);
  const forced = runCli(home, ["org", "remove", "acme", "--force"]);
  assert.equal(forced.status, 1);
  assert.match(forced.stderr, /Unknown option '--force'/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).orgs), ["default", "acme"]);
});

test("a positional path that starts with a dash needs the -- separator", (t) => {
  const base = makeDir(t, "dash");
  const home = join(base, "home");
  const repo = join(base, "-weird-dir");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const rejected = runCli(home, ["init", "-weird-dir", "--no-gh"], { cwd: base });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Unknown option/);
  const accepted = runCli(home, ["init", "--no-gh", "--", "-weird-dir"], { cwd: base });
  assert.equal(accepted.status, 0);
  assert.match(accepted.stdout, /registered project `weird-dir`/);
});

test("an unexpected failure exits 2 with a stack", () => {
  const result = runCli("/dev/null/nested", ["setup"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /at /);
  assert.doesNotMatch(result.stderr, /^nightshift: /m);
});

test("connection test reports login and scopes, and fails as a user error", async (t) => {
  const home = makeDir(t, "test-home");
  runCli(home, ["setup"]);
  runCli(home, ["connection", "add", "gh", "--type", "github"], { input: `${SENTINEL}\n` });
  const okResponse = {
    status: 200,
    headers: new Headers({ "X-OAuth-Scopes": "repo" }),
    json: async () => ({ login: "octocat" }),
  };
  const ok = makeContext(home, { fetchImpl: async () => okResponse });
  assert.equal(await run(["connection", "test", "gh"], ok.ctx), 0);
  assert.deepEqual(ok.out, ["gh (github): ok — login=octocat scopes=repo"]);
  const denied = makeContext(home, {
    fetchImpl: async () => ({ status: 401, headers: new Headers(), json: async () => ({}) }),
  });
  assert.equal(await run(["connection", "test", "gh"], denied.ctx), 1);
  assert.deepEqual(denied.err, ["nightshift: gh (github): failed — HTTP 401"]);
  assert.equal(JSON.stringify([ok.out, ok.err, denied.out, denied.err]).includes(SENTINEL), false);
});

test("a failed config write after the secret write points at the recovery command", async (t) => {
  const home = makeDir(t, "partial-add");
  const { ctx, err } = makeContext(home, {
    stdin: Readable.from([`${SENTINEL}\n`]),
    saveConfig: () => {
      throw new Error("disk on fire");
    },
  });
  assert.equal(await run(["connection", "add", "gh", "--type", "github"], ctx), 2);
  assert.match(err.join("\n"), /secret stored for `gh`, but the config write failed: disk on fire/);
  assert.match(err.join("\n"), /run `nightshift connection bind gh --org default`/);
  assert.equal(readFileSync(join(home, "secrets.json"), "utf8").includes(SENTINEL), true);
  assert.equal(statSync(join(home, "config.json"), { throwIfNoEntry: false }), undefined);
});

test("a failed secret write after the config write points at the recovery command", async (t) => {
  const home = makeDir(t, "partial-remove");
  runCli(home, ["setup"]);
  runCli(home, ["connection", "add", "gh", "--type", "github"], { input: `${SENTINEL}\n` });
  const { ctx, err } = makeContext(home, {
    saveSecrets: () => {
      throw new Error("disk on fire");
    },
  });
  assert.equal(await run(["connection", "remove", "gh"], ctx), 2);
  assert.match(err.join("\n"), /unbound `gh` from all orgs, but the secret file write failed: disk on fire/);
  assert.match(err.join("\n"), /run `nightshift connection remove gh` again/);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(config.orgs.default.connections.github, null);
  assert.equal(readFileSync(join(home, "secrets.json"), "utf8").includes(SENTINEL), true);
});

test("the hidden prompt never echoes and always restores the terminal", async () => {
  const rawModeCalls = [];
  let handler = null;
  const stdin = {
    isTTY: true,
    setRawMode: (value) => rawModeCalls.push(value),
    on: (event, fn) => {
      if (event === "data") handler = fn;
    },
    off: () => {
      handler = null;
    },
    pause: () => {},
  };
  const written = [];
  const stdout = { write: (chunk) => written.push(chunk) };

  const typed = readSecret({ stdin, stdout, prompt: "token: " });
  handler(Buffer.from([0x61, 0x62, 0x78, 0x7f, 0x63, 0x0d]));
  assert.equal(await typed, "abc");
  assert.deepEqual(rawModeCalls, [true, false]);
  assert.equal(written.join("").includes("abc"), false);

  const aborted = readSecret({ stdin, stdout, prompt: "token: " });
  handler(Buffer.from([0x03]));
  await assert.rejects(aborted, /aborted/);
  assert.deepEqual(rawModeCalls, [true, false, true, false]);
});

test("memory stats answers on a home that has no database yet", (t) => {
  const home = makeDir(t, "memory-stats");
  const result = runCli(home, ["memory", "stats"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^project\s+lessons\s+memory\s+index\s+libs\s+runs$/m);
  assert.match(result.stdout, /^\(global\)/m);
  assert.deepEqual(JSON.parse(runCli(home, ["memory", "stats", "--json"]).stdout), { projects: [] });
});

test("the session start hook prints the lessons already stored for the repository", (t) => {
  const home = makeDir(t, "hook-home");
  const repo = makeRepo(t, "hook-repo");
  assert.equal(runCli(home, ["init", repo, "--name", "api", "--no-gh"]).status, 0);
  const env = { NIGHTSHIFT_HOME: home };
  t.after(() => closeDb(env));
  const { id } = saveLesson(
    {
      project: "api",
      title: "the worker leaks a file descriptor on failure",
      root_cause: "the early return skipped the close",
      solution: "close it in a finally block",
      prevention: "always close the file descriptor in a finally block",
    },
    env,
  );
  closeDb(env);

  const result = runCli(home, ["hook", "session-start"], { input: JSON.stringify({ session_id: "s1", cwd: repo }) });
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`\\[L${id}\\] the worker leaks a file descriptor on failure`));
});

test("an unknown hook names the valid ones", (t) => {
  const home = makeDir(t, "hook-unknown");
  const result = runCli(home, ["hook", "nope"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown hook `nope`; use: session-start, prompt-context, reflect/);
});
