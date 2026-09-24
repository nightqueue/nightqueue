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
export const FAKE_GH_PR_URL = "https://github.com/octocat/hello-world/pull/7";

const OWN_ENV_KEYS = [
  "NIGHTQUEUE_HOME",
  "NIGHTQUEUE_JOB_ID",
  "NIGHTQUEUE_CLOSE_WORKER",
  "NIGHTQUEUE_JOB_HOME",
  "NIGHTQUEUE_JOB_CLAUDE_DIR",
  "NIGHTQUEUE_EMBED_DISABLED",
  "NIGHTQUEUE_REFLECT",
  "NIGHTQUEUE_CLAUDE_BIN",
  "NIGHTQUEUE_FAKE_CLAUDE_LOG",
  "NIGHTQUEUE_FAKE_CLAUDE_EXIT",
  "NIGHTQUEUE_GH_BIN",
  "NIGHTQUEUE_FAKE_GH_LOG",
  "NIGHTQUEUE_FAKE_GH_STATE",
  "NIGHTQUEUE_FAKE_GH_TOKEN",
  "NIGHTQUEUE_FAKE_GH_LOGIN",
  "NIGHTQUEUE_FAKE_GH_PR_STATE",
  "NIGHTQUEUE_FAKE_GH_PR_SHA",
  "NIGHTQUEUE_FAKE_GH_PR_URL",
  "NIGHTQUEUE_FAKE_GH_PR_LIST",
  "NIGHTQUEUE_FAKE_GH_SLEEP_MS",
  "NIGHTQUEUE_FAKE_GH_PR_MERGEABLE",
  "NIGHTQUEUE_FAKE_GH_PR_DRAFT",
  "NIGHTQUEUE_NPM_BIN",
  "NIGHTQUEUE_FAKE_NPM_LOG",
  "NIGHTQUEUE_FAKE_NPM_SOURCE",
  "NIGHTQUEUE_FAKE_NPM_EXIT",
  "NIGHTQUEUE_FAKE_NPM_AUDIT",
  "NIGHTQUEUE_FAKE_NPM_LATEST",
  "NIGHTQUEUE_NO_UPDATE_CHECK",
  "NIGHTQUEUE_NO_PR_CHECK",
  "CLAUDE_CONFIG_DIR",
];

const ISOLATION_KEYS = [
  "NIGHTQUEUE_HOME",
  "CLAUDE_CONFIG_DIR",
  "NIGHTQUEUE_CLAUDE_BIN",
  "NIGHTQUEUE_GH_BIN",
  "NIGHTQUEUE_NPM_BIN",
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
    NIGHTQUEUE_NO_UPDATE_CHECK: "1",
    NIGHTQUEUE_NO_PR_CHECK: "1",
    CLAUDE_CONFIG_DIR: configDir,
    NIGHTQUEUE_NPM_BIN: installFakeBin(dir, FAKE_NPM_SOURCE, "npm"),
    NIGHTQUEUE_FAKE_NPM_LOG: join(dir, "npm-calls.log"),
    NIGHTQUEUE_FAKE_NPM_SOURCE: CHECKOUT_ROOT,
    NIGHTQUEUE_CLAUDE_BIN: installFakeBin(dir, FAKE_CLAUDE_SOURCE, "claude"),
    NIGHTQUEUE_FAKE_CLAUDE_LOG: join(dir, "claude-calls.log"),
    NIGHTQUEUE_GH_BIN: installFakeBin(dir, FAKE_GH_SOURCE, "gh"),
    NIGHTQUEUE_FAKE_GH_LOG: join(dir, "gh-calls.log"),
    NIGHTQUEUE_FAKE_GH_STATE: "logged-out",
    NIGHTQUEUE_FAKE_GH_TOKEN: FAKE_GH_TOKEN,
    NIGHTQUEUE_FAKE_GH_LOGIN: FAKE_GH_LOGIN,
    NIGHTQUEUE_FAKE_GH_PR_URL: FAKE_GH_PR_URL,
  };
}

// Fully isolated host: temporary configuration home, temporary Claude config dir and the fake claude CLI.
export function makeHostEnv(t, name, { exitCode } = {}) {
  const base = makeDir(t, name);
  const vars = isolatedHostVars(base);
  const env = { ...process.env };
  for (const key of OWN_ENV_KEYS) delete env[key];
  Object.assign(env, vars);
  env.NIGHTQUEUE_HOME = join(base, "home");
  env.NIGHTQUEUE_EMBED_DISABLED = "1";
  if (exitCode) env.NIGHTQUEUE_FAKE_CLAUDE_EXIT = String(exitCode);
  t.after(() => closeDb(env));
  const runtimePackage = runtimePackageDir(env);
  return {
    env,
    home: env.NIGHTQUEUE_HOME,
    runtimeDir: join(env.NIGHTQUEUE_HOME, "runtime"),
    runtimeVersions: join(env.NIGHTQUEUE_HOME, "runtime", "versions"),
    runtimeCurrent: join(env.NIGHTQUEUE_HOME, "runtime", "current"),
    runtimePackage,
    entry: join(runtimePackage, "bin", "nightqueue.mjs"),
    binDir: join(env.NIGHTQUEUE_HOME, "bin"),
    shim: join(env.NIGHTQUEUE_HOME, "bin", "nightqueue"),
    shims: {
      nightqueue: join(env.NIGHTQUEUE_HOME, "bin", "nightqueue"),
      nshift: join(env.NIGHTQUEUE_HOME, "bin", "nshift"),
      nsft: join(env.NIGHTQUEUE_HOME, "bin", "nsft"),
    },
    legacyShim: join(env.NIGHTQUEUE_HOME, "bin", "shift"),
    embeddingDir: join(env.NIGHTQUEUE_HOME, "embedding"),
    userHome: vars.HOME,
    rcPath: join(vars.HOME, ".zshrc"),
    configDir: vars.CLAUDE_CONFIG_DIR,
    settingsPath: join(vars.CLAUDE_CONFIG_DIR, "settings.json"),
    calls: () => readCalls(vars.NIGHTQUEUE_FAKE_CLAUDE_LOG),
    ghCalls: () => readCalls(vars.NIGHTQUEUE_FAKE_GH_LOG),
    npmCalls: () => readCalls(vars.NIGHTQUEUE_FAKE_NPM_LOG),
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
