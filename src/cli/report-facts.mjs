import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { recordedFiles } from "../queue/file-list.mjs";
import { DEFAULT_PIPELINE, fileListArtifacts, loadReport, pinnedPipelineName } from "../queue/pipeline-package.mjs";
import { withoutHtmlComments } from "../queue/stream.mjs";
import { readRunFile } from "./run-context.mjs";

export const FACTS_HEADING = "## Facts for the report";

const FACT_LINE_MAX = 220;

// The non-empty files of the run's evidence directory, by name.
function evidenceFiles(runDir) {
  const dir = join(runDir, "evidence");
  try {
    return readdirSync(dir).filter((name) => statSync(join(dir, name)).size > 0).sort();
  } catch {
    return [];
  }
}

// The worktree the run recorded, or an empty text when it recorded none.
function recordedRoot(state) {
  return typeof state?.worktree === "string" ? state.worktree.trim() : "";
}

// One fact as a list line on one line, clipped to its own width, so no artifact text can open a heading of the report.
export function factLine(fact) {
  const wide = fact !== null && typeof fact === "object";
  const text = String(wide ? fact.text : fact).replace(/\s+/g, " ").trim();
  const max = wide && Number.isInteger(fact.max) && fact.max > 0 ? fact.max : FACT_LINE_MAX;
  const points = [...text];
  return `- ${points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`}`;
}

// The run's artifacts as the package's facts read them; an implementation artifact that lists no file reads as the list `run check` derived, when there is one.
function factTexts(runDir, { manifest, report }) {
  const files = Array.isArray(report.FACT_FILES) ? report.FACT_FILES : [];
  const texts = Object.fromEntries(files.map((file) => [file, withoutHtmlComments(readRunFile(runDir, file))]));
  const { artifact, fallback } = fileListArtifacts(manifest);
  if (artifact === null || fallback === null) return texts;
  const derived = withoutHtmlComments(readRunFile(runDir, fallback));
  return recordedFiles(texts[artifact] ?? "").length === 0 && recordedFiles(derived).length > 0 ? { ...texts, [artifact]: derived } : texts;
}

// The facts the package states over the run's artifacts, none when it states none.
function packageFacts({ runDir, state, worktree }, pipeline) {
  if (typeof pipeline.report.facts !== "function") return [];
  const facts = pipeline.report.facts({ texts: factTexts(runDir, pipeline), state, root: recordedRoot(state), evidence: evidenceFiles(runDir), worktree });
  if (!Array.isArray(facts)) throw new Error("the pipeline's report.mjs `facts` answered no list");
  return facts;
}

// The bounded lines of `## Facts for the report`, read from the run's artifacts by its pipeline's package; a failure is one line, never a failed report.
export async function reportFacts({ runDir, state, worktree = null, manifest = null, report = null }) {
  try {
    const pipeline = manifest !== null && report !== null ? { manifest, report } : await loadReport(pinnedPipelineName(state) ?? DEFAULT_PIPELINE);
    return packageFacts({ runDir, state, worktree }, pipeline).map(factLine);
  } catch (error) {
    return [factLine(`the facts could not be read: ${error?.message ?? String(error)}`)];
  }
}
