import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { STORE_UNAVAILABLE_HINT, StoreUnavailableError } from "../config/errors.mjs";
import {
  LEGACY_SHIM_NAME,
  LEGACY_SHIM_NAMES,
  SHIM_NAME,
  binDir,
  configPath,
  dbPath,
  dbShmPath,
  dbWalPath,
  embeddingDir,
  homeDir,
  legacyHomeDir,
  legacyOperatorQaDir,
  qaDir,
  queuePausedPath,
  secretsPath,
  shimNames,
  worktreesDir,
} from "../config/paths.mjs";
import { CONNECTION_TYPES, testConnection } from "../config/connections.mjs";
import { loadConfig, loadRawConfig, loadSecrets, moveHomeFilesInto, removeHomeFiles } from "../config/store.mjs";
import { claudeBin } from "../host/claude.mjs";
import { DESKTOP_LABEL, desktopState } from "../host/desktop.mjs";
import { MCP_SERVER_NAME, readRegisteredServer, serverIsCurrent } from "../host/mcp.mjs";
import { RISKY_FS_TYPES, isRiskyFsType, mountOfPath } from "../host/mounts.mjs";
import { npmBin, npmView } from "../host/npm.mjs";
import { OPERATOR_AGENT, OPERATOR_MODE_AGENT, operatorAgentPath, probeOperatorLaunch } from "../host/operator.mjs";
import { marketplaceIsCurrent, pluginRef, readInstalledPlugin, readKnownMarketplace } from "../host/plugin.mjs";
import { isOwnShim, legacyShimState, packageVersion, registrySpec, runtimeVersion, shimState } from "../host/runtime.mjs";
import { spawnRoot } from "../host/paths.mjs";
import { hookStatus, readHostSettings } from "../host/settings.mjs";
import { TOOL_CONTRACT } from "../mcp/tool-contract.mjs";
import { loadPty } from "../studio/pty.mjs";
import { readStudioStampFile } from "../studio/stamp.mjs";
import { PATH_MARK, binDirInPath, rcFilePath, shadowingDir } from "../host/shell.mjs";
import { EMBEDDING_MODEL_TAG, embeddingLibraryEntry, isModelCached } from "../memory/embedding.mjs";
import { HOST_COMMANDS_SAMPLE_SIZE } from "../memory/jobs.mjs";
import { hasLegacyRegistry } from "../memory/migration/v18.mjs";
import { DB_USER_VERSION } from "../memory/schema.mjs";
import { decisionRef } from "../memory/scope.mjs";
import { keepAwakeMode, resolveCaffeinateBin } from "../queue/keep-awake.mjs";
import { findLostJobs, logOnlyTail, scanDisk } from "../queue/lost-rows.mjs";
import { isRegistryFailure, killProcess, listRunnerRecords, liveRunnersReport, registryReadError } from "../queue/registry.mjs";
import { closesSummary } from "../queue/close-view.mjs";
import { canonicalPath, droppedNames, jobWorktreeOwners, lockState, parseWorktreeList, removeEmptyDir, sameDir } from "../queue/worktree.mjs";
import { compactStamp } from "../queue/runner.mjs";
import { QA_WORKTREE_TTL_MS, listQaWorktrees, sweepQaWorktrees } from "../queue/qa-worktree.mjs";
import { openStore, openStoreReadOnly, releaseHomeConnections, withReadOnlyStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { firstLine } from "./report.mjs";
import { runtimeLabel, runtimeLocation } from "./runtime-versions.mjs";
import { jobRef } from "../memory/refs.mjs";

const COMMAND_TIMEOUT_MS = 5000;
const CONNECTION_TEST_TIMEOUT_MS = 5000;
const CONNECTION_TEST_GRACE_MS = 1000;
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

// Checks whether the studio can embed a terminal: node-pty loads and, on darwin, its spawn-helper is executable; it only reports, never chmods.
async function checkStudioTerminal(ctx) {
  const loaded = await (ctx.loadPtyImpl ?? loadPty)({ fix: false });
  if (loaded.available) return check("studio terminal", "ok", `node-pty ${loaded.version}: the studio can embed a terminal`);
  const hint = loaded.helper
    ? `chmod +x ${loaded.helper}`
    : "the studio falls back to copy-the-command; `nightqueue update` on a host with a C++ toolchain installs it";
  return check("studio terminal", "warn", `node-pty unavailable (${loaded.reason})`, hint);
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

// The stored secrets, or none when secrets.json cannot be read (the secrets check already reports it).
function readSecretsQuietly(ctx) {
  try {
    return loadSecrets(ctx.env, { warn: () => {} });
  } catch {
    return null;
  }
}

// Runs the same test as `connection test`, answering a timeout once it outlives its own budget plus a grace.
function testWithDeadline(ctx, { name, secrets, timeoutMs }) {
  let timer;
  const timedOut = { ok: false, detail: `timeout (${Math.round(timeoutMs / 1000)}s)` };
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs + CONNECTION_TEST_GRACE_MS);
  });
  const tested = testConnection({ name, secrets, fetchImpl: ctx.fetchImpl, timeoutMs }).catch(() => ({ ok: false, detail: "the test threw" }));
  return Promise.race([tested, deadline]).finally(() => clearTimeout(timer));
}

// One line per stored connection: its type answered, a failed test or a type this build does not know is a warning.
async function connectionCheck(ctx, { name, secrets, timeoutMs }) {
  const label = `connection ${name}`;
  const type = secrets.connections[name].type;
  if (!CONNECTION_TYPES.has(type)) return check(label, "warn", `unknown type ${type}`, `update nightqueue or run \`nightqueue connection remove ${name}\``);
  const result = await testWithDeadline(ctx, { name, secrets, timeoutMs });
  return result?.ok === true
    ? check(label, "ok", `${type}: ok`)
    : check(label, "warn", `${type}: failed - ${result?.detail ?? "no answer"}`, `nightqueue connection test ${name}`);
}

// Tests every stored connection in parallel, sorted by name; never a failure, since a service outage says nothing about this host.
async function checkConnections(ctx) {
  const secrets = readSecretsQuietly(ctx);
  const names = Object.keys(secrets?.connections ?? {}).sort();
  const timeoutMs = ctx.connectionTestTimeoutMs ?? CONNECTION_TEST_TIMEOUT_MS;
  return Promise.all(names.map((name) => connectionCheck(ctx, { name, secrets, timeoutMs })));
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

// Checks the studio build the runtime serves: ok with the sha of its stamp, a warning when there is no stamp or it was written for an older version than the runtime.
function checkStudioBuild(ctx) {
  const stamp = readStudioStampFile(spawnRoot(ctx.env));
  const rebuild = "run `npm run studio:build` in the source, then `nightqueue update --from <dir>`";
  if (typeof stamp?.hash !== "string" || !stamp.hash) return check("studio build", "warn", "no studio build stamp in the runtime", rebuild);
  const installed = runtimeVersion(ctx.env);
  if (installed && stamp.version !== installed) {
    return check("studio build", "warn", `built for ${stamp.version ? `v${stamp.version}` : "an older version"}, the runtime is v${installed}`, rebuild);
  }
  return check("studio build", "ok", stamp.hash.slice(0, 12));
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
  return `run \`nightqueue update\` to list them (a refused migration writes nothing), then fix or clear them with sqlite3 on ${path}`;
}

// A row for a database SQLite refuses (not a database, corrupt, I/O error, read-only) or that is older than this build: a warning naming the code, with its one fix.
function unavailableCheck(name, { code, detail, hint }) {
  return check(name, "warn", `${code}: ${detail}`, hint ?? STORE_UNAVAILABLE_HINT);
}

// Checks the memory database, opening it read-only so the diagnosis never creates nor migrates it; a database SQLite refuses only warns.
async function checkDatabase(ctx) {
  const path = dbPath(ctx.env);
  if (!existsSync(path)) return check("database", "warn", "no database yet", "it is created on the first memory write");
  const store = openStoreReadOnly(ctx.env);
  try {
    const health = await store.health();
    const { schemaVersion, errors } = health;
    if (health.unavailable) return unavailableCheck("database", health.unavailable);
    if (errors.schemaVersion !== null) return check("database", "fail", errors.schemaVersion, `inspect ${path}`);
    if (schemaVersion === DB_USER_VERSION) return check("database", "ok", `schema v${schemaVersion}`);
    const refusal = refusedMigration(health);
    const outdated = `schema v${schemaVersion}, this nightqueue expects v${DB_USER_VERSION}`;
    if (refusal) return check("database", "warn", `${outdated}; ${refusal}`, danglingHint(path));
    return check("database", "warn", outdated, "run `nightqueue update`");
  } catch (err) {
    if (err instanceof StoreUnavailableError) return unavailableCheck("database", err);
    return check("database", "fail", err?.message ?? String(err), `inspect ${path}`);
  } finally {
    await store.close();
  }
}

// One drifted entry: an item or a project row behind its job, or an org item whose status disagrees with its rows.
function issueDriftEntry(row) {
  if (row.job_id === null) return `${row.ref} ${row.status} (derived from its project rows: ${row.expected})`;
  const where = row.project ? ` row ${row.project}` : "";
  return `${row.ref}${where} ${row.status} (${jobRef(row.job_id)} ${row.job_status}, expected ${row.expected})`;
}

// The detail of the issue entries whose status disagrees with their job or their rows: how many, then each with its status and the expected one.
function issueDriftDetail(rows) {
  const noun = rows.length === 1 ? "issue status out of step" : "issue statuses out of step";
  return `${rows.length} ${noun}: ${rows.map(issueDriftEntry).join(", ")}`;
}

// What to do about the drift: the claim cycle re-syncs what is behind a job; an org item is re-derived at its next row change or set by hand.
function issueDriftHint(rows) {
  const hints = [];
  if (rows.some((row) => row.job_id !== null)) hints.push("the next `nightqueue queue run` claim cycle re-syncs the ones behind a job");
  if (rows.some((row) => row.job_id === null)) {
    hints.push("an org item is re-derived at its next project row change, or set its status with `issue_update`");
  }
  return hints.join("; ");
}

// Reports the issues and rows whose status disagrees with their linked job, and the org items whose status disagrees with their rows, reading read-only.
async function checkIssueWorkflow(ctx) {
  const store = openStoreReadOnly(ctx.env);
  try {
    const rows = await store.issues.issueDrift();
    if (!rows.length) return check("issue workflow", "ok", "every linked item follows its job");
    return check("issue workflow", "warn", issueDriftDetail(rows), issueDriftHint(rows));
  } catch (err) {
    return check("issue workflow", "warn", err?.message ?? String(err), `inspect ${dbPath(ctx.env)}`);
  } finally {
    await store.close();
  }
}

// The database check plus, only on a database at the current schema, the checks that read its columns.
async function checkDatabaseAndRows(ctx) {
  const database = await checkDatabase(ctx);
  if (database.status !== "ok") return [database];
  return [database, await checkIssueWorkflow(ctx)];
}

const ORPHAN_PREFIXES = [".fuse_hidden", ".nfs"];
const SHM_HINT =
  "the shared-memory index of the WAL was replaced while a connection was still attached to it, which loses writes; stop the runner, run `nightqueue doctor` again, and move NIGHTQUEUE_HOME to local disk; a copy for inspection is `cp`, never a second sqlite on the live file";
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

const SICK_CODES = ["SQLITE_NOTADB", "SQLITE_CORRUPT"];
const CHECKPOINT_BUSY_HINT = "stop the runner, then nightqueue doctor --fix";
const HOLDER_HINT = "stop every nightqueue process (runners and MCP clients), then nightqueue doctor --fix";

// The first lines a check pragma answered, short enough for a report line.
function checkLines(verdict) {
  return verdict.lines.slice(0, 3).join("; ");
}

// A byte count for the `db files` row, or `none` when the file is not there.
function sizeOrNone(bytes) {
  return Number.isFinite(bytes) ? humanBytes(bytes) : "none";
}

// The sizes of the database file and its sidecars, stat only.
async function dbFileSizes(ctx) {
  return await withReadOnlyStore(ctx.env, (store) => store.db.files());
}

// The `db files` row of `--db`: the sizes of the main file, `-wal` and `-shm`, and the identity of `-shm`.
async function checkDbFiles(ctx) {
  try {
    const { main, wal, shm } = await dbFileSizes(ctx);
    const identity = shmIdentity(dbShmPath(ctx.env));
    const inode = identity ? ` (inode ${identity.dev}:${identity.ino})` : "";
    return check("db files", "ok", `main ${sizeOrNone(main)}, wal ${sizeOrNone(wal)}, shm ${sizeOrNone(shm)}${inode}`);
  } catch (err) {
    return check("db files", "warn", err?.message ?? String(err), `read the permissions of ${homeDir(ctx.env)}`);
  }
}

// The `db integrity` row of `--db`: `quick_check` on the live file, read-only.
async function checkDbIntegrity(ctx) {
  const name = "db integrity";
  try {
    const verdict = await withReadOnlyStore(ctx.env, (store) => store.db.quickCheck());
    return verdict.ok ? check(name, "ok", "quick_check ok") : check(name, "warn", `quick_check: ${checkLines(verdict)}`, STORE_UNAVAILABLE_HINT);
  } catch (err) {
    if (err instanceof StoreUnavailableError) return unavailableCheck(name, err);
    return check(name, "warn", err?.message ?? String(err), `inspect ${dbPath(ctx.env)}`);
  }
}

const RECOVER_HINT = "nightqueue queue repair --from-disk";

// One lost job as the `lost jobs` row names it.
function lostJobEntry(job) {
  return `${jobRef(job.jobId)} ${job.project}/${job.slug} last=${job.lastStatus} pr=${job.prUrl ?? "-"}`;
}

// The detail of the `lost jobs` row: each lost job, then the tail of the logs no run and no row explain.
function lostJobsDetail({ lost, logOnly }) {
  const tail = logOnlyTail(logOnly);
  return [...lost.map(lostJobEntry), ...(tail ? [tail] : [])].join("; ");
}

// The ok detail of the `lost jobs` row: log-only ids are named for reading only, since no repair can rebuild them.
function nothingLostDetail(logOnly) {
  const tail = logOnlyTail(logOnly);
  return tail ? `no job on disk is missing from the table; ${tail}, kept for reading only` : "no job on disk is missing from the table";
}

// The `lost jobs` row when the table cannot be read: unknown, still naming the jobs the disk holds.
function unreadableLostJobs(ctx) {
  const disk = scanDisk(ctx.env);
  const ids = [...new Set([...disk.runs.map((entry) => entry.jobId), ...disk.logIds])].sort((a, b) => a - b);
  const onDisk = ids.length === 0 ? "no job on disk" : `on disk: ${ids.map(jobRef).join(", ")}`;
  return check("lost jobs", "warn", `unknown: the table cannot be read; ${onDisk}`, STORE_UNAVAILABLE_HINT);
}

// The `lost jobs` row of `--db`: the jobs the disk knows and the table does not.
async function checkLostJobs(ctx) {
  try {
    const found = await withReadOnlyStore(ctx.env, (store) => findLostJobs(ctx.env, store));
    if (found.lost.length === 0) return check("lost jobs", "ok", nothingLostDetail(found.logOnly));
    return check("lost jobs", "warn", lostJobsDetail(found), RECOVER_HINT);
  } catch (err) {
    if (err instanceof StoreUnavailableError) return unreadableLostJobs(ctx);
    return check("lost jobs", "warn", err?.message ?? String(err), `inspect ${dbPath(ctx.env)}`);
  }
}

// The rows only `--db` adds to the report; it never changes what `--fix` does.
async function dbReportChecks(ctx, values) {
  if (values.db !== true || !existsSync(dbPath(ctx.env))) return [];
  return [await checkDbFiles(ctx), await checkDbIntegrity(ctx), await checkLostJobs(ctx)];
}

// The `db checkpoint` row of `--fix`: the write-ahead log folded and truncated; no row when there is no log to fold or the store does not answer.
async function checkpointChecks(ctx) {
  const name = "db checkpoint";
  try {
    const { wal } = await dbFileSizes(ctx);
    if (!(wal > 0)) return [];
    const { busy, log, checkpointed } = await openStore(ctx.env).db.checkpointTruncate();
    if (busy) return [check(name, "warn", `busy: a live connection kept ${Math.max(0, log - checkpointed)} frames`, CHECKPOINT_BUSY_HINT)];
    return [check(name, "ok", `folded ${checkpointed} frames (busy=${busy})`)];
  } catch (err) {
    if (err instanceof StoreUnavailableError) return [];
    return [check(name, "warn", err?.message ?? String(err), `inspect ${dbPath(ctx.env)}`)];
  }
}

// The code of a database the probe finds not a database or corrupt, or null when it answers or fails for another reason.
async function sickCode(ctx) {
  const probe = ctx.dbProbeImpl ?? (() => withReadOnlyStore(ctx.env, (store) => store.db.quickCheck()));
  try {
    const verdict = await probe();
    return verdict?.ok === false ? "SQLITE_CORRUPT" : null;
  } catch (err) {
    return err instanceof StoreUnavailableError && SICK_CODES.includes(err.code) ? err.code : null;
  }
}

// Tells whether the main file passes `quick_check` on its own, checked on a temporary copy and never on the live file.
async function mainIsIntact(ctx) {
  try {
    return (await withReadOnlyStore(ctx.env, (store) => store.db.quickCheckMainAlone())).ok === true;
  } catch {
    return false;
  }
}

// One backup file with its size and last change, or null when the path is not a file.
function backupEntry(path) {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    return stats?.isFile() ? { path, size: stats.size, mtimeMs: stats.mtimeMs } : null;
  } catch {
    return null;
  }
}

// The files of every `_broken-*` quarantine of the home, or none when the home cannot be listed.
function quarantinedFiles(env) {
  try {
    return readdirSync(homeDir(env), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(QUARANTINE_PREFIX))
      .flatMap((entry) => readdirSync(join(homeDir(env), entry.name)).map((name) => join(homeDir(env), entry.name, name)));
  } catch {
    return [];
  }
}

const PRE_VERSION_BACKUP = /^nightqueue\.db\.pre-v(\d+)(\.(?!.*\.tmp$).+)?$/;

// The copies taken before each schema migration (`nightqueue.db.pre-v<N>`, stamped ones included), oldest version first; a half-written `.tmp` copy is no backup.
function preVersionCopies(env) {
  const home = homeDir(env);
  let names;
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, match: PRE_VERSION_BACKUP.exec(name) }))
    .filter(({ match }) => match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]) || a.name.localeCompare(b.name))
    .map(({ name }) => join(home, name));
}

// Every backup of the home: the copies taken before each schema migration, then the files of each quarantine.
function homeBackups(env) {
  return [...preVersionCopies(env), ...quarantinedFiles(env)].map(backupEntry).filter(Boolean);
}

// One backup as the report names it: path, size and last change.
function describeBackup({ path, size, mtimeMs }) {
  return `${path} (${humanBytes(size)}, ${new Date(mtimeMs).toISOString()})`;
}

// The command that puts the newest whole-database backup back, once every process that holds the database is stopped.
function restoreHint(env, backups) {
  const mains = backups.filter((entry) => !/-(wal|shm)$/.test(entry.path)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const source = mains.length ? shellQuote(mains[0].path) : "<newest backup>";
  return `stop every nightqueue process (runners and MCP clients), then: cp ${source} ${shellQuote(dbPath(env))}`;
}

// The `db repair` refusal for a main file that fails on its own: nothing moves, and the detail names every backup of the home.
function refusedRepair(ctx, code) {
  const backups = homeBackups(ctx.env);
  const listed = backups.length ? `backups: ${backups.map(describeBackup).join(", ")}` : `no backup found in ${homeDir(ctx.env)}`;
  return check("db repair", "fail", `${code}: the main file fails on its own, so nothing was moved; ${listed}`, restoreHint(ctx.env, backups));
}

// Reopens the database once its sidecars are gone: null when `quick_check` and `integrity_check` both pass, else why not.
async function reopenFailure(ctx) {
  try {
    return await withReadOnlyStore(ctx.env, async (store) => {
      const quick = await store.db.quickCheck();
      if (!quick.ok) return `quick_check: ${checkLines(quick)}`;
      const full = await store.db.integrityCheck();
      return full.ok ? null : `integrity_check: ${checkLines(full)}`;
    });
  } catch (err) {
    return err?.message ?? String(err);
  }
}

// The `db repair` row once no runner can hold the sidecars: they are moved aside, then the database is reopened and checked.
async function moveSidecarsAside(ctx, code) {
  const name = `${QUARANTINE_PREFIX}${compactStamp()}`;
  const dir = join(homeDir(ctx.env), name);
  const sidecars = [dbWalPath(ctx.env), dbShmPath(ctx.env)].map((path) => basename(path));
  const { moved, error } = moveHomeFilesInto(ctx.env, { names: sidecars, dir: name });
  if (error !== null) {
    return check("db repair", "fail", `${code}: moving the sidecars into ${dir} failed after ${moved.length ? moved.join(", ") : "none"} (${error})`, `inspect ${homeDir(ctx.env)} and ${dir}`);
  }
  const what = `moved ${moved.length ? moved.join(", ") : "nothing"} into ${dir}`;
  const failure = await reopenFailure(ctx);
  if (failure === null) return check("db repair", "ok", `${what}; integrity ok`);
  return check("db repair", "fail", `${code}: ${what}; the database still fails (${failure})`, restoreHint(ctx.env, homeBackups(ctx.env)));
}

// Reads `lsof -t` strictly: the pids other than this process, no holder only for a clean exit 1, and `unknown` for anything else.
function parseLsof(result) {
  if (result?.error) return { unknown: `lsof: ${result.error.code ?? result.error.message ?? String(result.error)}` };
  const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : "";
  if (result?.status === 1 && !stdout && !stderr) return { pids: [] };
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (result?.status === 0 && lines.length && lines.every((line) => /^\d+$/.test(line))) {
    return { pids: [...new Set(lines.map(Number))].filter((pid) => pid !== process.pid) };
  }
  return { unknown: `lsof exited ${result?.status ?? "without a status"}${stderr ? `: ${firstLine(stderr)}` : ""}` };
}

// The processes other than this one that hold any of the files open, by `lsof`; `unknown` when that cannot be told.
function fileHolders(ctx, paths) {
  const existing = paths.filter((path) => existsSync(path));
  if (!existing.length) return { pids: [] };
  const lsof = ctx.lsofImpl ?? spawnSync;
  try {
    return parseLsof(lsof("lsof", ["-t", "--", ...existing], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS }));
  } catch (err) {
    return { unknown: `lsof: ${err?.message ?? String(err)}` };
  }
}

// Why the sidecars must stay because some process holds the database files (this one included, through a broken handle); null when none is proven to.
function databaseHolder(ctx) {
  if (releaseHomeConnections(ctx.env).heldBroken) return "this doctor process holds a broken connection; run `nightqueue doctor --fix` again";
  const found = fileHolders(ctx, [dbPath(ctx.env), dbWalPath(ctx.env), dbShmPath(ctx.env)]);
  if (found.unknown) return `cannot tell whether a process holds the database (${found.unknown})`;
  return found.pids.length ? `pid ${found.pids.join(", ")} still has the database open` : null;
}

// The `db repair` row of `--fix`, only for a database the probe finds not a database or corrupt.
async function repairChecks(ctx) {
  const code = await sickCode(ctx);
  if (code === null) return [];
  if (!(await mainIsIntact(ctx))) return [refusedRepair(ctx, code)];
  const notMoved = (holder, hint) => [check("db repair", "warn", `${code} with an intact main file; not moved: ${holder}`, hint)];
  const runner = orphanHolder(ctx);
  if (runner !== null) return notMoved(runner, CHECKPOINT_BUSY_HINT);
  const holder = databaseHolder(ctx);
  if (holder !== null) return notMoved(holder, HOLDER_HINT);
  return [await moveSidecarsAside(ctx, code)];
}

// The database actions of `--fix`, one row per action taken: fold the log, then repair a database SQLite refuses.
async function dbFixChecks(ctx, values) {
  if (values.fix !== true || !existsSync(dbPath(ctx.env))) return [];
  return [...(await checkpointChecks(ctx)), ...(await repairChecks(ctx))];
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

const QUEUE_JOBS_MIGRATE_HINT = "run `nightqueue update` to migrate the database";

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
      "accept or reject each with `decision_update` (`status: accepted|rejected`) or `nightqueue decision update <number> --status accepted|rejected`",
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
      return { pending: `database is at v${schemaVersion}; run \`nightqueue update\` to migrate it to v${DB_USER_VERSION}` };
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

// The worktrees at least one job names and only closed or cancelled jobs do, the ones `--fix` may force-remove; a worktree no job names is never in it.
async function releasableWorktrees(store, env) {
  const named = await store.jobs.listNamedJobs();
  const jobs = Array.isArray(named) ? named : [];
  const finished = (job) => job.status === "closed" || job.status === "cancelled";
  const holding = jobWorktreeOwners(jobs.filter((job) => !finished(job)), env);
  return new Set([...jobWorktreeOwners(jobs.filter(finished), env).keys()].filter((path) => !holding.has(path)));
}

// The worktrees a job that is not closed still names in the state of its run, canonical and mapped to that job; read through a read-only store only.
async function ownedWorktrees(ctx, { fix = false } = {}) {
  if (!existsSync(dbPath(ctx.env))) return { owners: new Map(), releasable: new Set(), error: null };
  const store = openStoreReadOnly(ctx.env);
  try {
    const found = jobWorktreeOwners(await store.jobs.listOpenJobs(), ctx.env);
    const owners = new Map([...found].map(([path, owner]) => [path, owner.jobId]));
    return { owners, releasable: fix ? await releasableWorktrees(store, ctx.env) : new Set(), error: null };
  } catch (err) {
    return { owners: null, releasable: new Set(), error: err?.message ?? String(err) };
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

// The row of a leftover `--fix` force-removed: what it dropped, or why git refused.
function removeLeftover(ctx, { project, dir, entry, name }) {
  const status = runCommand(ctx, "git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir });
  const dropped = status.ok ? droppedNames(status.stdout) : "";
  if (lockState(entry, ctx.killImpl ?? killProcess) === "stale") runCommand(ctx, "git", ["worktree", "unlock", dir], { cwd: project.path });
  const removed = runCommand(ctx, "git", ["worktree", "remove", "--force", dir], { cwd: project.path });
  if (!removed.ok) return check(name, "warn", `git worktree remove --force failed (${firstLine(removed.stderr) || `exit ${removed.status}`})`, `inspect ${shellQuote(dir)}`);
  return check(name, "ok", `removed: left over, no open job owns it${dropped ? ` (dropped uncommitted: ${dropped})` : ""}`);
}

// Tells whether a directory holds nothing at all.
function isEmptyDir(dir) {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

// The row of an orphaned empty directory `--fix` removed, or the warning when it could not.
function removeEmptyOrphan(name, dir) {
  try {
    removeEmptyDir(dir);
    return check(name, "ok", "removed: left over, orphaned and empty");
  } catch (err) {
    return check(name, "warn", `could not remove the empty directory (${err?.message ?? String(err)})`, `rm -rf ${shellQuote(dir)}`);
  }
}

// What `--fix` makes of a home directory: an unregistered empty one is removed, a registered unlocked or stale-locked worktree is force-removed only when every job naming it is closed or cancelled; anything else keeps its row.
function fixLeftover(ctx, { project, dir, entries, row, releasable }) {
  const name = `worktree ${project.name}/${basename(dir)}`;
  const entry = entries.find((candidate) => canonicalPath(candidate.path) === canonicalPath(dir));
  if (!entry) return row?.status === "warn" && isEmptyDir(dir) ? removeEmptyOrphan(name, dir) : row;
  if (!releasable.has(canonicalPath(dir))) return row;
  const lock = lockState(entry, ctx.killImpl ?? killProcess);
  return lock === "none" || lock === "stale" ? removeLeftover(ctx, { project, dir, entry, name }) : row;
}

// The row of one worktree directory of a project under the home.
function homeRow(ctx, { project, dir, entries, owners, releasable, links, fix }) {
  if (links.commonDir === null && existsSync(join(dir, ".git"))) return unreadableLinkCheck(project, dir);
  if (links.broken.includes(dir)) return brokenLinkCheck(project, dir, { fix, failure: links.failure, holdsNow: !links.stillBroken.includes(dir) });
  const row = leftoverCheck(ctx, { project, dir, entries, owners, legacy: false });
  return fix ? fixLeftover(ctx, { project, dir, entries, row, releasable }) : row;
}

// With `--fix`, prunes the entries git registers under the project's home directory whose directory is gone and no open job owns, one row each.
function pruneGoneRows(ctx, { project, root, owners }) {
  const listed = runCommand(ctx, "git", ["worktree", "list", "--porcelain"], { cwd: project.path });
  if (!listed.ok) return [];
  const gone = parseWorktreeList(listed.stdout).filter(
    (entry) => entry.prunable !== null && !existsSync(entry.path) && sameDir(dirname(entry.path), root) && !owners.has(canonicalPath(entry.path)),
  );
  if (!gone.length) return [];
  const pruned = runCommand(ctx, "git", ["worktree", "prune"], { cwd: project.path });
  const failure = `git worktree prune failed (${firstLine(pruned.stderr) || `exit ${pruned.status}`})`;
  return gone.map((entry) => {
    const name = `worktree ${project.name}/${basename(entry.path)}`;
    return pruned.ok ? check(name, "ok", "pruned: registered in git but its directory is gone") : check(name, "warn", failure, `git -C ${shellQuote(project.path)} worktree prune`);
  });
}

// The rows of the worktrees one project has under the home, the broken links repaired and the leftovers cleared first with `--fix`.
function homeProjectRows(ctx, { project, root, owners, releasable, fix }) {
  const pruned = fix ? pruneGoneRows(ctx, { project, root, owners }) : [];
  const links = homeLinks(ctx, { project, dirs: worktreeDirsOrNone(root), fix });
  const rows = scanWorktreeDir(ctx, { project, root, rowOf: (dir, entries) => homeRow(ctx, { project, dir, entries, owners, releasable, links, fix }) });
  return [...pruned, ...rows];
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
function checkHomeWorktrees(ctx, { projects, owners, releasable, fix }) {
  return scanHomeRoot({ base: worktreesDir(ctx.env), projects, label: "worktrees", rowsOf: (project, root) => homeProjectRows(ctx, { project, root, owners, releasable, fix }) });
}

const LEGACY_OPERATOR_QA_LABEL = "operator-qa (legacy)";

// Reports, read-only, the QA worktrees an operator before D-58 left under `operator-qa`; no job ever owns one, so each is a leftover.
function checkOperatorQa(ctx, { projects }) {
  const rowOf = (project) => (dir, entries) => leftoverCheck(ctx, { project, dir, entries, owners: new Map(), legacy: false, kind: LEGACY_OPERATOR_QA_LABEL });
  return scanHomeRoot({ base: legacyOperatorQaDir(ctx.env), projects, label: LEGACY_OPERATOR_QA_LABEL, rowsOf: (project, root) => scanWorktreeDir(ctx, { project, root, rowOf: rowOf(project) }) });
}

// An age in hours from one hour on, else in minutes.
function ageText(ms) {
  const minutes = Math.floor((Number.isFinite(ms) ? ms : 0) / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`;
}

// The name of a qa row: `qa <project>/<id>`, else the path under the qa root.
function qaRowName(env, row) {
  if (row.project && row.id) return `qa ${row.project.name}/${row.id}`;
  return `qa ${relative(qaDir(env), row.path) || basename(row.path)}`;
}

// Why a stale qa worktree is stale: its directory gone, its age past the TTL, or its session gone.
function staleWhy(row) {
  if (row.missing) return "its directory is gone";
  return row.ageMs > QA_WORKTREE_TTL_MS ? `age ${ageText(row.ageMs)}` : `session pid ${row.owner} gone`;
}

// The report of one qa worktree row, as `doctor` without `--fix` sees it.
function qaRowCheck(env, row) {
  const name = qaRowName(env, row);
  if (row.foreign) return check(name, "warn", `not a qa worktree; inspect ${row.path} (${row.reason})`, `inspect ${shellQuote(row.path)}`);
  if (row.stale) return check(name, "warn", `stale (${staleWhy(row)}): dropped by the next \`nightqueue open\` or \`nightqueue doctor --fix\``, "nightqueue doctor --fix");
  if (row.ownerState === "live") return check(name, "ok", `in use by pid ${row.owner} (age ${ageText(row.ageMs)})`);
  if (row.ownerState === "manual") return check(name, "warn", `locked by hand (${row.locked || "no reason"})`, `git -C ${shellQuote(row.project.path)} worktree unlock ${shellQuote(row.path)}`);
  return check(name, "ok", `age ${ageText(row.ageMs)}, no session recorded`);
}

// The rows of `doctor --fix` over the qa worktrees: the stale ones dropped, the failures with their reason, the rest as reported.
function fixedQaChecks(ctx, projects) {
  const swept = sweepQaWorktrees({ env: ctx.env, projects, spawnSyncImpl: ctx.spawnSyncImpl, killImpl: ctx.killImpl ?? killProcess });
  const dropped = swept.dropped.map((row) => check(qaRowName(ctx.env, row), "ok", row.missing ? "pruned: stale qa worktree whose directory is gone" : "removed: stale qa worktree"));
  const failed = swept.failed.map(({ row, reason }) =>
    check(row ? qaRowName(ctx.env, row) : "qa", "warn", `could not drop the stale qa worktree (${reason})`, row ? `inspect ${shellQuote(row.path)}` : "nightqueue doctor --fix"),
  );
  return [...dropped, ...failed, ...swept.kept.map((row) => qaRowCheck(ctx.env, row))];
}

// Reports every qa worktree of the home; only `--fix` drops the stale ones.
function checkQaWorktrees(ctx, { projects, fix }) {
  if (worktreeDirsOrNone(qaDir(ctx.env)).length === 0) return [];
  if (fix) return fixedQaChecks(ctx, projects);
  const rows = listQaWorktrees({ env: ctx.env, projects, spawnSyncImpl: ctx.spawnSyncImpl, killImpl: ctx.killImpl ?? killProcess });
  return rows.map((row) => qaRowCheck(ctx.env, row));
}

// Tells whether the home holds any worktree directory doctor reports on.
function hasHomeWorktrees(env) {
  return [worktreesDir(env), legacyOperatorQaDir(env), qaDir(env)].some((dir) => worktreeDirsOrNone(dir).length > 0);
}

// Reports the worktrees of the home and the legacy ones under `.claude/worktrees`, with the command that cleans each; the only write is `git worktree repair` with `--fix`.
async function checkWorktreeLeftovers(ctx, values) {
  const projects = await checkoutsOrNone(ctx);
  const legacy = projectsWithLegacyWorktrees(projects);
  if (!legacy.length && !hasHomeWorktrees(ctx.env)) return [];
  const qaRows = checkQaWorktrees(ctx, { projects, fix: values.fix === true });
  const owned = await ownedWorktrees(ctx, { fix: values.fix === true });
  if (owned.error !== null) {
    return [check("worktrees", "warn", `the queue cannot be read (${owned.error}), so the owner of a worktree is unknown`, `inspect ${dbPath(ctx.env)}`), ...qaRows];
  }
  const legacyRows = legacy.flatMap((project) =>
    scanWorktreeDir(ctx, { project, root: project.dir, rowOf: (dir, entries) => leftoverCheck(ctx, { project, dir, entries, owners: owned.owners, legacy: true }) }),
  );
  return [...legacyRows, ...checkHomeWorktrees(ctx, { projects, owners: owned.owners, releasable: owned.releasable, fix: values.fix === true }), ...checkOperatorQa(ctx, { projects }), ...qaRows];
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

// Asks the npm registry only when the user opted in; the stored connections are the only other services the diagnosis contacts.
function checkUpdates(ctx, values) {
  return values["check-updates"] === true ? [checkRegistry(ctx)] : [];
}

// Runs every check, in the order the report prints them.
async function collect(ctx, values) {
  return [
    checkNode(),
    checkClaude(ctx),
    checkOperator(ctx),
    await checkStudioTerminal(ctx),
    checkGh(ctx),
    checkConfig(ctx),
    checkSecrets(ctx),
    ...(await checkConnections(ctx)),
    checkRuntime(ctx),
    checkStudioBuild(ctx),
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
    ...(await dbFixChecks(ctx, values)),
    ...(await dbReportChecks(ctx, values)),
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

// Runs `nightqueue doctor`: reads the host and the home (more of the database with `--db`), writes only with `--fix` (`git worktree repair`, shm orphans, the WAL checkpoint, the db sidecars moved aside), exits 1 on any failure.
export async function run(argv, ctx) {
  const options = { json: { type: "boolean" }, "check-updates": { type: "boolean" }, fix: { type: "boolean" }, db: { type: "boolean" } };
  const { values, positionals } = parseCommand(argv, options);
  checkArgs(positionals, { max: 0, usage: "nightqueue doctor [--json] [--check-updates] [--fix] [--db]" });
  const checks = await collect(ctx, values);
  const ok = !checks.some((entry) => entry.status === "fail");
  if (values.json === true) ctx.out(JSON.stringify({ ok, checks }));
  else {
    const width = nameWidth(checks);
    for (const entry of checks) ctx.out(reportLine(entry, width));
  }
  return ok ? 0 : 1;
}
