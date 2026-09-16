import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePackageDir } from "../src/config/paths.mjs";
import { closeDb } from "../src/memory/db.mjs";
import { makeDir } from "./memory.mjs";

const FAKE_CLAUDE_SOURCE = fileURLToPath(new URL("./fake-claude-host.mjs", import.meta.url));
const FAKE_GH_SOURCE = fileURLToPath(new URL("./fake-gh.mjs", import.meta.url));
const FAKE_NPM_SOURCE = fileURLToPath(new URL("./fake-npm.mjs", import.meta.url));
const CHECKOUT_ROOT = fileURLToPath(new URL("../", import.meta.url));

export const FAKE_GH_TOKEN = "gh-fake-token-do-not-print";
export const FAKE_GH_LOGIN = "octocat";

const OWN_ENV_KEYS = [
  "NIGHTSHIFT_HOME",
  "NIGHTSHIFT_JOB_ID",
  "NIGHTSHIFT_JOB_HOME",
  "NIGHTSHIFT_JOB_CLAUDE_DIR",
  "NIGHTSHIFT_EMBED_DISABLED",
  "NIGHTSHIFT_REFLECT",
  "NIGHTSHIFT_CLAUDE_BIN",
  "NIGHTSHIFT_FAKE_CLAUDE_LOG",
  "NIGHTSHIFT_FAKE_CLAUDE_EXIT",
  "NIGHTSHIFT_GH_BIN",
  "NIGHTSHIFT_FAKE_GH_LOG",
  "NIGHTSHIFT_FAKE_GH_STATE",
  "NIGHTSHIFT_FAKE_GH_TOKEN",
  "NIGHTSHIFT_FAKE_GH_LOGIN",
  "NIGHTSHIFT_FAKE_GH_PR_STATE",
  "NIGHTSHIFT_FAKE_GH_PR_SHA",
  "NIGHTSHIFT_FAKE_GH_PR_LIST",
  "NIGHTSHIFT_NPM_BIN",
  "NIGHTSHIFT_FAKE_NPM_LOG",
  "NIGHTSHIFT_FAKE_NPM_SOURCE",
  "NIGHTSHIFT_FAKE_NPM_EXIT",
  "NIGHTSHIFT_FAKE_NPM_AUDIT",
  "NIGHTSHIFT_FAKE_NPM_LATEST",
  "NIGHTSHIFT_NO_UPDATE_CHECK",
  "NIGHTSHIFT_NO_PR_CHECK",
  "CLAUDE_CONFIG_DIR",
];

const ISOLATION_KEYS = [
  "NIGHTSHIFT_HOME",
  "CLAUDE_CONFIG_DIR",
  "NIGHTSHIFT_CLAUDE_BIN",
  "NIGHTSHIFT_GH_BIN",
  "NIGHTSHIFT_NPM_BIN",
];

// Tells whether HOME still points at the home directory of the person running the suite.
function isRealHome(value) {
  if (typeof value !== "string" || !value.trim()) return true;
  const home = resolve(value.trim());
  return home === resolve(homedir()) || home === resolve(process.env.HOME ?? homedir());
}

// Refuses an environment that would let a test reach the real host instead of a temporary one.
export function assertIsolatedEnv(env) {
  const missing = ISOLATION_KEYS.filter((key) => !env?.[key]);
  if (missing.length) {
    throw new Error(`this environment is not isolated from the real host (missing ${missing.join(", ")}); build it with makeHostEnv or isolatedHostVars`);
  }
  if (isRealHome(env?.HOME)) {
    throw new Error("this environment still carries the real HOME; build it with makeHostEnv or isolatedHostVars");
  }
  return env;
}

// Copies one fake CLI into the temporary directory, always executable.
function installFakeBin(dir, source, name) {
  const bin = join(dir, name);
  copyFileSync(source, bin);
  chmodSync(bin, 0o755);
  return bin;
}

// Calls the fake CLI received so far, one array of arguments per call.
function readCalls(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Environment variables that keep any process away from the real host: isolated config dir, the fake claude and gh CLIs, and the update and pull request checks off so nothing reaches the network.
export function isolatedHostVars(dir) {
  const configDir = join(dir, "claude-config");
  const userHome = join(dir, "user-home");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  return {
    HOME: userHome,
    SHELL: "/bin/zsh",
    NIGHTSHIFT_NO_UPDATE_CHECK: "1",
    NIGHTSHIFT_NO_PR_CHECK: "1",
    CLAUDE_CONFIG_DIR: configDir,
    NIGHTSHIFT_NPM_BIN: installFakeBin(dir, FAKE_NPM_SOURCE, "npm"),
    NIGHTSHIFT_FAKE_NPM_LOG: join(dir, "npm-calls.log"),
    NIGHTSHIFT_FAKE_NPM_SOURCE: CHECKOUT_ROOT,
    NIGHTSHIFT_CLAUDE_BIN: installFakeBin(dir, FAKE_CLAUDE_SOURCE, "claude"),
    NIGHTSHIFT_FAKE_CLAUDE_LOG: join(dir, "claude-calls.log"),
    NIGHTSHIFT_GH_BIN: installFakeBin(dir, FAKE_GH_SOURCE, "gh"),
    NIGHTSHIFT_FAKE_GH_LOG: join(dir, "gh-calls.log"),
    NIGHTSHIFT_FAKE_GH_STATE: "logged-out",
    NIGHTSHIFT_FAKE_GH_TOKEN: FAKE_GH_TOKEN,
    NIGHTSHIFT_FAKE_GH_LOGIN: FAKE_GH_LOGIN,
  };
}

// Fully isolated host: temporary configuration home, temporary Claude config dir and the fake claude CLI.
export function makeHostEnv(t, name, { exitCode } = {}) {
  const base = makeDir(t, name);
  const vars = isolatedHostVars(base);
  const env = { ...process.env };
  for (const key of OWN_ENV_KEYS) delete env[key];
  Object.assign(env, vars);
  env.NIGHTSHIFT_HOME = join(base, "home");
  env.NIGHTSHIFT_EMBED_DISABLED = "1";
  if (exitCode) env.NIGHTSHIFT_FAKE_CLAUDE_EXIT = String(exitCode);
  t.after(() => closeDb(env));
  const runtimePackage = runtimePackageDir(env);
  return {
    env,
    home: env.NIGHTSHIFT_HOME,
    runtimeDir: join(env.NIGHTSHIFT_HOME, "runtime"),
    runtimeVersions: join(env.NIGHTSHIFT_HOME, "runtime", "versions"),
    runtimeCurrent: join(env.NIGHTSHIFT_HOME, "runtime", "current"),
    runtimePackage,
    entry: join(runtimePackage, "bin", "nightshift.mjs"),
    binDir: join(env.NIGHTSHIFT_HOME, "bin"),
    shim: join(env.NIGHTSHIFT_HOME, "bin", "nightshift"),
    shims: {
      nightshift: join(env.NIGHTSHIFT_HOME, "bin", "nightshift"),
      nshift: join(env.NIGHTSHIFT_HOME, "bin", "nshift"),
      nsft: join(env.NIGHTSHIFT_HOME, "bin", "nsft"),
    },
    legacyShim: join(env.NIGHTSHIFT_HOME, "bin", "shift"),
    embeddingDir: join(env.NIGHTSHIFT_HOME, "embedding"),
    userHome: vars.HOME,
    rcPath: join(vars.HOME, ".zshrc"),
    configDir: vars.CLAUDE_CONFIG_DIR,
    settingsPath: join(vars.CLAUDE_CONFIG_DIR, "settings.json"),
    calls: () => readCalls(vars.NIGHTSHIFT_FAKE_CLAUDE_LOG),
    ghCalls: () => readCalls(vars.NIGHTSHIFT_FAKE_GH_LOG),
    npmCalls: () => readCalls(vars.NIGHTSHIFT_FAKE_NPM_LOG),
    backups: () => readdirSync(vars.CLAUDE_CONFIG_DIR).filter((file) => file.includes(".bak-")),
  };
}

// Writes the shim an older installation left behind, pointing at the entry the previous command name used.
export function writeLegacyShim(host, content = null) {
  mkdirSync(host.binDir, { recursive: true });
  const body = content ?? `#!/bin/sh\nexec node "${join(host.runtimePackage, "bin", "shift.mjs")}" "$@"\n`;
  writeFileSync(host.legacyShim, body, { mode: 0o755 });
  return host.legacyShim;
}

// Hook entries an older installation registered, pointing at the entry the previous command name used.
export function legacyHookCommand(host, hook) {
  return `node ${join(host.runtimePackage, "bin", "shift.mjs")} hook ${hook}`;
}

// Writes a settings.json fixture in the isolated configuration directory.
export function writeSettingsFixture(configDir, data) {
  const path = join(configDir, "settings.json");
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}

// Parsed content of the settings.json of the isolated configuration directory.
export function readSettingsFile(configDir) {
  return JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
}
