import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reads the explicitly named home, or an empty string when the environment names none.
function explicitHome(env) {
  return typeof env?.NIGHTQUEUE_HOME === "string" ? env.NIGHTQUEUE_HOME.trim() : "";
}

// Resolves the configuration home, reading the environment on every call; a test process never falls back to the default.
export function homeDir(env = process.env) {
  const raw = explicitHome(env);
  if (raw) return resolve(raw);
  if (process.env.NODE_TEST_CONTEXT) {
    throw new Error("refused: a test resolved the default ~/.nightqueue; set NIGHTQUEUE_HOME to a temporary directory (see test-support/memory.mjs makeHome)");
  }
  return join(homedir(), ".nightqueue");
}

// Resolves the home for a script that touches the store, refusing the default so an operator's own home is never reached by accident.
export function requireExplicitHome(env = process.env) {
  if (!explicitHome(env)) {
    throw new Error("refused: this script changes the store and needs an explicit NIGHTQUEUE_HOME (NIGHTQUEUE_HOME=/path node scripts/...)");
  }
  return homeDir(env);
}

// Path of the configuration file.
export function configPath(env = process.env) {
  return join(homeDir(env), "config.json");
}

// Path of the secrets file.
export function secretsPath(env = process.env) {
  return join(homeDir(env), "secrets.json");
}

// Path of the SQLite database of the memory runtime.
export function dbPath(env = process.env) {
  return join(homeDir(env), "nightqueue.db");
}

// Path of the copy of the database taken right before its one-shot migration to schema v18.
export function preV18BackupPath(env = process.env) {
  return `${dbPath(env)}.pre-v18`;
}

// Path of the copy of the database taken right before its one-shot migration to schema v19.
export function preV19BackupPath(env = process.env) {
  return `${dbPath(env)}.pre-v19`;
}

// Path of the copy of the database taken right before its one-shot migration to schema v20.
export function preV20BackupPath(env = process.env) {
  return `${dbPath(env)}.pre-v20`;
}

// Path of the copy of the database taken right before its one-shot migration to schema v22.
export function preV22BackupPath(env = process.env) {
  return `${dbPath(env)}.pre-v22`;
}

// Path of the copy of the database `nightqueue update` takes right before it migrates the home to schema `version`.
export function preVersionBackupPath(env = process.env, version) {
  return `${dbPath(env)}.pre-v${version}`;
}

// Path of the shared-memory index of the WAL, the file every open connection of the database maps.
export function dbShmPath(env = process.env) {
  return `${dbPath(env)}-shm`;
}

// Path of the write-ahead log of the database.
export function dbWalPath(env = process.env) {
  return `${dbPath(env)}-wal`;
}

// Path of the cache of the update check: the newest published version and when it was asked for.
export function updateCheckPath(env = process.env) {
  return join(homeDir(env), "update-check.json");
}

// Directory of the embedding model weights, kept outside node_modules on purpose.
export function modelsDir(env = process.env) {
  return join(homeDir(env), "models");
}

// Directory of the self-contained runtime: the root that holds every installed version and the link that names the live one.
export function runtimeDir(env = process.env) {
  return join(homeDir(env), "runtime");
}

// Directory that holds one npm prefix per installed version, the only place an install ever writes a new tree into.
export function runtimeVersionsDir(env = process.env) {
  return join(runtimeDir(env), "versions");
}

// Path of the link that names the version the host runs, the single thing an install ever swaps.
export function runtimeCurrentLink(env = process.env) {
  return join(runtimeDir(env), "current");
}

// Name this package declares to npm, read once because it is the identity the installed layout is built from.
function declaredPackageName() {
  const path = fileURLToPath(new URL("../../package.json", import.meta.url));
  let name;
  try {
    name = JSON.parse(readFileSync(path, "utf8"))?.name;
  } catch (err) {
    throw new Error(
      `cannot read ${path}: ${err?.message ?? String(err)}; this installation of nightqueue is incomplete, reinstall it with \`npm i -g @nightqueue/nq\``,
    );
  }
  if (typeof name !== "string" || !name.trim()) throw new Error(`${path} declares no name; this installation of nightqueue is incomplete, reinstall it`);
  return name.trim();
}

export const PACKAGE_NAME = declaredPackageName();

// Trail from the configuration home down to the installed package, the layout every shim this package writes points into.
export const RUNTIME_PACKAGE_TRAIL = `runtime/current/node_modules/${PACKAGE_NAME}`;

// Trail an installation written before the versioned layout still points into, kept resolvable so an old install never breaks.
export const LEGACY_RUNTIME_PACKAGE_TRAIL = `runtime/node_modules/${PACKAGE_NAME}`;

// Tells whether the runtime of this home is still the one an installation before the versioned layout wrote: no link at all, but a package under the old trail.
function legacyRuntimeOnly(env) {
  if (lstatSync(runtimeCurrentLink(env), { throwIfNoEntry: false })) return false;
  return existsSync(join(homeDir(env), LEGACY_RUNTIME_PACKAGE_TRAIL, "package.json"));
}

// Directory of the package the host is registered against: through the `current` link, and only through the old trail while no link was ever written.
export function runtimePackageDir(env = process.env) {
  const trail = legacyRuntimeOnly(env) ? LEGACY_RUNTIME_PACKAGE_TRAIL : RUNTIME_PACKAGE_TRAIL;
  return join(homeDir(env), trail);
}

// Version directory the `current` link really names, or null when nothing is behind it.
export function resolvedRuntimeDir(env = process.env) {
  try {
    return realpathSync(runtimeCurrentLink(env));
  } catch {
    return null;
  }
}

// Directory of the isolated npm prefix that holds the embedding library, installed on demand.
export function embeddingDir(env = process.env) {
  return join(homeDir(env), "embedding");
}

// Directory the user is invited to put on the PATH.
export function binDir(env = process.env) {
  return join(homeDir(env), "bin");
}

export const SHIM_NAME = "nightqueue";
export const SHORTCUT_SHIM_NAMES = ["nq"];
export const LEGACY_SHIM_NAME = "shift";
export const LEGACY_SHIM_NAMES = ["nightshift", "nsft", "nshift"];

// The user's own home directory, the one a legacy `~/.nightshift` lives in; HOME wins so a test can point it at a temporary directory.
export function userHomeDir(env = process.env) {
  const raw = typeof env?.HOME === "string" ? env.HOME.trim() : "";
  return raw ? resolve(raw) : homedir();
}

// Directory the command before the rename kept its runtime and data in.
export function legacyHomeDir(env = process.env) {
  return join(userHomeDir(env), ".nightshift");
}

// Path of one shim that starts the CLI from the runtime, the canonical name unless another is asked for.
export function shimPath(env = process.env, name = SHIM_NAME) {
  return join(binDir(env), name);
}

// Names of the shims one installation writes: the canonical one always, the shortcuts unless they were turned off.
export function shimNames({ shortcuts } = {}) {
  return shortcuts === false ? [SHIM_NAME] : [SHIM_NAME, ...SHORTCUT_SHIM_NAMES];
}

// Path of the shim an older installation wrote under a previous command name, `shift` unless another is asked for.
export function legacyShimPath(env = process.env, name = LEGACY_SHIM_NAME) {
  return shimPath(env, name);
}

// Directory of the per-session state written by the hooks.
export function stateDir(env = process.env) {
  return join(homeDir(env), "state");
}

// Directory holding every run directory, one sub-directory per project id.
export function runsDir(env = process.env) {
  return join(homeDir(env), "runs");
}

// Directory where the pipeline writes the artifacts and the state.json of one run, keyed by the project's id.
export function runDir(projectId, slug, env = process.env) {
  return join(runsDir(env), projectId, slug);
}

// Path of the append-only file where a run queues the database records the store refused while it was unavailable.
export function pendingWritesPath(projectId, slug, env = process.env) {
  return join(runDir(projectId, slug, env), "pending-writes.jsonl");
}

// Directory holding the git worktree of every queued job, one sub-directory per project id.
export function worktreesDir(env = process.env) {
  return join(homeDir(env), "worktrees");
}

// Path of the git worktree the runtime places a queued job's run in, keyed by the project's id and the run slug.
export function jobWorktreePath(projectId, slug, env = process.env) {
  return join(worktreesDir(env), projectId, slug);
}

// Directory where an operator before D-58 left its QA worktrees, one sub-directory per project id; only doctor still reads it.
export function legacyOperatorQaDir(env = process.env) {
  return join(homeDir(env), "operator-qa");
}

// Directory holding the ephemeral QA worktrees of the operator's qa subagent, one sub-directory per project id.
export function qaDir(env = process.env) {
  return join(homeDir(env), "qa");
}

// Path of one ephemeral QA worktree, keyed by the project's id and the worktree's own id.
export function qaWorktreePath(projectId, id, env = process.env) {
  return join(qaDir(env), projectId, id);
}

// Path of the marker saying the run directories were moved from project names to project ids.
export function runsIdMarkerPath(env = process.env) {
  return join(runsDir(env), ".by-id");
}

// Directory of the queue logs: one file per job plus one per detached runner.
export function logsDir(env = process.env) {
  return join(homeDir(env), "logs");
}

// Path of the accumulated log of one queue job, appended once per attempt.
export function jobLogPath(id, env = process.env) {
  return join(logsDir(env), `job-${id}.log`);
}

// Path of the sentinel file that keeps the queue paused.
export function queuePausedPath(env = process.env) {
  return join(homeDir(env), "queue.paused");
}

// Path of the stamp `queue resume` writes: the instant every runner compares its own rate limit pause against.
export function queueResumePath(env = process.env) {
  return join(homeDir(env), "queue.resume");
}


// Directory of the runner registry: one file per live runner, the way any number of them coexist.
export function runnersDir(env = process.env) {
  return join(homeDir(env), "runners");
}

// Path of the registration of one runner, named after the pid it belongs to.
export function runnerRegistryPath(pid, env = process.env) {
  return join(runnersDir(env), `${pid}.json`);
}

// Directory of the studio's terminal registrations: one file per claude a studio spawned, read by the reaper of the next studio.
export function studioTerminalsDir(env = process.env) {
  return join(homeDir(env), "studio", "terminals");
}

// Path of the single pidfile an installation before the registry wrote; it is read until it is stopped or pruned, and never written again.
export function legacyRunnerPidPath(env = process.env) {
  return join(homeDir(env), "runner.pid");
}
