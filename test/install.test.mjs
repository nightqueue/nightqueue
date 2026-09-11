import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { PATH_MARK, pathBlock } from "../src/host/shell.mjs";
import { assertIsolatedEnv, makeHostEnv, readSettingsFile, writeLegacyShim } from "../test-support/host.mjs";
import { makeDir } from "../test-support/memory.mjs";

const CHECKOUT = fileURLToPath(new URL("../", import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const THIRD_PARTY = 'export PATH="/opt/x:$PATH"';

// Context that captures the output and refuses to run against anything but an isolated environment.
function makeCtx(env, overrides = {}) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env: assertIsolatedEnv(env),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: { isTTY: false },
    stdout: new PassThrough(),
    ...overrides,
  };
  return { ctx, out, err };
}

// Terminal double that answers every question with the given line.
function tty(answer) {
  const stdin = Readable.from([answer]);
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const written = [];
  stdout.on("data", (chunk) => written.push(String(chunk)));
  return { stdin, stdout, written: () => written.join("") };
}

// Host whose embedding step is offered instead of being disabled by the environment.
function makeEmbeddingHost(t, name) {
  const host = makeHostEnv(t, name);
  delete host.env.NIGHTSHIFT_EMBED_DISABLED;
  return host;
}

// npm calls of the run that installed something into the given prefix.
function installsInto(host, prefix) {
  return host.npmCalls().filter((call) => call[0] === "install" && call.includes(prefix));
}

// Specifiers the run installed into the given prefix, in the order npm received them.
function specsInto(host, prefix) {
  return installsInto(host, prefix).map((call) => call.at(-1));
}

// Directories the run packed into a tarball, in the order npm received them.
function packedDirs(host) {
  return host.npmCalls().filter((call) => call[0] === "pack").map((call) => call.at(-1));
}

// Content of the rc file of the isolated user home, or an empty string when it was never written.
function readRc(host) {
  return existsSync(host.rcPath) ? readFileSync(host.rcPath, "utf8") : "";
}

test("init outside a repository installs the whole host and only skips the project registration", async (t) => {
  const host = makeHostEnv(t, "install-outside-repo");
  const plain = makeDir(t, "install-outside-repo-cwd");
  const { ctx, out } = makeCtx(host.env, { cwd: plain });

  assert.equal(await run(["init", "--no-path", "--no-embedding", "--no-gh"], ctx), 0);
  assert.equal(existsSync(join(host.runtimePackage, "package.json")), true);
  assert.equal(existsSync(host.shim), true);
  assert.equal(existsSync(join(host.home, "config.json")), true);
  assert.ok(readSettingsFile(host.configDir).hooks.SessionStart.length, "the hooks were not merged into the host");
  assert.equal(out.some((line) => line.startsWith("no git repository in")), false, out.join("\n"));
  assert.ok(
    out.includes('  1. cd into a repository and run `nightshift queue add "<task>"` - it offers to register the project on the spot. In Claude Code, plan as usual and say "queue this for tonight" or run /nightshift:queue.'),
    out.join("\n"),
  );
  assert.deepEqual(JSON.parse(readFileSync(join(host.home, "config.json"), "utf8")).projects, {});
});

test("--from packs the given checkout and reinstalls even when the version already matches", async (t) => {
  const host = makeHostEnv(t, "install-from");
  const first = makeCtx(host.env);
  assert.equal(await run(["init", "--from", CHECKOUT, "--no-path", "--no-embedding", "--no-gh"], first.ctx), 0);
  assert.deepEqual(packedDirs(host), [CHECKOUT.replace(/\/$/, "")]);
  assert.deepEqual(specsInto(host, host.runtimeDir).map((spec) => spec.endsWith(".tgz")), [true], "--from installed a directory instead of a tarball of it");
  assert.equal(JSON.parse(readFileSync(join(host.runtimePackage, "package.json"), "utf8")).version, VERSION);

  const second = makeCtx(host.env);
  assert.equal(await run(["init", "--from", CHECKOUT, "--no-path", "--no-embedding", "--no-gh"], second.ctx), 0);
  assert.equal(installsInto(host, host.runtimeDir).length, 2, "--from short-circuited instead of reinstalling");
});

test("the three shims are created executable and all point at the entry of the runtime", async (t) => {
  const host = makeHostEnv(t, "install-shim");
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(["setup", "--no-path", "--no-embedding"], ctx), 0);
  for (const [name, path] of Object.entries(host.shims)) {
    assert.equal(statSync(path).mode & 0o777, 0o755, `${name} is not executable`);
    assert.equal(readFileSync(path, "utf8"), `#!/bin/sh\nexec node "${host.entry}" "$@"\n`);
    assert.ok(out.includes(`shim ${name}: created (${path})`), out.join("\n"));
  }
});

test("--no-shortcuts writes the canonical shim alone, on setup and on init", async (t) => {
  const host = makeHostEnv(t, "install-no-shortcuts");
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(["setup", "--no-path", "--no-embedding", "--no-shortcuts"], ctx), 0);
  assert.equal(existsSync(host.shims.nightshift), true);
  assert.equal(existsSync(host.shims.nshift), false);
  assert.equal(existsSync(host.shims.nsft), false);
  assert.ok(out.includes("shim shortcuts: skipped (--no-shortcuts)"), out.join("\n"));

  const other = makeHostEnv(t, "init-no-shortcuts");
  const init = makeCtx(other.env, { cwd: makeDir(t, "init-no-shortcuts-cwd") });
  assert.equal(await run(["init", "--no-path", "--no-embedding", "--no-gh", "--no-shortcuts"], init.ctx), 0);
  assert.equal(existsSync(other.shims.nightshift), true);
  assert.equal(existsSync(other.shims.nshift), false);
  assert.equal(existsSync(other.shims.nsft), false);
});

test("--shortcuts together with --no-shortcuts is refused before anything is installed", async (t) => {
  const host = makeHostEnv(t, "install-shortcuts-clash");
  const { ctx, err } = makeCtx(host.env);

  assert.equal(await run(["setup", "--shortcuts", "--no-shortcuts"], ctx), 1);
  assert.match(err.join("\n"), /`--shortcuts` and `--no-shortcuts` cannot be used together/);
  assert.equal(existsSync(host.shims.nightshift), false);
});

test("a setup over the shim of the previous command name removes it and says why", async (t) => {
  const host = makeHostEnv(t, "install-legacy-shim");
  writeLegacyShim(host);
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(["setup", "--no-path", "--no-embedding"], ctx), 0);
  assert.equal(existsSync(host.legacyShim), false);
  assert.ok(out.includes(`legacy shim: removed (${host.legacyShim})`), out.join("\n"));
  assert.ok(
    out.some((line) => line.includes("the `shift` command was renamed to `nightshift`")),
    out.join("\n"),
  );
  assert.equal(existsSync(host.shims.nightshift), true);
});

test("a file of another tool under the previous command name is kept, never deleted", async (t) => {
  const host = makeHostEnv(t, "install-legacy-foreign");
  const foreign = "#!/bin/sh\necho other-tool\n";
  writeLegacyShim(host, foreign);
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(["setup", "--no-path", "--no-embedding"], ctx), 0);
  assert.equal(readFileSync(host.legacyShim, "utf8"), foreign);
  assert.ok(out.includes(`legacy shim: kept (${host.legacyShim} was not written by nightshift)`), out.join("\n"));
});

test("the PATH step asks on a terminal, writes one marked line and never asks again once the directory is there", async (t) => {
  const host = makeHostEnv(t, "install-path-tty");
  writeFileSync(host.rcPath, `${THIRD_PARTY}\n`);
  const terminal = tty("y\n");
  const asked = makeCtx(host.env, { stdin: terminal.stdin, stdout: terminal.stdout });

  assert.equal(await run(["setup", "--no-embedding"], asked.ctx), 0);
  assert.equal(terminal.written().includes(`Add ${host.binDir} to your PATH?`), true, terminal.written());
  assert.equal(terminal.written().includes(host.rcPath), true, terminal.written());
  assert.equal(readRc(host), `${THIRD_PARTY}\n${pathBlock(host.env)}\n`);

  const onPath = { ...host.env, PATH: [host.binDir, host.env.PATH ?? ""].join(delimiter) };
  const again = makeCtx(onPath, { stdin: tty("y\n").stdin });
  assert.equal(await run(["setup", "--no-embedding"], again.ctx), 0);
  assert.equal(readRc(host), `${THIRD_PARTY}\n${pathBlock(host.env)}\n`);
  assert.ok(again.out.includes(`PATH: already present (${host.binDir})`), again.out.join("\n"));
});

test("--no-path never writes, and without a terminal the block is only printed", async (t) => {
  const refused = makeHostEnv(t, "install-path-refused");
  const { ctx, out } = makeCtx(refused.env);
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], ctx), 0);
  assert.equal(existsSync(refused.rcPath), false);
  assert.ok(out.includes("PATH: skipped (--no-path)"), out.join("\n"));

  const quiet = makeHostEnv(t, "install-path-no-tty");
  const silent = makeCtx(quiet.env);
  assert.equal(await run(["setup", "--no-embedding"], silent.ctx), 0);
  assert.equal(existsSync(quiet.rcPath), false, "a run without a terminal wrote to an rc file");
  assert.ok(silent.out.includes("PATH: skipped (no terminal)"), silent.out.join("\n"));
  assert.ok(silent.out.includes(`add this block to ${quiet.rcPath}:`), silent.out.join("\n"));
  for (const line of pathBlock(quiet.env).split("\n")) {
    assert.ok(silent.out.includes(`  ${line}`), silent.out.join("\n"));
  }
});

test("--path writes without asking, and a terminal that says no leaves the rc file alone", async (t) => {
  const forced = makeHostEnv(t, "install-path-forced");
  const { ctx } = makeCtx(forced.env);
  assert.equal(await run(["setup", "--path", "--no-embedding"], ctx), 0);
  assert.equal(readRc(forced), `${pathBlock(forced.env)}\n`);

  const declined = makeHostEnv(t, "install-path-declined");
  const terminal = tty("n\n");
  const answer = makeCtx(declined.env, { stdin: terminal.stdin, stdout: terminal.stdout });
  assert.equal(await run(["setup", "--no-embedding"], answer.ctx), 0);
  assert.equal(existsSync(declined.rcPath), false);
  assert.ok(answer.out.includes("PATH: skipped (declined)"), answer.out.join("\n"));
});

test("--embedding installs the library into its own prefix and then downloads the weights", async (t) => {
  const host = makeEmbeddingHost(t, "install-embedding");
  const asked = [];
  const { ctx, out } = makeCtx(host.env, {
    warmupImpl: async (options) => {
      asked.push(options);
      return { model: "fake@v1", modelDir: "fake", downloaded: true };
    },
  });

  assert.equal(await run(["setup", "--no-path", "--embedding"], ctx), 0);
  assert.deepEqual(installsInto(host, host.embeddingDir).map((call) => call.at(-1)), ["@huggingface/transformers@^4.2.0"]);
  assert.equal(existsSync(join(host.embeddingDir, "node_modules", "@huggingface", "transformers")), true);
  assert.deepEqual(asked, [{ allowDownload: true }]);
  assert.ok(out.includes(`embedding: created (${host.embeddingDir})`), out.join("\n"));
  assert.ok(out.includes("model: created (fake@v1)"), out.join("\n"));

  const again = makeCtx(host.env, { warmupImpl: async () => ({ model: "fake@v1", modelDir: "fake", downloaded: false }) });
  assert.equal(await run(["setup", "--no-path", "--embedding"], again.ctx), 0);
  assert.equal(installsInto(host, host.embeddingDir).length, 1, "a prefix that already holds the library reached npm again");
  assert.ok(again.out.includes(`embedding: already present (${host.embeddingDir})`), again.out.join("\n"));
});

test("a semantic recall that was turned down is recorded once, never asked again and still installable on demand", async (t) => {
  const host = makeEmbeddingHost(t, "install-embedding-declined");
  const embedded = (env) => JSON.parse(readFileSync(join(env.NIGHTSHIFT_HOME, "config.json"), "utf8")).embedding;

  const declined = makeCtx(host.env);
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], declined.ctx), 0);
  assert.ok(declined.out.includes("embedding: skipped (--no-embedding)"), declined.out.join("\n"));
  assert.equal(embedded(host.env), "declined");

  const terminal = tty("y\n");
  const remembered = makeCtx(host.env, { stdin: terminal.stdin, stdout: terminal.stdout });
  assert.equal(await run(["setup", "--no-path"], remembered.ctx), 0);
  assert.equal(terminal.written().includes("Enable semantic recall?"), false, terminal.written());
  assert.ok(remembered.out.includes("embedding: skipped (declined)"), remembered.out.join("\n"));
  assert.equal(remembered.out.some((line) => line.startsWith("semantic recall skipped")), false, remembered.out.join("\n"));
  assert.deepEqual(installsInto(host, host.embeddingDir), [], "a recorded decline still reached npm");

  const asked = makeCtx(host.env, { warmupImpl: async () => ({ model: "fake@v1", modelDir: "fake", downloaded: true }) });
  assert.equal(await run(["setup", "--no-path", "--embedding"], asked.ctx), 0);
  assert.ok(asked.out.includes(`embedding: created (${host.embeddingDir})`), asked.out.join("\n"));
  assert.equal(embedded(host.env), "declined", "an explicit --embedding rewrote the answer of the operator");
});

test("update reinstalls the runtime, re-points a host left on another path and keeps config, secrets and database", async (t) => {
  const host = makeHostEnv(t, "install-update");
  const first = makeCtx(host.env);
  assert.equal(await run(["setup", "--no-path", "--no-embedding", "--no-shortcuts"], first.ctx), 0);
  writeLegacyShim(host);
  writeFileSync(join(host.home, "nightshift.db"), "database bytes");
  const before = ["config.json", "secrets.json", "nightshift.db"].map((file) => readFileSync(join(host.home, file), "utf8"));

  const stale = readSettingsFile(host.configDir);
  stale.hooks.SessionStart[0].hooks[0].command = "node /old/checkout/bin/nightshift.mjs hook session-start";
  writeFileSync(host.settingsPath, `${JSON.stringify(stale, null, 2)}\n`);

  const { ctx, out } = makeCtx(host.env);
  assert.equal(await run(["update"], ctx), 0);
  const specs = specsInto(host, host.runtimeDir);
  assert.equal(specs.length, 2);
  assert.equal(specs[0].endsWith(".tgz"), true, "the setup installed from the registry instead of packing this package");
  assert.equal(specs[1], "@maykonv/nightshift@latest", "update is the only command allowed to fall back to the registry");
  assert.equal(packedDirs(host).length, 1, "update packed this package instead of asking the registry");
  assert.equal(
    readSettingsFile(host.configDir).hooks.SessionStart[0].hooks[0].command,
    `node ${host.entry} hook session-start`,
  );
  assert.ok(out.includes("hook SessionStart: updated"), out.join("\n"));
  for (const path of Object.values(host.shims)) assert.equal(existsSync(path), true, `update left ${path} behind`);
  assert.equal(existsSync(host.legacyShim), false, "update kept the shim of the previous command name");
  assert.deepEqual(
    ["config.json", "secrets.json", "nightshift.db"].map((file) => readFileSync(join(host.home, file), "utf8")),
    before,
  );
});

test("update <version> asks the registry for that exact version and the runtime line names both versions", async (t) => {
  const host = makeHostEnv(t, "install-update-version");
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], makeCtx(host.env).ctx), 0);

  const { ctx, out } = makeCtx(host.env);
  assert.equal(await run(["update", "0.2.0"], ctx), 0);
  assert.equal(specsInto(host, host.runtimeDir).at(-1), "@maykonv/nightshift@0.2.0");
  assert.ok(out.includes(`runtime: updated (v${VERSION} -> v0.2.0 at ${host.runtimeDir})`), out.join("\n"));
});

test("a version npm would read as another package or as a flag never reaches it", async (t) => {
  const host = makeHostEnv(t, "install-update-bad-version");
  for (const argv of [["update", "evil@1.0.0"], ["update", "--force-real"], ["update", "0.2.0", "--from", host.home]]) {
    const { ctx, err } = makeCtx(host.env);
    assert.equal(await run(argv, ctx), 1, argv.join(" "));
    assert.ok(err.some((line) => line.startsWith("nightshift: ")), err.join("\n"));
  }
  assert.deepEqual(host.npmCalls(), [], "a refused update still reached npm");
});

test("--remove takes out every shim and the marked line, keeps the runtime and never touches config or secrets", async (t) => {
  const host = makeHostEnv(t, "install-remove");
  writeFileSync(host.rcPath, `${THIRD_PARTY}\n`);
  assert.equal(await run(["setup", "--path", "--no-embedding"], makeCtx(host.env).ctx), 0);
  writeLegacyShim(host);
  for (const path of Object.values(host.shims)) assert.equal(existsSync(path), true);

  const { ctx, out } = makeCtx(host.env);
  assert.equal(await run(["setup", "--remove"], ctx), 0);
  for (const path of Object.values(host.shims)) assert.equal(existsSync(path), false);
  assert.equal(existsSync(host.legacyShim), false);
  assert.equal(readRc(host), `${THIRD_PARTY}\n`);
  assert.equal(readRc(host).includes(PATH_MARK), false);
  assert.equal(existsSync(join(host.home, "config.json")), true);
  assert.equal(existsSync(join(host.home, "secrets.json")), true);
  assert.equal(existsSync(host.runtimePackage), true, "the removal deleted the runtime without a terminal saying so");
  assert.ok(out.some((line) => line.startsWith("installed directories: kept")), out.join("\n"));
});

test("--purge is the only path that deletes the configuration home", async (t) => {
  const host = makeHostEnv(t, "install-purge");
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], makeCtx(host.env).ctx), 0);
  assert.equal(existsSync(join(host.home, "config.json")), true);

  const { ctx, out } = makeCtx(host.env);
  assert.equal(await run(["setup", "--remove", "--purge"], ctx), 0);
  assert.equal(existsSync(host.home), false);
  assert.ok(out.includes(`home: removed (${host.home})`), out.join("\n"));
});

test("a home whose runtime directory is missing installs it again on the next setup", async (t) => {
  const host = makeHostEnv(t, "install-runtime-gone");
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], makeCtx(host.env).ctx), 0);
  mkdirSync(host.home, { recursive: true });

  const { ctx, out } = makeCtx(host.env);
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], ctx), 0);
  assert.ok(out.some((line) => line.startsWith("runtime: already present")), out.join("\n"));
  assert.equal(existsSync(join(host.runtimePackage, "package.json")), true);
});

test("--from a tarball installs it as it is, without packing anything", async (t) => {
  const host = makeHostEnv(t, "install-from-tarball");
  const tarball = join(makeDir(t, "install-from-tarball-src"), `nightshift-${VERSION}.tgz`);
  writeFileSync(tarball, `${JSON.stringify({ name: "nightshift", version: VERSION })}\n`);
  const { ctx } = makeCtx(host.env);

  assert.equal(await run(["setup", "--from", tarball, "--no-path", "--no-embedding"], ctx), 0);
  assert.deepEqual(packedDirs(host), [], "a tarball was packed again instead of being installed as it is");
  assert.deepEqual(specsInto(host, host.runtimeDir), [tarball]);
});

test("--from a path that is neither a directory nor a tarball fails the runtime step instead of installing something else", async (t) => {
  const host = makeHostEnv(t, "install-from-missing");
  const missing = join(host.home, "no-such-checkout");
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(["setup", "--from", missing, "--no-path", "--no-embedding"], ctx), 0);
  assert.ok(out.includes(`runtime: failed (no directory or tarball at ${missing})`), out.join("\n"));
  assert.deepEqual(host.npmCalls(), [], "a missing --from still reached npm");
});

test("no installation ever asks for a global prefix, and never for sudo", async (t) => {
  const host = makeHostEnv(t, "install-never-global");
  const forbidden = ["-g", "--global", "sudo"];

  assert.equal(await run(["setup", "--no-path", "--no-embedding"], makeCtx(host.env).ctx), 0);
  assert.equal(await run(["update"], makeCtx(host.env).ctx), 0);
  for (const call of host.npmCalls()) {
    assert.equal(call.some((arg) => forbidden.includes(arg)), false, call.join(" "));
    if (call[0] !== "install") continue;
    assert.equal(call[1], "--prefix", call.join(" "));
    assert.equal(call[2].startsWith(host.home), true, `an install left the configuration home: ${call.join(" ")}`);
  }
});

test("an update whose runtime npm could not reinstall exits 1 and prints the command to finish by hand", async (t) => {
  const host = makeHostEnv(t, "install-update-failed");
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], makeCtx(host.env).ctx), 0);
  host.env.NIGHTSHIFT_FAKE_NPM_EXIT = "1";
  const { ctx, out, err } = makeCtx(host.env);

  assert.equal(await run(["update"], ctx), 1);
  assert.ok(out.some((line) => line.startsWith("runtime: failed")), out.join("\n"));
  assert.ok(err.some((line) => line.includes("@maykonv/nightshift@latest")), err.join("\n"));
});
