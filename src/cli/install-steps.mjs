import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { binDir, embeddingDir, homeDir, legacyShimPath, runtimeDir, shimPath } from "../config/paths.mjs";
import { npmInstall, npmPack } from "../host/npm.mjs";
import { packageRoot } from "../host/paths.mjs";
import {
  packageVersion,
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

const RUNTIME_LABEL = "runtime";
const RUNTIME_CHECK_LABEL = "runtime check";
const SHIM_CHECK_TIMEOUT_MS = 15000;
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
  const destDir = mkdtempSync(join(tmpdir(), "nightshift-pack-"));
  const cleanup = () => rmSync(destDir, { recursive: true, force: true });
  const result = npmPack({ dir, destDir, env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
  if (result.ok) return { ok: true, spec: result.file, cleanup };
  report.degrade(RUNTIME_LABEL, npmFailure(result), result.command);
  cleanup();
  return { ok: false, cleanup: () => {} };
}

// Where the runtime comes from: the package this process runs from, the directory or tarball of `--from`, the registry only when an update forces it.
function openRuntimeSource(ctx, report, { from, force } = {}) {
  const target = typeof from === "string" && from.trim() ? resolve(from.trim()) : "";
  if (!target) {
    if (force === true) return { ok: true, spec: registrySpec("latest"), cleanup: () => {} };
    return packDirectory(ctx, report, packageRoot());
  }
  const stat = statOrNull(target);
  if (!stat) {
    report.degrade(RUNTIME_LABEL, `no directory or tarball at ${target}`, `ls ${target}`);
    return { ok: false, cleanup: () => {} };
  }
  if (stat.isDirectory()) return packDirectory(ctx, report, target);
  return { ok: true, spec: target, cleanup: () => {} };
}

// Installs the package into the runtime prefix and reports whether the prefix really ended up holding it.
export function setupRuntime(ctx, report, { from, force } = {}) {
  const prefix = runtimeDir(ctx.env);
  const wanted = packageVersion();
  const current = runtimeVersion(ctx.env);
  if (!force && !from && current && current === wanted) {
    report.step(RUNTIME_LABEL, "already present", `v${current} at ${prefix}`);
    return runtimeReady(ctx.env);
  }
  const source = openRuntimeSource(ctx, report, { from, force });
  if (!source.ok) return false;
  try {
    mkdirSync(prefix, { recursive: true });
    const result = npmInstall({ prefix, spec: source.spec, env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
    if (!result.ok || !runtimeReady(ctx.env)) {
      report.degrade(RUNTIME_LABEL, npmFailure(result), result.command);
      return false;
    }
    report.step(RUNTIME_LABEL, current ? "updated" : "created", `v${runtimeVersion(ctx.env) ?? "?"} at ${prefix}`);
    return true;
  } finally {
    source.cleanup();
  }
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

// Deletes the shim of the previous command name, telling the user why the old command stopped resolving.
export function dropLegacyShim(ctx, report) {
  guarded(report, LEGACY_SHIM_LABEL, `rm -f ${legacyShimPath(ctx.env)}`, () => {
    const { path, status } = removeLegacyShim(ctx.env);
    if (status === "not present") return;
    if (status === "kept") {
      report.step(LEGACY_SHIM_LABEL, status, `${path} was not written by nightshift`);
      return;
    }
    report.step(LEGACY_SHIM_LABEL, status, path);
    ctx.out("the `shift` command was renamed to `nightshift`; use `nightshift`, `nshift` or `nsft` from now on");
  });
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
function printPathBlock(ctx) {
  ctx.out(`add this block to ${rcFilePath(ctx.env)}:`);
  for (const line of pathBlock(ctx.env).split("\n")) ctx.out(`  ${line}`);
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
    printPathBlock(ctx);
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
    report.degrade("model", firstLine(err?.message ?? String(err)), "nightshift embed download");
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

// Offers the semantic recall, which is opt-in and never brings the installation down when it fails.
export async function setupEmbedding(ctx, report, { embedding } = {}) {
  if (ctx.env?.NIGHTSHIFT_EMBED_DISABLED === "1") {
    report.step(EMBEDDING_LABEL, "skipped", "NIGHTSHIFT_EMBED_DISABLED");
    return;
  }
  if (embedding === false) {
    report.step(EMBEDDING_LABEL, "skipped", "--no-embedding");
    return;
  }
  const wanted = await wantsEmbedding(ctx, embedding);
  if (wanted !== true) {
    report.step(EMBEDDING_LABEL, "skipped", wanted === false ? "declined" : "no terminal");
    ctx.out("semantic recall skipped; run `nightshift embed install` to enable it");
    return;
  }
  await installEmbedding(ctx, report);
}

// Deletes every shim, and only the ones whose content on disk is what this package wrote.
export function removeShimStep(ctx, report) {
  guarded(report, SHIM_LABEL, `rm -f ${binDir(ctx.env)}/nightshift`, () => {
    for (const { name, path, status } of removeShims(ctx.env)) {
      const detail = status === "kept" ? `${path} was not written by nightshift` : path;
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
