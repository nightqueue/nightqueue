import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { UserError } from "../config/errors.mjs";
import { ghPrCreate } from "../host/gh.mjs";
import { runGit } from "../host/git.mjs";
import { commitTypeOf, publishedBranchName } from "../queue/branch-name.mjs";
import { FILE_LIST, listedFiles } from "../queue/file-list.mjs";
import { publishedBodyFile } from "../queue/pr-footer.mjs";
import { readRunState } from "../queue/resume.mjs";
import { recordOutcome, recordPrUrl, recordRunFields } from "../queue/run-state.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { bodyProblems } from "./pr-body.mjs";
import { lockfileRule } from "./lockfile-rule.mjs";
import { findPrTemplate } from "./pr-template.mjs";
import { failureLine, outputLines, projectCheckout, readRequiredFile, resolveRun, RUN_OPTIONS, worktreeOf } from "./run-context.mjs";
import { scratchFiles } from "./scratch-files.mjs";

export const PUBLISH_USAGE =
  "nightqueue run publish --message-file <path> --body-file <path> [--files-from <path>] [--extra <pathspec>] [--title <text>] [--remove-worktree]";

const BASE_REFS = ["refs/remotes/origin/HEAD", "origin/main", "origin/master", "main", "master"];

// Directories the pipeline never commits from, whoever asked for it: the host's own configuration and the scratch space of the run.
const NEVER_COMMITTED_DIRS = [".claude", "tmp"];

// Said after every refusal, so `--extra` is read as what it is — a way to add files, never a way to force a refused one through.
export const EXTRA_IS_NOT_AN_OVERRIDE =
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

// A `Refs:` trailer line, which only the runtime writes and `run commit` refuses in the agent's message.
const REFS_TRAILER = /^Refs\s*:/i;

// The commit message the agent wrote, refused when it is missing or empty: the message is the agent's and the command never invents one.
export function requireMessageFile(path, usage) {
  if (!path) throw new UserError(`\`--message-file <path>\` is required: the commit message is the agent's; usage: ${usage}`);
  const absolute = resolve(path);
  if (readRequiredFile(absolute, "--message-file").trim() === "") throw new UserError(`the commit message at ${absolute} is empty`);
  return absolute;
}

// The files the implementation artifact (or the file the caller named) lists under `## Modified files`.
export function listedFromArtifact(run, filesFrom) {
  const artifact = resolve(filesFrom ?? join(run.runDir, "04-implementation.md"));
  return { artifact, listed: listedFiles(readRequiredFile(artifact, "--files-from")) };
}

// Why the pipeline refuses to commit a path from a directory it never commits from, or null; the comparison folds the case, because the filesystem resolves `.Claude/hook.js` to the very `.claude/hook.js` this refusal exists for.
function refusalReason(path) {
  const segments = path.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  const directory = segments.find((segment) => NEVER_COMMITTED_DIRS.includes(segment));
  return directory ? `under \`${directory}/\`` : null;
}

// The same entries, each lockfile among them refused unless the paired-manifest rule lets it through for this publish set.
function withLockfileReasons(entries, rule) {
  const set = new Set(entries.map((entry) => entry.path));
  return entries.map((entry) => (entry.reason ? entry : { ...entry, reason: rule.reasonFor(entry.path, set) }));
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
export function stageable({ cwd, listed, extras, env, install }) {
  const rule = lockfileRule({ cwd, env, baseRef: () => baseRef(cwd, env), install });
  const files = candidates(cwd, listed);
  const pathspecs = candidates(cwd, extras);
  const asked = withLockfileReasons([...files, ...pathspecs], rule).filter((entry) => entry.reason);
  if (asked.length > 0) return { paths: [], refused: asked };
  const matched = candidates(cwd, extras.flatMap((pathspec) => expandExtra(cwd, pathspec, env)));
  const everything = withLockfileReasons([...files, ...matched], rule);
  const refused = everything.filter((entry) => entry.reason);
  const paths = [...new Set(everything.map((entry) => entry.path))];
  return { paths: refused.length > 0 ? [] : paths, refused };
}

// The two lines a refused list prints, the second one saying `--extra` is no way around it.
export function refusedLines(refused) {
  return [`REFUSED: ${refused.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}`, EXTRA_IS_NOT_AN_OVERRIDE];
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
export function commitConvention(cwd, env) {
  const declared = conventionFile(cwd);
  return `${declared ? `declared by ${declared}; ` : ""}${inferredConvention(cwd, env)}`;
}

// Stages exactly the list and commits it with the agent's own message; a git refusal is reported as it came, never guessed at.
function commitFiles({ cwd, paths, messageFile, env }) {
  const staged = runGit({ args: ["add", "--", ...paths], cwd, env });
  if (!staged.ok) throw new UserError(`git could not stage the list in ${cwd}: ${failureLine(staged)}`);
  const committed = runGit({ args: ["commit", "-F", messageFile], cwd, env });
  if (!committed.ok) throw new UserError(`git could not commit in ${cwd}: ${failureLine(committed)}`);
  return shortHead(cwd, env);
}

// The short hash of HEAD, or `HEAD` when git cannot name it.
function shortHead(cwd, env) {
  const head = runGit({ args: ["rev-parse", "--short", "HEAD"], cwd, env });
  return head.ok ? head.stdout.trim() : "HEAD";
}

// The first line of the agent's message that is a `Refs:` trailer, or null when it carries none.
function refsTrailerLine(message) {
  const lines = message.split("\n");
  const at = lines.findIndex((line) => REFS_TRAILER.test(line.trim()));
  return at < 0 ? null : { number: at + 1, line: lines[at].trim() };
}

// Commits the stageable paths with the agent's message, printing the convention and the commit; answers the exit code of the step.
export async function commitPaths({ cwd, paths, messageFile, ctx }) {
  const trailer = refsTrailerLine(readRequiredFile(messageFile, "--message-file"));
  if (trailer !== null) {
    ctx.out(`REFUSED: line ${trailer.number} of the message is a \`Refs:\` trailer, which only the runtime writes: ${trailer.line}`);
    return 1;
  }
  ctx.out(`CONVENTION: ${commitConvention(cwd, ctx.env)}`);
  ctx.out(`COMMITTED: ${commitFiles({ cwd, paths, messageFile, env: ctx.env })} (${paths.length} files)`);
  return 0;
}

// One violation of the body as the command prints it, the rules being the template's own (`references/pr-template.md`).
function problemLine(problem) {
  return problem.missing === undefined ? `REJECTED: ${problem.rejected}` : `MISSING: ${problem.missing}`;
}

// The violation lines of a pull request body against the template in effect.
export function bodyProblemLines({ run, template, body }) {
  return bodyProblems({ body, template, evidenceDir: join(run.runDir, "evidence"), slug: run.slug, jobId: run.jobId }).map(problemLine);
}

// The first ref among the remote and local default branches that exists in the worktree: the base the branch is compared with.
function baseRef(cwd, env) {
  const found = BASE_REFS.find((ref) => runGit({ args: ["rev-parse", "--verify", "--quiet", ref], cwd, env }).ok);
  if (!found) throw new UserError(`no base branch (${BASE_REFS.join(", ")}) exists in ${cwd}: the files the branch adds cannot be checked for scratch`);
  return found;
}

// The files the branch adds against its base, as repo-relative paths.
function addedFiles(cwd, env) {
  const added = runGit({ args: ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", `${baseRef(cwd, env)}...HEAD`], cwd, env });
  if (!added.ok) throw new UserError(`git could not list the files the branch adds: ${failureLine(added)}`);
  return added.stdout.split("\0").filter(Boolean);
}

// One `REJECTED:` line per scratch file the branch adds (plus the paths about to be committed), each naming the way out.
export function scratchProblemLines(cwd, run, env, pending = []) {
  const paths = [...new Set([...addedFiles(cwd, env), ...pending])];
  return scratchFiles(paths, { cwd, runDir: run.runDir }).map(
    (path) => `REJECTED: scratch file ${path} — remove it, or promote it to a hermetic test with a real name, then commit and retry`,
  );
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

// The commit type the subject of HEAD declares, or null when git cannot read it or it follows no known type.
function headCommitType(cwd, env) {
  const subject = runGit({ args: ["log", "-1", "--format=%s"], cwd, env });
  return subject.ok ? commitTypeOf(subject.stdout.trim()) : null;
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
  const recorded = recordOutcome({ projectId: run.projectId, slug: run.slug, status: "done", env });
  const prRecorded = recordPrUrl({ projectId: run.projectId, slug: run.slug, prUrl: created.url, env });
  const branchRecorded = recordRunFields({ projectId: run.projectId, slug: run.slug, fields: { branch }, env });
  return { url: created.url, recorded, prRecorded, branchRecorded };
}

// Removes the worktree of the run from the checkout that owns it; the pull request is already open, so a refusal is reported, never fatal.
function worktreeRemoval(run, path, env) {
  const removed = runGit({ args: ["worktree", "remove", path], cwd: projectCheckout(run.project, env), env });
  return removed.ok ? `WORKTREE REMOVED: ${path}` : `WORKTREE KEPT: ${failureLine(removed)}`;
}

// Renames the branch to its final name, pushes it, opens the pull request and prints what happened; the body is already checked.
export async function openPullRequest({ run, cwd, bodyFile, body, title, removeWorktree, ctx }) {
  const published = publishedBodyFile({ bodyFile, runDir: run.runDir, jobId: run.jobId });
  const state = readRunState({ projectId: run.projectId, slug: run.slug, env: ctx.env });
  const current = currentBranch(cwd, ctx.env);
  const final = publishedBranchName(current, { type: state?.type, slug: run.slug, commitType: headCommitType(cwd, ctx.env) });
  const branch = renameBranch({ cwd, current, final, env: ctx.env });
  const { url, recorded, prRecorded, branchRecorded } = publishBranch({ run, cwd, branch, title: prTitle(title, body), bodyFile: published, env: ctx.env });
  ctx.out(`BRANCH: ${branch}${branch === current ? "" : ` (renamed from ${current})`}`);
  ctx.out(`PR: ${url ?? "opened"}`);
  if (recorded.status !== "written") ctx.err(`nightqueue: the run was not recorded as done: ${recorded.reason}`);
  if (prRecorded.status !== "written") ctx.err(`nightqueue: the pull request was not recorded on the run: ${prRecorded.reason}`);
  if (branchRecorded.status !== "written") ctx.err(`nightqueue: the published branch was not recorded on the run: ${branchRecorded.reason}`);
  ctx.out(`WORKTREE: ${cwd}`);
  if (removeWorktree) ctx.out(worktreeRemoval(run, cwd, ctx.env));
  return 0;
}

// True when every path is clean and the branch is ahead of its base: a retry after the commit already happened.
function alreadyCommitted(cwd, paths, env) {
  if (paths.length === 0) return false;
  const status = runGit({ args: ["status", "--porcelain", "--", ...paths], cwd, env });
  if (!status.ok || outputLines(status).length > 0) return false;
  const ahead = runGit({ args: ["rev-list", "--count", `${baseRef(cwd, env)}..HEAD`], cwd, env });
  return ahead.ok && Number(ahead.stdout.trim()) > 0;
}

// Prints the lines of a refused step and the sentence saying what was left untouched; answers the exit code.
function refuse(lines, ctx) {
  for (const line of lines) ctx.out(line);
  ctx.out("nothing was committed or pushed: fix the problems above and call `nightqueue run publish` again");
  return 1;
}

// Commits the list, or answers the commit a previous attempt of this same publication already made.
async function commitOnce({ run, cwd, paths, messageFile, ctx }) {
  if (!alreadyCommitted(cwd, paths, ctx.env)) {
    if (paths.length === 0) throw new UserError(`the artifact lists no file under \`${FILE_LIST}\`: there is nothing to commit`);
    return await commitPaths({ run, cwd, paths, messageFile, ctx });
  }
  ctx.out(`CONVENTION: ${commitConvention(cwd, ctx.env)}`);
  ctx.out(`COMMITTED: ${shortHead(cwd, ctx.env)} (already committed)`);
  return 0;
}

// The options `run publish` reads, parsed and with the two files it cannot work without.
function publishOptions(argv) {
  const options = {
    "message-file": { type: "string" },
    "body-file": { type: "string" },
    "files-from": { type: "string" },
    extra: { type: "string", multiple: true },
    title: { type: "string" },
    "remove-worktree": { type: "boolean" },
  };
  const { values, positionals } = parseCommand(argv, { ...RUN_OPTIONS, ...options });
  checkArgs(positionals, { max: 0, usage: PUBLISH_USAGE });
  if (!values["body-file"]) throw new UserError(`\`--body-file <path>\` is required: the pull request body is the agent's; usage: ${PUBLISH_USAGE}`);
  return values;
}

// The title of the pull request: `--title`, else the body's `# <title>`, else the subject of the commit message.
function publishTitle(given, body, messageFile) {
  const asked = (given ?? "").trim();
  if (asked || body.split("\n").some((line) => /^#\s+\S/.test(line.trim()))) return prTitle(asked, body);
  const subject = readRequiredFile(messageFile, "--message-file").split("\n")[0].trim();
  return prTitle(subject, body);
}

// Runs `run publish`: checks the body, commits the list once, refuses scratch files, then pushes and opens the pull request.
export async function runPublish(argv, ctx) {
  const values = publishOptions(argv);
  const messageFile = requireMessageFile(values["message-file"], PUBLISH_USAGE);
  const run = await resolveRun(values, ctx);
  const cwd = worktreeOf(run, ctx.env);
  const bodyFile = resolve(values["body-file"]);
  const body = readRequiredFile(bodyFile, "--body-file");
  const title = publishTitle(values.title, body, messageFile);
  const problems = bodyProblemLines({ run, template: findPrTemplate(cwd), body });
  if (problems.length > 0) return refuse(problems, ctx);
  const { listed } = listedFromArtifact(run, values["files-from"]);
  const { paths, refused } = stageable({ cwd, listed, extras: values.extra ?? [], env: ctx.env });
  if (refused.length > 0) return refuse(refusedLines(refused), ctx);
  const scratch = scratchProblemLines(cwd, run, ctx.env, paths);
  if (scratch.length > 0) return refuse(scratch, ctx);
  const committed = await commitOnce({ run, cwd, paths, messageFile, ctx });
  if (committed !== 0) return committed;
  return await openPullRequest({ run, cwd, bodyFile, body, title, removeWorktree: values["remove-worktree"] === true, ctx });
}
