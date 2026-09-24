import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  SHIM_NAME,
  binDir,
  configPath,
  dbPath,
  dbShmPath,
  embeddingDir,
  homeDir,
  queuePausedPath,
  secretsPath,
  shimNames,
} from "../config/paths.mjs";
import { listProjects } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { claudeBin } from "../host/claude.mjs";
import { DESKTOP_LABEL, desktopState } from "../host/desktop.mjs";
import { MCP_SERVER_NAME, readRegisteredServer, serverIsCurrent } from "../host/mcp.mjs";
import { RISKY_FS_TYPES, isRiskyFsType, mountOfPath } from "../host/mounts.mjs";
import { npmBin, npmView } from "../host/npm.mjs";
import { OPERATOR_AGENT, OPERATOR_MODE_AGENT, operatorAgentPath, probeOperatorLaunch } from "../host/operator.mjs";
import { marketplaceIsCurrent, pluginRef, readInstalledPlugin, readKnownMarketplace } from "../host/plugin.mjs";
import { legacyShimState, packageVersion, registrySpec, runtimeVersion, shimState } from "../host/runtime.mjs";
import { hookStatus, readHostSettings } from "../host/settings.mjs";
import { PATH_MARK, binDirInPath, rcFilePath } from "../host/shell.mjs";
import { EMBEDDING_MODEL_TAG, embeddingLibraryEntry, isModelCached } from "../memory/embedding.mjs";
import { HOST_COMMANDS_SAMPLE_SIZE } from "../memory/jobs.mjs";
import { DB_USER_VERSION } from "../memory/schema.mjs";
import { ownerLabel } from "../memory/scope.mjs";
import { keepAwakeMode, resolveCaffeinateBin } from "../queue/keep-awake.mjs";
import { isRegistryFailure, killProcess, listRunnerRecords, liveRunnersReport, registryReadError } from "../queue/registry.mjs";
import { closesSummary } from "../queue/close-view.mjs";
import { readRunState } from "../queue/resume.mjs";
import { canonicalPath, lockState, parseWorktreeList } from "../queue/worktree.mjs";
import { openStoreReadOnly } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { orphanOrgRows, readPendingRename } from "./org.mjs";
import { firstLine } from "./report.mjs";
import { runtimeLabel, runtimeLocation } from "./runtime-versions.mjs";

const COMMAND_TIMEOUT_MS = 5000;
const MIN_NODE_MAJOR = 22;

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
      missing: result?.error?.code === "ENOENT",
    };
  } catch (err) {
    return { ok: false, stdout: "", missing: err?.code === "ENOENT" };
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
  return check(label, "ok", state.path);
}

// Checks every command name the installation can write, the canonical one plus the two shortcuts.
function checkShims(ctx) {
  return shimNames().map((name) => checkShim(ctx, name));
}

// Warns about the shim of the previous command name, which a current installation no longer writes.
function checkLegacyShim(ctx) {
  const state = legacyShimState(ctx.env);
  if (!state.present) return [];
  const hint = state.own ? "run `nightqueue setup` to remove it" : `remove ${state.path} by hand`;
  return [check("legacy shim", "warn", `${state.path} is left over from the \`shift\` command`, hint)];
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

// Hint for a database whose schema version is not the one this build knows.
function schemaVersionHint(version) {
  return version < DB_USER_VERSION
    ? "run `nightqueue queue status` once to migrate it"
    : "upgrade nightqueue to the version that wrote this schema";
}

// Checks the memory database, opening it read-only so the diagnosis never creates nor migrates it.
async function checkDatabase(ctx) {
  const path = dbPath(ctx.env);
  if (!existsSync(path)) return check("database", "warn", "no database yet", "it is created on the first memory write");
  const store = openStoreReadOnly(ctx.env);
  try {
    const { schemaVersion, errors } = await store.health();
    if (errors.schemaVersion !== null) return check("database", "fail", errors.schemaVersion, `inspect ${path}`);
    if (schemaVersion === DB_USER_VERSION) return check("database", "ok", `schema v${schemaVersion}`);
    const status = schemaVersion < DB_USER_VERSION ? "warn" : "fail";
    return check("database", status, `schema v${schemaVersion}, expected v${DB_USER_VERSION}`, schemaVersionHint(schemaVersion));
  } catch (err) {
    return check("database", "fail", err?.message ?? String(err), `inspect ${path}`);
  } finally {
    await store.close();
  }
}

const ORG_REPAIR_HINT = "run `nightqueue org repair`";

// Checks that every org row has its org: no rename left in flight, no row pointing to a name the config does not know.
async function checkOrgRows(ctx) {
  const pending = readPendingRename(ctx.env);
  if (pending) {
    const which = pending.from ? `\`${pending.from}\` -> \`${pending.to}\`` : "of unknown names";
    return check("org rows", "fail", `org rename ${which} interrupted`, ORG_REPAIR_HINT);
  }
  const store = openStoreReadOnly(ctx.env);
  try {
    const orphans = await orphanOrgRows(ctx.env, loadConfig(ctx.env, { warn: () => {} }), store);
    if (orphans.length) {
      const detail = orphans.map((o) => `${o.total} row(s) point to unknown org \`${o.org}\``).join("; ");
      return check("org rows", "fail", detail, `${ORG_REPAIR_HINT} --to <org>`);
    }
    return check("org rows", "ok", "every org row has its org");
  } catch (err) {
    return check("org rows", "fail", err?.message ?? String(err), `inspect ${dbPath(ctx.env)}`);
  } finally {
    await store.close();
  }
}

// One drifted entry: an item or a project row behind its job, or an org item whose status disagrees with its rows.
function roadmapDriftEntry(row) {
  if (row.job_id === null) return `${row.owner}#${row.id} ${row.status} (derived from its project rows: ${row.expected})`;
  const where = row.project ? ` row ${row.project}` : "";
  return `#${row.id}${where} ${row.status} (job ${row.job_id} ${row.job_status}, expected ${row.expected})`;
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
  return [database, await checkOrgRows(ctx), await checkRoadmapWorkflow(ctx)];
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

// Checks the shared-memory file of the database: the hidden orphans a filesystem left beside it, and whether a live runner is still attached to the one on disk.
function checkDbShm(ctx) {
  const name = "db shm";
  if (!existsSync(dbPath(ctx.env))) return check(name, "ok", "no database yet");
  const orphans = orphanArtifacts(ctx.env);
  if (orphans.error) return check(name, "warn", `unknown: ${homeDir(ctx.env)} cannot be listed (${orphans.error})`, `read the permissions of ${homeDir(ctx.env)}`);
  if (orphans.names.length) {
    const detail = `${orphans.names.length} hidden orphan file(s) beside the database (${orphans.names.slice(0, 3).join(", ")})`;
    return check(name, "warn", detail, SHM_HINT);
  }
  return checkShmWitness(ctx, name);
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
  const items = rows.map((row) => `${ownerLabel(row)} (job ${row.job_id})`).join(", ");
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
  if (info.mode === "close") return `, close job #${info.jobId}`;
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
    ...closeGroup(inFlight, "in flight", ({ id, step, pid }) => `#${id} at ${step}${pid === null ? "" : `, pid ${pid}`}`),
    ...closeGroup(failed, "failed", ({ id, step, reason }) => `#${id} at ${step}: ${reason}`),
    ...closeGroup(stalled, "with a dead lease", ({ id }) => `#${id}`),
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

// Checks every registered project, or reports that none is registered.
function checkProjects(ctx) {
  let projects = [];
  try {
    projects = listProjects(loadConfig(ctx.env, { warn: () => {} }));
  } catch {
    return [];
  }
  if (!projects.length) return [check("projects", "warn", "no project registered", "run `nightqueue init`")];
  return projects.map((project) => checkProject(ctx, project));
}

// Quotes a path for a POSIX shell, so a hint can be pasted as is whatever the path holds.
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// Registered projects that have a `.claude/worktrees` directory, the only place the pipeline creates its worktrees.
function projectsWithWorktrees(ctx) {
  try {
    return listProjects(loadConfig(ctx.env, { warn: () => {} }))
      .filter((project) => project.exists)
      .map((project) => ({ ...project, dir: join(project.path, ".claude", "worktrees") }))
      .filter((project) => statSync(project.dir, { throwIfNoEntry: false })?.isDirectory() === true);
  } catch {
    return [];
  }
}

// The worktrees a job that is not closed still names in the state of its run, canonical; read through a read-only store only.
async function ownedWorktrees(ctx) {
  if (!existsSync(dbPath(ctx.env))) return { paths: new Set(), error: null };
  const store = openStoreReadOnly(ctx.env);
  try {
    const jobs = await store.jobs.listOpenJobs();
    const recorded = jobs.map((job) => readRunState({ project: job.project, slug: job.slug, env: ctx.env })?.worktree);
    return { paths: new Set(recorded.filter((path) => typeof path === "string" && path.trim()).map((path) => canonicalPath(path.trim()))), error: null };
  } catch (err) {
    return { paths: null, error: err?.message ?? String(err) };
  } finally {
    await store.close();
  }
}

// The report of one directory under `.claude/worktrees` no open job owns, or null when it is owned or a live session holds it.
function leftoverCheck(ctx, { project, dir, entries, owned }) {
  const canonical = canonicalPath(dir);
  if (owned.has(canonical)) return null;
  const name = `worktree ${project.name}/${basename(dir)}`;
  const entry = entries.find((candidate) => canonicalPath(candidate.path) === canonical);
  if (!entry) return check(name, "warn", "left over: not registered in git (orphaned), no open job owns it", `rm -rf ${shellQuote(dir)}`);
  const lock = lockState(entry, ctx.killImpl ?? killProcess);
  if (lock === "live") return null;
  const remove = `git -C ${shellQuote(project.path)} worktree remove ${shellQuote(dir)}`;
  if (lock === "none") return check(name, "warn", "left over: registered in git, no open job owns it", remove);
  const unlock = `git -C ${shellQuote(project.path)} worktree unlock ${shellQuote(dir)}`;
  return check(name, "warn", `left over: registered in git and locked (${entry.locked || "no reason"}), no open job owns it`, `${unlock} && ${remove}`);
}

// Directories directly under a `.claude/worktrees`, symlinks left out.
function worktreeDirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => join(dir, dirent.name));
}

// Reports every leftover under the `.claude/worktrees` of one project, or one warning when git or the directory cannot be read.
function projectLeftovers(ctx, project, owned) {
  const listed = runCommand(ctx, "git", ["worktree", "list", "--porcelain"], { cwd: project.path });
  if (!listed.ok) return [check(`worktrees ${project.name}`, "warn", "git could not list the worktrees of the checkout", `inspect ${project.path}`)];
  const entries = parseWorktreeList(listed.stdout);
  try {
    return worktreeDirs(project.dir)
      .map((dir) => leftoverCheck(ctx, { project, dir, entries, owned }))
      .filter(Boolean);
  } catch (err) {
    return [check(`worktrees ${project.name}`, "warn", `${project.dir} cannot be listed (${err?.message ?? String(err)})`, `read the permissions of ${project.dir}`)];
  }
}

// Reports the directories under `.claude/worktrees` of each project that no open job owns, with the command that cleans each; it never cleans anything itself.
async function checkWorktreeLeftovers(ctx) {
  const projects = projectsWithWorktrees(ctx);
  if (!projects.length) return [];
  const owned = await ownedWorktrees(ctx);
  if (owned.error !== null) {
    return [check("worktrees", "warn", `the queue cannot be read (${owned.error}), so the owner of a worktree is unknown`, `inspect ${dbPath(ctx.env)}`)];
  }
  return projects.flatMap((project) => projectLeftovers(ctx, project, owned.paths));
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
    ...checkShims(ctx),
    ...checkLegacyShim(ctx),
    checkPath(ctx),
    checkMcp(ctx),
    checkDesktopMcp(ctx),
    ...checkHooks(ctx),
    checkPlugin(ctx),
    checkModel(ctx),
    ...checkEmbeddingPrefix(ctx),
    ...(await checkDatabaseAndRows(ctx)),
    checkDbShm(ctx),
    checkHomeMount(ctx),
    ...(await checkQueue(ctx)),
    ...checkProjects(ctx),
    ...(await checkWorktreeLeftovers(ctx)),
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

// Runs `nightqueue doctor`: reads the state of the host and of the home, writes nothing, and exits 1 on any failure.
export async function run(argv, ctx) {
  const options = { json: { type: "boolean" }, "check-updates": { type: "boolean" } };
  const { values, positionals } = parseCommand(argv, options);
  checkArgs(positionals, { max: 0, usage: "nightqueue doctor [--json] [--check-updates]" });
  const checks = await collect(ctx, values);
  const ok = !checks.some((entry) => entry.status === "fail");
  if (values.json === true) ctx.out(JSON.stringify({ ok, checks }));
  else {
    const width = nameWidth(checks);
    for (const entry of checks) ctx.out(reportLine(entry, width));
  }
  return ok ? 0 : 1;
}
