import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { resolvedRuntimeDir } from "../src/config/paths.mjs";
import {
  assertIsolatedEnv,
  legacyHookCommand,
  makeHostEnv,
  readSettingsFile,
  writeLegacyShim,
  writeSettingsFixture,
} from "../test-support/host.mjs";

const SETUP = ["setup", "--no-path", "--no-embedding"];
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const MANIFEST = JSON.parse(readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));

const THIRD_PARTY_SETTINGS = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  model: "sonnet",
  hooks: {
    SessionStart: [
      { matcher: "startup|resume|clear", hooks: [{ type: "command", command: "other-tool session", timeout: 20 }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool prompt", timeout: 15 }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: "other-tool end", timeout: 5 }] }],
    PostToolUse: [
      { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "other-tool format", timeout: 30 }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "other-tool stop", timeout: 10 }] }],
  },
};

// Context that captures the output and refuses to run against anything but an isolated environment.
function makeCtx(env, overrides = {}) {
  const out = [];
  const err = [];
  const ctx = { ...defaultContext(), env: assertIsolatedEnv(env), out: (line) => out.push(line), err: (line) => err.push(line), ...overrides };
  return { ctx, out, err };
}

// The command the host registers for one hook: the entry of the runtime, never the checkout that ran the setup.
function hookCommandOf(host, hook) {
  return `node ${host.entry} hook ${hook}`;
}

// Entries of one event that belong to this package.
function ownEntries(settings, event) {
  return (settings.hooks?.[event] ?? []).flatMap((group) =>
    (group.hooks ?? []).filter((entry) => entry.command.includes("bin/nightshift.mjs hook")),
  );
}

// Permission bits of a file on disk.
function fileMode(path) {
  return statSync(path).mode & 0o777;
}

// Calls of the fake CLI whose first arguments match the given prefix.
function callsMatching(calls, prefix) {
  return calls.filter((call) => prefix.every((value, index) => call[index] === value));
}

test("setup creates the three hook entries when settings.json does not exist", async (t) => {
  const host = makeHostEnv(t, "setup-fresh");
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  const settings = readSettingsFile(host.configDir);
  assert.deepEqual(settings.hooks.SessionStart, [
    { hooks: [{ type: "command", command: hookCommandOf(host, "session-start"), timeout: 10 }] },
  ]);
  assert.deepEqual(settings.hooks.UserPromptSubmit, [
    { hooks: [{ type: "command", command: hookCommandOf(host, "prompt-context"), timeout: 10 }] },
  ]);
  assert.deepEqual(settings.hooks.SessionEnd, [
    { hooks: [{ type: "command", command: hookCommandOf(host, "reflect"), timeout: 15 }] },
  ]);
  for (const event of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
    assert.ok(out.includes(`hook ${event}: created`), out.join("\n"));
  }
  assert.deepEqual(host.backups(), []);
});

test("third-party hooks of the five events survive the merge untouched", async (t) => {
  const host = makeHostEnv(t, "setup-third-party");
  writeSettingsFixture(host.configDir, THIRD_PARTY_SETTINGS);
  const { ctx } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  const settings = readSettingsFile(host.configDir);
  assert.deepEqual(settings.hooks.SessionStart[0], THIRD_PARTY_SETTINGS.hooks.SessionStart[0]);
  assert.deepEqual(settings.hooks.UserPromptSubmit[0], THIRD_PARTY_SETTINGS.hooks.UserPromptSubmit[0]);
  assert.deepEqual(settings.hooks.SessionEnd[0], THIRD_PARTY_SETTINGS.hooks.SessionEnd[0]);
  assert.deepEqual(settings.hooks.PostToolUse, THIRD_PARTY_SETTINGS.hooks.PostToolUse);
  assert.deepEqual(settings.hooks.Stop, THIRD_PARTY_SETTINGS.hooks.Stop);
  assert.equal(settings.model, "sonnet");
  assert.equal(settings.$schema, THIRD_PARTY_SETTINGS.$schema);
  assert.equal(ownEntries(settings, "SessionStart").length, 1);
});

test("the second run writes nothing, backs nothing up again and calls no subcommand twice", async (t) => {
  const host = makeHostEnv(t, "setup-idempotent");
  writeSettingsFixture(host.configDir, THIRD_PARTY_SETTINGS);
  const first = makeCtx(host.env);

  assert.equal(await run(SETUP, first.ctx), 0);
  const afterFirst = readFileSync(host.settingsPath, "utf8");
  assert.equal(host.backups().length, 1);
  const callsAfterFirst = host.calls().length;

  const second = makeCtx(host.env);
  assert.equal(await run(SETUP, second.ctx), 0);
  assert.equal(readFileSync(host.settingsPath, "utf8"), afterFirst);
  assert.equal(host.backups().length, 1);
  assert.equal(host.calls().length, callsAfterFirst);
  for (const line of second.out) {
    assert.doesNotMatch(line, /: (created|updated|failed)/, second.out.join("\n"));
  }
});

test("a package path that changed updates only the entry of this package", async (t) => {
  const host = makeHostEnv(t, "setup-moved");
  const stale = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|clear",
          hooks: [
            { type: "command", command: "other-tool session", timeout: 20 },
            { type: "command", command: "node /old/pkg/bin/nightshift.mjs hook session-start", timeout: 3 },
          ],
        },
      ],
      Stop: THIRD_PARTY_SETTINGS.hooks.Stop,
    },
  };
  writeSettingsFixture(host.configDir, stale);
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  const settings = readSettingsFile(host.configDir);
  const group = settings.hooks.SessionStart[0];
  assert.equal(group.matcher, "startup|resume|clear");
  assert.deepEqual(group.hooks[0], stale.hooks.SessionStart[0].hooks[0]);
  assert.deepEqual(group.hooks[1], { type: "command", command: hookCommandOf(host, "session-start"), timeout: 10 });
  assert.deepEqual(settings.hooks.Stop, THIRD_PARTY_SETTINGS.hooks.Stop);
  assert.ok(out.includes("hook SessionStart: updated"), out.join("\n"));
  assert.ok(out.includes("hook SessionEnd: created"), out.join("\n"));
});

test("a reflect hook left at the shorter timeout is raised to fifteen, and the neighbours stay put", async (t) => {
  const host = makeHostEnv(t, "setup-timeout-raised");
  const stale = {
    hooks: {
      SessionEnd: [
        {
          hooks: [
            { type: "command", command: "other-tool end", timeout: 5 },
            { type: "command", command: hookCommandOf(host, "reflect"), timeout: 10 },
          ],
        },
      ],
      Stop: THIRD_PARTY_SETTINGS.hooks.Stop,
    },
  };
  writeSettingsFixture(host.configDir, stale);
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  const settings = readSettingsFile(host.configDir);
  const group = settings.hooks.SessionEnd[0];
  assert.deepEqual(group.hooks[0], stale.hooks.SessionEnd[0].hooks[0]);
  assert.deepEqual(group.hooks[1], { type: "command", command: hookCommandOf(host, "reflect"), timeout: 15 });
  assert.equal(ownEntries(settings, "SessionEnd").length, 1);
  assert.deepEqual(settings.hooks.Stop, THIRD_PARTY_SETTINGS.hooks.Stop);
  assert.ok(out.includes("hook SessionEnd: updated"), out.join("\n"));
});

test("a settings.json closed with chmod 600 keeps that mode, and so does its backup", async (t) => {
  const host = makeHostEnv(t, "setup-mode-kept");
  writeSettingsFixture(host.configDir, THIRD_PARTY_SETTINGS);
  chmodSync(host.settingsPath, 0o600);
  const { ctx } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  assert.equal(ownEntries(readSettingsFile(host.configDir), "SessionStart").length, 1);
  assert.equal(fileMode(host.settingsPath).toString(8), "600");
  const [backup] = host.backups();
  assert.ok(backup, "the rewrite must leave a backup behind");
  assert.equal(fileMode(join(host.configDir, backup)).toString(8), "600");
});

test("a settings.json created from scratch keeps the default mode of the process", async (t) => {
  const host = makeHostEnv(t, "setup-mode-default");
  const reference = join(host.configDir, "reference.json");
  writeFileSync(reference, "{}\n");

  assert.equal(await run(SETUP, makeCtx(host.env).ctx), 0);
  assert.equal(fileMode(host.settingsPath), fileMode(reference));
});

test("the MCP server is registered at user scope with the absolute entry path", async (t) => {
  const host = makeHostEnv(t, "setup-mcp");
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  assert.deepEqual(callsMatching(host.calls(), ["mcp", "add"]), [
    ["mcp", "add", "--scope", "user", "nightshift", "--", "node", host.entry, "mcp"],
  ]);
  const registered = JSON.parse(readFileSync(join(host.configDir, ".claude.json"), "utf8"));
  assert.deepEqual(registered.mcpServers.nightshift.args, [host.entry, "mcp"]);
  assert.ok(out.includes("mcp nightshift: created"), out.join("\n"));
});

test("an MCP server already registered with the same command is not registered again", async (t) => {
  const host = makeHostEnv(t, "setup-mcp-present");
  writeFileSync(
    join(host.configDir, ".claude.json"),
    JSON.stringify({ mcpServers: { nightshift: { type: "stdio", command: "node", args: [host.entry, "mcp"], env: {} } } }),
  );
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  assert.deepEqual(callsMatching(host.calls(), ["mcp"]), []);
  assert.ok(out.includes("mcp nightshift: already present"), out.join("\n"));
});

test("a setup over an installation of the previous command name updates it in place, without a duplicate", async (t) => {
  const host = makeHostEnv(t, "setup-legacy");
  const legacyEntry = join(host.runtimePackage, "bin", "shift.mjs");
  writeLegacyShim(host);
  writeSettingsFixture(host.configDir, {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: legacyHookCommand(host, "session-start"), timeout: 10 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: legacyHookCommand(host, "prompt-context"), timeout: 10 }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: legacyHookCommand(host, "reflect"), timeout: 15 }] }],
    },
  });
  writeFileSync(
    join(host.configDir, ".claude.json"),
    JSON.stringify({ mcpServers: { nightshift: { type: "stdio", command: "node", args: [legacyEntry, "mcp"], env: {} } } }),
  );
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  const settings = readSettingsFile(host.configDir);
  for (const [event, hook] of [
    ["SessionStart", "session-start"],
    ["UserPromptSubmit", "prompt-context"],
    ["SessionEnd", "reflect"],
  ]) {
    assert.deepEqual(ownEntries(settings, event).map((entry) => entry.command), [hookCommandOf(host, hook)]);
  }
  assert.deepEqual(callsMatching(host.calls(), ["mcp"]).map((call) => call[1]), ["remove", "add"]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(host.configDir, ".claude.json"), "utf8")).mcpServers.nightshift.args,
    [host.entry, "mcp"],
  );
  assert.equal(existsSync(host.legacyShim), false);
  for (const path of Object.values(host.shims)) assert.equal(existsSync(path), true);
  assert.ok(out.includes(`legacy shim: removed (${host.legacyShim})`), out.join("\n"));
});

test("the marketplace manifest is valid and the setup registers and installs the plugin", async (t) => {
  assert.equal(MANIFEST.name, "nightshift");
  assert.equal(typeof MANIFEST.owner.name, "string");
  assert.deepEqual(
    MANIFEST.plugins.map((plugin) => plugin.name),
    ["nightshift"],
  );
  assert.equal(MANIFEST.plugins[0].source, "./plugin");
  assert.ok(MANIFEST.plugins[0].description.length > 0);

  const host = makeHostEnv(t, "setup-plugin");
  const { ctx, out } = makeCtx(host.env);
  assert.equal(await run(SETUP, ctx), 0);
  assert.deepEqual(callsMatching(host.calls(), ["plugin", "marketplace", "add"]), [
    ["plugin", "marketplace", "add", host.runtimePackage],
  ]);
  assert.deepEqual(callsMatching(host.calls(), ["plugin", "install"]), [
    ["plugin", "install", "nightshift@nightshift", "-y", "--scope", "user"],
  ]);
  assert.ok(out.includes("plugin marketplace: created"), out.join("\n"));
  assert.ok(out.includes("plugin nightshift@nightshift: created"), out.join("\n"));
});

test("--remove takes out only the entries of this package and keeps the home", async (t) => {
  const host = makeHostEnv(t, "setup-remove");
  writeSettingsFixture(host.configDir, THIRD_PARTY_SETTINGS);
  assert.equal(await run(SETUP, makeCtx(host.env).ctx), 0);

  const { ctx, out } = makeCtx(host.env);
  assert.equal(await run(["setup", "--remove"], ctx), 0);
  const settings = readSettingsFile(host.configDir);
  assert.equal(JSON.stringify(settings).includes("bin/nightshift.mjs hook"), false);
  assert.deepEqual(settings.hooks.SessionStart, THIRD_PARTY_SETTINGS.hooks.SessionStart);
  assert.deepEqual(settings.hooks.PostToolUse, THIRD_PARTY_SETTINGS.hooks.PostToolUse);
  assert.deepEqual(settings.hooks.Stop, THIRD_PARTY_SETTINGS.hooks.Stop);
  assert.deepEqual(callsMatching(host.calls(), ["mcp", "remove"]), [["mcp", "remove", "--scope", "user", "nightshift"]]);
  assert.deepEqual(callsMatching(host.calls(), ["plugin", "uninstall"]), [
    ["plugin", "uninstall", "nightshift@nightshift", "-y", "--scope", "user"],
  ]);
  assert.deepEqual(callsMatching(host.calls(), ["plugin", "marketplace", "remove"]), [
    ["plugin", "marketplace", "remove", "nightshift"],
  ]);
  assert.equal(existsSync(join(host.home, "config.json")), true);
  assert.equal(existsSync(join(host.home, "secrets.json")), true);
  assert.equal(existsSync(host.shim), false, "--remove kept the shim behind");
  assert.equal(existsSync(host.runtimeDir), true, "--remove deleted the runtime without being asked");
  assert.ok(out.some((line) => line.startsWith("home: kept")), out.join("\n"));
});

test("--no-embedding installs no library, downloads no weight and calls npm only for the runtime", async (t) => {
  const host = makeHostEnv(t, "setup-no-embedding");
  const warmupCalls = [];
  const { ctx, out } = makeCtx(host.env, {
    warmupImpl: async (options, env) => {
      warmupCalls.push({ options, env });
      return { model: "fake", modelDir: "fake", downloaded: true };
    },
  });

  assert.equal(await run(SETUP, ctx), 0);
  assert.deepEqual(warmupCalls, []);
  assert.equal(existsSync(join(host.home, "models")), false);
  assert.equal(existsSync(host.embeddingDir), false);
  assert.deepEqual(
    host.npmCalls().filter((call) => call.includes(host.embeddingDir)),
    [],
    host.npmCalls().map((call) => call.join(" ")).join("\n"),
  );
  assert.ok(out.some((line) => line.startsWith("runtime: created")), out.join("\n"));
});

test("the runtime is packed from this package, installed once and registered in the host, never against the running checkout", async (t) => {
  const host = makeHostEnv(t, "setup-runtime");
  const first = makeCtx(host.env);

  assert.equal(await run(SETUP, first.ctx), 0);
  const [pack, install] = host.npmCalls();
  assert.equal(host.npmCalls().length, 2, host.npmCalls().map((call) => call.join(" ")).join("\n"));
  assert.deepEqual(pack.slice(0, 2), ["pack", "--json"]);
  assert.equal(pack.includes("--ignore-scripts"), true, "the pack ran the lifecycle scripts of the packed package");
  assert.equal(pack.at(-1), PACKAGE_ROOT);
  assert.deepEqual(
    [install[0], install[1], ...install.slice(3, 7)],
    ["install", "--prefix", "--omit=dev", "--no-audit", "--no-fund", "--loglevel"],
  );
  assert.equal(dirname(install[2]), host.runtimeVersions, `the install wrote outside the versions directory: ${install[2]}`);
  assert.match(basename(install[2]), /^\.staging-\d{8}T\d{6}Z$/, `the install wrote into a final version directory: ${install[2]}`);
  assert.equal(install.at(-1).endsWith(".tgz"), true, `the install did not take the packed tarball: ${install.join(" ")}`);
  assert.equal(install.some((arg) => arg.includes("nightshift@")), false, "setup asked the registry for the runtime");
  assert.equal(existsSync(join(host.runtimePackage, "package.json")), true);
  assert.equal(readSettingsFile(host.configDir).hooks.SessionStart[0].hooks[0].command, hookCommandOf(host, "session-start"));

  const second = makeCtx(host.env);
  assert.equal(await run(SETUP, second.ctx), 0);
  assert.equal(host.npmCalls().length, 2, "the second setup packed or reinstalled the runtime again");
  const location = `${host.runtimeCurrent} -> ${resolvedRuntimeDir(host.env)}`;
  assert.ok(second.out.includes(`runtime: already present (v${VERSION} at ${location})`), second.out.join("\n"));
});

test("a runtime that npm could not install leaves the host untouched instead of pointing it at nothing", async (t) => {
  const host = makeHostEnv(t, "setup-runtime-failed");
  host.env.NIGHTSHIFT_FAKE_NPM_EXIT = "1";
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  assert.equal(existsSync(host.runtimePackage), false);
  assert.equal(existsSync(host.settingsPath), false, "a failed runtime still wrote hooks into the host");
  assert.equal(existsSync(host.shim), false, "a failed runtime still wrote a shim pointing at nothing");
  assert.deepEqual(callsMatching(host.calls(), ["mcp", "add"]), []);
  assert.ok(out.some((line) => line.startsWith("runtime: failed")), out.join("\n"));
  assert.ok(out.includes("shim nightshift: skipped (runtime missing)"), out.join("\n"));
  assert.ok(out.includes("hook SessionStart: skipped (runtime missing)"), out.join("\n"));
});

test("a runtime whose npm exits non-zero is a failure even when an older install is still on disk", async (t) => {
  const host = makeHostEnv(t, "setup-runtime-stale");
  assert.equal(await run(SETUP, makeCtx(host.env).ctx), 0);
  writeFileSync(join(host.runtimePackage, "package.json"), `${JSON.stringify({ name: "nightshift", version: "0.0.1" })}\n`);
  host.env.NIGHTSHIFT_FAKE_NPM_EXIT = "1";
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  assert.ok(out.some((line) => line.startsWith("runtime: failed")), out.join("\n"));
  assert.equal(out.some((line) => line.startsWith("runtime: updated")), false, out.join("\n"));
  assert.ok(out.includes("shim nightshift: skipped (runtime missing)"), out.join("\n"));
});

test("a claude CLI that cannot run degrades the steps that need it, never the hooks", async (t) => {
  const host = makeHostEnv(t, "setup-degraded");
  host.env.NIGHTSHIFT_CLAUDE_BIN = join(host.configDir, "does-not-exist");
  const { ctx, out, err } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  const settings = readSettingsFile(host.configDir);
  assert.equal(ownEntries(settings, "SessionStart").length, 1);
  assert.ok(out.includes("mcp nightshift: failed (claude CLI not found)"), out.join("\n"));
  assert.ok(out.some((line) => line.startsWith("setup finished with")), out.join("\n"));
  assert.ok(err.some((line) => line.includes("mcp add --scope user nightshift")), err.join("\n"));
});

test("a broken settings.json is a user error, and the file is left alone", async (t) => {
  const host = makeHostEnv(t, "setup-broken");
  writeFileSync(host.settingsPath, "{ not json");
  const { ctx, err } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 1);
  assert.equal(readFileSync(host.settingsPath, "utf8"), "{ not json");
  assert.match(err.join("\n"), /is not valid JSON/);
});

test("a settings directory that does not exist yet is created by the setup", async (t) => {
  const host = makeHostEnv(t, "setup-nested");
  const nested = join(host.configDir, "nested");
  host.env.CLAUDE_CONFIG_DIR = nested;
  mkdirSync(host.home, { recursive: true });
  const { ctx } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0);
  const settings = JSON.parse(readFileSync(join(nested, "settings.json"), "utf8"));
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, hookCommandOf(host, "session-start"));
});
