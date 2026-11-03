import { existsSync, readFileSync } from "node:fs";
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
const TRACK_TEXT_KEYS = ["lane", "promptMode"];
const PHASE_FLAG_KEYS = ["delivers", "precedesDelivery"];
const REPORT_FILE = "report.mjs";

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
function phaseDefect(phase, gateStops) {
  if (!isPlainObject(phase)) return "a phase is not an object";
  return PHASE_LIST_KEYS.map((key) => (Array.isArray(phase[key]) ? null : `the phase \`${String(phase.id)}\` has no \`${key}\` list`)).find(Boolean) ?? phaseFlagDefect(phase, gateStops);
}

// What is wrong with the optional gate stop and delivery flags of one phase, or null.
function phaseFlagDefect(phase, gateStops) {
  const notBoolean = PHASE_FLAG_KEYS.find((key) => phase[key] !== undefined && typeof phase[key] !== "boolean");
  if (notBoolean !== undefined) return `the phase \`${String(phase.id)}\` has a \`${notBoolean}\` that is not a boolean`;
  if (phase.gateStop === undefined || gateStops.includes(phase.gateStop)) return null;
  return `the phase \`${String(phase.id)}\` has a \`gateStop\` \`${String(phase.gateStop)}\` that \`gateStops\` does not list`;
}

// What is wrong with the optional gate stops and the delivering phase of a manifest, or null.
function deliveryDefect(manifest) {
  if (manifest.gateStops !== undefined && !(Array.isArray(manifest.gateStops) && manifest.gateStops.every((stop) => typeof stop === "string"))) {
    return "`gateStops` is not a list of strings";
  }
  return manifest.phases.filter((phase) => phase?.delivers === true).length > 1 ? "more than one phase `delivers`" : null;
}

// What is wrong with the phases of a manifest, their flags included, or null.
function phasesDefect(manifest) {
  const defect = deliveryDefect(manifest);
  if (defect !== null) return defect;
  const gateStops = gateStopsOf(manifest);
  return manifest.phases.map((phase) => phaseDefect(phase, gateStops)).find(Boolean) ?? null;
}

// What is wrong with one row of the report layout, or null.
function reportRowDefect(row, phaseIds) {
  if (!isPlainObject(row)) return "a `report.rows` entry is not an object";
  if (row.phase !== null && !phaseIds.includes(row.phase)) return `the \`report.rows\` phase \`${String(row.phase)}\` is not a declared phase`;
  const notText = ["step", "agent"].find((key) => typeof row[key] !== "string");
  return notText === undefined ? null : `the \`report.rows\` entry of \`${String(row.phase)}\` has no \`${notText}\` string`;
}

// What is wrong with the optional report section of a manifest, or null.
function reportDefect(manifest) {
  if (manifest.report === undefined) return null;
  if (!isPlainObject(manifest.report)) return "`report` is not an object";
  if (!Array.isArray(manifest.report.rows)) return "`report.rows` is not a list";
  const phaseIds = phaseIdsOf(manifest);
  return manifest.report.rows.map((row) => reportRowDefect(row, phaseIds)).find(Boolean) ?? null;
}

// What is wrong with the optional lane keys of one track slot, or null.
function trackSlotDefect(slot) {
  if (!isPlainObject(slot)) return "a `track` slot is not an object";
  const notText = TRACK_TEXT_KEYS.find((key) => slot[key] !== undefined && typeof slot[key] !== "string");
  return notText === undefined ? null : `the \`track\` slot \`${String(slot.name)}\` has a \`${notText}\` that is not a string`;
}

// What is wrong with the shape of a manifest, or null.
function manifestDefect(manifest) {
  if (!isPlainObject(manifest)) return "it is not an object";
  if (typeof manifest.name !== "string") return "`name` is not a string";
  const notList = MANIFEST_LIST_KEYS.find((key) => !Array.isArray(manifest[key]));
  if (notList !== undefined) return `\`${notList}\` is not a list`;
  const notObject = MANIFEST_OBJECT_KEYS.find((key) => !isPlainObject(manifest[key]));
  if (notObject !== undefined) return `\`${notObject}\` is not an object`;
  return phasesDefect(manifest) ?? manifest.track.map(trackSlotDefect).find(Boolean) ?? reportDefect(manifest);
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

// The package of a pipeline as `run report` reads it: its manifest and its report.mjs module, `{}` when the package ships none.
export async function loadReport(name) {
  const manifest = pipelineManifest(name);
  const report = existsSync(join(pipelineDir(name), REPORT_FILE)) ? await pipelineModule(name, REPORT_FILE) : {};
  return { manifest, report };
}

// The rows of a manifest's report table: its own layout, else one row per phase named by its id.
export function reportLayoutOf(manifest) {
  if (Array.isArray(manifest?.report?.rows)) return manifest.report.rows;
  return phaseIdsOf(manifest).map((id) => ({ phase: id, step: id, agent: "-" }));
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

// The manifest of the pipeline a run's state pinned, the default pipeline's when it pinned none.
export function stateManifest(state) {
  return pipelineManifest(pinnedPipelineName(state) ?? DEFAULT_PIPELINE);
}

// The phase ids of the pipeline a run's state pinned, the default pipeline's when it pinned none.
export function phaseNamesOf(state) {
  return phaseIdsOf(stateManifest(state));
}

// The gate stops a manifest declares, in order, an empty list when it declares none.
export function gateStopsOf(manifest) {
  return Array.isArray(manifest?.gateStops) ? manifest.gateStops : [];
}

// The gate stop a run that stopped at one phase of a manifest records, or null when the phase names none.
export function gateStopOf(manifest, phase) {
  const stop = manifest?.phases?.find((entry) => entry?.id === phase && phase !== null)?.gateStop;
  return typeof stop === "string" ? stop : null;
}

// The id of the phase that delivers a manifest's run, or null when no phase delivers.
export function deliveryPhaseOf(manifest) {
  return manifest?.phases?.find((entry) => entry?.delivers === true)?.id ?? null;
}

// The ids of the phases a manifest's delivery directly follows.
export function phasesBeforeDeliveryOf(manifest) {
  return (manifest?.phases ?? []).filter((entry) => entry?.precedesDelivery === true).map((entry) => entry.id);
}

// The file a manifest's implementation phase lists its files in and the file its derived list falls back to.
export function fileListArtifacts(manifest = pipelineManifest()) {
  const phase = manifest.phases.find((entry) => entry.derivesFileList === true);
  return { artifact: phase?.artifact ?? null, fallback: manifest.fileListFallback ?? null };
}
