import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { UserError } from "../config/errors.mjs";
import { packageRoot } from "../host/paths.mjs";

// The pipeline a job with no name of its own runs.
export const DEFAULT_PIPELINE = "resolve";

export const PIPELINE_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

// The keys of a manifest and of its phases the runtime reads without asking.
const MANIFEST_LIST_KEYS = ["phases", "targets", "recordable", "track"];
const MANIFEST_OBJECT_KEYS = ["models", "constants"];
const PHASE_LIST_KEYS = ["sections", "verdicts"];

const manifests = new Map();

// The name refused unless it can be one directory of the plugin's skills.
function validName(name) {
  if (typeof name === "string" && PIPELINE_NAME_RE.test(name)) return name;
  throw new UserError(`the pipeline \`${String(name)}\` is not a valid name; it must match ${PIPELINE_NAME_RE.source}`);
}

// The directory of a pipeline's package, inside this npm package's own plugin.
export function pipelineDir(name) {
  return join(packageRoot(), "plugin", "skills", validName(name), "pipeline");
}

// Whether a value is a plain object.
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// What is wrong with one phase of a manifest, or null.
function phaseDefect(phase) {
  if (!isPlainObject(phase)) return "a phase is not an object";
  return PHASE_LIST_KEYS.map((key) => (Array.isArray(phase[key]) ? null : `the phase \`${String(phase.id)}\` has no \`${key}\` list`)).find(Boolean) ?? null;
}

// What is wrong with the shape of a manifest, or null.
function manifestDefect(manifest) {
  if (!isPlainObject(manifest)) return "it is not an object";
  if (typeof manifest.name !== "string") return "`name` is not a string";
  const notList = MANIFEST_LIST_KEYS.find((key) => !Array.isArray(manifest[key]));
  if (notList !== undefined) return `\`${notList}\` is not a list`;
  const notObject = MANIFEST_OBJECT_KEYS.find((key) => !isPlainObject(manifest[key]));
  if (notObject !== undefined) return `\`${notObject}\` is not an object`;
  return manifest.phases.map(phaseDefect).find(Boolean) ?? null;
}

// Reads and parses one package's manifest, naming the pipeline and the path when it cannot or when its shape is wrong.
function readManifest(name) {
  const path = join(pipelineDir(name), "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UserError(`the pipeline \`${name}\` has no readable package: ${path} (${String(error?.message ?? error).split("\n")[0]})`);
  }
  const defect = manifestDefect(manifest);
  if (defect !== null) throw new UserError(`the pipeline \`${name}\` has an invalid manifest: ${path} (${defect})`);
  return manifest;
}

// The manifest of a pipeline, read once per process.
export function pipelineManifest(name = DEFAULT_PIPELINE) {
  if (!manifests.has(name)) manifests.set(name, readManifest(name));
  return manifests.get(name);
}

// Imports one module of a pipeline's package by its file name, naming the pipeline when it cannot.
export async function pipelineModule(name, file) {
  const path = join(pipelineDir(name), file);
  try {
    return await import(pathToFileURL(path).href);
  } catch (error) {
    throw new UserError(`the pipeline \`${name}\` has no loadable ${file}: ${path} (${String(error?.message ?? error).split("\n")[0]})`);
  }
}

// The package of a pipeline: its manifest and its `check`.
export async function loadPipeline(name) {
  const manifest = pipelineManifest(name);
  const { check } = await pipelineModule(name, "check.mjs");
  if (typeof check !== "function") throw new UserError(`the pipeline \`${name}\` exports no \`check\` from its check.mjs`);
  return { manifest, check };
}

// The phase ids a manifest declares, in order.
export function phaseIdsOf(manifest) {
  return manifest.phases.map((phase) => phase.id).filter((id) => id !== null);
}

// The name of the pipeline a state pinned, or null when it pinned none.
export function pinnedPipelineName(state) {
  const name = state?.pipeline?.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

// The phase ids of the pipeline a run's state pinned, the default pipeline's when it pinned none.
export function phaseNamesOf(state) {
  return phaseIdsOf(pipelineManifest(pinnedPipelineName(state) ?? DEFAULT_PIPELINE));
}

// The file a manifest's implementation phase lists its files in and the file its derived list falls back to.
export function fileListArtifacts(manifest = pipelineManifest()) {
  const phase = manifest.phases.find((entry) => entry.derivesFileList === true);
  return { artifact: phase?.artifact ?? null, fallback: manifest.fileListFallback ?? null };
}
