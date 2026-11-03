import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { UserError } from "../config/errors.mjs";
import { refuseInvalidAnswer } from "../queue/pipeline-answer.mjs";
import { DEFAULT_PIPELINE, loadPipeline, pinnedPipelineName } from "../queue/pipeline-package.mjs";
import { defaultGitImpl } from "../queue/preflight.mjs";
import { readRunState } from "../queue/resume.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { isProvisionalSlug } from "../queue/run-slug.mjs";
import { recordPrTemplate, withRunLock } from "../queue/run-state.mjs";
import { runDurationS } from "../queue/telemetry.mjs";
import { openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { applyLockedWrites, checkEffectLines } from "./check-effects.mjs";
import { APPEND_USAGE, runAppend } from "./run-append.mjs";
import { saveIndexFromText } from "./index-save.mjs";
import { realPath } from "./paths.mjs";
import { findPrTemplate } from "./pr-template.mjs";
import { changedFiles, durationCell, phaseRows, readJobLog, readRequiredFile, readRunFile, requireRunState, resolveRun, resolveWritableRun, RUN_OPTIONS, worktreeOf } from "./run-context.mjs";
import { bodyProblemLines, foldedPaths, openPullRequest, PUBLISH_USAGE, runPublish, scratchProblemLines, wipProblemLines } from "./run-publish.mjs";
import { REPORT_USAGE, runReport } from "./run-report.mjs";
import { START_USAGE, runStart } from "./run-start.mjs";
import { SECRETS_SWEEP_USAGE, runSecretsSweep } from "./secrets-sweep.mjs";

const USAGE = {
  check: "nightqueue run check <NN> [--stage analyst|triage] [--project <name> --slug <slug>]",
  append: APPEND_USAGE,
  dir:"nightqueue run dir [--project <name> --slug <slug>]",
  log: "nightqueue run log [--json] [--project <name> --slug <slug>]",
  pr: "nightqueue run pr --body-file <path> [--title <text>] [--remove-worktree] | --template",
  "index-save": "nightqueue run index-save <artifact> [--project <name>] [--repo-root <path>]",
  "secrets-sweep": SECRETS_SWEEP_USAGE,
  start: START_USAGE,
  publish: PUBLISH_USAGE,
  report: REPORT_USAGE,
};

const HELP_FLAGS = new Set(["--help", "-h", "help"]);

const NOTHING_TO_PRINT = "no phase recorded yet";

const COMMIT_REMOVED = "`run commit` was removed: `nightqueue run publish --message-file <path> --body-file <path>` commits and opens the pull request in one call";

// The tab-separated table the agent pastes: one line per phase, then the total of the whole run.
function logLines(rows, totalS) {
  const phases = rows.map((row) => [row.phase, row.model ?? "-", row.status, durationCell(row.durationS)].join("\t"));
  return [...(phases.length ? phases : [NOTHING_TO_PRINT]), `total\t${durationCell(totalS)}`];
}

// Runs `run log`, which prints the phases of THIS run with the model and the duration the runtime measured for each one.
async function runLog(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { ...RUN_OPTIONS, json: { type: "boolean" } });
  checkArgs(positionals, { max: 0, usage: USAGE.log });
  const run = await resolveRun(values, ctx);
  const state = requireRunState(run, ctx.env);
  const log = readJobLog(run.jobId, ctx.env);
  const rows = phaseRows(state, log);
  const totalS = runDurationS(log);
  if (values.json === true) ctx.out(JSON.stringify({ run, phases: rows, durationS: totalS }));
  else for (const line of logLines(rows, totalS)) ctx.out(line);
  return 0;
}

// The caller's own job row, or null outside a job or when the store cannot read it.
async function callerJobRow(env) {
  const own = callerJobId(env);
  if (own === null) return null;
  try {
    return await openStore(env).jobs.getJob(own);
  } catch {
    return null;
  }
}

// The manifest entry of a check.
function phaseOfCheck(manifest, check) {
  return manifest.phases.find((phase) => phase.check === check);
}

// The stage a check names, refused unless its phase declares that stage; null without one.
function checkStage(manifest, check, value) {
  if (value === undefined) return null;
  if (Object.hasOwn(phaseOfCheck(manifest, check).stages ?? {}, value)) return value;
  const staged = manifest.phases.filter((phase) => phase.stages).map((phase) => `${phase.check} --stage ${Object.keys(phase.stages).join("|")}`);
  throw new UserError(`unknown stage \`${value}\` of check \`${check}\`; the stages are \`${staged.join(", ")}\``);
}

// The check and the stage a call asks for, refused in the words of the pipeline's manifest.
function checkRequest(manifest, asked, stageValue) {
  const check = asked.trim().toLowerCase();
  const renumbered = manifest.renumbered ?? {};
  if (Object.hasOwn(renumbered, check)) throw new UserError(`renumbered: use ${renumbered[check]}`);
  if (!phaseOfCheck(manifest, check)) {
    const covered = manifest.phases.map((phase) => phase.check).filter((name) => name !== null);
    throw new UserError(`unknown phase \`${asked}\`; the artifact gate covers: ${covered.join(", ")}`);
  }
  return { check, stage: checkStage(manifest, check, stageValue) };
}

// Every file the run changed: the worktree's own changes and what the run's own wip commits carry.
function changedByRun(run, ctx) {
  const cwd = worktreeOf(run, ctx.env);
  const carried = foldedPaths(cwd, run, ctx.env).map((file) => join(cwd, file));
  return [...new Set([...changedFiles(cwd, ctx.gitImpl ?? defaultGitImpl), ...carried])].sort();
}

// What a check may read of the run: its files, its worktree and, only for a phase that derives a file list and only when asked, what git says changed; such a phase takes no run lock, so git never runs under it.
function checkFiles(run, phase, ctx) {
  const base = { read: (name) => readRunFile(run.runDir, name), worktree: () => worktreeOf(run, ctx.env) };
  if (phase.derivesFileList !== true) return { ...base, changed: null };
  return {
    ...base,
    get changed() {
      return changedByRun(run, ctx);
    },
  };
}

// The answer of the pipeline's `check` on the state as it is now, validated whole with its artifact writes applied, all under the run lock on a phase with rounds so no concurrent `run append` or check is lost between the read and the write.
function checkAnswer({ pipeline, request, job, run, ctx }) {
  const phase = phaseOfCheck(pipeline.manifest, request.check);
  const files = checkFiles(run, phase, ctx);
  const evaluate = () => {
    const state = readRunState({ projectId: run.projectId, slug: run.slug, env: ctx.env });
    const answer = pipeline.check({ phase: request.check, stage: request.stage, runDir: run.runDir, state, files, run: { slug: run.slug, provisionalSlug: isProvisionalSlug(job, run.slug) }, env: ctx.env });
    refuseInvalidAnswer(answer, pipeline.manifest);
    applyLockedWrites(answer.effects, run.runDir);
    return answer;
  };
  if (phase.rounds !== true || !existsSync(run.runDir)) return evaluate();
  return withRunLock({ projectId: run.projectId, slug: run.slug, env: ctx.env }, evaluate);
}

// Prints a check's answer: its contract lines, the lines of its effects, the device script so it never breaks the line parsing, and the next action last.
function printCheck(answer, effects, ctx) {
  for (const line of [...answer.lines, ...effects]) ctx.out(line);
  if (answer.script.length > 0) {
    ctx.out("SCRIPT:");
    for (const line of answer.script) ctx.out(line);
  }
  ctx.out(`NEXT: ${answer.next}`);
}

// Runs `run dir`, which prints the absolute directory of THIS run: `runs/<project_id>/<slug>` under the home.
async function runDirCommand(argv, ctx) {
  const { values, positionals } = parseCommand(argv, RUN_OPTIONS);
  checkArgs(positionals, { max: 0, usage: USAGE.dir });
  const run = await resolveRun(values, ctx);
  ctx.out(run.runDir);
  return 0;
}

// Runs `run check`, which resolves the run's pipeline to its package, has it answer for the artifact of a phase of THIS run, and applies and prints the answer.
async function runCheck(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { ...RUN_OPTIONS, stage: { type: "string" } });
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.check });
  const load = ctx.loadPipeline ?? loadPipeline;
  const job = await callerJobRow(ctx.env);
  const firstName = job?.pipeline ?? DEFAULT_PIPELINE;
  const first = await load(firstName);
  const asked = checkRequest(first.manifest, positionals[0], values.stage);
  const run = await resolveWritableRun(values, ctx);
  const pinned = pinnedPipelineName(readRunState({ projectId: run.projectId, slug: run.slug, env: ctx.env }));
  const name = job?.pipeline ?? pinned ?? DEFAULT_PIPELINE;
  const pipeline = name === firstName ? first : await load(name);
  const request = name === firstName ? asked : checkRequest(pipeline.manifest, positionals[0], values.stage);
  const answer = checkAnswer({ pipeline, request, job, run, ctx });
  printCheck(answer, await checkEffectLines({ answer, run, job, ctx }), ctx);
  return 0;
}

// Refuses a `run pr` call that asks for nothing, or for both the template query and a publication at once.
function checkPrMode(values) {
  if (values.template === true && values["body-file"]) {
    throw new UserError("`--template` only prints the template in effect; call it without `--body-file`");
  }
  if (values.template !== true && !values["body-file"]) {
    throw new UserError(`\`--body-file <path>\` is required to publish, or \`--template\` to print the template in effect; usage: ${USAGE.pr}`);
  }
}

// Prints the pull request template in effect for the run and records it in state.json, so Phase 8 reads it instead of deciding.
function announceTemplate(run, cwd, ctx) {
  const template = findPrTemplate(cwd);
  ctx.out(template.source === "repo" ? `TEMPLATE: repo (${template.label})` : "TEMPLATE: nightqueue (fallback)");
  ctx.out(`HEADINGS: ${template.headings.length > 0 ? template.headings.join(" · ") : "none"}`);
  const recorded = recordPrTemplate({ projectId: run.projectId, slug: run.slug, template, env: ctx.env });
  if (recorded.status !== "written") ctx.err(`nightqueue: the pull request template was not recorded on the run: ${recorded.reason}`);
  return template;
}

// Runs `run pr`, which finds the template in effect, checks the body against it, publishes the branch under its final name and records the run as done.
async function runPr(argv, ctx) {
  const options = { "body-file": { type: "string" }, title: { type: "string" }, "remove-worktree": { type: "boolean" }, template: { type: "boolean" } };
  const { values, positionals } = parseCommand(argv, { ...RUN_OPTIONS, ...options });
  checkArgs(positionals, { max: 0, usage: USAGE.pr });
  checkPrMode(values);
  const run = await resolveWritableRun(values, ctx);
  const cwd = worktreeOf(run, ctx.env);
  const template = announceTemplate(run, cwd, ctx);
  if (values.template === true) return 0;
  const bodyFile = resolve(values["body-file"]);
  const body = readRequiredFile(bodyFile, "--body-file");
  const lines = [...bodyProblemLines({ run, template, body }), ...scratchProblemLines(cwd, run, ctx.env), ...wipProblemLines(cwd, run, ctx.env)];
  if (lines.length > 0) {
    for (const line of lines) ctx.out(line);
    ctx.out("nothing was pushed and no pull request was opened: fix the problems above and call `nightqueue run pr` again");
    return 1;
  }
  return await openPullRequest({ run, cwd, bodyFile, body, title: values.title, removeWorktree: values["remove-worktree"] === true, ctx });
}

// ---- Steps the subagents call: they act on a named artifact, never on the run of a job.

// What the filesystem says one path really is, `null` when there is nothing there and a named refusal for any other error.
function statOf(path, subject) {
  try {
    return statSync(path);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new UserError(`${subject} cannot be read: ${path} (${err?.message ?? String(err)})`);
  }
}

// Absolute path of the artifact, every component of it resolved: the run directory sits outside the worktree on purpose, so the
// boundary here is not the working directory but the kind of path - an existing regular file, never a directory or a device.
function artifactPath(cwd, value) {
  const path = realPath(resolve(cwd, value));
  const stats = statOf(path, "artifact");
  if (!stats) throw new UserError(`artifact not found: ${path}`);
  if (stats.isDirectory()) throw new UserError(`artifact is a directory, not a file: ${path}`);
  if (!stats.isFile()) throw new UserError(`artifact is not a regular file: ${path}`);
  return path;
}

// Absolute path of the repository the index is saved for: an existing directory, which the store then still refuses unless it is a registered project.
function repoRootPath(cwd, value) {
  const path = realPath(resolve(cwd, value ?? "."));
  const stats = statOf(path, "repository root");
  if (!stats) throw new UserError(`repository root not found: ${path}`);
  if (!stats.isDirectory()) throw new UserError(`repository root is not a directory: ${path}`);
  return path;
}

// Reads an artifact the caller named, naming the path instead of letting a filesystem error out of the command.
function readNamedArtifact(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") throw new UserError(`artifact not found: ${path}`);
    if (err?.code === "EISDIR") throw new UserError(`artifact is a directory, not a file: ${path}`);
    throw new UserError(`artifact cannot be read: ${path} (${err?.message ?? String(err)})`);
  }
}

// Persists the `## File map` and the `## Third-party libraries` of an explore artifact into the project index.
async function runIndexSave(argv, ctx) {
  const { values, positionals } = parseCommand(argv, { project: { type: "string" }, "repo-root": { type: "string" } });
  const [artifact] = checkArgs(positionals, { min: 1, max: 1, usage: USAGE["index-save"] });
  const repoRoot = repoRootPath(ctx.cwd, values["repo-root"]);
  const project = values.project ?? repoRoot;
  const text = readNamedArtifact(artifactPath(ctx.cwd, artifact));
  const warn = (line) => ctx.err(`nightqueue run index-save: ${line}`);
  const saved = await saveIndexFromText({ text, project, repoRoot, ctx, warn });
  if (saved.status === "queued") ctx.err(`QUEUED: ${saved.path}`);
  else ctx.out(`index saved: ${saved.files} files, ${saved.libs} libs`);
  return 0;
}

const SUBCOMMANDS = new Map([
  ["check", runCheck],
  ["append", runAppend],
  ["dir", runDirCommand],
  ["log", runLog],
  ["pr", runPr],
  ["index-save", runIndexSave],
  ["secrets-sweep", runSecretsSweep],
  ["start", runStart],
  ["publish", runPublish],
  ["report", runReport],
]);

const HELP = `usage: nightqueue run <subcommand> [options]

subcommands:
${Object.values(USAGE).map((line) => `  ${line}`).join("\n")}`;

// Dispatches the subcommands of `nightqueue run`, returning the exit code the subcommand decided.
export async function run(argv, ctx) {
  const [sub, ...rest] = argv;
  if (HELP_FLAGS.has(sub)) {
    ctx.out(HELP);
    return 0;
  }
  if (sub === "commit") throw new UserError(COMMIT_REMOVED);
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(
      `unknown run subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}. ` +
        "`nightqueue run` acts on the run of the job it is called from; to work the queue itself, use `nightqueue queue run`",
    );
  }
  return await handler(rest, ctx);
}
