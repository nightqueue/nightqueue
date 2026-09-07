import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "../src/memory/db.mjs";
import { makeDir } from "./memory.mjs";

const FAKE_CLAUDE_SOURCE = fileURLToPath(new URL("./fake-claude-host.mjs", import.meta.url));
const FAKE_GH_SOURCE = fileURLToPath(new URL("./fake-gh.mjs", import.meta.url));

export const FAKE_GH_TOKEN = "gh-fake-token-do-not-print";
export const FAKE_GH_LOGIN = "octocat";

const OWN_ENV_KEYS = [
  "NIGHTSHIFT_HOME",
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
  "CLAUDE_CONFIG_DIR",
];

const ISOLATION_KEYS = ["NIGHTSHIFT_HOME", "CLAUDE_CONFIG_DIR", "NIGHTSHIFT_CLAUDE_BIN", "NIGHTSHIFT_GH_BIN"];

// Refuses an environment that would let a test reach the real host instead of a temporary one.
export function assertIsolatedEnv(env) {
  const missing = ISOLATION_KEYS.filter((key) => !env?.[key]);
  if (!missing.length) return env;
  throw new Error(`this environment is not isolated from the real host (missing ${missing.join(", ")}); build it with makeHostEnv or isolatedHostVars`);
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

// Environment variables that keep any process away from the real host: isolated config dir plus the fake claude and gh CLIs.
export function isolatedHostVars(dir) {
  const configDir = join(dir, "claude-config");
  mkdirSync(configDir, { recursive: true });
  return {
    CLAUDE_CONFIG_DIR: configDir,
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
  return {
    env,
    home: env.NIGHTSHIFT_HOME,
    configDir: vars.CLAUDE_CONFIG_DIR,
    settingsPath: join(vars.CLAUDE_CONFIG_DIR, "settings.json"),
    calls: () => readCalls(vars.NIGHTSHIFT_FAKE_CLAUDE_LOG),
    ghCalls: () => readCalls(vars.NIGHTSHIFT_FAKE_GH_LOG),
    backups: () => readdirSync(vars.CLAUDE_CONFIG_DIR).filter((file) => file.includes(".bak-")),
  };
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
