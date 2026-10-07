import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StoreUnavailableError, UserError } from "../config/errors.mjs";
import { resolveProjectRef } from "../config/projects.mjs";
import { withMeasuredMtimes } from "../memory/index-paths.mjs";
import { FILE_LIST } from "../queue/file-list.mjs";
import { resolveJobRun } from "../queue/job-run.mjs";
import { appendPendingWrite, PENDING_KEYS } from "../queue/pending-writes.mjs";
import { PHASE_ARTIFACTS } from "../queue/phase-artifacts.mjs";
import { defaultGitImpl } from "../queue/preflight.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { recordPrTemplate } from "../queue/run-state.mjs";
import { runDurationS } from "../queue/telemetry.mjs";
import { openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { parseExploreArtifact } from "./explore-artifact.mjs";
import { realPath } from "./paths.mjs";
import { findPrTemplate } from "./pr-template.mjs";
import { durationCell, phaseRows, readJobLog, readRequiredFile, requireRunState, resolveRun, RUN_OPTIONS, worktreeOf } from "./run-context.mjs";
import {
  bodyProblemLines,
  commitPaths,
  listedFromArtifact,
  openPullRequest,
  PUBLISH_USAGE,
  refusedLines,
  requireMessageFile,
  runPublish,
  scratchProblemLines,
  stageable,
} from "./run-publish.mjs";
import { REPORT_USAGE, runReport } from "./run-report.mjs";
import { START_USAGE, runStart } from "./run-start.mjs";
import { SECRETS_SWEEP_USAGE, runSecretsSweep } from "./secrets-sweep.mjs";

const USAGE = {
  check: "nightqueue run check <NN> [--project <name> --slug <slug>]",
  commit: "nightqueue run commit --message-file <path> [--files-from <path>] [--extra <pathspec>]",
  dir: "nightqueue run dir [--project <name> --slug <slug>]",
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

// The artifact as it is on disk, and nothing at all when the phase never wrote it.
function readArtifact(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// Whether the artifact carries a section, matched on the heading line so `## Verification — iteration 2` still counts as `## Verification`.
function hasHeading(text, heading) {
  return text.split("\n").some((line) => line.trimEnd().startsWith(heading));
}

// The first non-blank line of a section, closed by the next `## ` heading; null when the section is absent or empty.
function firstLineOfSection(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trimEnd().startsWith(heading));
  if (start === -1) return null;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) return null;
    if (line.trim() !== "") return line.trim();
  }
  return null;
}

// Whether the section's first line is the one the gate requires in that position.
function firstLineHolds(text, { heading, pattern }) {
  const line = firstLineOfSection(text, heading);
  return line !== null && pattern.test(line);
}

// What the gate found absent: the required sections the artifact does not carry, the artifact itself when nothing was written, or the line a section must open with.
function missingParts(text, { file, sections, firstLineUnder }) {
  const absent = sections.filter((heading) => !hasHeading(text, heading));
  if (absent.length > 0) return absent;
  if (text.trim() === "") return [`${file} (not written)`];
  return firstLineUnder && !firstLineHolds(text, firstLineUnder) ? [firstLineUnder.label] : [];
}

// The lines a read-only git command answered, or null when git refused to answer at all.
function gitLines(gitImpl, cwd, args) {
  try {
    return String(gitImpl({ args, cwd }) ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

// Every file the worktree changed, tracked and untracked alike, as the absolute paths a `## Modified files` lists.
function changedFiles(cwd, gitImpl) {
  const tracked = gitLines(gitImpl, cwd, ["diff", "--name-only", "HEAD"]);
  const untracked = gitLines(gitImpl, cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (tracked === null && untracked === null) {
    throw new UserError(`git answered nothing about \`${cwd}\`: the worktree of this run is gone or is not a git repository`);
  }
  return [...new Set([...(tracked ?? []), ...(untracked ?? [])])].sort().map((file) => join(cwd, file));
}

// Whether the implementation artifact already lists at least one file, which is what its section exists for.
function listsFiles(text) {
  const after = text.split(FILE_LIST).slice(1).join(FILE_LIST);
  const body = after.split("\n## ")[0] ?? "";
  return body.split("\n").some((line) => line.trim() !== "");
}

// The implementation artifact derived from git, written only when the agent left none with a file list.
function writeFileList(path, files) {
  const body = ["# Implementation (derived from git)", "", FILE_LIST, ...files, ""].join("\n");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  } catch (error) {
    throw new UserError(`could not write ${path}: ${error.message}`);
  }
}

// The gate of the implementation artifact, the only one with a fallback: no file list means deriving it from the worktree's own changes.
function checkFileList(run, path, text, ctx) {
  if (listsFiles(text)) return "OK";
  const files = changedFiles(worktreeOf(run, ctx.env), ctx.gitImpl ?? defaultGitImpl);
  if (files.length === 0) return `MISSING: ${FILE_LIST} (no changed files)`;
  writeFileList(path, files);
  return "GENERATED";
}

// The gate of one phase: the sections its artifact must carry, checked on the artifact itself.
function checkArtifact(run, artifact, ctx) {
  const path = join(run.runDir, artifact.file);
  const text = readArtifact(path);
  if (artifact.sections[0] === FILE_LIST) return checkFileList(run, path, text, ctx);
  const missing = missingParts(text, artifact);
  return missing.length === 0 ? "OK" : `MISSING: ${missing.join(", ")}`;
}

// Runs `run dir`, which prints the absolute directory of THIS run: `runs/<project_id>/<slug>` under the home.
async function runDirCommand(argv, ctx) {
  const { values, positionals } = parseCommand(argv, RUN_OPTIONS);
  checkArgs(positionals, { max: 0, usage: USAGE.dir });
  const run = await resolveRun(values, ctx);
  ctx.out(run.runDir);
  return 0;
}

// Runs `run check`, which answers whether the artifact of a phase of THIS run is there with the sections the pipeline reads from it.
async function runCheck(argv, ctx) {
  const { values, positionals } = parseCommand(argv, RUN_OPTIONS);
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.check });
  const artifact = PHASE_ARTIFACTS.get(positionals[0].trim().toLowerCase());
  if (!artifact) {
    throw new UserError(`unknown phase \`${positionals[0]}\`; the artifact gate covers: ${[...PHASE_ARTIFACTS.keys()].join(", ")}`);
  }
  const run = await resolveRun(values, ctx);
  ctx.out(checkArtifact(run, artifact, ctx));
  return 0;
}

// Runs `run commit`, which stages what the implementation artifact declared — and nothing the pipeline never commits — and commits it.
async function runCommit(argv, ctx) {
  const options = { "files-from": { type: "string" }, extra: { type: "string", multiple: true }, "message-file": { type: "string" } };
  const { values, positionals } = parseCommand(argv, { ...RUN_OPTIONS, ...options });
  checkArgs(positionals, { max: 0, usage: USAGE.commit });
  const messageFile = requireMessageFile(values["message-file"], USAGE.commit);
  const run = await resolveRun(values, ctx);
  const cwd = worktreeOf(run, ctx.env);
  const { artifact, listed } = listedFromArtifact(run, values["files-from"]);
  const { paths, refused } = stageable({ cwd, listed, extras: values.extra ?? [], env: ctx.env });
  if (refused.length > 0) {
    for (const line of refusedLines(refused)) ctx.out(line);
    return 1;
  }
  if (paths.length === 0) throw new UserError(`${artifact} lists no file under \`${FILE_LIST}\`: there is nothing to commit`);
  return await commitPaths({ run, cwd, paths, messageFile, ctx });
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

// Prints the pull request template in effect for the run and records it in state.json, so Phase 7 reads it instead of deciding.
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
  const run = await resolveRun(values, ctx);
  const cwd = worktreeOf(run, ctx.env);
  const template = announceTemplate(run, cwd, ctx);
  if (values.template === true) return 0;
  const bodyFile = resolve(values["body-file"]);
  const body = readRequiredFile(bodyFile, "--body-file");
  const lines = [...bodyProblemLines({ run, template, body }), ...scratchProblemLines(cwd, run, ctx.env)];
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
  const parsed = parseExploreArtifact(readNamedArtifact(artifactPath(ctx.cwd, artifact)));
  if (!parsed.libsSection) ctx.err("nightqueue run index-save: no `## Third-party libraries` section; no lib was saved");
  for (const line of parsed.ignoredLibs) {
    ctx.err(`nightqueue run index-save: not a \`<lib>@<version>\` entry, skipped: ${line}`);
  }
  const store = openStore(ctx.env);
  try {
    const saved = await store.index.saveProjectIndex({
      projectId: (await resolveProjectRef(store, project))?.id ?? null,
      repoRoot,
      files: parsed.files,
      libs: parsed.libs,
    });
    ctx.out(`index saved: ${saved.files} files, ${saved.libs} libs`);
    return 0;
  } catch (err) {
    return await queueIndexSave(err, { repoRoot, parsed }, ctx);
  }
}

// Queues an index save the unavailable database refused inside a job into the job's run, saying where it waits; outside a job, or for any other failure, the error is raised as it came.
async function queueIndexSave(err, { repoRoot, parsed }, ctx) {
  const own = callerJobId(ctx.env);
  if (!(err instanceof StoreUnavailableError) || own === null) throw err;
  const run = await resolveJobRun(own, ctx.env);
  const at = new Date().toISOString();
  const payload = { projectId: run.projectId, repoRoot, files: withMeasuredMtimes(parsed.files, repoRoot), libs: parsed.libs };
  const entry = { key: PENDING_KEYS.indexSave(run.projectId, at), kind: "index_save", at, jobId: own, payload };
  const queued = appendPendingWrite({ projectId: run.projectId, slug: run.slug, entry, env: ctx.env });
  if (queued.status !== "queued") throw err;
  ctx.err(`QUEUED: ${queued.path}`);
  return 0;
}

const SUBCOMMANDS = new Map([
  ["check", runCheck],
  ["commit", runCommit],
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
  const handler = SUBCOMMANDS.get(sub);
  if (!handler) {
    throw new UserError(
      `unknown run subcommand \`${sub ?? ""}\`; use: ${[...SUBCOMMANDS.keys()].join(", ")}. ` +
        "`nightqueue run` acts on the run of the job it is called from; to work the queue itself, use `nightqueue queue run`",
    );
  }
  return await handler(rest, ctx);
}
