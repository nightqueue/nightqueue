import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../host/paths.mjs";
import { PLUGIN_DIR_ENV } from "./orchestrator-scope.mjs";
import { DEFAULT_PIPELINE } from "./pipeline-package.mjs";
import { BLOCK_CODES } from "./preflight.mjs";
import { pinnedPipeline } from "./run-state.mjs";

export { DEFAULT_PIPELINE };

const UNPINNED_HEAD = "Pipeline version: this run recorded none (";
const UNPINNED_TAIL = "), so a later pipeline update will not gate it.";

// The plugin directory a run loads its pipeline from: the one the runner handed the session, or this package's own.
function installedPluginDir(env) {
  const handed = typeof env?.[PLUGIN_DIR_ENV] === "string" ? env[PLUGIN_DIR_ENV].trim() : "";
  return handed || join(packageRoot(), "plugin");
}

// The manifest that declares the version of the installed pipeline.
function pluginManifestPath(env) {
  return join(installedPluginDir(env), ".claude-plugin", "plugin.json");
}

// The version of the installed pipeline, or null when its manifest cannot be read.
export function installedPipelineVersion(env = process.env) {
  try {
    const { version } = JSON.parse(readFileSync(pluginManifestPath(env), "utf8"));
    return typeof version === "string" && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

// The block of a run that started under another pipeline version, or whose installed version cannot be read, or null when it may go on; only a known change asks for a fresh retry.
export function pipelineVersionBlock(state, env = process.env) {
  const pinned = pinnedPipeline(state);
  if (pinned === null) return null;
  const installed = installedPipelineVersion(env);
  if (installed === pinned.version) return null;
  const started = `this run started under ${pinned.name ?? DEFAULT_PIPELINE}@${pinned.version}`;
  if (installed === null) {
    const message = `${started} and the installed pipeline version cannot be read from ${pluginManifestPath(env)}; repair the plugin, then retry`;
    return { ok: false, code: BLOCK_CODES.PIPELINE_VERSION_UNKNOWN, message };
  }
  return { ok: false, code: BLOCK_CODES.PIPELINE_VERSION_CHANGED, message: `${started}; retry with --fresh to start it over under @${installed}`, fresh: true };
}

// Tells whether one paragraph is the whole line `withUnpinnedLine` builds, never a text that merely starts alike.
export function isUnpinnedLine(paragraph) {
  return typeof paragraph === "string" && paragraph.startsWith(UNPINNED_HEAD) && paragraph.endsWith(UNPINNED_TAIL) && !paragraph.includes("\n");
}

// Tells whether a state marks its run as unpinned.
export function carriesUnpinnedMark(state) {
  const reason = state?.pipelineUnpinned?.reason;
  return typeof reason === "string" && reason.trim() !== "";
}

// A notice without the unpinned line an earlier attempt appended, only when the state marks the run; anything else stays as it is.
export function withoutUnpinnedLine(notice, state) {
  if (typeof notice !== "string" || !carriesUnpinnedMark(state)) return notice;
  return notice.split("\n\n").filter((paragraph) => !isUnpinnedLine(paragraph)).join("\n\n");
}

// A notice carrying exactly one unpinned line when the state marks the run as unpinned; with no mark it stays as it is.
export function withUnpinnedLine(notice, state) {
  if (!carriesUnpinnedMark(state)) return notice;
  const base = typeof notice === "string" ? withoutUnpinnedLine(notice, state).trimEnd() : "";
  const reason = state.pipelineUnpinned.reason.replace(/\s+/g, " ").trim();
  const line = `${UNPINNED_HEAD}${reason}${UNPINNED_TAIL}`;
  return base ? `${base}\n\n${line}` : line;
}
