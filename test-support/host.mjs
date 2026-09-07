import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "../src/memory/db.mjs";
import { makeDir } from "./memory.mjs";

const FAKE_SOURCE = fileURLToPath(new URL("./fake-claude-host.mjs", import.meta.url));

const OWN_ENV_KEYS = [
  "NIGHTSHIFT_HOME",
  "NIGHTSHIFT_EMBED_DISABLED",
  "NIGHTSHIFT_REFLECT",
  "NIGHTSHIFT_CLAUDE_BIN",
  "NIGHTSHIFT_FAKE_CLAUDE_LOG",
  "NIGHTSHIFT_FAKE_CLAUDE_EXIT",
  "CLAUDE_CONFIG_DIR",
];

const ISOLATION_KEYS = ["NIGHTSHIFT_HOME", "CLAUDE_CONFIG_DIR", "NIGHTSHIFT_CLAUDE_BIN"];

// Refuses an environment that would let a test reach the real host instead of a temporary one.
export function assertIsolatedEnv(env) {
  const missing = ISOLATION_KEYS.filter((key) => !env?.[key]);
  if (!missing.length) return env;
  throw new Error(`this environment is not isolated from the real host (missing ${missing.join(", ")}); build it with makeHostEnv or isolatedHostVars`);
}

// Copies the fake claude CLI into the temporary directory, always executable.
function installFakeClaude(dir) {
  const bin = join(dir, "claude");
  copyFileSync(FAKE_SOURCE, bin);
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

// Environment variables that keep any process away from the real host: isolated config dir plus the fake claude CLI.
export function isolatedHostVars(dir) {
  const configDir = join(dir, "claude-config");
  mkdirSync(configDir, { recursive: true });
  return {
    CLAUDE_CONFIG_DIR: configDir,
    NIGHTSHIFT_CLAUDE_BIN: installFakeClaude(dir),
    NIGHTSHIFT_FAKE_CLAUDE_LOG: join(dir, "claude-calls.log"),
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
