import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { UserError } from "../config/errors.mjs";
import { writeFileAtomic } from "../config/store.mjs";
import { pipelineManifest } from "../queue/pipeline-package.mjs";
import { appendedText, nextRound, repairedLine, ROUND_HEADING } from "../queue/rounds.mjs";
import { withRunLock } from "../queue/run-state.mjs";
import { scanMarkdown } from "../queue/stream.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { readRequiredFile, resolveRun, RUN_OPTIONS } from "./run-context.mjs";

export const APPEND_USAGE = "nightqueue run append 05 (--group <id> | --group-label <label>) --from <file> [--project <name> --slug <slug>]";

const GROUP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The draft without a leading `## Round <n>` line: the runtime numbers the round itself.
function withoutRoundHeading(draft) {
  const lines = draft.split("\n");
  return ROUND_HEADING.test(lines[0].trimEnd()) ? lines.slice(1).join("\n").trim() : draft;
}

// The first non-blank line of a draft, without its markdown decoration.
function firstLineOf(draft) {
  return (draft.split("\n").find((line) => line.trim() !== "") ?? "").replace(/[*`]/g, "").trim();
}

// The draft without its own leading `source: prover…` line, which the runtime stamps instead.
function withoutProverSource(draft) {
  if (!/^source:\s*prover\b/i.test(firstLineOf(draft))) return draft;
  const lines = draft.split("\n");
  return lines.slice(lines.findIndex((line) => line.trim() !== "") + 1).join("\n").trim();
}

// Refuses a draft that could hide a later round: a column-0 round heading, or a comment or fence it leaves open.
function refuseUnsafeDraft(draft) {
  const scan = scanMarkdown(draft);
  if (scan.lines.some((line) => ROUND_HEADING.test(line.trimEnd()))) throw new UserError("the draft holds a `## Round` line: indent a quoted round heading");
  if (scan.unclosedComment !== null) throw new UserError(`the draft leaves an HTML comment open (line ${scan.unclosedComment.line}): close it with \`-->\` or write a literal \`<!--\` in backticks`);
  if (scan.openFence !== null) throw new UserError(`the draft leaves a code fence open (line ${scan.openFence.line})`);
}

const CANONICAL_STATUS = { REFUTED: "HELD (REFUTED)" };
const PROVER_STATUS_WORD = /^(\s*(?:[-+]\s+|\d+[.)]\s+)?[*_`]*H\d+[*_`]*\s*:\s*[*_`]*)(REFUTED)\b/i;

// The round with every `H<n>: REFUTED` line of its `## Validated risks` (outside fences and comments) written in the canonical `HELD (REFUTED)` form; a `PROVEN` stays as written, its reading depends on the hypothesis type; every other byte is kept.
function withCanonicalProverLines(round) {
  const { lines, steps } = scanMarkdown(round);
  let inRisks = false;
  return lines
    .map((line, at) => {
      const { inFence, inComment } = steps[at];
      if (inFence || inComment) return line;
      if (/^##\s+\S/.test(line)) inRisks = line.startsWith("## Validated risks");
      return inRisks ? line.replace(PROVER_STATUS_WORD, (_match, head, word) => `${head}${CANONICAL_STATUS[word.toUpperCase()]}`) : line;
    })
    .join("\n");
}

// The prover round a draft becomes: one safe round, never a consolidation, its source line stamped by the runtime with the group when one is given, its prover lines canonical.
export function proverRound(text, group = null) {
  const draft = withoutRoundHeading(String(text ?? "").replace(/\r\n?/g, "\n").trim());
  if (draft === "") throw new UserError("the draft is empty: write the round before appending it");
  refuseUnsafeDraft(draft);
  const first = firstLineOf(draft);
  if (/^source:\s*runtime consolidation\b/i.test(first)) throw new UserError("a consolidated round is written by `nightqueue run check 05`, never appended");
  if (group !== null) return withCanonicalProverLines(`source: prover · group: ${group}\n${withoutProverSource(draft)}`);
  return withCanonicalProverLines(/^source:/i.test(first) ? draft : `source: prover\n${draft}`);
}

// The group id of `--group`, required and shaped as the GROUP_ID of the prover's prompt.
function groupIdOf(value) {
  if (value === undefined || value === "") throw new UserError("`--group <id>` is required (the GROUP_ID of your prompt)");
  if (!GROUP_ID.test(value)) throw new UserError(`invalid group id \`${value}\`: lowercase letters, digits and dashes, at most 64`);
  return value;
}

// The id the runtime stamps on a prover's round: the group's slug plus a hash of the group, so two groups never share it.
export function groupIdFromLabel(label) {
  const group = String(label ?? "");
  const slug = group.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const hash = createHash("sha256").update(group).digest("hex").slice(0, 8);
  return slug === "" ? hash : `${slug}-${hash}`;
}

// The group id of a call: `--group` as given, or derived from `--group-label`, refusing both together and a blank label.
function groupOfCall(values) {
  const label = values["group-label"];
  if (label === undefined) return groupIdOf(values.group);
  if (values.group !== undefined) throw new UserError("`--group` and `--group-label` name the same thing: pass one");
  if (label.trim() === "") throw new UserError("`--group-label <label>` is blank (the GROUP of your request)");
  return groupIdFromLabel(label.trim());
}

// The artifact as it is on disk, or an empty text when no round was written yet.
function readRounds(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw new UserError(`could not read ${path}: ${err?.message ?? String(err)}`);
  }
}

// Appends the round under the run lock, numbering it from what is on disk at that moment, and answers its number and the fence it closed first.
function appendUnderLock(run, path, round, env) {
  return withRunLock({ projectId: run.projectId, slug: run.slug, env }, () => {
    const existing = readRounds(path);
    const number = nextRound(existing);
    const next = appendedText(existing, number, round);
    try {
      writeFileAtomic(path, next.text);
    } catch (err) {
      throw new UserError(`could not write ${path}: ${err?.message ?? String(err)}`);
    }
    return { number, closed: next.closed };
  });
}

// Runs `run append 05`, which appends one prover round to `05-qa.md` of THIS run, safe against provers appending at the same time.
export async function runAppend(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { ...RUN_OPTIONS, from: { type: "string" }, group: { type: "string" }, "group-label": { type: "string" } });
  const [check] = checkArgs(positionals, { min: 1, max: 1, usage: APPEND_USAGE });
  const appendable = pipelineManifest().phases.find((phase) => phase.appendable === true);
  if (check.trim() !== appendable.check) throw new UserError(`\`run append\` only takes \`${appendable.check}\` (the QA rounds)`);
  const group = groupOfCall(values);
  if (!values.from) throw new UserError(`\`--from <file>\` is required; usage: ${APPEND_USAGE}`);
  const round = proverRound(readRequiredFile(resolve(ctx.cwd, values.from), "--from"), group);
  const run = await resolveRun(values, ctx);
  const path = join(run.runDir, appendable.artifact);
  const { number, closed } = appendUnderLock(run, path, round, ctx.env);
  if (closed !== null) ctx.out(repairedLine(appendable.artifact, closed));
  ctx.out(`APPENDED: ## Round ${number} to ${path}`);
  return 0;
}
