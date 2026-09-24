import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { claudeDesktopConfigPath, claudeDesktopDir } from "../src/host/desktop.mjs";
import { assertIsolatedEnv, makeHostEnv } from "../test-support/host.mjs";
import { makeDir } from "../test-support/memory.mjs";

const SETUP = ["setup", "--no-path", "--no-embedding"];

const THIRD_PARTY = {
  globalShortcut: "Alt+Space",
  theme: "dark",
  mcpServers: {
    other: { command: "other", args: ["--serve"] },
    "nightqueue-extra": { command: "node", args: ["/opt/extra.mjs"] },
  },
};

// Context that captures the output and refuses to run against anything but an isolated environment.
function makeCtx(env, overrides = {}) {
  const out = [];
  const err = [];
  const ctx = { ...defaultContext(), env: assertIsolatedEnv(env), out: (line) => out.push(line), err: (line) => err.push(line), ...overrides };
  return { ctx, out, err };
}

// Installs the app of the isolated home, with the configuration fixture when there is one.
function installApp(env, content = null) {
  mkdirSync(claudeDesktopDir(env), { recursive: true });
  const path = claudeDesktopConfigPath(env);
  if (content !== null) writeFileSync(path, content);
  return path;
}

// Parsed configuration of the app of the isolated home.
function readApp(env) {
  return JSON.parse(readFileSync(claudeDesktopConfigPath(env), "utf8"));
}

// Backups the writes left in the configuration directory of the app.
function appBackups(env) {
  return readdirSync(claudeDesktopDir(env)).filter((file) => file.includes(".bak-"));
}

// Entry the setup is expected to register for this package.
function ownEntry(host) {
  return { command: "node", args: [host.entry, "mcp"] };
}

test("setup registers the server in an installed Claude Desktop and leaves every other key alone", async (t) => {
  const host = makeHostEnv(t, "desktop-setup");
  installApp(host.env, `${JSON.stringify(THIRD_PARTY, null, 2)}\n`);
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  const config = readApp(host.env);
  assert.deepEqual(config.mcpServers.nightqueue, ownEntry(host));
  assert.deepEqual(config.mcpServers.other, THIRD_PARTY.mcpServers.other);
  assert.deepEqual(config.mcpServers["nightqueue-extra"], THIRD_PARTY.mcpServers["nightqueue-extra"]);
  assert.equal(config.globalShortcut, THIRD_PARTY.globalShortcut);
  assert.equal(config.theme, THIRD_PARTY.theme);
  assert.ok(out.includes("claude desktop mcp: created"), out.join("\n"));
  assert.deepEqual(appBackups(host.env).length, 1);
});

test("a second setup rewrites nothing and backs nothing up again", async (t) => {
  const host = makeHostEnv(t, "desktop-idempotent");
  installApp(host.env, `${JSON.stringify(THIRD_PARTY, null, 2)}\n`);
  assert.equal(await run(SETUP, makeCtx(host.env).ctx), 0);
  const afterFirst = readFileSync(claudeDesktopConfigPath(host.env), "utf8");

  const second = makeCtx(host.env);
  assert.equal(await run(SETUP, second.ctx), 0);
  assert.equal(readFileSync(claudeDesktopConfigPath(host.env), "utf8"), afterFirst);
  assert.deepEqual(appBackups(host.env).length, 1);
  assert.ok(second.out.includes("claude desktop mcp: already present"), second.out.join("\n"));
});

test("an app that is not installed is a skipped step, and its directory is never created", async (t) => {
  const host = makeHostEnv(t, "desktop-absent");
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  assert.equal(existsSync(claudeDesktopDir(host.env)), false, "the setup created the directory of an app that is not installed");
  assert.ok(out.includes("claude desktop mcp: skipped (Claude Desktop not installed)"), out.join("\n"));
});

test("--no-desktop writes nothing, in setup as in init", async (t) => {
  const host = makeHostEnv(t, "desktop-off");
  const path = installApp(host.env);
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run([...SETUP, "--no-desktop"], ctx), 0);
  assert.equal(existsSync(path), false, "`--no-desktop` wrote the configuration of the app anyway");
  assert.ok(out.includes("claude desktop mcp: skipped (--no-desktop)"), out.join("\n"));

  const initHost = makeHostEnv(t, "desktop-off-init");
  const initPath = installApp(initHost.env);
  const init = makeCtx(initHost.env, { cwd: makeDir(t, "desktop-off-init-cwd") });

  assert.equal(await run(["init", "--no-path", "--no-embedding", "--no-gh", "--no-desktop"], init.ctx), 0);
  assert.equal(existsSync(initPath), false, "`init --no-desktop` wrote the configuration of the app anyway");
});

test("--desktop together with --no-desktop is refused before anything is installed", async (t) => {
  const host = makeHostEnv(t, "desktop-conflict");
  const { ctx, err } = makeCtx(host.env);

  assert.equal(await run([...SETUP, "--desktop", "--no-desktop"], ctx), 1);
  assert.match(err.join("\n"), /`--desktop` and `--no-desktop` cannot be used together/);
  assert.equal(existsSync(host.home), false, "a refused setup still touched the host");
});

test("--remove takes out our entry only, and leaves the server whose name merely starts like ours", async (t) => {
  const host = makeHostEnv(t, "desktop-remove");
  installApp(host.env, `${JSON.stringify(THIRD_PARTY, null, 2)}\n`);
  assert.equal(await run(SETUP, makeCtx(host.env).ctx), 0);

  const { ctx, out } = makeCtx(host.env);
  assert.equal(await run(["setup", "--remove"], ctx), 0);
  const config = readApp(host.env);
  assert.equal(Object.hasOwn(config.mcpServers, "nightqueue"), false);
  assert.deepEqual(config.mcpServers["nightqueue-extra"], THIRD_PARTY.mcpServers["nightqueue-extra"]);
  assert.deepEqual(config.mcpServers.other, THIRD_PARTY.mcpServers.other);
  assert.equal(config.globalShortcut, THIRD_PARTY.globalShortcut);
  assert.ok(out.includes("claude desktop mcp: removed"), out.join("\n"));
});

test("a configuration that cannot be trusted degrades one step, is left untouched and stops nothing else", async (t) => {
  const broken = makeHostEnv(t, "desktop-broken");
  const brokenPath = installApp(broken.env, "{ not json");
  const first = makeCtx(broken.env);

  assert.equal(await run(SETUP, first.ctx), 0);
  assert.equal(readFileSync(brokenPath, "utf8"), "{ not json");
  assert.ok(first.out.some((line) => line.startsWith("claude desktop mcp: failed")), first.out.join("\n"));
  assert.ok(first.out.includes("hook SessionStart: created"), first.out.join("\n"));
  assert.ok(first.out.some((line) => line.startsWith("setup finished with")), first.out.join("\n"));

  const unsafe = makeHostEnv(t, "desktop-unsafe");
  const unsafeBody = '{"__proto__": {"polluted": true}, "mcpServers": {}}';
  const unsafePath = installApp(unsafe.env, unsafeBody);
  const second = makeCtx(unsafe.env);

  assert.equal(await run(SETUP, second.ctx), 0);
  assert.equal(readFileSync(unsafePath, "utf8"), unsafeBody);
  assert.equal({}.polluted, undefined, "the setup polluted Object.prototype");
  assert.ok(second.out.includes("claude desktop mcp: failed (unsafe `__proto__` key)"), second.out.join("\n"));
});

test("a configuration the setup creates is closed to group and others", async (t) => {
  const host = makeHostEnv(t, "desktop-mode");
  const path = installApp(host.env);

  assert.equal(await run(SETUP, makeCtx(host.env).ctx), 0);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(appBackups(host.env), []);
});

test("a runtime that could not be installed skips the step instead of pointing the app at nothing", async (t) => {
  const host = makeHostEnv(t, "desktop-no-runtime");
  host.env.NIGHTQUEUE_FAKE_NPM_EXIT = "1";
  const path = installApp(host.env);
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  assert.equal(existsSync(path), false);
  assert.ok(out.includes("claude desktop mcp: skipped (runtime missing)"), out.join("\n"));
});

test("the diagnosis reads the three states of the registration and never fails on them", async (t) => {
  const absent = makeHostEnv(t, "desktop-doctor-absent");
  const report = [];
  const doctorCtx = (env) => ({ ...defaultContext(), env, out: (line) => report.push(line), err: () => {} });

  assert.equal(await run(["doctor", "--json"], doctorCtx(absent.env)), 1, report.join("\n"));
  const withoutApp = JSON.parse(report[0]).checks.find((entry) => entry.name === "claude desktop mcp");
  assert.deepEqual([withoutApp.status, withoutApp.detail], ["ok", "Claude Desktop not installed"]);

  const idle = makeHostEnv(t, "desktop-doctor-idle");
  installApp(idle.env, JSON.stringify({ mcpServers: { other: { command: "other" } } }));
  report.length = 0;
  await run(["doctor", "--json"], doctorCtx(idle.env));
  const notRegistered = JSON.parse(report[0]).checks.find((entry) => entry.name === "claude desktop mcp");
  assert.equal(notRegistered.status, "warn");
  assert.match(notRegistered.hint, /nightqueue setup/);

  const ready = makeHostEnv(t, "desktop-doctor-ok");
  installApp(ready.env);
  await run(SETUP, makeCtx(ready.env).ctx);
  report.length = 0;
  await run(["doctor", "--json"], doctorCtx(ready.env));
  const parsed = JSON.parse(report[0]);
  assert.equal(parsed.checks.find((entry) => entry.name === "claude desktop mcp").status, "ok");
  assert.deepEqual(parsed.checks.filter((entry) => entry.status === "fail"), []);
});

test("a registration pointing at another runtime warns instead of failing the diagnosis", async (t) => {
  const host = makeHostEnv(t, "desktop-doctor-elsewhere");
  installApp(host.env);
  await run(SETUP, makeCtx(host.env).ctx);
  writeFileSync(
    claudeDesktopConfigPath(host.env),
    JSON.stringify({ mcpServers: { nightqueue: { command: "node", args: [join("/old", "bin", "nightqueue.mjs"), "mcp"] } } }),
  );

  const report = [];
  const code = await run(["doctor", "--json"], { ...defaultContext(), env: host.env, out: (line) => report.push(line), err: () => {} });
  const check = JSON.parse(report[0]).checks.find((entry) => entry.name === "claude desktop mcp");
  assert.deepEqual([check.status, check.detail], ["warn", "registered from another path"]);
  assert.equal(code, 0, report.join("\n"));
});
