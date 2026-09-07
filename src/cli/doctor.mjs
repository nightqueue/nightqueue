import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { configPath, dbPath, queuePausedPath, secretsPath } from "../config/paths.mjs";
import { listProjects } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { claudeBin } from "../host/claude.mjs";
import { MCP_SERVER_NAME, readRegisteredServer, serverIsCurrent } from "../host/mcp.mjs";
import { marketplaceIsCurrent, pluginRef, readInstalledPlugin, readKnownMarketplace } from "../host/plugin.mjs";
import { hookStatus, readHostSettings } from "../host/settings.mjs";
import { DB_USER_VERSION, openDbReadOnly } from "../memory/db.mjs";
import { EMBEDDING_MODEL_TAG, isModelCached } from "../memory/embedding.mjs";
import { ORPHAN_PREDICATE } from "../memory/jobs.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const COMMAND_TIMEOUT_MS = 5000;
const MIN_NODE_MAJOR = 22;
const TRANSFORMERS = "@huggingface/transformers";

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
    : check("claude", "fail", `${bin} did not answer`, "install the claude CLI or point NIGHTSHIFT_CLAUDE_BIN at it");
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
  if (!existsSync(path)) return check("config", "fail", "config.json not found", "run `shift setup`");
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
  if (!stats) return check("secrets", "fail", "secrets.json not found", "run `shift setup`");
  const mode = stats.mode & 0o777;
  return (mode & 0o077) === 0
    ? check("secrets", "ok", "mode 0600")
    : check("secrets", "fail", `mode 0${mode.toString(8).padStart(3, "0")}`, `run \`chmod 600 ${path}\``);
}

// Checks that the host starts the MCP server from this very package.
function checkMcp(ctx) {
  const entry = readRegisteredServer(ctx.env);
  if (!entry) return check("mcp", "fail", `\`${MCP_SERVER_NAME}\` not registered`, "run `shift setup`");
  return serverIsCurrent(entry)
    ? check("mcp", "ok", `\`${MCP_SERVER_NAME}\` at user scope`)
    : check("mcp", "fail", "registered from another path", "run `shift setup` to point it at this package");
}

// Checks the three hook entries of this package in the host settings.
function checkHooks(ctx) {
  let settings;
  try {
    settings = readHostSettings(ctx.env);
  } catch (err) {
    return [check("hooks", "fail", err?.message ?? String(err), "fix the host settings file")];
  }
  return hookStatus(settings.data).map(({ event, expected, current }) => {
    const name = `hook ${event}`;
    if (!current) return check(name, "fail", "not registered", "run `shift setup`");
    return current === expected
      ? check(name, "ok", "registered")
      : check(name, "fail", "registered from another path", "run `shift setup`");
  });
}

// Checks whether the plugin of this package is installed, and whether it really comes from the marketplace of this package.
function checkPlugin(ctx) {
  const installed = readInstalledPlugin(ctx.env);
  const fromThisPackage = marketplaceIsCurrent(readKnownMarketplace(ctx.env));
  if (installed.state === "unknown") {
    return check("plugin", "warn", "the host plugin file has an unknown shape", "run `claude plugin list`");
  }
  if (installed.state === "installed") {
    if (fromThisPackage) return check("plugin", "ok", `${pluginRef()} installed`);
    const detail = `${pluginRef()} installed from a marketplace that is not this package`;
    return check("plugin", "warn", detail, "run `shift setup` to register this package as the marketplace");
  }
  return fromThisPackage
    ? check("plugin", "warn", "marketplace registered, plugin not installed", "run `shift setup`")
    : check("plugin", "fail", "no marketplace of this package registered and no plugin installed", "run `shift setup`");
}

// Checks whether the embedding weights are already on disk.
function checkModel(ctx) {
  return isModelCached(ctx.env)
    ? check("model", "ok", EMBEDDING_MODEL_TAG)
    : check("model", "warn", "no weight on disk", "run `shift embed download`");
}

// Checks the optional embedding library, resolving it without ever loading it.
function checkTransformers() {
  try {
    createRequire(import.meta.url).resolve(TRANSFORMERS);
    return check("transformers", "ok", TRANSFORMERS);
  } catch {
    return check("transformers", "warn", `${TRANSFORMERS} not installed`, "the recall stays BM25 only; run `npm install`");
  }
}

// Hint for a database whose schema version is not the one this build knows.
function schemaVersionHint(version) {
  return version < DB_USER_VERSION
    ? "run `shift memory stats` once to let the runtime migrate it"
    : "upgrade nightshift to the version that wrote this schema";
}

// Checks the memory database, opening it read-only so the diagnosis never creates nor migrates it.
function checkDatabase(ctx) {
  const path = dbPath(ctx.env);
  if (!existsSync(path)) return check("database", "warn", "no database yet", "it is created on the first memory write");
  let db = null;
  try {
    db = openDbReadOnly(ctx.env);
    const version = db.prepare("PRAGMA user_version").get().user_version;
    return version === DB_USER_VERSION
      ? check("database", "ok", `schema v${version}`)
      : check("database", "fail", `schema v${version}, expected v${DB_USER_VERSION}`, schemaVersionHint(version));
  } catch (err) {
    return check("database", "fail", err?.message ?? String(err), `inspect ${path}`);
  } finally {
    db?.close();
  }
}

// Checks whether the operator left the queue paused, which is a sentinel file and not a config key.
function checkQueuePause(ctx) {
  return existsSync(queuePausedPath(ctx.env))
    ? check("queue", "warn", "paused", "run `shift queue resume`")
    : check("queue", "ok", "not paused");
}

// Counts the jobs left `running` by a runner that died, reading the database read-only.
function checkQueueJobs(ctx) {
  let db = null;
  try {
    db = openDbReadOnly(ctx.env);
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${ORPHAN_PREDICATE}`).get();
    return n > 0
      ? check("queue jobs", "warn", `${n} orphaned`, "run `shift queue run` to recycle them, or `shift queue cancel <id>`")
      : check("queue jobs", "ok", "no orphan");
  } catch (err) {
    const hint = "run `shift memory stats` once to let the runtime migrate the database";
    return check("queue jobs", "warn", err?.message ?? String(err), hint);
  } finally {
    db?.close();
  }
}

// Checks the queue: the pause sentinel always, the orphaned jobs only once the database exists.
function checkQueue(ctx) {
  const checks = [checkQueuePause(ctx)];
  if (existsSync(dbPath(ctx.env))) checks.push(checkQueueJobs(ctx));
  return checks;
}

// Checks one registered project: its path and the state of its worktree.
function checkProject(ctx, project) {
  const name = `project ${project.name}`;
  if (!project.exists) return check(name, "fail", `${project.path} no longer exists`, `run \`shift project remove ${project.name}\``);
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
  if (!projects.length) return [check("projects", "warn", "no project registered", "run `shift init`")];
  return projects.map((project) => checkProject(ctx, project));
}

// Runs every check, in the order the report prints them.
function collect(ctx) {
  return [
    checkNode(),
    checkClaude(ctx),
    checkGh(ctx),
    checkConfig(ctx),
    checkSecrets(ctx),
    checkMcp(ctx),
    ...checkHooks(ctx),
    checkPlugin(ctx),
    checkModel(ctx),
    checkTransformers(),
    checkDatabase(ctx),
    ...checkQueue(ctx),
    ...checkProjects(ctx),
  ];
}

// One line of the human report.
function reportLine({ status, name, detail, hint }) {
  const tail = status === "ok" || !hint ? detail : `${detail} - ${hint}`;
  return `${status.padEnd(6)}${name.padEnd(22)}${tail}`;
}

// Runs `shift doctor`: reads the state of the host and of the home, writes nothing, and exits 1 on any failure.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: "shift doctor [--json]" });
  const checks = collect(ctx);
  const ok = !checks.some((entry) => entry.status === "fail");
  if (values.json === true) ctx.out(JSON.stringify({ ok, checks }));
  else for (const entry of checks) ctx.out(reportLine(entry));
  return ok ? 0 : 1;
}
