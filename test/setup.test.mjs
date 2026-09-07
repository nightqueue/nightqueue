import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { assertIsolatedEnv, makeHostEnv, readSettingsFile, writeSettingsFixture } from "../test-support/host.mjs";

const ENTRY = fileURLToPath(new URL("../bin/shift.mjs", import.meta.url));
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

// The command registered by this package for one hook.
function hookCommandOf(hook) {
  return `node ${ENTRY} hook ${hook}`;
}

// Entries of one event that belong to this package.
function ownEntries(settings, event) {
  return (settings.hooks?.[event] ?? []).flatMap((group) =>
    (group.hooks ?? []).filter((entry) => entry.command.includes("bin/shift.mjs hook")),
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

  assert.equal(await run(["setup", "--no-model"], ctx), 0);
  const settings = readSettingsFile(host.configDir);
  assert.deepEqual(settings.hooks.SessionStart, [
    { hooks: [{ type: "command", command: hookCommandOf("session-start"), timeout: 10 }] },
  ]);
  assert.deepEqual(settings.hooks.UserPromptSubmit, [
    { hooks: [{ type: "command", command: hookCommandOf("prompt-context"), timeout: 10 }] },
  ]);
  assert.deepEqual(settings.hooks.SessionEnd, [
    { hooks: [{ type: "command", command: hookCommandOf("reflect"), timeout: 15 }] },
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

  assert.equal(await run(["setup", "--no-model"], ctx), 0);
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

  assert.equal(await run(["setup", "--no-model"], first.ctx), 0);
  const afterFirst = readFileSync(host.settingsPath, "utf8");
  assert.equal(host.backups().length, 1);
  const callsAfterFirst = host.calls().length;

  const second = makeCtx(host.env);
  assert.equal(await run(["setup", "--no-model"], second.ctx), 0);
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
            { type: "command", command: "node /old/pkg/bin/shift.mjs hook session-start", timeout: 3 },
          ],
        },
      ],
      Stop: THIRD_PARTY_SETTINGS.hooks.Stop,
    },
  };
  writeSettingsFixture(host.configDir, stale);
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(["setup", "--no-model"], ctx), 0);
  const settings = readSettingsFile(host.configDir);
  const group = settings.hooks.SessionStart[0];
  assert.equal(group.matcher, "startup|resume|clear");
  assert.deepEqual(group.hooks[0], stale.hooks.SessionStart[0].hooks[0]);
  assert.deepEqual(group.hooks[1], { type: "command", command: hookCommandOf("session-start"), timeout: 10 });
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
            { type: "command", command: hookCommandOf("reflect"), timeout: 10 },
          ],
        },
      ],
      Stop: THIRD_PARTY_SETTINGS.hooks.Stop,
    },
  };
  writeSettingsFixture(host.configDir, stale);
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(["setup", "--no-model"], ctx), 0);
  const settings = readSettingsFile(host.configDir);
  const group = settings.hooks.SessionEnd[0];
  assert.deepEqual(group.hooks[0], stale.hooks.SessionEnd[0].hooks[0]);
  assert.deepEqual(group.hooks[1], { type: "command", command: hookCommandOf("reflect"), timeout: 15 });
  assert.equal(ownEntries(settings, "SessionEnd").length, 1);
  assert.deepEqual(settings.hooks.Stop, THIRD_PARTY_SETTINGS.hooks.Stop);
  assert.ok(out.includes("hook SessionEnd: updated"), out.join("\n"));
});

test("a settings.json closed with chmod 600 keeps that mode, and so does its backup", async (t) => {
  const host = makeHostEnv(t, "setup-mode-kept");
  writeSettingsFixture(host.configDir, THIRD_PARTY_SETTINGS);
  chmodSync(host.settingsPath, 0o600);
  const { ctx } = makeCtx(host.env);

  assert.equal(await run(["setup", "--no-model"], ctx), 0);
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

  assert.equal(await run(["setup", "--no-model"], makeCtx(host.env).ctx), 0);
  assert.equal(fileMode(host.settingsPath), fileMode(reference));
});

test("the MCP server is registered at user scope with the absolute entry path", async (t) => {
  const host = makeHostEnv(t, "setup-mcp");
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(["setup", "--no-model"], ctx), 0);
  assert.deepEqual(callsMatching(host.calls(), ["mcp", "add"]), [
    ["mcp", "add", "--scope", "user", "nightshift", "--", "node", ENTRY, "mcp"],
  ]);
  const registered = JSON.parse(readFileSync(join(host.configDir, ".claude.json"), "utf8"));
  assert.deepEqual(registered.mcpServers.nightshift.args, [ENTRY, "mcp"]);
  assert.ok(out.includes("mcp nightshift: created"), out.join("\n"));
});

test("an MCP server already registered with the same command is not registered again", async (t) => {
  const host = makeHostEnv(t, "setup-mcp-present");
  writeFileSync(
    join(host.configDir, ".claude.json"),
    JSON.stringify({ mcpServers: { nightshift: { type: "stdio", command: "node", args: [ENTRY, "mcp"], env: {} } } }),
  );
  const { ctx, out } = makeCtx(host.env);

  assert.equal(await run(["setup", "--no-model"], ctx), 0);
  assert.deepEqual(callsMatching(host.calls(), ["mcp"]), []);
  assert.ok(out.includes("mcp nightshift: already present"), out.join("\n"));
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
  assert.equal(await run(["setup", "--no-model"], ctx), 0);
  assert.deepEqual(callsMatching(host.calls(), ["plugin", "marketplace", "add"]), [
    ["plugin", "marketplace", "add", PACKAGE_ROOT],
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
  assert.equal(await run(["setup", "--no-model"], makeCtx(host.env).ctx), 0);

  const { ctx, out } = makeCtx(host.env);
  assert.equal(await run(["setup", "--remove"], ctx), 0);
  const settings = readSettingsFile(host.configDir);
  assert.equal(JSON.stringify(settings).includes("bin/shift.mjs hook"), false);
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
  assert.ok(out.some((line) => line.startsWith("home: kept")), out.join("\n"));
});

test("--no-model downloads nothing, and the download is the only path that opens the network", async (t) => {
  const skipped = makeHostEnv(t, "setup-no-model");
  const warmupCalls = [];
  const spy = makeCtx(skipped.env, {
    warmupImpl: async (options, env) => {
      warmupCalls.push({ options, env });
      return { model: "fake", modelDir: "fake", downloaded: true };
    },
  });
  assert.equal(await run(["setup", "--no-model"], spy.ctx), 0);
  assert.deepEqual(warmupCalls, []);
  assert.equal(existsSync(join(skipped.home, "models")), false);
  assert.ok(spy.out.includes("model: skipped (--no-model)"), spy.out.join("\n"));

  const downloading = makeHostEnv(t, "setup-model");
  const asked = [];
  const full = makeCtx(downloading.env, {
    warmupImpl: async (options) => {
      asked.push(options);
      return { model: "fake@v1", modelDir: "fake", downloaded: true };
    },
  });
  assert.equal(await run(["setup"], full.ctx), 0);
  assert.deepEqual(asked, [{ allowDownload: true }]);
  assert.ok(full.out.includes("model: created (fake@v1)"), full.out.join("\n"));
});

test("a claude CLI that cannot run degrades the steps that need it, never the hooks", async (t) => {
  const host = makeHostEnv(t, "setup-degraded");
  host.env.NIGHTSHIFT_CLAUDE_BIN = join(host.configDir, "does-not-exist");
  const { ctx, out, err } = makeCtx(host.env);

  assert.equal(await run(["setup", "--no-model"], ctx), 0);
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

  assert.equal(await run(["setup", "--no-model"], ctx), 1);
  assert.equal(readFileSync(host.settingsPath, "utf8"), "{ not json");
  assert.match(err.join("\n"), /is not valid JSON/);
});

test("a settings directory that does not exist yet is created by the setup", async (t) => {
  const host = makeHostEnv(t, "setup-nested");
  const nested = join(host.configDir, "nested");
  host.env.CLAUDE_CONFIG_DIR = nested;
  mkdirSync(host.home, { recursive: true });
  const { ctx } = makeCtx(host.env);

  assert.equal(await run(["setup", "--no-model"], ctx), 0);
  const settings = JSON.parse(readFileSync(join(nested, "settings.json"), "utf8"));
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, hookCommandOf("session-start"));
});
