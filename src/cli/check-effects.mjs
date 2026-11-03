import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { writeFileAtomic } from "../config/store.mjs";
import { adoptRunSlug } from "../queue/run-slug.mjs";
import { clearTermination, recordCheck, recordRunFields, recordRuntimeField, recordTermination, RUNTIME_AUTHOR } from "../queue/run-state.mjs";
import { openStore } from "../store/open.mjs";
import { saveIndexFromText } from "./index-save.mjs";
import { worktreeOf } from "./run-context.mjs";

// The closed vocabulary a pipeline's `check` answers with, executed in order. None of it changes the contract lines the answer printed first.

// The first line of an error's message.
function firstLine(err) {
  return String(err?.message ?? err).split("\n")[0];
}

// The line a refused write prints, so the caller sees the record did not happen without the check failing.
function notRecorded(written) {
  return `recorded: not recorded (${written.reason ?? "unknown reason"})`;
}

// The effect's own line on a write, the refusal's otherwise.
function writtenLines(written, line) {
  if (written.status !== "written") return [notRecorded(written)];
  return line ? [line] : [];
}

// Writes the answer's artifact writes, the only effects that must not lose a concurrent append: the caller holds the run lock when the phase has rounds; a failure stops the check.
export function applyLockedWrites(effects, runDirectory) {
  for (const effect of effects.filter((candidate) => candidate.kind === "writeRunFile" && candidate.locked === true)) {
    const path = join(runDirectory, effect.name);
    try {
      mkdirSync(runDirectory, { recursive: true });
      writeFileAtomic(path, effect.text);
    } catch (error) {
      throw new UserError(`could not write ${effect.what ?? effect.name} to ${path}: ${error.message}`);
    }
  }
}

// A plain run file, whose failure is one line and never a failed check.
function plainWriteLines(effect, { run }) {
  try {
    writeFileSync(join(run.runDir, effect.name), effect.text);
  } catch (err) {
    return [notRecorded({ reason: `${effect.name} could not be written: ${firstLine(err)}` })];
  }
  return effect.line ? [effect.line] : [];
}

// The `index:` line: the explore map saved into the project index, queued, or why not; never a failure of the check.
async function indexLines(effect, { run, ctx }) {
  try {
    const saved = await saveIndexFromText({ text: effect.text, project: run.project, repoRoot: worktreeOf(run, ctx.env), ctx });
    if (saved.status === "queued") return [`index: not saved (store unavailable; queued at ${saved.path})`];
    return [`index: saved ${saved.files} files, ${saved.libs} libs`];
  } catch (err) {
    return [`index: not saved (${firstLine(err)})`];
  }
}

// A field of the run itself, under the caller's claim.
function runFieldLines({ name, value, line }, { run, ctx }) {
  return writtenLines(recordRunFields({ projectId: run.projectId, slug: run.slug, fields: { [name]: value }, claim: run.claim, env: ctx.env }), line);
}

// The QA mode a phase decided, a key only the runtime writes.
function qaModeLines({ value, line, dropPhases }, { run, ctx }) {
  const qaMode = { ...value, at: new Date().toISOString() };
  return writtenLines(recordRuntimeField({ projectId: run.projectId, slug: run.slug, name: "qaMode", value: qaMode, dropPhases, env: ctx.env }), line);
}

// The pipeline's loop counters, a key only the runtime writes, set aside when the claim is over; nothing prints on success.
function loopsLines({ value }, { run, ctx }) {
  return writtenLines(recordRuntimeField({ projectId: run.projectId, slug: run.slug, name: "pipelineLoops", value, claim: run.claim, env: ctx.env }), null);
}

// A termination lifted or recorded: lifting prints its line only when one was lifted.
function terminationLines({ value, line }, { run, ctx }) {
  const target = { projectId: run.projectId, slug: run.slug, phase: value.phase, env: ctx.env };
  if (value.clear !== true) return writtenLines(recordTermination({ ...target, reason: value.reason, by: RUNTIME_AUTHOR, claim: run.claim }), line);
  const cleared = clearTermination(target);
  return cleared.status === "absent" ? [] : writtenLines(cleared, line);
}

// The Brief's slug adopted by a provisional run: the row rebound and the run dir renamed, or the slug kept and why.
async function slugLines({ value: named }, { run, job, ctx }) {
  if (job === null) return [`recorded: slug ${run.slug} (kept: the job's row cannot be read)`];
  try {
    const adopted = await adoptRunSlug({ job: { id: job.id, worker: job.worker, project_id: job.project_id }, from: run.slug, to: named, store: openStore(ctx.env), env: ctx.env });
    if (adopted.status === "kept") return [`recorded: slug ${run.slug} (kept: ${[adopted.reason, adopted.warning].filter(Boolean).join("; ")})`];
    return [`recorded: slug ${named} (renamed from ${run.slug}; run dir ${adopted.dir})`];
  } catch (err) {
    return [`recorded: slug ${run.slug} (kept: ${firstLine(err)})`];
  }
}

// The runtime's one writer of each recordable field.
const FIELD_WRITERS = { type: runFieldLines, commitType: runFieldLines, qaMode: qaModeLines, termination: terminationLines, slug: slugLines, pipelineLoops: loopsLines };

// Every field of a `recordFields` effect, through its writer.
async function fieldsLines(effect, exec) {
  const lines = [];
  for (const [name, value] of Object.entries(effect.fields)) lines.push(...(await FIELD_WRITERS[name]({ name, value, line: effect.line, dropPhases: effect.dropPhases ?? null }, exec)));
  return lines;
}

// One effect applied, and the lines it prints; the writes of the lock span were applied already.
async function effectLines(effect, exec) {
  if (effect.kind === "say") return [effect.line];
  if (effect.kind === "saveIndex") return await indexLines(effect, exec);
  if (effect.kind === "recordFields") return await fieldsLines(effect, exec);
  return effect.locked === true ? [] : plainWriteLines(effect, exec);
}

// The `recorded: phase_done` line from what the check record decided: appended (with its reason) or already recorded.
function phaseDoneLine(done, written) {
  if (written.status !== "written" || written.phase === null) return notRecorded(written);
  const base = `recorded: phase_done ${done.phase} ${done.verdict}`;
  if (written.phase.status === "already") return `${base} (already)`;
  return written.phase.reason ? `${base} — reason: ${written.phase.reason}` : base;
}

// Writes the check memo and, for a completed check of a phase, the phase itself; answers the `recorded:` line of the phase.
function memoAndPhaseLines(answer, { run, ctx, measures }) {
  const { key, ...memo } = answer.memo;
  const written = recordCheck({ projectId: run.projectId, slug: run.slug, check: key, memo, done: answer.record, claim: run.claim, measures, env: ctx.env });
  if (answer.record !== null) return [phaseDoneLine(answer.record, written)];
  if (written.status !== "written") ctx.err(`nightqueue: the check memo was not recorded on the run: ${written.reason}`);
  return [];
}

// The effects of an answer in order, with the memo and the phase record between those that go before it and those that go after it, and the lines they print.
export async function checkEffectLines({ answer, run, job, ctx, measures = null }) {
  const exec = { run, job, ctx, measures };
  const lines = [];
  for (const effect of answer.effects.filter((candidate) => candidate.afterRecord !== true)) lines.push(...(await effectLines(effect, exec)));
  lines.push(...memoAndPhaseLines(answer, exec));
  for (const effect of answer.effects.filter((candidate) => candidate.afterRecord === true)) lines.push(...(await effectLines(effect, exec)));
  return lines;
}
