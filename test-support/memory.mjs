import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject } from "../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../src/config/store.mjs";
import { closeDb } from "../src/memory/db.mjs";

const OWN_ENV_KEYS = [
  "NIGHTSHIFT_HOME",
  "NIGHTSHIFT_EMBED_DISABLED",
  "NIGHTSHIFT_EMBED_DEADLINE_MS",
  "NIGHTSHIFT_REFLECT",
  "NIGHTSHIFT_REFLECT_MODEL",
  "NIGHTSHIFT_CLAUDE_BIN",
  "NIGHTSHIFT_MODEL",
  "NIGHTSHIFT_SESSION_ID",
  "NIGHTSHIFT_JOB_ID",
  "NIGHTSHIFT_NO_UPDATE_CHECK",
];

// Creates a temporary directory removed at the end of the test.
export function makeDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `nightshift-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Environment of an isolated home, with the semantic path off unless the test asks for it.
export function makeHome(t, name, { embed = false } = {}) {
  const home = join(makeDir(t, name), "home");
  const env = { ...process.env };
  for (const key of OWN_ENV_KEYS) delete env[key];
  env.NIGHTSHIFT_HOME = home;
  env.NIGHTSHIFT_NO_UPDATE_CHECK = "1";
  if (!embed) env.NIGHTSHIFT_EMBED_DISABLED = "1";
  t.after(() => closeDb(env));
  return env;
}

// Registers a temporary directory that looks like a git repository as a project of the home.
export function makeProject(t, env, name) {
  const path = makeDir(t, `repo-${name}`);
  mkdirSync(join(path, ".git"), { recursive: true });
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path, name }).config, env);
  return path;
}

// Embedder double with a fixed vector, so the hybrid recall never depends on the real model.
export function fakeEmbedder(vector, { model = "fake-embedder@v1" } = {}) {
  const calls = [];
  return {
    calls,
    model,
    embedText: async (text) => {
      calls.push(text);
      return typeof vector === "function" ? vector(text) : vector;
    },
  };
}
