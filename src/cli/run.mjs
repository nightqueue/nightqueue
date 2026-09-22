import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, runDir } from "../config/paths.mjs";
import { projectByName } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { ghPrCreate } from "../host/gh.mjs";
import { runGit } from "../host/git.mjs";
import { publishedBranchName } from "../queue/branch-name.mjs";
import { formatDuration } from "../queue/narrate.mjs";
import { defaultGitImpl } from "../queue/preflight.mjs";
import { isSafeSegment, isStateObject, readRunState } from "../queue/resume.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { recordOutcome, recordPrTemplate, recordPrUrl, recordRunFields } from "../queue/run-state.mjs";
import { phaseTelemetry, runDurationS } from "../queue/telemetry.mjs";
import { openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { parseExploreArtifact } from "./explore-artifact.mjs";
import { realPath } from "./paths.mjs";
import { bodyProblems } from "./pr-body.mjs";
import { findPrTemplate } from "./pr-template.mjs";
import { SECRETS_SWEEP_USAGE, runSecretsSweep } from "./secrets-sweep.mjs";

const USAGE = {
  check: "nightshift run check <NN> [--project <name> --slug <slug>]",
  commit: "nightshift run commit --message-file <path> [--files-from <path>] [--extra <pathspec>]",
  log: "nightshift run log [--json] [--project <name> --slug <slug>]",
  pr: "nightshift run pr --body-file <path> [--title <text>] [--remove-worktree] | --template",
  "index-save": "nightshift run index-save <artifact> [--project <name>] [--repo-root <path>]",
  "secrets-sweep": SECRETS_SWEEP_USAGE,
};

const HELP_FLAGS = new Set(["--help", "-h", "help"]);

// The options every subcommand shares: outside a job they are the only way to say which run is meant.
const RUN_OPTIONS = { project: { type: "string" }, slug: { type: "string" } };

const NOTHING_TO_PRINT = "no phase recorded yet";

// The one section of the pipeline the runtime can write by itself, because git already knows what the implementation touched.
const FILE_LIST = "## Modified files";

// Refuses to read another run from inside a job: the run of a job is the one its own row names, never one the prompt spelled out.
function refuseNamedRun(own) {
  throw new UserError(
    `refusing to name a run from inside job \`${own}\`: \`nightshift run\` acts on the run of the job it is called from; ` +
      "drop `--project`/`--slug`, or run the command outside the queue",
  );
}

// Refuses to work a run whose slug the row does not carry yet, instead of inventing one.
function refuseMissingSlug(own) {
  throw new UserError(
    `job \`${own}\` has no run slug on its row yet: print \`SLUG: <slug>\` once, so the runtime binds the run directory, ` +
      "then call this command again",
  );
}

// The run of the job this process belongs to, read from its own row.
async function jobRun(own, values, env) {
  if (values.project !== undefined || values.slug !== undefined) refuseNamedRun(own);
  const row = await openStore(env).jobs.getJob(own);
  if (!isSafeSegment(row?.slug)) refuseMissingSlug(own);
  return { jobId: own, project: row.project, slug: row.slug };
}

// The run an operator names from outside a job, where nothing else can tell which one it is.
function operatorRun(values, env) {
  const project = (values.project ?? "").trim();
  const slug = (values.slug ?? "").trim();
  if (!project || !slug) {
    throw new UserError(
      "outside a job, `--project` (the registered NAME) and `--slug` (the `<slug>` of runs/<project>/<slug>) are both required",
    );
  }
  if (!isSafeSegment(slug)) {
    throw new UserError(`invalid slug \`${slug}\`: a run slug is one path segment of letters, digits and \`. _ + -\``);
  }
  const registered = projectByName(loadConfig(env, { warn: () => {} }), project);
  if (!registered) {
    throw new UserError(`unknown project \`${project}\`: pass the registered project NAME; list them with \`nightshift project list\``);
  }
  return { jobId: null, project: registered.name, slug };
}

// The run every `nightshift run` subcommand acts on: the caller's own job run inside the queue, the one an operator named outside it.
async function resolveRun(values, ctx) {
  const own = callerJobId(ctx.env);
  const run = own === null ? operatorRun(values, ctx.env) : await jobRun(own, values, ctx.env);
  return { ...run, runDir: runDir(run.project, run.slug, ctx.env) };
}

// The state.json of the run, refusing when nothing has been recorded into it yet.
function requireRunState({ project, slug, runDir: dir }, env) {
  const state = readRunState({ project, slug, env });
  if (!isStateObject(state)) {
    throw new UserError(`no run recorded at ${join(dir, "state.json")}; the runtime writes it as the phases complete`);
  }
  return state;
}

// The accumulated stream of the job on disk, the only source of what the runtime measured; no log means nothing was measured.
function readJobLog(jobId, env) {
  if (jobId === null) return "";
  try {
    return readFileSync(jobLogPath(jobId, env), "utf8");
  } catch {
    return "";
  }
}

// The lanes the runtime measured, grouped by phase name, so a phase that ran twice keeps one measure per run of it.
function measuredByPhase(log) {
  const byPhase = new Map();
  for (const lane of phaseTelemetry(log)) {
    const lanes = byPhase.get(lane.phase) ?? [];
    lanes.push(lane);
    byPhase.set(lane.phase, lanes);
  }
  return byPhase;
}

// How a recorded phase ended: the verdict the phase reported, or `ok` for a phase that was recorded without one.
function phaseStatus(entry) {
  const verdict = typeof entry?.verdict === "string" ? entry.verdict.trim() : "";
  return verdict || "ok";
}

// One row per phase recorded in state.json, enriched with the model and the duration the runtime measured for its lane.
function phaseRows(state, log) {
  const measured = measuredByPhase(log);
  const phases = Array.isArray(state.phases) ? state.phases : [];
  return phases.map((entry) => {
    const lane = measured.get(entry?.phase)?.shift() ?? null;
    return {
      phase: String(entry?.phase ?? "-"),
      at: typeof entry?.at === "string" ? entry.at : null,
      model: lane?.model ?? null,
      status: phaseStatus(entry),
      durationS: lane?.durationS ?? null,
    };
  });
}

// A duration as the report reads it, and a dash when the runtime measured none.
function durationCell(seconds) {
  return Number.isFinite(seconds) ? formatDuration(seconds * 1000) : "-";
}

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

// The artifact of each phase and the sections its gate requires; a phase with no required section is checked for existence alone.
const ARTIFACTS = new Map([
  ["01", { file: "01-triage.md", sections: ["## Verdict"] }],
  ["02", { file: "02-explore.md", sections: [] }],
  ["03", { file: "03-plan.md", sections: ["## Implementation plan", "## Assumptions", "## Pre-mortem", "## Identified risks"] }],
  ["04", { file: "04-implementation.md", sections: [FILE_LIST] }],
  ["05a", { file: "05a-qa-analyst.md", sections: ["## Break hypotheses", "## Test recipe"] }],
  ["05", { file: "05-qa.md", sections: ["## Validated risks"] }],
  ["06", { file: "06-verification.md", sections: ["## Verification"] }],
  ["06.5", { file: "06-runtime.md", sections: ["## Runtime verdict"] }],
]);

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

// What the gate found absent: the required sections the artifact does not carry, or the artifact itself when nothing was written.
function missingParts(text, { file, sections }) {
  const absent = sections.filter((heading) => !hasHeading(text, heading));
  if (absent.length > 0) return absent;
  return text.trim() === "" ? [`${file} (not written)`] : [];
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

// The checkout of the project of a run: the directory its worktrees were created from, and the only one that may remove them.
function projectCheckout(project, env) {
  const registered = projectByName(loadConfig(env, { warn: () => {} }), project);
  if (!registered) throw new UserError(`unknown project \`${project}\`: it is no longer registered, so its checkout cannot be read`);
  return registered.path;
}

// Where the code of this run lives: the worktree the pipeline recorded, or the project's own checkout when no worktree was created.
function worktreeOf({ project, slug }, env) {
  const state = readRunState({ project, slug, env });
  const recorded = isStateObject(state) && typeof state.worktree === "string" ? state.worktree.trim() : "";
  return recorded || projectCheckout(project, env);
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

// Runs `run check`, which answers whether the artifact of a phase of THIS run is there with the sections the pipeline reads from it.
async function runCheck(argv, ctx) {
  const { values, positionals } = parseCommand(argv, RUN_OPTIONS);
  checkArgs(positionals, { min: 1, max: 1, usage: USAGE.check });
  const artifact = ARTIFACTS.get(positionals[0].trim().toLowerCase());
  if (!artifact) {
    throw new UserError(`unknown phase \`${positionals[0]}\`; the artifact gate covers: ${[...ARTIFACTS.keys()].join(", ")}`);
  }
  const run = await resolveRun(values, ctx);
  ctx.out(checkArtifact(run, artifact, ctx));
  return 0;
}

// Directories the pipeline never commits from, whoever asked for it: the host's own configuration and the scratch space of the run.
const NEVER_COMMITTED_DIRS = [".claude", "tmp"];

// Dependency lockfiles, which a pipeline run never owns: they are regenerated by the tool, never hand-edited into a pull request.
const LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"];

// Said after every refusal, so `--extra` is read as what it is — a way to add files, never a way to force a refused one through.
const EXTRA_IS_NOT_AN_OVERRIDE =
  "`--extra` adds files to the list, it never overrides this refusal: stop here and record it as an open item of the report, " +
  "instead of calling the command again with the same path";

// Files a repository declares its commit convention in, the most explicit first.
const CONVENTION_FILES = [
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.js",
  ".commitlintrc.yml",
  ".commitlintrc.yaml",
  ".husky",
  ".gitmessage",
  "CONTRIBUTING.md",
  "CONTRIBUTING",
];

const CONVENTIONAL_SUBJECT_RE = /^[a-z]+(\([^)]*\))?!?: \S/;

// The lines a host command answered on stdout, trimmed and without the empty ones.
function outputLines(result) {
  return String(result?.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// The one line of a failed host command worth showing, so an error message never carries a whole page of output.
function failureLine(result) {
  const text = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`.trim();
  return text.split("\n")[0] || "the command answered nothing";
}

// A file the command cannot work without, read from where the caller pointed at it.
function readRequiredFile(path, flag) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new UserError(`could not read \`${flag}\` ${path}: ${error.message}`);
  }
}

// The commit message the agent wrote, refused when it is missing or empty: the message is the agent's and the command never invents one.
function requireMessageFile(path) {
  if (!path) throw new UserError(`\`--message-file <path>\` is required: the commit message is the agent's; usage: ${USAGE.commit}`);
  const absolute = resolve(path);
  if (readRequiredFile(absolute, "--message-file").trim() === "") throw new UserError(`the commit message at ${absolute} is empty`);
  return absolute;
}

// One path of a `## Modified files` list, with the bullet and the backticks the agent may have written around it; a line carrying inner whitespace is the prose an agent tends to leave in the section, never one of the paths it lists one per line.
function pathOfLine(line) {
  const text = line.trim().replace(/^[-*]\s+/, "").replace(/^`+|`+$/g, "").trim();
  if (text.startsWith("#") || /\s/.test(text)) return "";
  return text;
}

// The paths the implementation artifact listed under `## Modified files`, which is the list this commit is allowed to stage.
function listedFiles(text) {
  const after = text.split(FILE_LIST).slice(1).join(FILE_LIST);
  const body = after.split("\n## ")[0] ?? "";
  return body.split("\n").map(pathOfLine).filter(Boolean);
}

// Why the pipeline refuses to commit a path, or null when it may be staged; the comparison folds the case, because the filesystem resolves `.Claude/hook.js` to the very `.claude/hook.js` this refusal exists for.
function refusalReason(path) {
  const segments = path.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  const directory = segments.find((segment) => NEVER_COMMITTED_DIRS.includes(segment));
  if (directory) return `under \`${directory}/\``;
  return LOCKFILES.includes(segments.at(-1) ?? "") ? "a dependency lockfile" : null;
}

// Every path the command was pointed at, as git names it inside the worktree, carrying the reason it is refused when there is one.
function candidates(cwd, paths) {
  return paths.map((raw) => {
    const path = relative(cwd, isAbsolute(raw) ? raw : join(cwd, raw));
    if (!path || path.startsWith("..")) return { path: raw, reason: `outside the worktree ${cwd}` };
    return { path, reason: refusalReason(path) };
  });
}

// The files a `--extra` pathspec really matches, so the refusal list is checked against what would be staged and never against the pattern alone.
function expandExtra(cwd, pathspec, env) {
  const result = runGit({ args: ["ls-files", "--cached", "--others", "--exclude-standard", "--", pathspec], cwd, env });
  if (!result.ok) throw new UserError(`git could not expand \`--extra ${pathspec}\`: ${failureLine(result)}`);
  const files = outputLines(result);
  if (files.length === 0) throw new UserError(`\`--extra ${pathspec}\` matches no file in ${cwd}`);
  return files;
}

// What this commit may stage, or the paths it refuses: the listed files and the `--extra` pathspecs first, then everything those really match.
function stageable({ cwd, listed, extras, env }) {
  const files = candidates(cwd, listed);
  const pathspecs = candidates(cwd, extras);
  const asked = [...files, ...pathspecs].filter((entry) => entry.reason);
  if (asked.length > 0) return { paths: [], refused: asked };
  const matched = candidates(cwd, extras.flatMap((pathspec) => expandExtra(cwd, pathspec, env)));
  const refused = matched.filter((entry) => entry.reason);
  const paths = [...new Set([...files, ...matched].map((entry) => entry.path))];
  return { paths: refused.length > 0 ? [] : paths, refused };
}

// The file of the repository that declares how a commit message is written, or null when no file does.
function conventionFile(cwd) {
  const declared = CONVENTION_FILES.find((name) => existsSync(join(cwd, name)));
  if (declared) return declared;
  try {
    return "commitlint" in JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) ? "package.json (commitlint)" : null;
  } catch {
    return null;
  }
}

// The shape the last commits of the repository really have, which is what the message must look like when no file declares it.
function inferredConvention(cwd, env) {
  const subjects = outputLines(runGit({ args: ["log", "--format=%s", "-30"], cwd, env }));
  if (subjects.length === 0) return "no commit to read it from; follow the repository's own guidelines";
  const conventional = subjects.filter((subject) => CONVENTIONAL_SUBJECT_RE.test(subject));
  if (conventional.length * 2 >= subjects.length) {
    return `conventional commits in ${conventional.length} of the last ${subjects.length} (e.g. \`${conventional[0]}\`)`;
  }
  return `free-form subjects in the last ${subjects.length} commits (e.g. \`${subjects[0]}\`)`;
}

// The commit convention of the worktree, as the agent needs to read it before writing the message.
function commitConvention(cwd, env) {
  const declared = conventionFile(cwd);
  return `${declared ? `declared by ${declared}; ` : ""}${inferredConvention(cwd, env)}`;
}

// Stages exactly the list and commits it with the agent's own message; a git refusal is reported as it came, never guessed at.
function commitFiles({ cwd, paths, messageFile, env }) {
  const staged = runGit({ args: ["add", "--", ...paths], cwd, env });
  if (!staged.ok) throw new UserError(`git could not stage the list in ${cwd}: ${failureLine(staged)}`);
  const committed = runGit({ args: ["commit", "-F", messageFile], cwd, env });
  if (!committed.ok) throw new UserError(`git could not commit in ${cwd}: ${failureLine(committed)}`);
  const head = runGit({ args: ["rev-parse", "--short", "HEAD"], cwd, env });
  return head.ok ? head.stdout.trim() : "HEAD";
}

// Runs `run commit`, which stages what the implementation artifact declared — and nothing the pipeline never commits — and commits it.
async function runCommit(argv, ctx) {
  const options = { "files-from": { type: "string" }, extra: { type: "string", multiple: true }, "message-file": { type: "string" } };
  const { values, positionals } = parseCommand(argv, { ...RUN_OPTIONS, ...options });
  checkArgs(positionals, { max: 0, usage: USAGE.commit });
  const messageFile = requireMessageFile(values["message-file"]);
  const run = await resolveRun(values, ctx);
  const cwd = worktreeOf(run, ctx.env);
  const artifact = resolve(values["files-from"] ?? join(run.runDir, "04-implementation.md"));
  const listed = listedFiles(readRequiredFile(artifact, "--files-from"));
  const { paths, refused } = stageable({ cwd, listed, extras: values.extra ?? [], env: ctx.env });
  if (refused.length > 0) {
    ctx.out(`REFUSED: ${refused.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}`);
    ctx.out(EXTRA_IS_NOT_AN_OVERRIDE);
    return 1;
  }
  if (paths.length === 0) throw new UserError(`${artifact} lists no file under \`${FILE_LIST}\`: there is nothing to commit`);
  ctx.out(`CONVENTION: ${commitConvention(cwd, ctx.env)}`);
  ctx.out(`COMMITTED: ${commitFiles({ cwd, paths, messageFile, env: ctx.env })} (${paths.length} files)`);
  return 0;
}

// One violation of the body as the command prints it, the rules being the template's own (`references/pr-template.md`).
function problemLine(problem) {
  return problem.missing === undefined ? `REJECTED: ${problem.rejected}` : `MISSING: ${problem.missing}`;
}

// The title of the pull request: the one the caller passed, or the `# <title>` the body opens with.
function prTitle(given, body) {
  const asked = (given ?? "").trim();
  if (asked) return asked;
  const heading = body.split("\n").find((line) => /^#\s+\S/.test(line.trim()));
  if (!heading) throw new UserError("pass `--title <text>`: the body carries no `# <title>` line to take one from");
  return heading.trim().replace(/^#\s+/, "");
}

// The branch the worktree is on right now, which is the only name a push may trust.
function currentBranch(cwd, env) {
  const result = runGit({ args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd, env });
  const name = result.ok ? result.stdout.trim() : "";
  if (!name || name === "HEAD") throw new UserError(`no branch is checked out in ${cwd}: ${failureLine(result)}`);
  return name;
}

// Renames the local branch to the name the remote should carry, which is what the push and the pull request then use.
function renameBranch({ cwd, current, final, env }) {
  if (final === current) return current;
  const renamed = runGit({ args: ["branch", "-m", current, final], cwd, env });
  if (!renamed.ok) throw new UserError(`git could not rename \`${current}\` to \`${final}\`: ${failureLine(renamed)}`);
  return final;
}

// Publishes the branch and opens the pull request, then records the run as done with the URL gh answered and the branch it pushed: the record is written
// here, at the point of publication, so a run driven outside the queue runner (a resumed session, another program) ends up
// with the same state.json as one the runner watched. A value the record refuses is reported, never fatal.
function publishBranch({ run, cwd, branch, title, bodyFile, env }) {
  const pushed = runGit({ args: ["push", "-u", "origin", branch], cwd, env });
  if (!pushed.ok) throw new UserError(`git could not push \`${branch}\`: ${failureLine(pushed)}`);
  const created = ghPrCreate({ title, bodyFile, head: branch, cwd, env });
  if (created.missing) throw new UserError(`\`${branch}\` is pushed, but the GitHub CLI is not installed: open the pull request by hand`);
  if (!created.ok) throw new UserError(`\`${branch}\` is pushed, but gh could not open the pull request: ${failureLine(created)}`);
  const recorded = recordOutcome({ project: run.project, slug: run.slug, status: "done", env });
  const prRecorded = recordPrUrl({ project: run.project, slug: run.slug, prUrl: created.url, env });
  const branchRecorded = recordRunFields({ project: run.project, slug: run.slug, fields: { branch }, env });
  return { url: created.url, recorded, prRecorded, branchRecorded };
}

// Removes the worktree of the run from the checkout that owns it; the pull request is already open, so a refusal is reported, never fatal.
function worktreeRemoval(run, path, env) {
  const removed = runGit({ args: ["worktree", "remove", path], cwd: projectCheckout(run.project, env), env });
  return removed.ok ? `WORKTREE REMOVED: ${path}` : `WORKTREE KEPT: ${failureLine(removed)}`;
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
  ctx.out(template.source === "repo" ? `TEMPLATE: repo (${template.label})` : "TEMPLATE: nightshift (fallback)");
  ctx.out(`HEADINGS: ${template.headings.length > 0 ? template.headings.join(" · ") : "none"}`);
  const recorded = recordPrTemplate({ project: run.project, slug: run.slug, template, env: ctx.env });
  if (recorded.status !== "written") ctx.err(`nightshift: the pull request template was not recorded on the run: ${recorded.reason}`);
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
  const problems = bodyProblems({ body, template, evidenceDir: join(run.runDir, "evidence") });
  if (problems.length > 0) {
    for (const problem of problems) ctx.out(problemLine(problem));
    ctx.out("nothing was pushed and no pull request was opened: fix the body and call `nightshift run pr` again");
    return 1;
  }
  const state = readRunState({ project: run.project, slug: run.slug, env: ctx.env });
  const current = currentBranch(cwd, ctx.env);
  const branch = renameBranch({ cwd, current, final: publishedBranchName(current, { type: state?.type, slug: run.slug }), env: ctx.env });
  const { url, recorded, prRecorded, branchRecorded } = publishBranch({ run, cwd, branch, title: prTitle(values.title, body), bodyFile, env: ctx.env });
  ctx.out(`BRANCH: ${branch}${branch === current ? "" : ` (renamed from ${current})`}`);
  ctx.out(`PR: ${url ?? "opened"}`);
  if (recorded.status !== "written") ctx.err(`nightshift: the run was not recorded as done: ${recorded.reason}`);
  if (prRecorded.status !== "written") ctx.err(`nightshift: the pull request was not recorded on the run: ${prRecorded.reason}`);
  if (branchRecorded.status !== "written") ctx.err(`nightshift: the published branch was not recorded on the run: ${branchRecorded.reason}`);
  ctx.out(`WORKTREE: ${cwd}`);
  if (values["remove-worktree"] === true) ctx.out(worktreeRemoval(run, cwd, ctx.env));
  return 0;
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
  if (!parsed.libsSection) ctx.err("nightshift run index-save: no `## Third-party libraries` section; no lib was saved");
  for (const line of parsed.ignoredLibs) {
    ctx.err(`nightshift run index-save: not a \`<lib>@<version>\` entry, skipped: ${line}`);
  }
  const saved = await openStore(ctx.env).index.saveProjectIndex({
    project,
    repoRoot,
    files: parsed.files,
    libs: parsed.libs,
  });
  ctx.out(`index saved: ${saved.files} files, ${saved.libs} libs`);
  return 0;
}

const SUBCOMMANDS = new Map([
  ["check", runCheck],
  ["commit", runCommit],
  ["log", runLog],
  ["pr", runPr],
  ["index-save", runIndexSave],
  ["secrets-sweep", runSecretsSweep],
]);

const HELP = `usage: nightshift run <subcommand> [options]

subcommands:
${Object.values(USAGE).map((line) => `  ${line}`).join("\n")}`;

// Dispatches the subcommands of `nightshift run`, returning the exit code the subcommand decided.
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
        "`nightshift run` acts on the run of the job it is called from; to work the queue itself, use `nightshift queue run`",
    );
  }
  return await handler(rest, ctx);
}
