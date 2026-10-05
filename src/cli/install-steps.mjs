import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LEGACY_SHIM_NAME, LEGACY_SHIM_NAMES, binDir, embeddingDir, homeDir, legacyShimPath, runtimeDir, runtimeVersionsDir, shimPath } from "../config/paths.mjs";
import { loadConfig } from "../config/store.mjs";
import { npmInstall, npmPack, runNpmAsync } from "../host/npm.mjs";
import { packageRoot, spawnRoot } from "../host/paths.mjs";
import {
  packageVersion,
  prefixVersion,
  registrySpec,
  removeLegacyShim,
  removeShims,
  runtimeReady,
  runtimeVersion,
  writeShims,
} from "../host/runtime.mjs";
import { PATH_MARK, addPathLine, binDirInPath, pathBlock, rcFilePath, removePathLine } from "../host/shell.mjs";
import { EMBEDDING_PACKAGE, EMBEDDING_PACKAGE_RANGE, embeddingLibraryEntry, warmupModel } from "../memory/embedding.mjs";
import { confirm } from "./prompt.mjs";
import { firstLine } from "./report.mjs";
import { finishVersion, pruneVersions, runtimeLocation, stageInstall, switchCurrent, versionStamp } from "./runtime-versions.mjs";
import { SCHEMA_LABEL, SCHEMA_PARENT_ENV } from "./schema-migrate.mjs";

const RUNTIME_LABEL = "runtime";
const OLD_RUNTIMES_LABEL = "old runtimes";
const RUNTIME_CHECK_LABEL = "runtime check";
const STUDIO_LABEL = "studio";
const STUDIO_TOOLS = ["tsc", "vite"];
const STUDIO_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const STUDIO_TAIL_LINES = 5;
const STUDIO_HASH_CHARS = 12;
const STUDIO_STAMP_SCRIPT = join("scripts", "studio-stamp.mjs");
const STUDIO_STAMP_TIMEOUT_MS = 60 * 1000;
const STUDIO_OK = /^studio ok ([0-9a-f]+)$/m;
const SHIM_CHECK_TIMEOUT_MS = 15000;
const SCHEMA_TIMEOUT_MS = 30 * 60 * 1000;
const MIGRATED_DETAIL = /^v\d+ -> v\d+/;
const RESTART_CLIENTS_NOTICE =
  "the database schema changed: restart every MCP client (Claude Code sessions, Claude Desktop, a running `nq open`), so no server started by the old nightqueue keeps a connection to it";
const SHIM_LABEL = "shim";
const LEGACY_SHIM_LABEL = "legacy shim";
const PATH_LABEL = "PATH";
const EMBEDDING_LABEL = "embedding";
const DIRS_LABEL = "installed directories";

// Reason one npm call could not be finished, short enough for a report line.
function npmFailure(result) {
  if (result.missing) return "npm not found";
  return firstLine(result.stderr) || `exit ${result.status}`;
}

// Runs one step that touches the disk and turns any failure into a degraded line: a single broken step never aborts the run, neither on install nor on removal.
function guarded(report, label, hint, action) {
  try {
    action();
  } catch (err) {
    report.degrade(label, firstLine(err?.message ?? String(err)), hint);
  }
}

// Description of one path on disk, or null when nothing is there.
function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

// Packs one directory into a tarball of its own temporary directory, so the install never links a checkout into the runtime.
function packDirectory(ctx, report, dir) {
  const destDir = mkdtempSync(join(tmpdir(), "nightqueue-pack-"));
  const cleanup = () => rmSync(destDir, { recursive: true, force: true });
  const result = npmPack({ dir, destDir, env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
  if (result.ok) return { ok: true, spec: result.file, cleanup };
  report.degrade(RUNTIME_LABEL, npmFailure(result), result.command);
  cleanup();
  return { ok: false, cleanup: () => {} };
}

// The stamp check of a source directory, run by the source's own `scripts/studio-stamp.mjs check`: the source that wrote the stamp is the one that judges it, so the runtime's idea of the hash never has to match. A source without the script, or one that cannot be run, is a stale one, never a thrown error.
function readStudioStamp(ctx, dir) {
  const script = join(dir, STUDIO_STAMP_SCRIPT);
  if (!existsSync(script)) return { ok: false, hash: null, reason: `${dir} has no ${STUDIO_STAMP_SCRIPT}` };
  let result;
  try {
    result = ctx.spawnSyncImpl(process.execPath, [script, "check"], { cwd: dir, env: ctx.env, encoding: "utf8", timeout: STUDIO_STAMP_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, hash: null, reason: firstLine(err?.message ?? String(err)) };
  }
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const match = result?.status === 0 ? STUDIO_OK.exec(stdout) : null;
  if (match) return { ok: true, hash: match[1], reason: null };
  const said = firstLine(stdout.trim() || (typeof result?.stderr === "string" ? result.stderr.trim() : "") || result?.error?.message || "");
  return { ok: false, hash: null, reason: said || `${STUDIO_STAMP_SCRIPT} check exited ${result?.status ?? "?"}` };
}

// Tells whether both binaries the studio build runs are installed in the directory.
function studioToolsInstalled(dir) {
  return STUDIO_TOOLS.every((tool) => existsSync(join(dir, "node_modules", ".bin", tool)));
}

// Runs `npm run studio:build` in the directory, streaming what it prints as it prints it; `{ ok, detail }` says how it ended.
async function runStudioBuild(ctx, dir) {
  const result = await runNpmAsync(["run", "studio:build"], {
    cwd: dir,
    env: ctx.env,
    timeoutMs: STUDIO_BUILD_TIMEOUT_MS,
    spawnImpl: ctx.spawnImpl,
    echo: (text) => relayStderr(ctx, text),
  });
  if (result.ok) return { ok: true, detail: "" };
  const tail = result.output.split("\n").map((line) => line.trim()).filter(Boolean).slice(-STUDIO_TAIL_LINES).join(" | ");
  const how = result.timedOut ? "timed out" : result.missing ? "npm not found" : `exit ${result.status ?? "?"}`;
  return { ok: false, detail: `${how}${tail ? `: ${tail}` : ""}` };
}

// Builds the studio of a local source directory unless its dist is already fresh, so an install from a checkout never ships without one; false refuses the whole install.
export async function studioBuildStep(ctx, report, dir) {
  const stamp = readStudioStamp(ctx, dir);
  if (stamp.ok) {
    report.step(STUDIO_LABEL, "up to date", stamp.hash.slice(0, STUDIO_HASH_CHARS));
    return true;
  }
  if (!studioToolsInstalled(dir)) {
    report.degrade(STUDIO_LABEL, `the studio devDependencies are not installed in ${dir}: run npm ci there`, `cd ${dir} && npm ci`);
    return false;
  }
  const build = await runStudioBuild(ctx, dir);
  const built = build.ok ? readStudioStamp(ctx, dir) : null;
  if (built?.ok) {
    report.step(STUDIO_LABEL, `built from ${dir}`, built.hash.slice(0, STUDIO_HASH_CHARS));
    return true;
  }
  report.degrade(STUDIO_LABEL, `the studio build failed in ${dir}: ${build.ok ? built.reason : build.detail}`, `cd ${dir} && npm run studio:build`);
  return false;
}

// Where the runtime comes from: the package this process runs from, the directory or tarball of `--from`, the registry only when an update forces it.
async function openRuntimeSource(ctx, report, { from, force, version } = {}) {
  const target = typeof from === "string" && from.trim() ? resolve(from.trim()) : "";
  if (!target) {
    if (force === true) return { ok: true, spec: registrySpec(version), cleanup: () => {} };
    return packDirectory(ctx, report, packageRoot());
  }
  const stat = statOrNull(target);
  if (!stat) {
    report.degrade(RUNTIME_LABEL, `no directory or tarball at ${target}`, `ls ${target}`);
    return { ok: false, cleanup: () => {} };
  }
  if (stat.isDirectory()) {
    if (!(await studioBuildStep(ctx, report, target))) return { ok: false, cleanup: () => {} };
    return packDirectory(ctx, report, target);
  }
  return { ok: true, spec: target, cleanup: () => {} };
}

// Detail of an installed runtime: an update that replaced a version states the transition, every other path states only what is there now.
function runtimeDetail({ env, current, installed, force }) {
  const now = `v${installed ?? "?"} at ${runtimeLocation(env)}`;
  return force === true && current ? `v${current} -> ${now}` : now;
}

// Publishes a finished staging prefix: it becomes a version directory of its own and `current` is renamed onto it in one step.
function publishVersion(ctx, report, { staging, installed, stamp }) {
  try {
    switchCurrent(finishVersion(staging, installed, stamp), ctx.env);
    return true;
  } catch (err) {
    report.degrade(RUNTIME_LABEL, firstLine(err?.message ?? String(err)), `ls ${runtimeVersionsDir(ctx.env)}`);
    return false;
  }
}

// Installs the package into a new version directory and swaps `current` onto it, so a process already running keeps executing the tree it loaded from.
export async function setupRuntime(ctx, report, { from, force, version } = {}) {
  const wanted = packageVersion();
  const current = runtimeVersion(ctx.env);
  if (!force && !from && current && current === wanted) {
    report.step(RUNTIME_LABEL, "already present", `v${current} at ${runtimeLocation(ctx.env)}`);
    return runtimeReady(ctx.env);
  }
  const source = await openRuntimeSource(ctx, report, { from, force, version });
  if (!source.ok) return false;
  const stamp = versionStamp();
  const staging = stageInstall(ctx.env, stamp);
  try {
    const result = npmInstall({ prefix: staging, spec: source.spec, env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
    const installed = result.ok ? prefixVersion(staging) : null;
    if (!installed) {
      report.degrade(RUNTIME_LABEL, npmFailure(result), result.command);
      return false;
    }
    if (!publishVersion(ctx, report, { staging, installed, stamp })) return false;
    report.step(RUNTIME_LABEL, current ? "updated" : "created", runtimeDetail({ env: ctx.env, current, installed, force }));
    guarded(report, OLD_RUNTIMES_LABEL, `ls ${runtimeVersionsDir(ctx.env)}`, () => pruneVersions(ctx.env));
    return true;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    source.cleanup();
  }
}

// The report detail of a schema child that succeeded: its last stdout line without the label it already carries.
function schemaDetail(stdout) {
  const lines = String(stdout ?? "").trim().split("\n").filter(Boolean);
  return (lines.at(-1) ?? "").replace(`${SCHEMA_LABEL}: `, "");
}

// Why the schema child failed, short enough for a report line: its refusal line, else how it exited.
function schemaFailure(result) {
  const refusal = String(result?.stderr ?? "").split("\n").find((line) => line.startsWith("nightqueue: "));
  return firstLine(result?.error?.message ?? refusal?.slice("nightqueue: ".length)) || `exit ${result?.status ?? "?"}`;
}

// Relays every line a schema child printed on stderr (its warnings, its whole refusal) to the operator, unshortened.
function relayStderr(ctx, stderr) {
  for (const line of String(stderr ?? "").split("\n")) {
    if (line.trim()) ctx.err(line);
  }
}

// Migrates the home's database with the runtime just installed (`update --schema-only` in a child born from it), since only that build knows the target schema; the parent holds the home lock and the child borrows it. Without a ready runtime there is no build to migrate with.
export function migrateSchemaStep(ctx, report, { ready } = {}) {
  if (ready === false) {
    report.step(SCHEMA_LABEL, "skipped", "the runtime is not ready");
    return true;
  }
  const entry = join(spawnRoot(ctx.env), "bin", "nightqueue.mjs");
  const env = { ...ctx.env, [SCHEMA_PARENT_ENV]: String(process.pid) };
  let result;
  try {
    result = ctx.spawnSyncImpl(process.execPath, [entry, "update", "--schema-only"], { env, encoding: "utf8", timeout: SCHEMA_TIMEOUT_MS });
  } catch (err) {
    report.degrade(SCHEMA_LABEL, firstLine(err?.message ?? String(err)), "nightqueue update");
    return false;
  }
  relayStderr(ctx, result?.stderr);
  if (result?.error || result?.status !== 0) {
    report.degrade(SCHEMA_LABEL, schemaFailure(result), "nightqueue update");
    return false;
  }
  const detail = schemaDetail(result.stdout);
  report.step(SCHEMA_LABEL, "ok", detail);
  if (MIGRATED_DETAIL.test(detail)) report.note(RESTART_CLIENTS_NOTICE);
  return true;
}

// Reason the shim could not prove itself, short enough for a report line.
function shimCheckFailure(result) {
  const message = result?.error?.message ?? result?.stderr ?? "";
  return firstLine(message) || `exit ${result?.status ?? "?"}`;
}

// Runs the command the user will type, the only proof that the installed runtime really starts.
export function verifyShim(ctx, report) {
  const path = shimPath(ctx.env);
  const hint = `${path} --version`;
  let result;
  try {
    result = ctx.spawnSyncImpl(path, ["--version"], { env: ctx.env, encoding: "utf8", timeout: SHIM_CHECK_TIMEOUT_MS });
  } catch (err) {
    report.degrade(RUNTIME_CHECK_LABEL, firstLine(err?.message ?? String(err)), hint);
    return false;
  }
  const version = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  if (result?.error || result?.status !== 0 || !version) {
    report.degrade(RUNTIME_CHECK_LABEL, shimCheckFailure(result), hint);
    return false;
  }
  report.step(RUNTIME_CHECK_LABEL, "ok", `v${version}`);
  return true;
}

// Row label of one legacy shim: the historical one keeps its plain label, the others carry their name.
function legacyShimLabel(name) {
  return name === LEGACY_SHIM_NAME ? LEGACY_SHIM_LABEL : `${LEGACY_SHIM_LABEL} ${name}`;
}

// Deletes the shim of one previous command name, telling the user why the old command stopped resolving.
function dropOneLegacyShim(ctx, report, name) {
  const label = legacyShimLabel(name);
  guarded(report, label, `rm -f ${legacyShimPath(ctx.env, name)}`, () => {
    const { path, status } = removeLegacyShim(ctx.env, name);
    if (status === "not present") return;
    if (status === "kept") {
      report.step(label, status, `${path} was not written by nightqueue`);
      return;
    }
    report.step(label, status, path);
    ctx.out(`the \`${name}\` command was renamed to \`nightqueue\`; use \`nightqueue\` or \`nq\` from now on`);
  });
}

// Deletes the shims of every previous command name a package of ours wrote.
export function dropLegacyShim(ctx, report) {
  for (const name of [LEGACY_SHIM_NAME, ...LEGACY_SHIM_NAMES]) dropOneLegacyShim(ctx, report, name);
}

// Writes the shims that start the CLI of the runtime, the command names the user types.
export function setupShim(ctx, report, { shortcuts } = {}) {
  guarded(report, SHIM_LABEL, `mkdir -p ${binDir(ctx.env)}`, () => {
    for (const { name, path, status } of writeShims(ctx.env, { shortcuts })) {
      report.step(`${SHIM_LABEL} ${name}`, status, path);
    }
    if (shortcuts === false) report.step(`${SHIM_LABEL} shortcuts`, "skipped", "--no-shortcuts");
  });
  dropLegacyShim(ctx, report);
}

// Question asked before a guarded block is appended to the rc file of the user.
function pathQuestion(env) {
  return `Add ${binDir(env)} to your PATH? This appends a guarded block to ${rcFilePath(env)} [Y/n] `;
}

// Decides whether the PATH line may be written: `--path` when it is there, the terminal otherwise, null with neither.
async function wantsPath(ctx, path) {
  if (path === true) return true;
  if (!ctx.stdin?.isTTY) return null;
  return await confirm({ stdin: ctx.stdin, stdout: ctx.stdout, question: pathQuestion(ctx.env) });
}

// Prints the block the user has to add by hand, the only thing this step does without an explicit yes.
function printPathBlock(ctx, report) {
  report.note(`add this block to ${rcFilePath(ctx.env)}:`);
  for (const line of pathBlock(ctx.env).split("\n")) report.note(`  ${line}`);
}

// Puts the shim directory on the PATH, asking first and never writing to an rc file on its own.
export async function setupPath(ctx, report, { path } = {}) {
  if (binDirInPath(ctx.env)) {
    report.step(PATH_LABEL, "already present", binDir(ctx.env));
    return;
  }
  if (path === false) {
    report.step(PATH_LABEL, "skipped", "--no-path");
    return;
  }
  const wanted = await wantsPath(ctx, path);
  if (wanted !== true) {
    report.step(PATH_LABEL, "skipped", wanted === false ? "declined" : "no terminal");
    printPathBlock(ctx, report);
    return;
  }
  guarded(report, PATH_LABEL, `add the \`${PATH_MARK}\` block to ${rcFilePath(ctx.env)}`, () => {
    const result = addPathLine(ctx.env);
    report.step(PATH_LABEL, result.status, result.path);
  });
}

// Question asked before half a gigabyte of embedding runtime is installed.
function embeddingQuestion(env) {
  return `Enable semantic recall? Installs ~500 MB of embedding runtime into ${embeddingDir(env)} and downloads a 23 MB model. Without it, recall is keyword-only (BM25). [Y/n] `;
}

// Decides whether the embedding library may be installed: `--embedding` when it is there, the terminal otherwise.
async function wantsEmbedding(ctx, embedding) {
  if (embedding === true) return true;
  if (!ctx.stdin?.isTTY) return null;
  return await confirm({ stdin: ctx.stdin, stdout: ctx.stdout, question: embeddingQuestion(ctx.env) });
}

// Downloads the embedding weights, the only step that opens the network.
async function downloadModel(ctx, report) {
  try {
    const warmup = ctx.warmupImpl ?? warmupModel;
    const result = await warmup({ allowDownload: true }, ctx.env);
    report.step("model", result.downloaded ? "created" : "already present", result.model);
  } catch (err) {
    report.degrade("model", firstLine(err?.message ?? String(err)), "nightqueue embed download");
  }
}

// Installs the embedding library into its own prefix and then warms the weights up; a prefix that already holds it never reaches npm.
async function installEmbedding(ctx, report) {
  const prefix = embeddingDir(ctx.env);
  if (embeddingLibraryEntry(ctx.env)) {
    report.step(EMBEDDING_LABEL, "already present", prefix);
    await downloadModel(ctx, report);
    return;
  }
  mkdirSync(prefix, { recursive: true });
  const spec = `${EMBEDDING_PACKAGE}@${EMBEDDING_PACKAGE_RANGE}`;
  const result = npmInstall({ prefix, spec, env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
  if (!result.ok || !embeddingLibraryEntry(ctx.env)) {
    report.degrade(EMBEDDING_LABEL, npmFailure(result), result.command);
    return;
  }
  report.step(EMBEDDING_LABEL, "created", prefix);
  await downloadModel(ctx, report);
}

// Tells whether a previous run already recorded that the operator turned the semantic recall down.
function embeddingDeclined(ctx) {
  try {
    return loadConfig(ctx.env, { warn: ctx.err }).embedding === "declined";
  } catch {
    return false;
  }
}

// Records the decline, so no later run asks the question again; a configuration that cannot be written is a warning, never the end of the installation.
function recordDecline(ctx) {
  if (typeof ctx.saveConfig !== "function") return;
  try {
    const config = loadConfig(ctx.env, { warn: ctx.err });
    if (config.embedding === "declined") return;
    ctx.saveConfig({ ...config, embedding: "declined" }, ctx.env);
  } catch (err) {
    ctx.err(`nightqueue: the answer to the semantic recall could not be recorded: ${firstLine(err?.message ?? String(err))}`);
  }
}

// Offers the semantic recall, which is opt-in and never brings the installation down when it fails; the question is asked once and never again.
export async function setupEmbedding(ctx, report, { embedding } = {}) {
  if (ctx.env?.NIGHTQUEUE_EMBED_DISABLED === "1") {
    report.step(EMBEDDING_LABEL, "skipped", "NIGHTQUEUE_EMBED_DISABLED");
    return;
  }
  if (embedding !== true && embeddingLibraryEntry(ctx.env)) {
    report.step(EMBEDDING_LABEL, "already present", embeddingDir(ctx.env));
    return;
  }
  if (embedding !== true && embeddingDeclined(ctx)) {
    report.step(EMBEDDING_LABEL, "skipped", "declined");
    return;
  }
  if (embedding === false) {
    recordDecline(ctx);
    report.step(EMBEDDING_LABEL, "skipped", "--no-embedding");
    return;
  }
  const wanted = await wantsEmbedding(ctx, embedding);
  if (wanted !== true) {
    if (wanted === false) recordDecline(ctx);
    report.step(EMBEDDING_LABEL, "skipped", wanted === false ? "declined" : "no terminal");
    report.note("semantic recall skipped; run `nightqueue embed install` to enable it");
    return;
  }
  await installEmbedding(ctx, report);
}

// Deletes every shim, and only the ones whose content on disk is what this package wrote.
export function removeShimStep(ctx, report) {
  guarded(report, SHIM_LABEL, `rm -f ${binDir(ctx.env)}/nightqueue`, () => {
    for (const { name, path, status } of removeShims(ctx.env)) {
      const detail = status === "kept" ? `${path} was not written by nightqueue` : path;
      report.step(`${SHIM_LABEL} ${name}`, status, detail);
    }
  });
  dropLegacyShim(ctx, report);
}

// Takes our PATH line out of the rc file, leaving every other line exactly as it was.
export function removePathStep(ctx, report) {
  guarded(report, PATH_LABEL, `remove the \`${PATH_MARK}\` line from ${rcFilePath(ctx.env)}`, () => {
    const { path, status } = removePathLine(ctx.env);
    report.step(PATH_LABEL, status, path);
  });
}

// Directories the installation created and the removal may delete, the ones that hold no user data.
function installedDirs(env) {
  return [runtimeDir(env), embeddingDir(env)].filter((dir) => existsSync(dir));
}

// Deletes the installed directories, asking first; only `--purge` ever reaches the configuration home.
export async function removeInstalledDirs(ctx, report, { purge } = {}) {
  if (purge === true) {
    const home = homeDir(ctx.env);
    guarded(report, "home", `rm -rf ${home}`, () => {
      rmSync(home, { recursive: true, force: true });
      report.step("home", "removed", home);
    });
    return;
  }
  const dirs = installedDirs(ctx.env);
  if (!dirs.length) {
    report.step(DIRS_LABEL, "not present");
    return;
  }
  const question = `Remove ${dirs.join(" and ")}? [Y/n] `;
  const wanted = ctx.stdin?.isTTY ? await confirm({ stdin: ctx.stdin, stdout: ctx.stdout, question }) : false;
  if (!wanted) {
    report.step(DIRS_LABEL, "kept", dirs.join(", "));
    ctx.out(`remove them by hand with: rm -rf ${dirs.join(" ")}`);
    return;
  }
  guarded(report, DIRS_LABEL, `rm -rf ${dirs.join(" ")}`, () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    report.step(DIRS_LABEL, "removed", dirs.join(", "));
  });
}
