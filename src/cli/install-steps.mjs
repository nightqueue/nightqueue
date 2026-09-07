import { existsSync, mkdirSync, rmSync } from "node:fs";
import { binDir, embeddingDir, homeDir, runtimeDir, shimPath } from "../config/paths.mjs";
import { npmInstall } from "../host/npm.mjs";
import { packageVersion, removeShim, runtimeReady, runtimeSpec, runtimeVersion, writeShim } from "../host/runtime.mjs";
import { PATH_MARK, addPathLine, binDirInPath, pathLine, rcFilePath, removePathLine } from "../host/shell.mjs";
import { EMBEDDING_PACKAGE, EMBEDDING_PACKAGE_RANGE, embeddingLibraryEntry, warmupModel } from "../memory/embedding.mjs";
import { confirm } from "./prompt.mjs";
import { firstLine } from "./report.mjs";

const RUNTIME_LABEL = "runtime";
const SHIM_LABEL = "shim";
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

// Installs the package into the runtime prefix and reports whether the prefix really ended up holding it.
export function setupRuntime(ctx, report, { from, force } = {}) {
  const prefix = runtimeDir(ctx.env);
  const wanted = packageVersion();
  const current = runtimeVersion(ctx.env);
  if (!force && !from && current && current === wanted) {
    report.step(RUNTIME_LABEL, "already present", `v${current} at ${prefix}`);
    return runtimeReady(ctx.env);
  }
  mkdirSync(prefix, { recursive: true });
  const spec = runtimeSpec({ from, version: force && !from ? "latest" : wanted });
  const result = npmInstall({ prefix, spec, env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
  if (!result.ok || !runtimeReady(ctx.env)) {
    report.degrade(RUNTIME_LABEL, npmFailure(result), result.command);
    return false;
  }
  report.step(RUNTIME_LABEL, current ? "updated" : "created", `v${runtimeVersion(ctx.env) ?? "?"} at ${prefix}`);
  return true;
}

// Writes the shim that starts the CLI of the runtime, the single command name the user needs.
export function setupShim(ctx, report) {
  guarded(report, SHIM_LABEL, `mkdir -p ${binDir(ctx.env)}`, () => {
    const { path, status } = writeShim(ctx.env);
    report.step(SHIM_LABEL, status, path);
  });
}

// Question asked before a single line is appended to the rc file of the user.
function pathQuestion(env) {
  return `Add ${binDir(env)} to your PATH? This appends one line to ${rcFilePath(env)} [Y/n] `;
}

// Decides whether the PATH line may be written: `--path` when it is there, the terminal otherwise, null with neither.
async function wantsPath(ctx, path) {
  if (path === true) return true;
  if (!ctx.stdin?.isTTY) return null;
  return await confirm({ stdin: ctx.stdin, stdout: ctx.stdout, question: pathQuestion(ctx.env) });
}

// Prints the line the user has to add by hand, the only thing this step does without an explicit yes.
function printPathLine(ctx) {
  ctx.out(`add this line to ${rcFilePath(ctx.env)}: ${pathLine(ctx.env)}`);
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
    printPathLine(ctx);
    return;
  }
  guarded(report, PATH_LABEL, pathLine(ctx.env), () => {
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
    report.degrade("model", firstLine(err?.message ?? String(err)), "shift embed download");
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
    ctx.out("semantic recall skipped; run `shift embed install` to enable it");
    return;
  }
  await installEmbedding(ctx, report);
}

// Deletes the shim, and only when the file on disk is the one this package wrote.
export function removeShimStep(ctx, report) {
  guarded(report, SHIM_LABEL, `rm -f ${shimPath(ctx.env)}`, () => {
    const { path, status } = removeShim(ctx.env);
    report.step(SHIM_LABEL, status, status === "kept" ? `${path} was not written by nightshift` : path);
  });
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
