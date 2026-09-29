import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  LEGACY_SHIM_NAME,
  LEGACY_SHIM_NAMES,
  SHIM_NAME,
  binDir,
  configPath,
  dbPath,
  dbShmPath,
  embeddingDir,
  homeDir,
  legacyHomeDir,
  operatorQaDir,
  queuePausedPath,
  secretsPath,
  shimNames,
  worktreesDir,
} from "../config/paths.mjs";
import { loadConfig, loadRawConfig, removeHomeFiles } from "../config/store.mjs";
import { claudeBin } from "../host/claude.mjs";
import { DESKTOP_LABEL, desktopState } from "../host/desktop.mjs";
import { MCP_SERVER_NAME, readRegisteredServer, serverIsCurrent } from "../host/mcp.mjs";
import { RISKY_FS_TYPES, isRiskyFsType, mountOfPath } from "../host/mounts.mjs";
import { npmBin, npmView } from "../host/npm.mjs";
import { OPERATOR_AGENT, OPERATOR_MODE_AGENT, operatorAgentPath, probeOperatorLaunch } from "../host/operator.mjs";
import { marketplaceIsCurrent, pluginRef, readInstalledPlugin, readKnownMarketplace } from "../host/plugin.mjs";
import { isOwnShim, legacyShimState, packageVersion, registrySpec, runtimeVersion, shimState } from "../host/runtime.mjs";
import { hookStatus, readHostSettings } from "../host/settings.mjs";
import { TOOL_CONTRACT } from "../mcp/tool-contract.mjs";
import { PATH_MARK, binDirInPath, rcFilePath, shadowingDir } from "../host/shell.mjs";
import { EMBEDDING_MODEL_TAG, embeddingLibraryEntry, isModelCached } from "../memory/embedding.mjs";
import { HOST_COMMANDS_SAMPLE_SIZE } from "../memory/jobs.mjs";
import { hasLegacyRegistry } from "../memory/migration/v18.mjs";
import { DB_USER_VERSION } from "../memory/schema.mjs";
import { decisionRef } from "../memory/scope.mjs";
import { keepAwakeMode, resolveCaffeinateBin } from "../queue/keep-awake.mjs";
import { isRegistryFailure, killProcess, listRunnerRecords, liveRunnersReport, registryReadError } from "../queue/registry.mjs";
import { closesSummary } from "../queue/close-view.mjs";
import { canonicalPath, jobWorktreeOwners, lockState, parseWorktreeList } from "../queue/worktree.mjs";
import { openStoreReadOnly, withReadOnlyStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { firstLine } from "./report.mjs";
import { runtimeLabel, runtimeLocation } from "./runtime-versions.mjs";
import { jobRef } from "../memory/refs.mjs";

const COMMAND_TIMEOUT_MS = 5000;
const MIN_NODE_MAJOR = 22;
const GITDIR_PREFIX = "gitdir:";

// One diagnosis line, with the hint the user needs when it is not `ok`.
function check(name, status, detail, hint = null) {
  return { name, status, detail, hint };
}

// Runs a diagnosis command without ever throwing, because a diagnosis must not break on a missing binary.
function runCommand(ctx, file, args, options = {}) {
  try {
    const result = ctx.spawnSyncImpl(file, args, { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, env: ctx.env, ...options });
    return {
      ok: !result?.error && result?.status === 0,
      stdout: typeof result?.stdout === "string" ? result.stdout : "",
      stderr: typeof result?.stderr === "string" ? result.stderr : "",
      missing: result?.error?.code === "ENOENT",
      status: result?.status ?? null,
    };
  } catch (err) {
    return { ok: false, stdout: "", stderr: err?.message ?? "", missing: err?.code === "ENOENT", status: null };
  }
}

// Checks the Node version the memory runtime needs.
function checkNode() {
  const version = process.versions.node;
  const major = Number.parseInt(version.split(".")[0], 10);
  return major >= MIN_NODE_MAJOR
    ? check("node", "ok", `v${version}`)
    : check("node", "fail", `v${version}`, `the memory runtime needs Node >= ${MIN_NODE_MAJOR}`);
}

// Checks that the claude CLI answers.
function checkClaude(ctx) {
  const bin = claudeBin(ctx.env);
  const result = runCommand(ctx, bin, ["--version"]);
  return result.ok
    ? check("claude", "ok", `${bin} ${result.stdout.trim().split("\n")[0]}`.trim())
    : check("claude", "fail", `${bin} did not answer`, "install the claude CLI or point NIGHTQUEUE_CLAUDE_BIN at it");
}

// Checks how `nightqueue open` will load the operator: as the main-thread agent, or through the documented fallback.
function checkOperator(ctx) {
  if (!existsSync(operatorAgentPath())) return check("operator", "fail", "plugin/agents/operator.md missing", "reinstall with `nightqueue update`");
  const probe = probeOperatorLaunch({ bin: claudeBin(ctx.env), ctx });
  if (!probe.answered) return check("operator", "warn", "claude did not answer; `nightqueue open` cannot probe `--agent`", "install the claude CLI or point NIGHTQUEUE_CLAUDE_BIN at it");
  if (probe.mode === OPERATOR_MODE_AGENT) {
    return check("operator", "ok", `\`nightqueue open\` runs the operator as the main thread (\`--agent ${OPERATOR_AGENT}\`)`);
  }
  return check(
    "operator",
    "warn",
    "claude does not list `--agent`: `nightqueue open` appends the agent body with `--append-system-prompt`; the agent's tool restriction does not apply",
    "update Claude Code",
  );
}

// Checks the GitHub CLI, which the pipeline uses but the memory does not require.
function checkGh(ctx) {
  const result = runCommand(ctx, "gh", ["auth", "status"]);
  return result.ok
    ? check("gh", "ok", "authenticated")
    : check("gh", "warn", result.missing ? "not installed" : "not authenticated", "run `gh auth login`");
}

// Checks that config.json is there and readable.
function checkConfig(ctx) {
  const path = configPath(ctx.env);
  if (!existsSync(path)) return check("config", "fail", "config.json not found", "run `nightqueue setup`");
  try {
    loadConfig(ctx.env, { warn: () => {} });
    return check("config", "ok", path);
  } catch (err) {
    return check("config", "fail", err?.message ?? String(err), "fix or remove config.json");
  }
}

// Checks that secrets.json is there and closed to group and others.
function checkSecrets(ctx) {
  const path = secretsPath(ctx.env);
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return check("secrets", "fail", "secrets.json not found", "run `nightqueue setup`");
  const mode = stats.mode & 0o777;
  return (mode & 0o077) === 0
    ? check("secrets", "ok", "mode 0600")
    : check("secrets", "fail", `mode 0${mode.toString(8).padStart(3, "0")}`, `run \`chmod 600 ${path}\``);
}

// Checks that the host starts the MCP server from this very package.
function checkMcp(ctx) {
  const entry = readRegisteredServer(ctx.env);
  if (!entry) return check("mcp", "fail", `\`${MCP_SERVER_NAME}\` not registered`, "run `nightqueue setup`");
  return serverIsCurrent(entry, ctx.env)
    ? check("mcp", "ok", `\`${MCP_SERVER_NAME}\` at user scope`)
    : check("mcp", "fail", "registered from another path", "run `nightqueue setup` to point it at this package");
}

// Checks the registration in the Claude Desktop app, an optional client: an app that is not installed is never a failure.
function checkDesktopMcp(ctx) {
  const state = desktopState(ctx.env);
  if (!state.installed) return check(DESKTOP_LABEL, "ok", "Claude Desktop not installed");
  if (state.error) return check(DESKTOP_LABEL, "warn", state.error, `fix ${state.path} and run \`nightqueue setup\``);
  if (!state.entry) return check(DESKTOP_LABEL, "warn", `\`${MCP_SERVER_NAME}\` not registered`, "run `nightqueue setup`");
  return serverIsCurrent(state.entry, ctx.env)
    ? check(DESKTOP_LABEL, "ok", `\`${MCP_SERVER_NAME}\` at ${state.path}`)
    : check(DESKTOP_LABEL, "warn", "registered from another path", "run `nightqueue setup`");
}

// Checks the four hook entries of this package in the host settings.
function checkHooks(ctx) {
  let settings;
  try {
    settings = readHostSettings(ctx.env);
  } catch (err) {
    return [check("hooks", "fail", err?.message ?? String(err), "fix the host settings file")];
  }
  return hookStatus(settings.data, ctx.env).map(({ event, expected, current, matcherCurrent }) => {
    const name = `hook ${event}`;
    if (!current) return check(name, "fail", "not registered", "run `nightqueue setup`");
    if (current !== expected) return check(name, "fail", "registered from another path", "run `nightqueue setup`");
    if (matcherCurrent === false) return check(name, "warn", "registered with an older tool matcher", "run `nightqueue setup`");
    return check(name, "ok", "registered");
  });
}

// Checks whether the plugin of this package is installed, and whether it really comes from the marketplace of this package.
function checkPlugin(ctx) {
  const installed = readInstalledPlugin(ctx.env);
  const fromThisPackage = marketplaceIsCurrent(readKnownMarketplace(ctx.env), ctx.env);
  if (installed.state === "unknown") {
    return check("plugin", "warn", "the host plugin file has an unknown shape", "run `claude plugin list`");
  }
  if (installed.state === "installed") {
    if (fromThisPackage) return check("plugin", "ok", `${pluginRef()} installed`);
    const detail = `${pluginRef()} installed from a marketplace that is not this package`;
    return check("plugin", "warn", detail, "run `nightqueue setup` to register this package as the marketplace");
  }
  return fromThisPackage
    ? check("plugin", "warn", "marketplace registered, plugin not installed", "run `nightqueue setup`")
    : check("plugin", "fail", "no marketplace of this package registered and no plugin installed", "run `nightqueue setup`");
}

// Checks whether the embedding weights are already on disk.
function checkModel(ctx) {
  return isModelCached(ctx.env)
    ? check("model", "ok", EMBEDDING_MODEL_TAG)
    : check("model", "warn", "no weight on disk", "run `nightqueue embed download`");
}

// Checks that the runtime is installed, names the version directory `current` resolves to and holds the version this process runs.
function checkRuntime(ctx) {
  const location = runtimeLocation(ctx.env);
  const installed = runtimeVersion(ctx.env);
  const running = packageVersion();
  if (!installed) return check("runtime", "fail", `no runtime in ${location}`, "run `nightqueue setup`");
  if (installed !== running) {
    const detail = `v${installed} installed at ${location}, running v${running}`;
    return check("runtime", "warn", detail, "run `nightqueue update`");
  }
  return check("runtime", "ok", `v${installed} at ${location}`);
}

// Shows the tool contract this server publishes, the number a client's cached tool definitions are compared with.
function checkToolContract() {
  return check("tool contract", "ok", `contract ${TOOL_CONTRACT}; a client that cached older tool definitions must be restarted`);
}

// Hint for a command name that is not on disk: only an installation that already has the canonical shim can have turned the shortcuts off.
function missingShimHint(env, canonical) {
  if (canonical || !shimState(env).present) return "run `nightqueue setup`";
  return "run `nightqueue setup` without `--no-shortcuts` to write it";
}

// Checks one shim: the canonical name has to be there, a shortcut only earns a warning when it is missing.
function checkShim(ctx, name) {
  const label = `shim ${name}`;
  const canonical = name === SHIM_NAME;
  const state = shimState(ctx.env, name);
  if (!state.present) {
    const hint = missingShimHint(ctx.env, canonical);
    return check(label, canonical ? "fail" : "warn", `no shim at ${state.path}`, hint);
  }
  if (!state.executable) return check(label, "fail", `${state.path} is not executable`, `run \`chmod +x ${state.path}\``);
  if (!state.current) return check(label, "warn", `${state.path} points elsewhere`, "run `nightqueue setup`");
  const shadow = shadowingDir(name, ctx.env, { ignore: isOwnShim });
  if (shadow) {
    return check(label, "warn", `${state.path} is shadowed by ${join(shadow, name)}, which comes first on PATH`,
      `put ${binDir(ctx.env)} before ${shadow} in your PATH, or type \`${SHIM_NAME}\` instead`);
  }
  return check(label, "ok", state.path);
}

// Checks every command name the installation can write, the canonical one plus the `nq` shortcut.
function checkShims(ctx) {
  return shimNames().map((name) => checkShim(ctx, name));
}

// Warns about the shim of one previous command name, which a current installation no longer writes.
function checkOneLegacyShim(ctx, name) {
  const state = legacyShimState(ctx.env, name);
  if (!state.present) return [];
  const hint = state.own ? "run `nightqueue setup` or `nightqueue update` to remove it" : `remove ${state.path} by hand`;
  const label = name === LEGACY_SHIM_NAME ? "legacy shim" : `legacy shim ${name}`;
  return [check(label, "warn", `${state.path} is left over from the \`${name}\` command`, hint)];
}

// Warns about every shim of a previous command name still in the shim directory.
function checkLegacyShim(ctx) {
  return [LEGACY_SHIM_NAME, ...LEGACY_SHIM_NAMES].flatMap((name) => checkOneLegacyShim(ctx, name));
}

// Names the `~/.nightshift` directory of the command before the rename as removable; nothing here ever deletes it.
function checkLegacyHome(ctx) {
  const path = legacyHomeDir(ctx.env);
  if (!isDirectory(path)) return [];
  return [check("legacy home", "warn", `${path} is left over from the \`nightshift\` command and nothing reads it`, `remove it with: rm -rf ${shellQuote(path)}`)];
}

// Checks whether the shim directory is on the PATH, which is what makes `nightqueue` resolve at all.
function checkPath(ctx) {
  const dir = binDir(ctx.env);
  return binDirInPath(ctx.env)
    ? check("path", "ok", `${dir} on PATH`)
    : check("path", "warn", `${dir} not on PATH`, `run \`nightqueue setup --path\` to add the guarded \`${PATH_MARK}\` block to ${rcFilePath(ctx.env)}`);
}

// Checks the embedding library in its own prefix, resolving it without ever loading it.
function checkEmbedding(ctx) {
  return embeddingLibraryEntry(ctx.env)
    ? check("embedding", "ok", embeddingDir(ctx.env))
    : check("embedding", "warn", "not installed - keyword-only recall", "run `nightqueue embed install`");
}

// Total of the advisories one `npm audit --json` report declares, or null when the report is unreadable.
function auditTotal(stdout) {
  try {
    const total = JSON.parse(stdout)?.metadata?.vulnerabilities?.total;
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

// Audits the embedding prefix, informative only: those advisories sit in code nightqueue never executes.
function checkEmbeddingAudit(ctx) {
  const dir = embeddingDir(ctx.env);
  const result = runCommand(ctx, npmBin(ctx.env), ["audit", "--prefix", dir, "--json"]);
  const total = auditTotal(result.stdout);
  if (total === null) return check("embedding audit", "warn", "audit did not answer", `run \`npm audit --prefix ${dir}\``);
  if (total === 0) return check("embedding audit", "ok", "no advisory");
  const detail = `${total} advisories in the embedding prefix`;
  return check("embedding audit", "warn", detail, "they sit in parts of the library that nightqueue never executes");
}

// Checks the embedding prefix: the library always, its audit only once the prefix is there.
function checkEmbeddingPrefix(ctx) {
  const checks = [checkEmbedding(ctx)];
  if (existsSync(embeddingDir(ctx.env))) checks.push(checkEmbeddingAudit(ctx));
  return checks;
}

// Why the pending migration of an older database will refuse, or null when nothing points at a missing row.
function refusedMigration(health) {
  const count = health.danglingReferences;
  if (!Number.isInteger(count) || count === 0) return null;
  return `${count} row(s) point at a row that does not exist, so its migration to v${DB_USER_VERSION} will refuse and write nothing`;
}

// The hint that lists and fixes the rows a pending migration refuses.
function danglingHint(path) {
  return `run \`nightqueue queue status\` to list them (it writes nothing), then fix or clear them with sqlite3 on ${path}`;
}

// Checks the memory database, opening it read-only so the diagnosis never creates nor migrates it.
async function checkDatabase(ctx) {
  const path = dbPath(ctx.env);
  if (!existsSync(path)) return check("database", "warn", "no database yet", "it is created on the first memory write");
  const store = openStoreReadOnly(ctx.env);
  try {
    const health = await store.health();
    const { schemaVersion, errors } = health;
    if (errors.schemaVersion !== null) return check("database", "fail", errors.schemaVersion, `inspect ${path}`);
    if (schemaVersion === DB_USER_VERSION) return check("database", "ok", `schema v${schemaVersion}`);
    const refusal = refusedMigration(health);
    if (refusal) return check("database", "warn", `schema v${schemaVersion}, expected v${DB_USER_VERSION}; ${refusal}`, danglingHint(path));
    return check(
      "database",
      "warn",
      `schema v${schemaVersion}, expected v${DB_USER_VERSION}`,
      "run `nightqueue queue status` once to migrate it",
    );
  } catch (err) {
    return check("database", "fail", err?.message ?? String(err), `inspect ${path}`);
  } finally {
    await store.close();
  }
}

// One drifted entry: an item or a project row behind its job, or an org item whose status disagrees with its rows.
function roadmapDriftEntry(row) {
  if (row.job_id === null) return `${row.ref} ${row.status} (derived from its project rows: ${row.expected})`;
  const where = row.project ? ` row ${row.project}` : "";
  return `${row.ref}${where} ${row.status} (${jobRef(row.job_id)} ${row.job_status}, expected ${row.expected})`;
}

// The detail of the roadmap entries whose status disagrees with their job or their rows: how many, then each with its status and the expected one.
function roadmapDriftDetail(rows) {
  const noun = rows.length === 1 ? "roadmap status out of step" : "roadmap statuses out of step";
  return `${rows.length} ${noun}: ${rows.map(roadmapDriftEntry).join(", ")}`;
}

// What to do about the drift: the claim cycle re-syncs what is behind a job; an org item is re-derived at its next row change or set by hand.
function roadmapDriftHint(rows) {
  const hints = [];
  if (rows.some((row) => row.job_id !== null)) hints.push("the next `nightqueue queue run` claim cycle re-syncs the ones behind a job");
  if (rows.some((row) => row.job_id === null)) {
    hints.push("an org item is re-derived at its next project row change, or set its status with `roadmap_update`");
  }
  return hints.join("; ");
}

// Reports the roadmap items and rows whose status disagrees with their linked job, and the org items whose status disagrees with their rows, reading read-only.
async function checkRoadmapWorkflow(ctx) {
  const store = openStoreReadOnly(ctx.env);
  try {
    const rows = await store.roadmap.roadmapDrift();
    if (!rows.length) return check("roadmap workflow", "ok", "every linked item follows its job");
    return check("roadmap workflow", "warn", roadmapDriftDetail(rows), roadmapDriftHint(rows));
  } catch (err) {
    return check("roadmap workflow", "warn", err?.message ?? String(err), `inspect ${dbPath(ctx.env)}`);
  } finally {
    await store.close();
  }
}

// The database check plus, only on a database at the current schema, the checks that read its columns.
async function checkDatabaseAndRows(ctx) {
  const database = await checkDatabase(ctx);
  if (database.status !== "ok") return [database];
  return [database, await checkRoadmapWorkflow(ctx)];
}

const ORPHAN_PREFIXES = [".fuse_hidden", ".nfs"];
const SHM_HINT =
  "the shared-memory index of the WAL was replaced while a connection was still attached to it, which loses writes; stop the runner, run `nightqueue doctor` again, and move NIGHTQUEUE_HOME to local disk";
const MOUNT_LIMITATION = "only the mount in effect right now";
const MOUNT_HINT = `NIGHTQUEUE_HOME must be on local disk: ${RISKY_FS_TYPES.join(", ")} and any fuse filesystem are known to drop the POSIX advisory locks SQLite's WAL depends on`;

// Names of the hidden orphans a filesystem leaves in the home when it renames a file another process still holds instead of unlinking it.
function orphanArtifacts(env) {
  try {
    const names = readdirSync(homeDir(env)).filter((name) => ORPHAN_PREFIXES.some((prefix) => name.startsWith(prefix)));
    return { names, error: null };
  } catch (err) {
    return { names: [], error: err?.message ?? String(err) };
  }
}

// Identity of the shared-memory file on disk, as the decimal strings the runner registered, or null when it is not there.
function shmIdentity(path) {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stats ? { ino: String(stats.ino), dev: String(stats.dev) } : null;
  } catch {
    return null;
  }
}

// Compares the shared-memory file ONE live runner is attached to with the one on disk.
function shmWitnessCheck(ctx, name, info) {
  const witness = info.dbShm;
  const path = dbShmPath(ctx.env);
  const found = shmIdentity(path);
  if (!found) return check(name, "warn", `the shared-memory file the runner (pid ${info.pid}) is attached to is gone (${path})`, SHM_HINT);
  if (found.ino === String(witness.ino) && found.dev === String(witness.dev)) return check(name, "ok", `the live runner is attached to the file on disk (inode ${found.ino})`);
  return check(name, "warn", `the runner (pid ${info.pid}) holds inode ${witness.dev}:${witness.ino}, disk has ${found.dev}:${found.ino}`, SHM_HINT);
}

// Compares the shared-memory file the live runners are attached to with the one on disk; without a live runner, or without a witness, the answer is an unknown and never a pass.
function checkShmWitness(ctx, name) {
  const records = listRunnerRecords(ctx.env, ctx.killImpl);
  const registryError = registryReadError(records);
  if (registryError !== null) return check(name, "ok", `unknown: the runner registry cannot be listed (${registryError})`);
  const live = records.filter((record) => record.status === "alive");
  if (!live.length) return check(name, "ok", "no live runner to compare with");
  const witnessed = live.filter((record) => record.info.dbShm?.ino);
  if (!witnessed.length) {
    const pids = live.map((record) => `pid ${record.info.pid}`).join(", ");
    return check(name, "ok", `unknown: the live runner (${pids}) registered no shared-memory witness`);
  }
  const checks = witnessed.map((record) => shmWitnessCheck(ctx, name, record.info));
  return checks.find((entry) => entry.status !== "ok") ?? checks[0];
}

// Why the orphans must stay: a live runner may still hold them, and an unreadable registry could hide one; null when no runner can be attached.
function orphanHolder(ctx) {
  const records = listRunnerRecords(ctx.env, ctx.killImpl);
  const registryError = registryReadError(records);
  if (registryError !== null) return `the runner registry cannot be listed (${registryError})`;
  const live = records.filter((record) => record.status === "alive");
  return live.length ? `a live runner is registered (${live.map((record) => `pid ${record.info.pid}`).join(", ")})` : null;
}

// The `db shm` row for orphans found: a warning, or what `--fix` made of them once no live runner can hold them.
function orphanCheck(ctx, name, orphans, fix) {
  const detail = `${orphans.length} hidden orphan file(s) beside the database (${orphans.slice(0, 3).join(", ")})`;
  if (!fix) return check(name, "warn", detail, `${SHM_HINT}; with no runner alive, \`nightqueue doctor --fix\` removes them`);
  const holder = orphanHolder(ctx);
  if (holder !== null) return check(name, "warn", `${detail}; not removed: ${holder}`, SHM_HINT);
  const failure = removeHomeFiles(ctx.env, orphans);
  if (failure !== null) return check(name, "warn", `${detail}; could not remove them (${failure})`, `remove them by hand from ${homeDir(ctx.env)}`);
  return check(name, "ok", `removed ${orphans.length} hidden orphan file(s) beside the database`);
}

// Checks the shared-memory file of the database: the hidden orphans a filesystem left beside it (removed with `--fix` when no runner is alive), and whether a live runner is still attached to the one on disk.
function checkDbShm(ctx, fix) {
  const name = "db shm";
  if (!existsSync(dbPath(ctx.env))) return check(name, "ok", "no database yet");
  const orphans = orphanArtifacts(ctx.env);
  if (orphans.error) return check(name, "warn", `unknown: ${homeDir(ctx.env)} cannot be listed (${orphans.error})`, `read the permissions of ${homeDir(ctx.env)}`);
  if (orphans.names.length) return orphanCheck(ctx, name, orphans.names, fix);
  return checkShmWitness(ctx, name);
}

const QUARANTINE_PREFIX = "_broken-";
const QUARANTINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Total bytes of the files under a path, unreadable entries counting zero.
function treeBytes(path) {
  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) return stats.size;
    return readdirSync(path).reduce((total, entry) => total + treeBytes(join(path, entry)), 0);
  } catch {
    return 0;
  }
}

// A byte count as `12 B`, `3.4 KB`, `5.6 MB` or `1.2 GB`.
function humanBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

// Quarantine directories of the home last written more than 30 days ago, or none when the home cannot be listed.
function oldQuarantines(ctx) {
  try {
    return readdirSync(homeDir(ctx.env), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(QUARANTINE_PREFIX))
      .map((entry) => join(homeDir(ctx.env), entry.name))
      .filter((path) => Date.now() - statSync(path).mtimeMs > QUARANTINE_MAX_AGE_MS);
  } catch {
    return [];
  }
}

// Names each `_broken-<stamp>` quarantine older than 30 days as removable, with its size; nothing here ever deletes it.
function checkQuarantines(ctx) {
  return oldQuarantines(ctx).map((path) =>
    check(`quarantine ${basename(path)}`, "warn", `${humanBytes(treeBytes(path))} at ${path}, older than 30 days`, `remove it with: rm -rf ${shellQuote(path)}`),
  );
}

// Runs `mount` for the home-mount check, falling back to the bare name when the absolute path is not on this host.
function runMountCommand(ctx) {
  const absolute = runCommand(ctx, "/sbin/mount", []);
  return absolute.missing ? runCommand(ctx, "mount", []) : absolute;
}

// Checks the filesystem NIGHTQUEUE_HOME sits on, because SQLite's WAL is only correct where the operating system really enforces POSIX advisory locks.
function checkHomeMount(ctx) {
  const name = "home mount";
  const path = homeDir(ctx.env);
  const mount = mountOfPath(path, { runMount: () => runMountCommand(ctx) });
  if (mount.unknown) return check(name, "ok", `unknown: ${mount.unknown} (${MOUNT_LIMITATION})`);
  const detail = `${mount.type} at ${mount.point} (${MOUNT_LIMITATION})`;
  return isRiskyFsType(mount.type) ? check(name, "warn", detail, MOUNT_HINT) : check(name, "ok", detail);
}

// Checks whether the operator left the queue paused, which is a sentinel file and not a config key.
function checkQueuePause(ctx) {
  return existsSync(queuePausedPath(ctx.env))
    ? check("queue", "warn", "paused", "run `nightqueue queue resume`")
    : check("queue", "ok", "not paused");
}

const KEEP_AWAKE_LID_NOTE = "a closed lid with no external display still sleeps, and nothing here wakes an already-sleeping machine";

// Checks `queue.keepAwake`: a plain no-op outside macOS, and on macOS whether `caffeinate` can be found for the configured mode.
function checkKeepAwake(ctx) {
  const mode = keepAwakeMode(ctx.env);
  const platform = ctx.platform ?? process.platform;
  if (platform !== "darwin") return check("keep awake", "ok", `queue.keepAwake: ${mode} (does nothing outside macOS)`);
  if (mode === "off") return check("keep awake", "ok", `queue.keepAwake: off - ${KEEP_AWAKE_LID_NOTE}`);
  const bin = resolveCaffeinateBin(ctx.env);
  if (!bin) {
    return check(
      "keep awake",
      "warn",
      `queue.keepAwake: ${mode}, caffeinate not found - ${KEEP_AWAKE_LID_NOTE}`,
      "install the Xcode command line tools or set NIGHTQUEUE_CAFFEINATE_BIN to its absolute path",
    );
  }
  return check("keep awake", "ok", `queue.keepAwake: ${mode}, ${bin} - ${KEEP_AWAKE_LID_NOTE}`);
}

// Checks `queue.inheritUserEnvironment`: isolated (the default) is fine, inheriting the operator's own MCP servers, plugins and hooks only warns.
function checkJobEnvironment(ctx) {
  const inherits = loadConfig(ctx.env, { warn: () => {} }).queue?.inheritUserEnvironment === true;
  if (!inherits) {
    return check(
      "job environment",
      "ok",
      "isolated: jobs do not see the operator's MCP servers, plugins or user hooks (queue.inheritUserEnvironment: false)",
    );
  }
  return check(
    "job environment",
    "warn",
    "inherited: jobs see the operator's MCP servers, plugins and user hooks (queue.inheritUserEnvironment: true)",
    "set queue.inheritUserEnvironment to false to isolate jobs again",
  );
}

const QUEUE_JOBS_MIGRATE_HINT = "run `nightqueue memory stats` once to let the runtime migrate the database";

// Counts the jobs left `running` by a runner that died, reading the database read-only.
async function checkQueueJobs(ctx) {
  const store = openStoreReadOnly(ctx.env);
  try {
    const { orphanJobs, errors } = await store.health();
    if (errors.orphanJobs !== null) return check("queue jobs", "warn", errors.orphanJobs, QUEUE_JOBS_MIGRATE_HINT);
    return orphanJobs > 0
      ? check("queue jobs", "warn", `${orphanJobs} orphaned`, "run `nightqueue queue run` to recycle them, or `nightqueue queue cancel <id>`")
      : check("queue jobs", "ok", "no orphan");
  } catch (err) {
    return check("queue jobs", "warn", err?.message ?? String(err), QUEUE_JOBS_MIGRATE_HINT);
  } finally {
    await store.close();
  }
}

// The detail of the proposals left open on closed jobs: how many, then each by number and job.
function staleProposalsDetail(rows) {
  const noun = rows.length === 1 ? "proposed decision" : "proposed decisions";
  const items = rows.map((row) => `${decisionRef(row)} (${jobRef(row.job_id)})`).join(", ");
  return `${rows.length} ${noun} of closed jobs: ${items}`;
}

// Reports the decisions a queue job proposed and nobody settled before the job was closed, reading the database read-only.
async function checkDecisionProposals(ctx) {
  const store = openStoreReadOnly(ctx.env);
  try {
    const rows = await store.decisions.staleProposals();
    if (!rows.length) return check("decision proposals", "ok", "no proposal left open on a closed job");
    return check(
      "decision proposals",
      "warn",
      staleProposalsDetail(rows),
      "accept or reject each with `decision_update` (`status: accepted|rejected`) or `nightqueue decision update <number> --status accepted|rejected`; next time settle them with `nightqueue queue close <id> --decisions accept|reject`",
    );
  } catch (err) {
    return check("decision proposals", "warn", err?.message ?? String(err), QUEUE_JOBS_MIGRATE_HINT);
  } finally {
    await store.close();
  }
}

// What a live registration does, as the report adds it: a watcher's cadence, the job a close is closing, nothing otherwise.
function runnerCadenceDetail(info) {
  if (Number.isInteger(info.intervalS)) return `, ${info.mode} every ${info.intervalS} s`;
  if (info.mode === "close") return `, close ${jobRef(info.jobId)}`;
  return "";
}

// How a live runner is described in the report, with its cadence and the tree it loaded from only when its registration carries them.
function liveRunnerDetail(info, env) {
  const cadence = runnerCadenceDetail(info);
  const label = runtimeLabel(info.runtimeDir, env);
  return `running (pid ${info.pid}${cadence}${label ? `, runtime ${label}` : ""})`;
}

// Report of a live runner: a warning when the tree it loaded from is gone, because it stops claiming after the job it holds.
function liveRunnerCheck(name, info, env) {
  const detail = liveRunnerDetail(info, env);
  if (typeof info.runtimeDir === "string" && info.runtimeDir && !existsSync(info.runtimeDir)) {
    return check(name, "warn", `${detail}: the runtime directory of this runner is gone (${info.runtimeDir})`, "start a new runner with `nightqueue queue run` once it exits");
  }
  return check(name, "ok", detail);
}

// How one registration is named in the report: after the pid it belongs to, or after the registry when no pid can be read.
function runnerRowName(record) {
  return Number.isInteger(record.info?.pid) ? `runner ${record.info.pid}` : "runner registry";
}

// Checks one registration of the registry, which the diagnosis only ever reads.
function checkRunnerRecord(record, env) {
  const name = runnerRowName(record);
  if (isRegistryFailure(record)) {
    return check(name, "warn", `unknown: ${record.path} cannot be listed (${record.error}), so a live runner may be invisible`, `read the permissions of ${record.path}`);
  }
  if (record.status === "alive") return liveRunnerCheck(name, record.info, env);
  if (record.status === "stale") {
    return check(name, "warn", `stale (pid ${record.info.pid} is gone)`, "run `nightqueue queue run --stop` to clear it");
  }
  if (record.status === "foreign") {
    return check(name, "warn", `pid ${record.info.pid} belongs to another user, so it is not the runner`, `remove ${record.path}`);
  }
  return check(name, "warn", `unreadable: ${record.error}`, `remove ${record.path}`);
}

// Checks every registered runner, one row each, or reports that the registry holds none.
function checkRunners(ctx) {
  const records = listRunnerRecords(ctx.env, ctx.killImpl);
  if (!records.length) return [check("runner registry", "ok", "no runner registered")];
  return records.map((record) => checkRunnerRecord(record, ctx.env));
}

// Sums the host-command counters over the sample `nightqueue doctor` reports; a database or a column not there yet
// answers zero exactly like a build that has not migrated - a pure read, never a write and never a failure of its own.
async function hostCommandTotals(ctx) {
  const zero = { backgrounded: 0, killed: 0, timedOut: 0 };
  if (!existsSync(dbPath(ctx.env))) return zero;
  const store = openStoreReadOnly(ctx.env);
  try {
    const rows = await store.jobs.recentHostCommandCounts();
    return rows.reduce(
      (totals, row) => ({
        backgrounded: totals.backgrounded + (row.tasks_backgrounded ?? 0),
        killed: totals.killed + (row.tasks_killed ?? 0),
        timedOut: totals.timedOut + (row.bash_timeouts ?? 0),
      }),
      zero,
    );
  } catch {
    return zero;
  } finally {
    await store.close();
  }
}

// Checks the host commands a runner had to time out, background or kill over the last sample of finished jobs; a
// regression only warns once a task was actually backgrounded or killed, a timeout alone stays informative.
async function checkHostCommands(ctx) {
  const { backgrounded, killed, timedOut } = await hostCommandTotals(ctx);
  const detail = `host commands: ${backgrounded} backgrounded, ${killed} killed, ${timedOut} timed out in the last ${HOST_COMMANDS_SAMPLE_SIZE} jobs`;
  return check("host commands", backgrounded > 0 || killed > 0 ? "warn" : "ok", detail);
}

// Adds one job's orchestrator counters into the running totals; a job finished before the counters existed is not measured.
function addOrchestratorRow(totals, row) {
  if (!Number.isFinite(row?.orch_turns)) return totals;
  return {
    measured: totals.measured + 1,
    turns: totals.turns + row.orch_turns,
    reads: totals.reads + (row.orch_reads ?? 0),
    bash: totals.bash + (row.orch_bash ?? 0),
    explore: totals.explore + (row.orch_bash_explore ?? 0),
    context: totals.context + (row.orch_ctx_last ?? 0),
  };
}

// Sums the orchestrator counters over the sample `nightqueue doctor` reports; a database or a column not there yet
// answers zero - a pure read, never a write and never a failure of its own.
async function orchestratorTotals(ctx) {
  const zero = { measured: 0, turns: 0, reads: 0, bash: 0, explore: 0, context: 0 };
  if (!existsSync(dbPath(ctx.env))) return zero;
  const store = openStoreReadOnly(ctx.env);
  try {
    const rows = await store.jobs.recentOrchestratorCounts();
    return rows.reduce(addOrchestratorRow, zero);
  } catch {
    return zero;
  } finally {
    await store.close();
  }
}

// Checks what the orchestrator of the last sample of finished jobs did itself; it warns once it read the repository or explored with Bash.
async function checkOrchestrator(ctx) {
  const { measured, turns, reads, bash, explore, context } = await orchestratorTotals(ctx);
  const average = measured ? Math.round(context / measured) : 0;
  const detail =
    `orchestrator: ${turns} turns, ${reads} reads outside the run, ${bash} Bash (${explore} exploration), ` +
    `last context ${context} (avg ${average}) in the last ${HOST_COMMANDS_SAMPLE_SIZE} jobs (${measured} measured)`;
  return check("orchestrator", reads > 0 || explore > 0 ? "warn" : "ok", detail);
}

// One group of the closes row, `<n> <label> (<items>)`, or nothing when the group is empty.
function closeGroup(entries, label, describe) {
  return entries.length ? [`${entries.length} ${label} (${entries.map(describe).join(", ")})`] : [];
}

// The detail of the closes row: every close in flight, failed or on a dead lease, grouped.
function closesDetail({ inFlight, failed, stalled }) {
  const groups = [
    ...closeGroup(inFlight, "in flight", ({ id, step, pid }) => `${jobRef(id)} at ${step}${pid === null ? "" : `, pid ${pid}`}`),
    ...closeGroup(failed, "failed", ({ id, step, reason }) => `${jobRef(id)} at ${step}: ${reason}`),
    ...closeGroup(stalled, "with a dead lease", ({ id }) => jobRef(id)),
  ];
  return groups.length ? groups.join(", ") : "no close in flight, failed or stalled";
}

// Reports the closes in flight, failed or stalled on a dead lease, reading the database read-only; a database without the close columns only asks for the migration.
async function checkCloses(ctx) {
  const store = openStoreReadOnly(ctx.env);
  try {
    const { runners } = liveRunnersReport(ctx.env, ctx.killImpl);
    const summary = closesSummary(await store.jobs.listCloses(), runners);
    const stuck = summary.failed.length + summary.stalled.length > 0;
    return stuck ? check("closes", "warn", closesDetail(summary), "run again with: nightqueue queue close <id>") : check("closes", "ok", closesDetail(summary));
  } catch (err) {
    return check("closes", "warn", err?.message ?? String(err), QUEUE_JOBS_MIGRATE_HINT);
  } finally {
    await store.close();
  }
}

// Checks the queue: the pause sentinel and the runners always, the orphaned jobs, the closes and the open proposals of closed jobs only once the database exists.
async function checkQueue(ctx) {
  const checks = [checkQueuePause(ctx), checkKeepAwake(ctx), checkJobEnvironment(ctx), ...checkRunners(ctx)];
  if (existsSync(dbPath(ctx.env))) checks.push(await checkQueueJobs(ctx), await checkCloses(ctx), await checkDecisionProposals(ctx));
  checks.push(await checkHostCommands(ctx), await checkOrchestrator(ctx));
  return checks;
}

// Checks one registered project: its path and the state of its worktree.
function checkProject(ctx, project) {
  const name = `project ${project.name}`;
  if (!project.exists) return check(name, "fail", `${project.path} no longer exists`, `run \`nightqueue project remove ${project.name}\``);
  const result = runCommand(ctx, "git", ["status", "--porcelain"], { cwd: project.path });
  if (!result.ok) return check(name, "warn", "git did not answer", `inspect ${project.path}`);
  return result.stdout.trim()
    ? check(name, "warn", "worktree with uncommitted changes", `inspect ${project.path}`)
    : check(name, "ok", project.path);
}

// The registered projects that have a checkout, read without creating nor migrating anything: `{ projects }`, or `{ pending }` saying why they cannot be read yet.
async function registeredCheckouts(ctx) {
  if (!existsSync(dbPath(ctx.env))) {
    if (hasLegacyRegistry(loadRawConfig(ctx.env))) return { pending: "the projects of config.json move into the database on the next command that writes" };
    return { projects: [] };
  }
  return await withReadOnlyStore(ctx.env, async (store) => {
    const health = await store.health();
    const { schemaVersion } = health;
    if (Number.isInteger(schemaVersion) && schemaVersion < DB_USER_VERSION) {
      const refusal = refusedMigration(health);
      if (refusal) return { pending: `database is at v${schemaVersion}; ${refusal}`, hint: danglingHint(dbPath(ctx.env)) };
      return { pending: `database is at v${schemaVersion}; it migrates to v${DB_USER_VERSION} on the next command that writes` };
    }
    const projects = (await store.projects.list()).filter((project) => project.path);
    return { projects: projects.map((project) => ({ ...project, exists: existsSync(project.path) })) };
  });
}

// The registered projects with a checkout, or an empty list when they cannot be read.
async function checkoutsOrNone(ctx) {
  try {
    return (await registeredCheckouts(ctx)).projects ?? [];
  } catch {
    return [];
  }
}

// Checks every registered project, or reports that none is registered or that the registry is not readable yet.
async function checkProjects(ctx) {
  let found = null;
  try {
    found = await registeredCheckouts(ctx);
  } catch (err) {
    return [check("projects", "warn", `the registry cannot be read (${err?.message ?? String(err)})`, `inspect ${dbPath(ctx.env)}`)];
  }
  if (found.pending) return [check("projects", "warn", found.pending, found.hint)];
  if (!found.projects.length) return [check("projects", "warn", "no project registered", "run `nightqueue init`")];
  return found.projects.map((project) => checkProject(ctx, project));
}

// Quotes a path for a POSIX shell, so a hint can be pasted as is whatever the path holds.
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// Tells whether a path is a directory, never throwing.
function isDirectory(path) {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

// Registered projects with a legacy `.claude/worktrees` directory, the place an older nightqueue created its worktrees; it is only ever read.
function projectsWithLegacyWorktrees(projects) {
  return projects
    .filter((project) => project.exists)
    .map((project) => ({ ...project, dir: join(project.path, ".claude", "worktrees") }))
    .filter((project) => isDirectory(project.dir));
}

// The worktrees a job that is not closed still names in the state of its run, canonical and mapped to that job; read through a read-only store only.
async function ownedWorktrees(ctx) {
  if (!existsSync(dbPath(ctx.env))) return { owners: new Map(), error: null };
  const store = openStoreReadOnly(ctx.env);
  try {
    const found = jobWorktreeOwners(await store.jobs.listOpenJobs(), ctx.env);
    const owners = new Map([...found].map(([path, owner]) => [path, owner.jobId]));
    return { owners, error: null };
  } catch (err) {
    return { owners: null, error: err?.message ?? String(err) };
  } finally {
    await store.close();
  }
}

// The row of a directory git does not register: removable by hand only when it holds no link to git, else repaired first.
function unregisteredCheck(name, { project, dir, where }) {
  if (!existsSync(join(dir, ".git"))) return check(name, "warn", `${where}left over: not registered in git (orphaned), no open job owns it`, `rm -rf ${shellQuote(dir)}`);
  const repair = `git -C ${shellQuote(project.path)} worktree repair ${shellQuote(dir)}`;
  return check(name, "warn", `${where}left over: it links to git but ${project.path} does not register it, no open job owns it`, `${repair}, then git worktree remove it`);
}

// The report of one worktree directory: legacy-in-use when an open job owns a legacy one, a leftover when none owns it, null when owned or a live session holds it.
function leftoverCheck(ctx, { project, dir, entries, owners, legacy, kind = "worktree" }) {
  const canonical = canonicalPath(dir);
  const name = `${kind} ${project.name}/${basename(dir)}`;
  const owner = owners.get(canonical);
  if (owner !== undefined) {
    return legacy ? check(name, "ok", `legacy-in-use by ${jobRef(owner)} (old location .claude/worktrees): released when the job closes`) : null;
  }
  const where = legacy ? "legacy location, " : "";
  const entry = entries.find((candidate) => canonicalPath(candidate.path) === canonical);
  if (!entry) return unregisteredCheck(name, { project, dir, where });
  const lock = lockState(entry, ctx.killImpl ?? killProcess);
  if (lock === "live") return null;
  const remove = `git -C ${shellQuote(project.path)} worktree remove ${shellQuote(dir)}`;
  if (lock === "none") return check(name, "warn", `${where}left over: registered in git, no open job owns it`, remove);
  const unlock = `git -C ${shellQuote(project.path)} worktree unlock ${shellQuote(dir)}`;
  return check(name, "warn", `${where}left over: registered in git and locked (${entry.locked || "no reason"}), no open job owns it`, `${unlock} && ${remove}`);
}

// Directories directly under a worktrees directory, symlinks left out.
function worktreeDirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => join(dir, dirent.name));
}

// Directories directly under a worktrees directory, or none when it cannot be read.
function worktreeDirsOrNone(dir) {
  try {
    return worktreeDirs(dir);
  } catch {
    return [];
  }
}

// Reports one row per directory under a worktrees directory of a project, or one warning when git or the directory cannot be read.
function scanWorktreeDir(ctx, { project, root, rowOf }) {
  const listed = runCommand(ctx, "git", ["worktree", "list", "--porcelain"], { cwd: project.path });
  if (!listed.ok) return [check(`worktrees ${project.name}`, "warn", "git could not list the worktrees of the checkout", `inspect ${project.path}`)];
  const entries = parseWorktreeList(listed.stdout);
  try {
    return worktreeDirs(root)
      .map((dir) => rowOf(dir, entries))
      .filter(Boolean);
  } catch (err) {
    return [check(`worktrees ${project.name}`, "warn", `${root} cannot be listed (${err?.message ?? String(err)})`, `read the permissions of ${root}`)];
  }
}

// The trimmed content of a small text file, or null when it cannot be read.
function readText(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

// The git administrative directory a worktree's `.git` file points to, or null when it holds no such link.
function linkedAdminDir(dir) {
  const text = readText(join(dir, ".git"));
  if (!text?.startsWith(GITDIR_PREFIX)) return null;
  return resolve(dir, text.slice(GITDIR_PREFIX.length).trim());
}

// Tells whether a path lies strictly under a root once both are resolved.
function isUnderDir(root, path) {
  const inside = relative(canonicalPath(root), canonicalPath(path));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

// The git common directory of a checkout as git itself reports it, canonical, or null when git cannot read the checkout.
function commonDirOf(ctx, checkout) {
  const answered = runCommand(ctx, "git", ["rev-parse", "--git-common-dir"], { cwd: checkout });
  const out = answered.stdout.trim();
  return answered.ok && out ? canonicalPath(resolve(checkout, out)) : null;
}

// Tells whether the two-way link between a worktree and the common directory of its checkout broke, which is what a moved checkout or home leaves behind.
function linkBroken(dir, commonDir) {
  const admin = linkedAdminDir(dir);
  if (admin === null) return false;
  if (!existsSync(admin) || !isUnderDir(join(commonDir, "worktrees"), admin)) return true;
  const back = readText(join(admin, "gitdir"));
  return back === null || canonicalPath(resolve(admin, back)) !== canonicalPath(join(dir, ".git"));
}

// Runs one `git worktree repair` over the broken worktrees of a project, from its checkout; answers null when git accepted it, else git's reason.
function repairLinks(ctx, project, dirs) {
  const repaired = runCommand(ctx, "git", ["worktree", "repair", ...dirs], { cwd: project.path });
  return repaired.ok ? null : firstLine(repaired.stderr) || "git worktree repair failed";
}

// The row of a worktree whose link to its checkout broke: a warning, or what `--fix` made of it once the link is checked again.
function brokenLinkCheck(project, dir, { fix, failure, holdsNow }) {
  const name = `worktree ${project.name}/${basename(dir)}`;
  if (!fix) return check(name, "warn", `git no longer links it to ${project.path} (the checkout or the home moved)`, "run: nightqueue doctor --fix");
  if (holdsNow) return check(name, "ok", `repaired: git links it to ${project.path} again`);
  const why = failure === null ? "still not linked after git worktree repair" : `git worktree repair failed (${failure})`;
  return check(name, "warn", why, `git -C ${shellQuote(project.path)} worktree repair ${shellQuote(dir)}`);
}

// The row of a linked worktree whose link cannot be checked because git cannot read the checkout; nothing is offered for removal.
function unreadableLinkCheck(project, dir) {
  return check(`worktree ${project.name}/${basename(dir)}`, "warn", `cannot check its link: git could not read ${project.path}`, `inspect ${shellQuote(project.path)}`);
}

// The link state of the worktrees of one project under the home: the broken ones, repaired with `--fix` and checked again.
function homeLinks(ctx, { project, dirs, fix }) {
  const commonDir = commonDirOf(ctx, project.path);
  if (commonDir === null) return { commonDir, broken: [], failure: null, stillBroken: [] };
  const broken = dirs.filter((dir) => linkBroken(dir, commonDir));
  const failure = fix && broken.length ? repairLinks(ctx, project, broken) : null;
  const stillBroken = fix ? broken.filter((dir) => linkBroken(dir, commonDir)) : broken;
  return { commonDir, broken, failure, stillBroken };
}

// The row of one worktree directory of a project under the home.
function homeRow(ctx, { project, dir, entries, owners, links, fix }) {
  if (links.commonDir === null && existsSync(join(dir, ".git"))) return unreadableLinkCheck(project, dir);
  if (links.broken.includes(dir)) return brokenLinkCheck(project, dir, { fix, failure: links.failure, holdsNow: !links.stillBroken.includes(dir) });
  return leftoverCheck(ctx, { project, dir, entries, owners, legacy: false });
}

// The rows of the worktrees one project has under the home, the broken links repaired first with `--fix`.
function homeProjectRows(ctx, { project, root, owners, fix }) {
  const links = homeLinks(ctx, { project, dirs: worktreeDirsOrNone(root), fix });
  return scanWorktreeDir(ctx, { project, root, rowOf: (dir, entries) => homeRow(ctx, { project, dir, entries, owners, links, fix }) });
}

// Reports every project directory under a directory of the home: the rows of a registered project, one warning for an id no project with a checkout has.
function scanHomeRoot({ base, projects, label, rowsOf }) {
  const byId = new Map(projects.filter((project) => project.exists).map((project) => [project.id, project]));
  return worktreeDirsOrNone(base).flatMap((root) => {
    const project = byId.get(basename(root));
    if (project) return rowsOf(project, root);
    return [check(`${label} ${basename(root)}`, "warn", "project not registered (no registered project with a checkout has this id)", `inspect ${shellQuote(root)}`)];
  });
}

// Reports every project directory under the home's worktrees.
function checkHomeWorktrees(ctx, { projects, owners, fix }) {
  return scanHomeRoot({ base: worktreesDir(ctx.env), projects, label: "worktrees", rowsOf: (project, root) => homeProjectRows(ctx, { project, root, owners, fix }) });
}

// Reports the QA worktrees the operator left under the home; no job ever owns one, so each is a leftover.
function checkOperatorQa(ctx, { projects }) {
  const rowOf = (project) => (dir, entries) => leftoverCheck(ctx, { project, dir, entries, owners: new Map(), legacy: false, kind: "operator-qa" });
  return scanHomeRoot({ base: operatorQaDir(ctx.env), projects, label: "operator-qa", rowsOf: (project, root) => scanWorktreeDir(ctx, { project, root, rowOf: rowOf(project) }) });
}

// Tells whether the home holds any worktree directory doctor reports on.
function hasHomeWorktrees(env) {
  return worktreeDirsOrNone(worktreesDir(env)).length > 0 || worktreeDirsOrNone(operatorQaDir(env)).length > 0;
}

// Reports the worktrees of the home and the legacy ones under `.claude/worktrees`, with the command that cleans each; the only write is `git worktree repair` with `--fix`.
async function checkWorktreeLeftovers(ctx, values) {
  const projects = await checkoutsOrNone(ctx);
  const legacy = projectsWithLegacyWorktrees(projects);
  if (!legacy.length && !hasHomeWorktrees(ctx.env)) return [];
  const owned = await ownedWorktrees(ctx);
  if (owned.error !== null) {
    return [check("worktrees", "warn", `the queue cannot be read (${owned.error}), so the owner of a worktree is unknown`, `inspect ${dbPath(ctx.env)}`)];
  }
  const legacyRows = legacy.flatMap((project) =>
    scanWorktreeDir(ctx, { project, root: project.dir, rowOf: (dir, entries) => leftoverCheck(ctx, { project, dir, entries, owners: owned.owners, legacy: true }) }),
  );
  return [...legacyRows, ...checkHomeWorktrees(ctx, { projects, owners: owned.owners, fix: values.fix === true }), ...checkOperatorQa(ctx, { projects })];
}

// Reason the registry could not answer, short enough for a report line.
function registryFailure(result) {
  if (result.missing) return "npm not found";
  return firstLine(result.stderr) || `exit ${result.status}`;
}

// Compares the installed runtime with the newest published version, the only network call of the diagnosis and never a failure: a registry that is down says nothing about this host.
function checkRegistry(ctx) {
  const result = npmView({ spec: registrySpec(), env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
  if (!result.ok) return check("registry", "warn", registryFailure(result), result.command);
  const installed = runtimeVersion(ctx.env);
  if (result.version === installed) return check("registry", "ok", `v${installed} is the newest published`);
  const detail = `v${result.version} published, v${installed ?? "none"} installed`;
  return check("registry", "warn", detail, "run `nightqueue update`");
}

// Asks the registry only when the user opted in, which is what keeps the diagnosis offline by default.
function checkUpdates(ctx, values) {
  return values["check-updates"] === true ? [checkRegistry(ctx)] : [];
}

// Runs every check, in the order the report prints them.
async function collect(ctx, values) {
  return [
    checkNode(),
    checkClaude(ctx),
    checkOperator(ctx),
    checkGh(ctx),
    checkConfig(ctx),
    checkSecrets(ctx),
    checkRuntime(ctx),
    checkToolContract(),
    ...checkShims(ctx),
    ...checkLegacyShim(ctx),
    ...checkLegacyHome(ctx),
    checkPath(ctx),
    checkMcp(ctx),
    checkDesktopMcp(ctx),
    ...checkHooks(ctx),
    checkPlugin(ctx),
    checkModel(ctx),
    ...checkEmbeddingPrefix(ctx),
    ...(await checkDatabaseAndRows(ctx)),
    checkDbShm(ctx, values.fix === true),
    ...checkQuarantines(ctx),
    checkHomeMount(ctx),
    ...(await checkQueue(ctx)),
    ...(await checkProjects(ctx)),
    ...(await checkWorktreeLeftovers(ctx, values)),
    ...checkUpdates(ctx, values),
  ];
}

// Width of the name column: the longest name of the report plus one space, never below the historical 22.
export function nameWidth(checks) {
  return Math.max(22, ...checks.map((check) => check.name.length + 1));
}

// One line of the human report; `width` comes from `nameWidth` so a long project name never touches its detail.
export function reportLine({ status, name, detail, hint }, width = 22) {
  const tail = status === "ok" || !hint ? detail : `${detail} - ${hint}`;
  return `${status.padEnd(6)}${name.padEnd(width)}${tail}`;
}

// Runs `nightqueue doctor`: reads the host and the home, writes nothing but `git worktree repair` and the removal of shm orphans with `--fix`, exits 1 on any failure.
export async function run(argv, ctx) {
  const options = { json: { type: "boolean" }, "check-updates": { type: "boolean" }, fix: { type: "boolean" } };
  const { values, positionals } = parseCommand(argv, options);
  checkArgs(positionals, { max: 0, usage: "nightqueue doctor [--json] [--check-updates] [--fix]" });
  const checks = await collect(ctx, values);
  const ok = !checks.some((entry) => entry.status === "fail");
  if (values.json === true) ctx.out(JSON.stringify({ ok, checks }));
  else {
    const width = nameWidth(checks);
    for (const entry of checks) ctx.out(reportLine(entry, width));
  }
  return ok ? 0 : 1;
}
