import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeDesktopConfigPath,
  claudeDesktopDir,
  desktopInstalled,
  desktopState,
  mergeDesktopServer,
  readDesktopConfig,
  removeDesktopServer,
  unsafeKeyOf,
  writeDesktopConfig,
} from "../../src/host/desktop.mjs";
import { cliEntryPath } from "../../src/host/paths.mjs";
import { makeDir } from "../../test-support/memory.mjs";

// Environment of a temporary user home, the only one these tests are ever allowed to reach.
function makeEnv(t, name) {
  const home = makeDir(t, name);
  return { HOME: home, NIGHTSHIFT_HOME: join(home, "nightshift") };
}

// Creates the configuration directory of the app, with the given file content when there is one.
function installApp(env, content = null) {
  mkdirSync(claudeDesktopDir(env), { recursive: true });
  const path = claudeDesktopConfigPath(env);
  if (content !== null) writeFileSync(path, content);
  return path;
}

// Entry a current registration carries, the same one the Claude Code host gets.
function ownEntry(env) {
  return { command: "node", args: [cliEntryPath(env), "mcp"] };
}

// Permission bits of a file on disk.
function fileMode(path) {
  return statSync(path).mode & 0o777;
}

test("the configuration path is the one of the app on each operating system", (t) => {
  const home = makeDir(t, "desktop-paths");
  const env = { HOME: home };
  const file = "claude_desktop_config.json";

  assert.equal(claudeDesktopConfigPath(env, "darwin"), join(home, "Library", "Application Support", "Claude", file));
  assert.equal(claudeDesktopConfigPath(env, "linux"), join(home, ".config", "Claude", file));
  const roaming = join(home, "roaming");
  assert.equal(claudeDesktopConfigPath({ ...env, APPDATA: roaming }, "win32"), join(roaming, "Claude", file));
  assert.equal(claudeDesktopConfigPath(env, "win32"), join(home, "AppData", "Roaming", "Claude", file));
});

test("an app that is not installed has no directory, and reading its configuration creates nothing", (t) => {
  const env = makeEnv(t, "desktop-absent");

  assert.equal(desktopInstalled(env), false);
  const config = readDesktopConfig(env);
  assert.deepEqual(config.data, {});
  assert.equal(config.existed, false);
  assert.equal(existsSync(claudeDesktopDir(env)), false, "reading the configuration created the directory of the app");
});

test("the merge adds our server, keeps every other key and stays idempotent", (t) => {
  const env = makeEnv(t, "desktop-merge");
  const third = { command: "other", args: ["--serve"] };
  const data = { theme: "dark", mcpServers: { other: third } };

  assert.equal(mergeDesktopServer(data, env), "created");
  assert.deepEqual(data.mcpServers.nightshift, ownEntry(env));
  assert.deepEqual(data.mcpServers.other, third);
  assert.equal(data.theme, "dark");
  assert.equal(mergeDesktopServer(data, env), "already present");

  data.mcpServers.nightshift = { command: "node", args: ["/old/pkg/bin/nightshift.mjs", "mcp"] };
  assert.equal(mergeDesktopServer(data, env), "updated");
  assert.deepEqual(data.mcpServers.nightshift, ownEntry(env));
});

test("an entry of ours carrying extra fields of the user is left exactly as it is", (t) => {
  const env = makeEnv(t, "desktop-extra-fields");
  const entry = { type: "stdio", command: "node", args: [cliEntryPath(env), "mcp"], env: { DEBUG: "1" } };
  const data = { mcpServers: { nightshift: entry } };

  assert.equal(mergeDesktopServer(data, env), "already present");
  assert.deepEqual(data.mcpServers.nightshift, entry);
});

test("the removal takes the exact key and never a neighbour whose name only starts like ours", (t) => {
  const env = makeEnv(t, "desktop-remove");
  const extra = { command: "node", args: ["extra.mjs"] };
  const other = { command: "other", args: [] };
  const data = { mcpServers: { nightshift: ownEntry(env), "nightshift-extra": extra, other } };

  assert.equal(removeDesktopServer(data), "removed");
  assert.deepEqual(data.mcpServers, { "nightshift-extra": extra, other });
  assert.equal(removeDesktopServer(data), "not present");
  assert.deepEqual(data.mcpServers, { "nightshift-extra": extra, other }, "the second removal touched the servers of others");
});

test("a configuration carrying a prototype-poisoning key is named, not merged", (t) => {
  const env = makeEnv(t, "desktop-unsafe");
  const root = JSON.parse('{"__proto__": {"polluted": true}, "mcpServers": {}}');
  const nested = JSON.parse('{"mcpServers": {"constructor": {}}}');

  assert.equal(unsafeKeyOf(root), "__proto__");
  assert.equal(unsafeKeyOf(nested), "constructor");
  assert.equal(unsafeKeyOf({ mcpServers: { other: { command: "other" } } }), null);
  assert.equal(unsafeKeyOf({}), null);
  assert.equal({}.polluted, undefined, "reading the fixture polluted Object.prototype");

  installApp(env, '{"mcpServers": {"prototype": {}}}');
  const state = desktopState(env);
  assert.equal(state.installed, true);
  assert.match(state.error, /unsafe `prototype` key/);
  assert.equal(state.entry, null);
});

test("the write keeps a backup and the permission bits, and a file it creates is closed to others", (t) => {
  const env = makeEnv(t, "desktop-write");
  installApp(env);
  const fresh = readDesktopConfig(env);
  mergeDesktopServer(fresh.data, env);

  assert.equal(writeDesktopConfig(fresh), null, "a file that did not exist was backed up anyway");
  assert.equal(fileMode(fresh.path), 0o600);
  assert.equal(readFileSync(fresh.path, "utf8").endsWith("\n"), true);

  writeFileSync(fresh.path, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  chmodSync(fresh.path, 0o644);
  const again = readDesktopConfig(env);
  mergeDesktopServer(again.data, env);
  const backup = writeDesktopConfig(again);

  assert.ok(backup?.includes(".bak-"), `the rewrite left no backup behind: ${backup}`);
  assert.equal(existsSync(backup), true);
  assert.equal(fileMode(again.path), 0o644, "the rewrite dropped the permission bits the user had set");
  assert.deepEqual(JSON.parse(readFileSync(again.path, "utf8")).mcpServers.nightshift, ownEntry(env));
});

test("the state of a diagnosis answers the five situations it can find, and never throws", (t) => {
  const absent = makeEnv(t, "desktop-state-absent");
  assert.deepEqual(desktopState(absent), {
    installed: false,
    path: claudeDesktopConfigPath(absent),
    error: null,
    entry: null,
  });

  const empty = makeEnv(t, "desktop-state-empty");
  installApp(empty);
  assert.deepEqual(desktopState(empty).entry, null);
  assert.equal(desktopState(empty).error, null);

  const broken = makeEnv(t, "desktop-state-broken");
  installApp(broken, "{ not json");
  assert.match(desktopState(broken).error, /does not hold a JSON object/);

  const current = makeEnv(t, "desktop-state-current");
  installApp(current, JSON.stringify({ mcpServers: { nightshift: ownEntry(current) } }));
  assert.deepEqual(desktopState(current).entry, ownEntry(current));

  const elsewhere = makeEnv(t, "desktop-state-elsewhere");
  const stale = { command: "node", args: ["/old/pkg/bin/nightshift.mjs", "mcp"] };
  installApp(elsewhere, JSON.stringify({ mcpServers: { nightshift: stale } }));
  assert.deepEqual(desktopState(elsewhere).entry, stale);
});
