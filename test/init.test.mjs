import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { ghAuthStatus } from "../src/host/gh.mjs";
import { FAKE_GH_LOGIN, FAKE_GH_TOKEN, makeHostEnv, readSettingsFile } from "../test-support/host.mjs";
import { makeDir } from "../test-support/memory.mjs";

const QUESTION = `GitHub CLI is authenticated as ${FAKE_GH_LOGIN} — import its token as connection "gh"? [Y/n] `;

// Response of a GitHub API that accepts the token, in the shape `testConnection` reads.
function okResponse() {
  return { status: 200, headers: new Headers({ "X-OAuth-Scopes": "repo" }), json: async () => ({ login: FAKE_GH_LOGIN }) };
}

// Context that captures the output, answers the network with a double and never reaches the real host.
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
    fetchImpl: async () => okResponse(),
    ...overrides,
  };
  return { ctx, out, err, text: () => `${out.join("\n")}\n${err.join("\n")}` };
}

// A directory that looks like a git repository, without calling git.
function makeRepo(t, name) {
  const dir = makeDir(t, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

// Terminal double that answers the question with the given line.
function tty(answer) {
  const stdin = Readable.from([answer]);
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const written = [];
  stdout.on("data", (chunk) => written.push(String(chunk)));
  return { stdin, stdout, written };
}

// Parsed config.json of a home.
function readConfig(home) {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
}

// Host whose fake GitHub CLI reports an authenticated account.
function makeAuthenticatedHost(t, name) {
  const host = makeHostEnv(t, name);
  host.env.NIGHTSHIFT_FAKE_GH_STATE = "authenticated";
  return host;
}

// Names of the fake GitHub CLI subcommands the run called.
function ghSubcommands(host) {
  return host.ghCalls().map((call) => call.join(" "));
}

test("init sets the host up, registers the project and stays idempotent", async (t) => {
  const host = makeHostEnv(t, "init-bootstrap");
  const repo = makeRepo(t, "init-bootstrap-repo");
  const first = makeCtx(host.env);

  assert.equal(await run(["init", "--no-path", repo, "--name", "api", "--no-gh"], first.ctx), 0);
  assert.ok(first.out.some((line) => line.startsWith("home: created")), first.out.join("\n"));
  assert.ok(first.out.some((line) => line.startsWith("secrets.json: created")), first.out.join("\n"));
  assert.match(first.out.join("\n"), /registered project `api` -> .* \(org `default`\)/);
  assert.equal(statSync(host.home).mode & 0o777, 0o700);
  assert.equal(statSync(join(host.home, "secrets.json")).mode & 0o777, 0o600);
  assert.equal(readConfig(host.home).projects.api.org, "default");
  assert.ok(readSettingsFile(host.configDir).hooks.SessionStart.length, "the hooks were not merged into the host");
  assert.ok(host.calls().some((call) => call[0] === "mcp" && call[1] === "add"), "the MCP server was not registered");
  assert.deepEqual(host.ghCalls(), [], "`--no-gh` invoked the GitHub CLI");

  const second = makeCtx(host.env, { cwd: repo });
  assert.equal(await run(["init", "--no-path", "--no-gh"], second.ctx), 0);
  assert.ok(second.out.some((line) => line.startsWith("home: already present")), second.out.join("\n"));
  assert.ok(second.out.some((line) => line.startsWith("config.json: already present")), second.out.join("\n"));
  assert.match(second.out.join("\n"), /project `api` already registered/);
  assert.deepEqual(host.ghCalls(), []);
});

test("--gh imports the token of the GitHub CLI, binds it to the org and reports the connection test", async (t) => {
  const host = makeAuthenticatedHost(t, "init-gh");
  const repo = makeRepo(t, "init-gh-repo");
  const { ctx, out, text } = makeCtx(host.env);

  assert.equal(await run(["init", "--no-path", repo, "--name", "api", "--gh"], ctx), 0);
  assert.ok(out.includes("stored connection `gh` (github) and bound it to org `default`"), out.join("\n"));
  assert.ok(out.includes(`gh (github): ok — login=${FAKE_GH_LOGIN} scopes=repo`), out.join("\n"));
  assert.equal(readConfig(host.home).orgs.default.connections.github, "gh");
  assert.equal(readFileSync(join(host.home, "secrets.json"), "utf8").includes(FAKE_GH_TOKEN), true);
  assert.deepEqual(ghSubcommands(host), ["auth status", "auth token"]);
  assert.equal(text().includes(FAKE_GH_TOKEN), false, "the token showed up in the output");
});

test("the token never shows up in any listing of the CLI", async (t) => {
  const host = makeAuthenticatedHost(t, "init-gh-sweep");
  const repo = makeRepo(t, "init-gh-sweep-repo");
  const { ctx, text } = makeCtx(host.env);

  assert.equal(await run(["init", "--no-path", repo, "--name", "api", "--gh"], ctx), 0);
  for (const argv of [["connection", "list"], ["connection", "list", "--json"], ["project", "list", "--json"], ["queue", "status", "--json"]]) {
    assert.equal(await run(argv, ctx), 0, argv.join(" "));
  }
  assert.equal(text().includes(FAKE_GH_TOKEN), false, "a listing printed the token");
  assert.equal(readFileSync(join(host.home, "secrets.json"), "utf8").includes(FAKE_GH_TOKEN), true);
});

test("an occupied slot and a name already taken stop the import, with --gh included", async (t) => {
  const host = makeAuthenticatedHost(t, "init-gh-slot");
  const repo = makeRepo(t, "init-gh-slot-repo");
  const first = makeCtx(host.env);
  assert.equal(await run(["init", "--no-path", repo, "--name", "api", "--gh"], first.ctx), 0);

  const again = makeCtx(host.env);
  assert.equal(await run(["init", "--no-path", repo, "--name", "api", "--gh"], again.ctx), 0);
  assert.ok(again.out.includes("org `default` already uses `gh` for github; nothing to import"), again.out.join("\n"));
  assert.deepEqual(ghSubcommands(host), ["auth status", "auth token"], "the occupied slot still called the GitHub CLI");

  const other = makeRepo(t, "init-gh-slot-other");
  const moved = makeCtx(host.env);
  assert.equal(await run(["org", "add", "acme"], moved.ctx), 0);
  assert.equal(await run(["connection", "remove", "gh"], moved.ctx), 0);
  assert.equal(
    await run(["connection", "add", "gh", "--type", "github", "--org", "acme"], makeCtx(host.env, { stdin: Readable.from(["other-secret\n"]) }).ctx),
    0,
  );
  const collision = makeCtx(host.env);
  assert.equal(await run(["init", "--no-path", other, "--name", "web", "--gh"], collision.ctx), 0);
  assert.ok(collision.out.includes("connection `gh` already exists; run `shift connection bind gh --org default`"), collision.out.join("\n"));
  assert.equal(readConfig(host.home).projects.web.org, "default");
});

test("without a terminal init only points at the flag, and never reads the token", async (t) => {
  const host = makeAuthenticatedHost(t, "init-gh-no-tty");
  const repo = makeRepo(t, "init-gh-no-tty-repo");
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(["init", "--no-path", repo, "--name", "api"], ctx), 0);
  assert.ok(
    out.includes(`GitHub CLI is authenticated as ${FAKE_GH_LOGIN}; run \`shift init --gh\` to import its token as connection \`gh\``),
    out.join("\n"),
  );
  assert.deepEqual(ghSubcommands(host), ["auth status"]);
  assert.deepEqual(JSON.parse(readFileSync(join(host.home, "secrets.json"), "utf8")).connections, {});
});

test("on a terminal init asks the exact question and honours the answer", async (t) => {
  const accepted = makeAuthenticatedHost(t, "init-gh-yes");
  const yes = tty("y\n");
  const yesRun = makeCtx(accepted.env, { stdin: yes.stdin, stdout: yes.stdout });
  assert.equal(await run(["init", "--no-path", makeRepo(t, "init-gh-yes-repo"), "--name", "api"], yesRun.ctx), 0);
  assert.equal(yes.written.join("").includes(QUESTION), true, `the question changed: ${yes.written.join("")}`);
  assert.equal(readConfig(accepted.home).orgs.default.connections.github, "gh");
  assert.deepEqual(ghSubcommands(accepted), ["auth status", "auth token"]);

  const refused = makeAuthenticatedHost(t, "init-gh-no");
  const no = tty("n\n");
  const noRun = makeCtx(refused.env, { stdin: no.stdin, stdout: no.stdout });
  assert.equal(await run(["init", "--no-path", makeRepo(t, "init-gh-no-repo"), "--name", "api"], noRun.ctx), 0);
  assert.equal(no.written.join("").includes(QUESTION), true);
  assert.ok(
    noRun.out.includes('store a token with `echo "$GITHUB_TOKEN" | shift connection add gh --type github`'),
    noRun.out.join("\n"),
  );
  assert.deepEqual(ghSubcommands(refused), ["auth status"]);
  assert.deepEqual(JSON.parse(readFileSync(join(refused.home, "secrets.json"), "utf8")).connections, {});
});

test("an input that ends without an answer is a no, and the command still finishes", async (t) => {
  const host = makeAuthenticatedHost(t, "init-gh-eof");
  const eof = tty("");
  const { ctx, out } = makeCtx(host.env, { stdin: eof.stdin, stdout: eof.stdout });

  assert.equal(await run(["init", "--no-path", makeRepo(t, "init-gh-eof-repo"), "--name", "api"], ctx), 0);
  assert.ok(out.some((line) => line.startsWith("store a token with")), out.join("\n"));
  assert.deepEqual(ghSubcommands(host), ["auth status"]);
});

test("a GitHub CLI that is missing or logged out costs one line and never an error", async (t) => {
  const missing = makeHostEnv(t, "init-gh-missing");
  missing.env.NIGHTSHIFT_GH_BIN = join(missing.configDir, "does-not-exist");
  const absent = makeCtx(missing.env);
  assert.equal(await run(["init", "--no-path", makeRepo(t, "init-gh-missing-repo"), "--name", "api", "--gh"], absent.ctx), 0);
  assert.ok(
    absent.out.includes('GitHub CLI not found; store a token with `echo "$GITHUB_TOKEN" | shift connection add gh --type github`'),
    absent.out.join("\n"),
  );

  const loggedOut = makeHostEnv(t, "init-gh-logged-out");
  const anonymous = makeCtx(loggedOut.env);
  assert.equal(await run(["init", "--no-path", makeRepo(t, "init-gh-logged-out-repo"), "--name", "api", "--gh"], anonymous.ctx), 0);
  assert.ok(
    anonymous.out.includes("GitHub CLI is not authenticated; run `gh auth login` and then `shift init --gh`"),
    anonymous.out.join("\n"),
  );
  assert.deepEqual(ghSubcommands(loggedOut), ["auth status"]);
});

test("--gh together with --no-gh is refused before anything is installed", async (t) => {
  const host = makeHostEnv(t, "init-gh-conflict");
  const { ctx, err } = makeCtx(host.env);

  assert.equal(await run(["init", "--no-path", makeRepo(t, "init-gh-conflict-repo"), "--gh", "--no-gh"], ctx), 1);
  assert.match(err.join("\n"), /`--gh` and `--no-gh` cannot be used together/);
  assert.equal(existsSync(host.home), false, "a refused init still touched the host");
});

test("a path that is not a git repository stops init before it touches the host", async (t) => {
  const host = makeHostEnv(t, "init-bad-path");
  const { ctx, err } = makeCtx(host.env);

  assert.equal(await run(["init", "--no-path", makeDir(t, "init-bad-path-dir"), "--no-gh"], ctx), 1);
  assert.match(err.join("\n"), /not a git repository \(no \.git\)/);
  assert.equal(existsSync(host.home), false);
});

test("the login is read from either stream of `gh auth status`", () => {
  const onStderr = ghAuthStatus({
    env: {},
    spawnSyncImpl: () => ({ status: 0, stdout: "", stderr: "  Logged in to github.com account octocat (keyring)\n" }),
  });
  assert.deepEqual(onStderr, { authenticated: true, login: "octocat", missing: false });

  const onStdout = ghAuthStatus({
    env: {},
    spawnSyncImpl: () => ({ status: 0, stdout: "github.com\n  Logged in to github.com as octocat\n", stderr: "" }),
  });
  assert.equal(onStdout.login, "octocat");

  const unparsed = ghAuthStatus({ env: {}, spawnSyncImpl: () => ({ status: 0, stdout: "who knows", stderr: "" }) });
  assert.deepEqual(unparsed, { authenticated: true, login: null, missing: false });
});
