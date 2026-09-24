import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { resolvedRuntimeDir } from "../src/config/paths.mjs";
import { ghAuthStatus } from "../src/host/gh.mjs";
import { PATH_MARK, PATH_MARK_END, pathBlock } from "../src/host/shell.mjs";
import { FAKE_GH_LOGIN, FAKE_GH_TOKEN, assertIsolatedEnv, makeHostEnv, readSettingsFile, writeLegacyShim } from "../test-support/host.mjs";
import { makeDir } from "../test-support/memory.mjs";

const QUESTION = `GitHub CLI is authenticated as ${FAKE_GH_LOGIN} — import its token as connection "gh"? [Y/n] `;
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

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
  host.env.NIGHTQUEUE_FAKE_GH_STATE = "authenticated";
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
  assert.match(first.out.join("\n"), /^registered project `api` \(.+\)$/m);
  assert.equal(statSync(host.home).mode & 0o777, 0o700);
  assert.equal(statSync(join(host.home, "secrets.json")).mode & 0o777, 0o600);
  assert.equal(readConfig(host.home).projects.api.org, "default");
  assert.ok(readSettingsFile(host.configDir).hooks.SessionStart.length, "the hooks were not merged into the host");
  assert.ok(host.calls().some((call) => call[0] === "mcp" && call[1] === "add"), "the MCP server was not registered");
  assert.deepEqual(host.ghCalls(), [], "`--no-gh` invoked the GitHub CLI");

  const second = makeCtx(host.env, { cwd: repo });
  assert.equal(await run(["init", "--no-path", "--no-gh"], second.ctx), 0);
  assert.equal(second.out[0], `host already installed (v${VERSION}) - nothing to do`, second.out.join("\n"));
  assert.match(second.out[1], /^registered project `api` \(.+\)$/);
  assert.equal(second.out[2], "Next steps:", second.out.join("\n"));
  assert.equal(second.out.some((line) => line.includes("already present")), false, second.out.join("\n"));
  assert.deepEqual(host.ghCalls(), []);

  const verbose = makeCtx(host.env, { cwd: repo });
  assert.equal(await run(["init", "--no-path", "--no-gh", "--verbose"], verbose.ctx), 0);
  assert.ok(verbose.out.some((line) => line.startsWith("home: already present")), verbose.out.join("\n"));
  assert.ok(verbose.out.some((line) => line.startsWith("config.json: already present")), verbose.out.join("\n"));
  assert.equal(verbose.out.some((line) => line.startsWith("host already installed")), false, verbose.out.join("\n"));
});

test("the semantic recall question is asked once and the second init never brings it back", async (t) => {
  const host = makeHostEnv(t, "init-embedding-question");
  delete host.env.NIGHTQUEUE_EMBED_DISABLED;
  const repo = makeRepo(t, "init-embedding-question-repo");
  const no = tty("n\n");
  const first = makeCtx(host.env, { stdin: no.stdin, stdout: no.stdout });

  assert.equal(await run(["init", "--no-path", repo, "--name", "api", "--no-gh"], first.ctx), 0, first.err.join("\n"));
  assert.equal(no.written.join("").includes("Enable semantic recall?"), true, no.written.join(""));
  assert.ok(first.out.includes("embedding: skipped (declined)"), first.out.join("\n"));
  assert.ok(first.out.includes("semantic recall skipped; run `nightqueue embed install` to enable it"), first.out.join("\n"));
  assert.equal(readConfig(host.home).embedding, "declined");

  const again = tty("n\n");
  const second = makeCtx(host.env, { cwd: repo, stdin: again.stdin, stdout: again.stdout });
  assert.equal(await run(["init", "--no-path", "--no-gh"], second.ctx), 0, second.err.join("\n"));
  assert.equal(again.written.join("").includes("Enable semantic recall?"), false, again.written.join(""));
  assert.equal(second.out[0], `host already installed (v${VERSION}) - nothing to do`, second.out.join("\n"));
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
  assert.ok(collision.out.includes("connection `gh` already exists; run `nightqueue connection bind gh --org default`"), collision.out.join("\n"));
  assert.equal(readConfig(host.home).projects.web.org, "default");
});

test("without a terminal init only points at the flag, and never reads the token", async (t) => {
  const host = makeAuthenticatedHost(t, "init-gh-no-tty");
  const repo = makeRepo(t, "init-gh-no-tty-repo");
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(["init", "--no-path", repo, "--name", "api"], ctx), 0);
  assert.ok(
    out.includes(`GitHub CLI is authenticated as ${FAKE_GH_LOGIN}; run \`nightqueue init --gh\` to import its token as connection \`gh\``),
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
    noRun.out.includes('store a token with `echo "$GITHUB_TOKEN" | nightqueue connection add gh --type github`'),
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
  missing.env.NIGHTQUEUE_GH_BIN = join(missing.configDir, "does-not-exist");
  const absent = makeCtx(missing.env);
  assert.equal(await run(["init", "--no-path", makeRepo(t, "init-gh-missing-repo"), "--name", "api", "--gh"], absent.ctx), 0);
  assert.ok(
    absent.out.includes('GitHub CLI not found; store a token with `echo "$GITHUB_TOKEN" | nightqueue connection add gh --type github`'),
    absent.out.join("\n"),
  );

  const loggedOut = makeHostEnv(t, "init-gh-logged-out");
  const anonymous = makeCtx(loggedOut.env);
  assert.equal(await run(["init", "--no-path", makeRepo(t, "init-gh-logged-out-repo"), "--name", "api", "--gh"], anonymous.ctx), 0);
  assert.ok(
    anonymous.out.includes("GitHub CLI is not authenticated; run `gh auth login` and then `nightqueue init --gh`"),
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

test("a runtime npm could not install stops init before anything else is written", async (t) => {
  const host = makeHostEnv(t, "init-fatal-runtime");
  host.env.NIGHTQUEUE_FAKE_NPM_EXIT = "1";
  const { ctx, out, err } = makeCtx(host.env, { cwd: makeDir(t, "init-fatal-runtime-cwd") });

  assert.equal(await run(["init", "--path", "--no-embedding", "--no-gh"], ctx), 1);
  assert.ok(out.some((line) => line.startsWith("runtime: failed")), out.join("\n"));
  assert.match(err.join("\n"), /the `runtime` step failed/);
  assert.equal(existsSync(host.rcPath), false, "a failed runtime still wrote to the rc file of the user");
  assert.equal(existsSync(host.shim), false, "a failed runtime still wrote a shim pointing at nothing");
  assert.equal(existsSync(host.settingsPath), false, "a failed runtime still registered hooks in the host");
});

test("a shim that cannot answer `--version` stops init before the PATH is touched", async (t) => {
  const host = makeHostEnv(t, "init-fatal-check");
  const refuse = (file, args, options) =>
    file === host.shim ? { status: 1, stdout: "", stderr: "cannot execute binary file" } : spawnSync(file, args, options);
  const { ctx, out, err } = makeCtx(host.env, { cwd: makeDir(t, "init-fatal-check-cwd"), spawnSyncImpl: refuse });

  assert.equal(await run(["init", "--path", "--no-embedding", "--no-gh"], ctx), 1);
  assert.ok(out.some((line) => line.startsWith("runtime check: failed")), out.join("\n"));
  assert.match(err.join("\n"), /the `runtime check` step failed/);
  assert.equal(existsSync(host.rcPath), false, "the PATH was written before the runtime had proven itself");
});

test("a claude CLI that cannot run degrades the host services and still finishes init", async (t) => {
  const host = makeHostEnv(t, "init-claude-broken", { exitCode: 1 });
  const { ctx, out } = makeCtx(host.env, { cwd: makeDir(t, "init-claude-broken-cwd") });

  assert.equal(await run(["init", "--path", "--no-embedding", "--no-gh"], ctx), 0);
  assert.ok(out.some((line) => line.startsWith("mcp nightqueue: failed")), out.join("\n"));
  assert.ok(out.some((line) => line.startsWith("setup finished with")), out.join("\n"));
  assert.equal(readFileSync(host.rcPath, "utf8").includes(pathBlock(host.env)), true, "a degraded host service held the PATH back");

  const again = makeCtx(host.env, { cwd: makeDir(t, "init-claude-broken-again") });
  assert.equal(await run(["init", "--path", "--no-embedding", "--no-gh"], again.ctx), 0);
  assert.ok(again.out.some((line) => line.startsWith("mcp nightqueue: failed")), again.out.join("\n"));
  assert.equal(again.out.some((line) => line.startsWith("host already installed")), false, "a degraded step was hidden behind the summary");
});

test("host settings that are not valid JSON stop init with every step it held back on screen", async (t) => {
  const host = makeHostEnv(t, "init-broken-settings");
  const cwd = makeDir(t, "init-broken-settings-cwd");
  const first = makeCtx(host.env, { cwd });
  assert.equal(await run(["init", "--no-path", "--no-embedding", "--no-gh"], first.ctx), 0, first.err.join("\n"));
  writeFileSync(host.settingsPath, "{ this is not json");

  const broken = makeCtx(host.env, { cwd });
  assert.equal(await run(["init", "--no-path", "--no-embedding", "--no-gh"], broken.ctx), 1);
  assert.match(broken.err.join("\n"), /is not valid JSON/);
  assert.ok(broken.out.some((line) => line.startsWith("home: already present")), broken.out.join("\n"));
  assert.ok(broken.out.some((line) => line.startsWith("runtime: already present")), broken.out.join("\n"));
});

test("a foreign file at the legacy shim path is a no-op and never breaks the quiet re-run", async (t) => {
  const host = makeHostEnv(t, "init-legacy-shim-kept");
  const cwd = makeDir(t, "init-legacy-shim-kept-cwd");
  const first = makeCtx(host.env, { cwd });
  assert.equal(await run(["init", "--no-path", "--no-embedding", "--no-gh"], first.ctx), 0, first.err.join("\n"));
  writeLegacyShim(host, "#!/bin/sh\necho a script of somebody else\n");

  const again = makeCtx(host.env, { cwd });
  assert.equal(await run(["init", "--no-path", "--no-embedding", "--no-gh"], again.ctx), 0, again.err.join("\n"));
  assert.equal(again.out[0], `host already installed (v${VERSION}) - nothing to do`, again.out.join("\n"));
  assert.equal(again.out.some((line) => line.includes("legacy shim")), false, again.out.join("\n"));
  assert.equal(readFileSync(host.legacyShim, "utf8").includes("somebody else"), true, "init deleted a file it did not write");
});

test("the PATH block lands once however many times init runs, and the line of an older installation is migrated", async (t) => {
  const host = makeHostEnv(t, "init-path-block");
  const third = 'export PATH="/opt/x:$PATH"';
  const legacy = `export PATH="${host.binDir}:$PATH" ${PATH_MARK}`;
  writeFileSync(host.rcPath, `${third}\n${legacy}\n`);
  const cwd = makeDir(t, "init-path-block-cwd");

  assert.equal(await run(["init", "--path", "--no-embedding", "--no-gh"], makeCtx(host.env, { cwd }).ctx), 0);
  assert.equal(await run(["init", "--path", "--no-embedding", "--no-gh"], makeCtx(host.env, { cwd }).ctx), 0);
  const rc = readFileSync(host.rcPath, "utf8");
  assert.deepEqual(rc.split("\n"), [third, ...pathBlock(host.env).split("\n"), ""]);
  const opened = rc.split("\n").filter((line) => line === PATH_MARK);
  const closed = rc.split("\n").filter((line) => line === PATH_MARK_END);
  assert.deepEqual([opened.length, closed.length], [1, 1], `the rc file carries more than one block of ours: ${rc}`);
});

test("init closes by saying what it installed, where the block went and how to make the command resolve", async (t) => {
  const host = makeHostEnv(t, "init-final-message");
  const { ctx, out } = makeCtx(host.env, { cwd: makeDir(t, "init-final-message-cwd") });

  assert.equal(await run(["init", "--path", "--no-embedding", "--no-gh"], ctx), 0);
  assert.ok(out.includes(`installed nightqueue v${VERSION} in ${resolvedRuntimeDir(host.env)}`), out.join("\n"));
  assert.ok(out.includes(`commands: ${Object.values(host.shims).join(", ")}`), out.join("\n"));
  assert.ok(out.includes(`PATH block written to ${host.rcPath}:`), out.join("\n"));
  for (const line of pathBlock(host.env).split("\n")) assert.ok(out.includes(`  ${line}`), out.join("\n"));
  assert.ok(
    out.includes("Open a new terminal or run `source ~/.zshrc` (or your shell's rc) to use `nightqueue`."),
    out.join("\n"),
  );
});

test("a skipped PATH step is never sold as written", async (t) => {
  const host = makeHostEnv(t, "init-no-path-message");
  const { ctx, out } = makeCtx(host.env, { cwd: makeDir(t, "init-no-path-message-cwd") });

  assert.equal(await run(["init", "--no-path", "--no-embedding", "--no-gh"], ctx), 0);
  assert.ok(out.includes(`installed nightqueue v${VERSION} in ${resolvedRuntimeDir(host.env)}`), out.join("\n"));
  assert.equal(out.some((line) => line.startsWith("PATH block written to")), false, out.join("\n"));
  assert.equal(out.some((line) => line.startsWith("Open a new terminal")), false, out.join("\n"));
});

const LAST_STEPS = [
  '  2. When you leave, say "run the queue" or run `nightqueue queue run` - every queued job runs unattended and opens a pull request.',
  '  3. Come back to `nightqueue queue status` and review the PRs; a job waiting at the gate is answered with `nightqueue queue retry <id> --note "..."`.',
];

const NEXT_STEPS_REGISTERED = [
  "Next steps:",
  '  1. In Claude Code, plan as usual, then say "queue this for tonight" or run /nightqueue:queue.',
  ...LAST_STEPS,
];

const NEXT_STEPS_UNREGISTERED = [
  "Next steps:",
  '  1. cd into a repository and run `nightqueue queue add "<task>"` - it offers to register the project on the spot. In Claude Code, plan as usual and say "queue this for tonight" or run /nightqueue:queue.',
  ...LAST_STEPS,
];

test("init closes with the next steps, with no PATH block written and outside a repository too", async (t) => {
  const bare = makeHostEnv(t, "init-next-steps-bare");
  const outside = makeCtx(bare.env, { cwd: makeDir(t, "init-next-steps-bare-cwd") });

  assert.equal(await run(["init", "--no-path", "--no-embedding", "--no-gh"], outside.ctx), 0);
  assert.equal(existsSync(bare.rcPath), false, "the run under test wrote the PATH block after all");
  assert.equal(outside.out.some((line) => line.startsWith("no git repository in")), false, outside.out.join("\n"));
  assert.deepEqual(outside.out.slice(-NEXT_STEPS_UNREGISTERED.length), NEXT_STEPS_UNREGISTERED, outside.out.join("\n"));

  const host = makeHostEnv(t, "init-next-steps-repo");
  const inside = makeCtx(host.env, { cwd: makeRepo(t, "init-next-steps-repo-cwd") });

  assert.equal(await run(["init", "--path", "--no-embedding", "--no-gh"], inside.ctx), 0);
  assert.equal(readFileSync(host.rcPath, "utf8").includes(pathBlock(host.env)), true);
  assert.deepEqual(inside.out.slice(-NEXT_STEPS_REGISTERED.length), NEXT_STEPS_REGISTERED, inside.out.join("\n"));
  assert.equal(inside.out.some((line) => line.startsWith("  4.")), false, inside.out.join("\n"));
  assert.equal(inside.out.some((line) => line.includes("nightqueue project add")), false, inside.out.join("\n"));
});

test("init packs this package, installs the tarball and leaves a host the doctor passes", async (t) => {
  const host = makeHostEnv(t, "init-e2e");
  assertIsolatedEnv(host.env);
  const { ctx, out } = makeCtx(host.env, { cwd: makeDir(t, "init-e2e-cwd") });

  assert.equal(await run(["init", "--path", "--no-embedding", "--no-gh"], ctx), 0);
  const [pack, install] = host.npmCalls();
  assert.equal(pack[0], "pack");
  assert.equal(pack.at(-1), PACKAGE_ROOT);
  assert.equal(existsSync(pack[pack.indexOf("--pack-destination") + 1]), false, "the pack left its temporary directory behind");
  assert.equal(install.at(-1).endsWith(".tgz"), true, install.join(" "));
  assert.equal(host.npmCalls().some((call) => call.includes("-g") || call.includes("--global") || call.includes("sudo")), false);
  assert.ok(out.some((line) => line.startsWith(`runtime check: ok (v${VERSION}`)), out.join("\n"));

  const report = [];
  const doctor = { ...ctx, out: (line) => report.push(line) };
  assert.equal(await run(["doctor", "--json"], doctor), 0, report.join("\n"));
  assert.deepEqual(JSON.parse(report[0]).checks.filter((check) => check.status === "fail"), []);
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
