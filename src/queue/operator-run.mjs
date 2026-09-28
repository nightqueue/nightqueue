import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { UserError } from "../config/errors.mjs";
import { runDir } from "../config/paths.mjs";
import { decideResume, isSafeSegment, isStateObject, readRunState, rerunLines } from "./resume.mjs";

export const PRIOR_RUN_HEADING = "## PRIOR RUN (operator)";

const BRIEF_HEADING = /^## Brief\b/;
const FENCE = /^(```|~~~)/;

// The path a `run_dir` names, with a leading `~/` expanded against the caller's home; anything else relative is refused.
function expandRunDir(raw, env) {
  const text = typeof raw === "string" ? raw.trim() : "";
  const home = typeof env?.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : homedir();
  const path = text.startsWith("~/") ? join(home, text.slice(2)) : text;
  if (!isAbsolute(path)) throw new UserError(`\`run_dir\` must be an absolute or \`~/\` path, got \`${text}\``);
  return resolve(path);
}

// The path with every link of its nearest existing ancestor followed, so two spellings of one directory compare equal.
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonicalPath(parent), basename(path));
  }
}

// The operator run a `run_dir` names: its slug and its state, refused unless it is an operator run of this project under this home.
export function resolveOperatorRunDir({ runDir: raw, project, env = process.env } = {}) {
  const path = expandRunDir(raw, env);
  const slug = basename(path);
  const expected = isSafeSegment(slug) ? runDir(project, slug, env) : null;
  if (!expected || canonicalPath(path) !== canonicalPath(expected)) {
    throw new UserError(`\`run_dir\` must be \`${expected ?? runDir(project, "<slug>", env)}\`: a run of project \`${project}\` under this home`);
  }
  const state = readRunState({ project, slug, env });
  if (!isStateObject(state) || state.origin !== "operator" || state.project !== project) {
    throw new UserError(`\`${expected}\` is not an operator run: its state.json does not carry \`origin: operator\` for project \`${project}\``);
  }
  return { slug, state, dir: expected };
}

// The evidence line of the block, only for a bug whose level was recorded.
function evidenceLines(state) {
  const level = state.evidenceLevel;
  if (state.type === "feature/refactor" || !Number.isInteger(level) || level < 1 || level > 4) return [];
  return [`Evidence level: ${level}`];
}

// The block the runtime writes into a job queued from an operator run, from the same resume decision the runner will take.
export function priorRunBlock({ project, slug, state, env = process.env } = {}) {
  const dir = runDir(project, slug, env);
  const decision = decideResume({ state });
  if (!decision.resume && decision.reason !== "no-completed-phase") {
    throw new UserError(`the operator run \`${dir}\` cannot seed a job: its resume is refused (${decision.reason})`);
  }
  return [
    PRIOR_RUN_HEADING,
    `RUN_DIR: ${dir}`,
    `Last completed phase: ${decision.lastPhase ?? "none"}`,
    ...evidenceLines(state),
    ...(typeof state.planStatus === "string" ? [`Plan status: ${state.planStatus}`] : []),
    `Resume from phase: ${decision.fromPhase ?? "triage"}`,
    ...rerunLines(decision.reruns),
  ].join("\n");
}

// The `[index, line]` pairs of the prompt that sit outside a fenced code block.
function unfencedEntries(lines) {
  let fenced = false;
  const entries = [];
  for (const [index, line] of lines.entries()) {
    if (FENCE.test(line.trimStart())) fenced = !fenced;
    else if (!fenced) entries.push([index, line]);
  }
  return entries;
}

// Index of the first heading line after the `## Brief` one outside a fenced block, the end of the prompt when none follows, or -1 without a brief.
function briefEnd(lines) {
  let brief = -1;
  for (const [index, line] of unfencedEntries(lines)) {
    if (brief < 0 && BRIEF_HEADING.test(line)) brief = index;
    else if (brief >= 0 && line.startsWith("## ")) return index;
  }
  return brief < 0 ? -1 : lines.length;
}

// The text of the `## Brief` section of a prompt, found outside any fenced block, or null when the prompt carries none.
export function briefBody(prompt) {
  const lines = String(prompt ?? "").split("\n");
  const end = briefEnd(lines);
  if (end < 0) return null;
  const start = unfencedEntries(lines).find(([, line]) => BRIEF_HEADING.test(line))[0];
  return lines.slice(start + 1, end).join("\n");
}

// The prompt with the prior-run block placed right after its `## Brief` section; a prompt already carrying one outside a fence, or without a brief, is refused.
export function withPriorRun(prompt, block) {
  const lines = String(prompt ?? "").split("\n");
  if (unfencedEntries(lines).some(([, line]) => line.trim() === PRIOR_RUN_HEADING)) {
    throw new UserError(`the prompt already carries a \`${PRIOR_RUN_HEADING}\` block; send \`run_dir\` or the block, never both`);
  }
  const at = briefEnd(lines);
  if (at < 0) throw new UserError("a prompt sent with `run_dir` needs its `## Brief` section: the block goes right after it");
  const head = lines.slice(0, at).join("\n").trimEnd();
  const tail = lines.slice(at).join("\n");
  return tail ? `${head}\n\n${block}\n\n${tail}` : `${head}\n\n${block}\n`;
}
