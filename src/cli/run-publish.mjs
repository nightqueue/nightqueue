import { isAbsolute, join, relative, resolve } from "node:path";
import { UserError } from "../config/errors.mjs";
import { ghPrConvertToDraft, ghPrCreate, ghPrEditBody, ghPrMarkReady, ghPrUrlOfBranch } from "../host/gh.mjs";
import { runGit } from "../host/git.mjs";
import { commitTypeOf, publishedBranchName } from "../queue/branch-name.mjs";
import { FILE_LIST, listedFiles } from "../queue/file-list.mjs";
import { neverCommittedReason } from "../queue/never-committed.mjs";
import { fileListArtifacts } from "../queue/pipeline-package.mjs";
import { publishedBodyFile } from "../queue/pr-footer.mjs";
import { comparableQuestion, PLACEHOLDER_WORDS, plainQuestion } from "../queue/question-text.mjs";
import { readRunState } from "../queue/resume.mjs";
import { gitInChunks, readBranchWips, statusEntries, WIP_REF_PREFIX } from "../queue/wip-commit.mjs";
import { draftLine, recordOutcome, recordPhaseDone, recordPrUrl, recordRunFields, RUNTIME_AUTHOR } from "../queue/run-state.mjs";
import { unfencedLines, withoutHtmlComments } from "../queue/stream.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { commitMessageProblems, conventionFile, CONVENTIONAL_SUBJECT_RE, findCommitTemplate } from "./commit-template.mjs";
import { ANGLE_PLACEHOLDER, bodyProblems } from "./pr-body.mjs";
import { lockfileRule } from "./lockfile-rule.mjs";
import { findPrTemplate } from "./pr-template.mjs";
import { failureLine, outputLines, projectCheckout, readRequiredFile, readRunFile, resolveRun, RUN_OPTIONS, worktreeOf } from "./run-context.mjs";
import { scratchFiles } from "./scratch-files.mjs";

export const PUBLISH_USAGE =
  "nightqueue run publish --message-file <path> --body-file <path> [--files-from <path>] [--extra <pathspec>] [--title <text>] [--draft] [--remove-worktree]";

const BASE_REFS = ["refs/remotes/origin/HEAD", "origin/main", "origin/master", "main", "master"];

const ALREADY_EXISTS = /already exists/i;

const LAST_RENAME_RUNG = 99;

// A body line naming one failure a draft pull request leaves open, its text captured.
const REMAINING_FAILURE_LINE = /^Remaining failure:(.*)/;

// What a `Remaining failure:` line holds, whole, when it names no failure.
const NO_FAILURE_WORDS = [...PLACEHOLDER_WORDS, "none", "nothing"];

// Said on the `DRAFT:` line of the run's own draft a publish did not turn ready.
const KEPT_DRAFT_NOTE = " (stays a draft: the body still lists a Remaining failure: line)";

// Said after every refusal, so `--extra` is read as what it is — a way to add files, never a way to force a refused one through.
export const EXTRA_IS_NOT_AN_OVERRIDE =
  "`--extra` adds files to the list, it never overrides this refusal: stop here and record it as an open item of the report, " +
  "instead of calling the command again with the same path";

// A `Refs:` trailer line, a reserved trailer the commit refuses in the agent's message.
const REFS_TRAILER = /^Refs\s*:/i;

// The commit message the agent wrote, refused when it is missing or empty: the message is the agent's and the command never invents one.
export function requireMessageFile(path, usage) {
  if (!path) throw new UserError(`\`--message-file <path>\` is required: the commit message is the agent's; usage: ${usage}`);
  const absolute = resolve(path);
  if (readRequiredFile(absolute, "--message-file").trim() === "") throw new UserError(`the commit message at ${absolute} is empty`);
  return absolute;
}

// The files the implementation artifact (or the file the caller named) lists under `## Modified files`; an artifact that lists none falls back to the list `run check` derived, when there is one.
export function listedFromArtifact(run, filesFrom) {
  if (filesFrom) return { artifact: resolve(filesFrom), listed: listedFiles(readRequiredFile(resolve(filesFrom), "--files-from")) };
  const { artifact, fallback } = fileListArtifacts();
  const derived = listedFiles(readRunFile(run.runDir, fallback));
  const own = readRunFile(run.runDir, artifact);
  if (listedFiles(own).length === 0 && derived.length > 0) return { artifact: join(run.runDir, fallback), listed: derived };
  const path = join(run.runDir, artifact);
  return { artifact: path, listed: listedFiles(readRequiredFile(path, "--files-from")) };
}

// The same entries, each lockfile among them refused unless the paired-manifest rule lets it through for this publish set, which includes what a fold carries.
function withLockfileReasons(entries, rule, carried) {
  const set = new Set([...entries.map((entry) => entry.path), ...carried]);
  return entries.map((entry) => (entry.reason ? entry : { ...entry, reason: rule.reasonFor(entry.path, set) }));
}

// Every path the command was pointed at, as git names it inside the worktree, carrying the reason it is refused when there is one.
function candidates(cwd, paths) {
  return paths.map((raw) => {
    const path = relative(cwd, isAbsolute(raw) ? raw : join(cwd, raw));
    if (!path || path.startsWith("..")) return { path: raw, reason: `outside the worktree ${cwd}` };
    return { path, reason: neverCommittedReason(path) };
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

// The fold split into what it carries into the delivery and what it leaves out, on disk and uncommitted, with the reason of each.
function foldWithLeftOut({ fold, paths, rule, cwd, runDir }) {
  const set = new Set([...fold.carried, ...paths]);
  const scratch = new Set(scratchFiles(fold.carried, { cwd, runDir }));
  const entries = fold.carried.map((path) => ({
    path,
    reason: neverCommittedReason(path) ?? (scratch.has(path) ? "a scratch file" : rule.reasonFor(path, set)),
  }));
  return { ...fold, carried: entries.filter((entry) => !entry.reason).map((entry) => entry.path), leftOut: entries.filter((entry) => entry.reason) };
}

// What this commit may stage, or the paths it refuses: the listed files and the `--extra` pathspecs first, then everything those really match; a fold comes back split by what it may carry.
export function stageable({ cwd, listed, extras, env, install, fold = null, runDir = null }) {
  const rule = lockfileRule({ cwd, env, baseRef: () => baseRef(cwd, env), install });
  const carried = fold?.carried ?? [];
  const files = candidates(cwd, listed);
  const pathspecs = candidates(cwd, extras);
  const asked = withLockfileReasons([...files, ...pathspecs], rule, carried).filter((entry) => entry.reason);
  if (asked.length > 0) return { paths: [], refused: asked, fold: null };
  const matched = candidates(cwd, extras.flatMap((pathspec) => expandExtra(cwd, pathspec, env)));
  const everything = withLockfileReasons([...files, ...matched], rule, carried);
  const refused = everything.filter((entry) => entry.reason);
  if (refused.length > 0) return { paths: [], refused, fold: null };
  const paths = [...new Set(everything.map((entry) => entry.path))];
  return { paths, refused, fold: fold ? foldWithLeftOut({ fold, paths, rule, cwd, runDir }) : null };
}

// The two lines a refused list prints, the second one saying `--extra` is no way around it.
export function refusedLines(refused) {
  return [`REFUSED: ${refused.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}`, EXTRA_IS_NOT_AN_OVERRIDE];
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

// Stages exactly the list; a git refusal is reported as it came, never guessed at.
function stageList({ cwd, paths, env }) {
  const staged = runGit({ args: ["add", "--", ...paths], cwd, env });
  if (!staged.ok) throw new UserError(`git could not stage the list in ${cwd}: ${failureLine(staged)}`);
}

// Commits what is staged with the agent's own message; a git refusal is reported as it came, never guessed at.
function commitStaged({ cwd, messageFile, env }) {
  const committed = runGit({ args: ["commit", "-F", messageFile], cwd, env });
  if (!committed.ok) throw new UserError(`git could not commit in ${cwd}: ${failureLine(committed)}`);
}

// The carried paths the worktree changed after the wip commit, which the delivery must take as the worktree has them.
function carriedChanges({ cwd, fold, env }) {
  const status = runGit({ args: ["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"], cwd, env });
  if (!status.ok) throw new UserError(`git could not read the status of ${cwd}: ${failureLine(status)}`);
  const carried = new Set(fold.carried);
  return statusEntries(status.stdout).filter((entry) => entry.changed && carried.has(entry.path)).map((entry) => entry.path);
}

// Runs one literal-pathspec git command over the paths, refusing with what git said.
function literalPaths({ command, paths, cwd, env, what }) {
  const failed = gitInChunks({ command: ["--literal-pathspecs", ...command, "--"], paths, cwd, env });
  if (failed) throw new UserError(`git could not ${what} in ${cwd}: ${failureLine(failed)}`);
}

// Stages the delivery on the wip's parent, whose index already holds the wip: drops what is left out, adds the list and the carried paths edited since.
function stageFold({ cwd, paths, fold, env }) {
  literalPaths({ command: ["reset", "-q"], paths: fold.leftOut.map((entry) => entry.path), cwd, env, what: "unstage what the fold leaves out" });
  const carried = new Set(fold.carried);
  const added = paths.filter((path) => !carried.has(path));
  if (added.length > 0) stageList({ cwd, paths: added, env });
  literalPaths({ command: ["add"], paths: carriedChanges({ cwd, fold, env }), cwd, env, what: "stage the carried paths" });
}

// Puts the branch and the index back on the wip commit after a fold that failed, the worktree untouched; answers what to add to the error.
function undoFold({ cwd, fold, env }) {
  const back = runGit({ args: ["reset", "-q", fold.head], cwd, env });
  if (!back.ok) return `the branch could not be put back on the wip commit ${fold.head}: ${failureLine(back)}`;
  return `the branch is back on the wip commit ${fold.head.slice(0, 7)}`;
}

// Moves the branch onto the wip's parent keeping the index; a fold a kill interrupted already sits there, and a second reset would overwrite the ORIG_HEAD that identifies it.
function moveOntoParent({ cwd, fold, env }) {
  if (fold.interrupted) return;
  const moved = runGit({ args: ["reset", "--soft", "-q", fold.parent], cwd, env });
  if (!moved.ok) throw new UserError(`git could not move the branch off the wip commit in ${cwd}: ${failureLine(moved)}`);
}

// Replaces the run's own wip commits with one delivery commit on their parent; a failure leaves the branch back on the wip, whose ref is never touched.
function commitFold({ cwd, paths, fold, messageFile, env }) {
  moveOntoParent({ cwd, fold, env });
  try {
    stageFold({ cwd, paths, fold, env });
    commitStaged({ cwd, messageFile, env });
  } catch (error) {
    throw new UserError(`${error.message}; ${undoFold({ cwd, fold, env })}`);
  }
}

// The line reporting a fold: how many wip commits and files went in, and what stayed out with its reason.
function foldedLine(fold) {
  const leftOut = fold.leftOut.map((entry) => `${entry.path} (${entry.reason})`).join(", ");
  return `FOLDED: ${fold.commits.length} wip commits (${fold.carried.length} files)${leftOut ? `; left out: ${leftOut}` : ""}`;
}

// The paths HEAD changed, or null when git cannot answer.
function headPaths(cwd, env) {
  const listed = runGit({ args: ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--root", "HEAD"], cwd, env });
  return listed.ok ? listed.stdout.split("\0").filter(Boolean) : null;
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

// Commits the stageable paths with the agent's message, folding the run's own wip commits into it, printing the convention and the commit; answers the exit code of the step.
export async function commitPaths({ cwd, paths, messageFile, fold = null, ctx }) {
  const trailer = refsTrailerLine(readRequiredFile(messageFile, "--message-file"));
  if (trailer !== null) {
    ctx.out(`REFUSED: line ${trailer.number} of the message is a \`Refs:\` trailer, which is reserved and never written by an agent: ${trailer.line}`);
    return 1;
  }
  ctx.out(`CONVENTION: ${commitConvention(cwd, ctx.env)}`);
  if (fold) {
    commitFold({ cwd, paths, fold, messageFile, env: ctx.env });
    ctx.out(foldedLine(fold));
  } else {
    stageList({ cwd, paths, env: ctx.env });
    commitStaged({ cwd, messageFile, env: ctx.env });
  }
  ctx.out(`COMMITTED: ${shortHead(cwd, ctx.env)} (${(headPaths(cwd, ctx.env) ?? paths).length} files)`);
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

// One `REJECTED: commit message — <reason>` line per violation of the message against the commit template in effect.
export function messageProblemLines(cwd, messageFile, env) {
  const message = readRequiredFile(messageFile, "--message-file");
  return commitMessageProblems(message, findCommitTemplate(cwd, env)).map((reason) => `REJECTED: commit message — ${reason}`);
}

// The first ref among the remote and local default branches that exists in the worktree, or undefined.
function findBaseRef(cwd, env) {
  return BASE_REFS.find((ref) => runGit({ args: ["rev-parse", "--verify", "--quiet", ref], cwd, env }).ok);
}

// The base the branch is compared with, refused when no default branch exists in the worktree.
export function baseRef(cwd, env) {
  const found = findBaseRef(cwd, env);
  if (!found) throw new UserError(`no base branch (${BASE_REFS.join(", ")}) exists in ${cwd}: the files the branch adds cannot be checked for scratch`);
  return found;
}

// The files the branch adds against its base up to a commit, as repo-relative paths.
function addedFiles(cwd, env, upTo) {
  const added = runGit({ args: ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", `${baseRef(cwd, env)}...${upTo}`], cwd, env });
  if (!added.ok) throw new UserError(`git could not list the files the branch adds: ${failureLine(added)}`);
  return added.stdout.split("\0").filter(Boolean);
}

// One `REJECTED:` line per scratch file the branch adds up to a commit (plus the paths about to be committed), each naming the way out.
export function scratchProblemLines(cwd, run, env, pending = [], upTo = "HEAD") {
  const paths = [...new Set([...addedFiles(cwd, env, upTo), ...pending])];
  return scratchFiles(paths, { cwd, runDir: run.runDir }).map(
    (path) => `REJECTED: scratch file ${path} — remove it, or promote it to a hermetic test with a real name, then commit and retry`,
  );
}

// The slugs whose wip commits are this run's own: its slug, and the one its wip record names when a retry renamed the run.
function ownWipSlugs(run, env) {
  const ref = readRunState({ projectId: run.projectId, slug: run.slug, env })?.wip?.ref;
  return typeof ref === "string" && ref.startsWith(WIP_REF_PREFIX) ? [run.slug, ref.slice(WIP_REF_PREFIX.length)] : [run.slug];
}

// What the branch's wip commits mean for a commit: the refusals, or the fold of the run's own; a job with `start_branch` also owns the wips it inherited, and with no base there is nothing to compare.
export function branchWips(cwd, run, env) {
  const base = findBaseRef(cwd, env);
  if (!base) return { problems: [], fold: null };
  return readBranchWips({ cwd, base, slugs: ownWipSlugs(run, env), anySlug: Boolean(run.startBranch), env });
}

// The paths the run's own wip commits would carry into a delivery, for a list derived on a clean retry; only the publication runs the paired install.
export function foldedPaths(cwd, run, env) {
  const { fold } = branchWips(cwd, run, env);
  if (!fold) return [];
  return stageable({ cwd, listed: [], extras: [], env, fold, runDir: run.runDir, install: () => ({ ok: true }) }).fold.carried;
}

// True when a commit would take nothing: no path to stage and no wip path to carry.
export function nothingToCommit(paths, fold) {
  return paths.length === 0 && (fold?.carried.length ?? 0) === 0;
}

// One `REJECTED:` line per wip commit the branch still carries, for a publication that does not fold, naming the way out for the run's own.
export function wipProblemLines(cwd, run, env) {
  const { problems, fold } = branchWips(cwd, run, env);
  const own = (fold?.commits ?? []).map(
    (commit) => `REJECTED: the branch carries the runtime's wip commit ${commit.slice(0, 7)}, which is never pushed: call \`nightqueue run publish\`, which folds it into the delivery commit`,
  );
  return [...problems, ...own];
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

// Tells whether a local branch exists in the worktree's repository.
function localBranchExists(cwd, branch, env) {
  return runGit({ args: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd, env }).ok;
}

// The name a rename can land on: the final name, or its next free `-<n>` when another local branch already carries it.
function freeBranchName({ cwd, final, env }) {
  if (!localBranchExists(cwd, final, env)) return final;
  for (let rung = 2; rung <= LAST_RENAME_RUNG; rung += 1) {
    const candidate = `${final}-${rung}`;
    if (!localBranchExists(cwd, candidate, env)) return candidate;
  }
  return final;
}

// Renames the local branch to the name the remote should carry, which is what the push and the pull request then use.
function renameBranch({ cwd, current, final, env }) {
  if (final === current) return current;
  const target = freeBranchName({ cwd, final, env });
  const renamed = runGit({ args: ["branch", "-m", current, target], cwd, env });
  if (!renamed.ok) throw new UserError(`git could not rename \`${current}\` to \`${target}\`: ${failureLine(renamed)}`);
  return target;
}

// Records on the run the branch the worktree now holds, before anything external can fail; a refused record is reported, never fatal.
function recordPublishedBranch({ run, branch, ctx }) {
  const recorded = recordRunFields({ projectId: run.projectId, slug: run.slug, fields: { branch }, claim: run.claim, env: ctx.env });
  if (recorded.status !== "written") ctx.err(`nightqueue: the published branch was not recorded on the run: ${recorded.reason}`);
}

// Publishes the branch and opens the pull request, then records the run as done with the URL gh answered and the files HEAD delivered: the record is written
// here, at the point of publication, so a run driven outside the queue runner (a resumed session, another program) ends up
// with the same state.json as one the runner watched. A value the record refuses is reported, never fatal.
function publishBranch({ run, cwd, branch, title, bodyFile, files, failures, listedFailures, ownedDraft, env }) {
  const pushed = runGit({ args: ["push", "-u", "origin", branch], cwd, env });
  if (!pushed.ok) throw new UserError(`git could not push \`${branch}\`: ${failureLine(pushed)}`);
  const pr = openOrUpdatePr({ branch, title, bodyFile, draft: failures > 0, ownedDraft, listedFailures, cwd, env });
  const remaining = pr.keptDraft ? listedFailures : failures;
  const recorded = recordOutcome({ projectId: run.projectId, slug: run.slug, status: "done", ...(files ? { files } : {}), draft: pr.draft, failures: remaining, draftPrUrl: pr.draftPrUrl, staysDraft: pr.staysDraft !== undefined, claim: run.claim, env });
  const prRecorded = recordPrUrl({ projectId: run.projectId, slug: run.slug, prUrl: pr.url, prTitle: title, claim: run.claim, env });
  return { ...pr, remaining, recorded, prRecorded };
}

// What became of an existing pull request the caller wants as a draft, with gh's reason when it refused.
function convertedToDraft({ url, cwd, env }) {
  const converted = ghPrConvertToDraft({ url, cwd, env });
  return converted.ok ? { draft: true, draftPrUrl: url } : { draft: false, draftRefusal: failureLine(converted) };
}

// What became of an existing pull request published without the flag: only the draft this run itself opened is turned ready, never while its body lists a failure, with gh's reason when it refused.
function readiedOwnDraft({ url, ownedDraft, listedFailures, cwd, env }) {
  if (url !== ownedDraft) return { draft: false };
  if (listedFailures > 0) return { draft: true, keptDraft: true, draftPrUrl: url };
  const ready = ghPrMarkReady({ url, cwd, env });
  return ready.ok ? { draft: false, readied: true, draftPrUrl: null } : { draft: false, staysDraft: failureLine(ready) };
}

// Asks gh to open the pull request; a draft refused for any reason but an existing pull request or a missing gh is asked once more as a normal one, keeping gh's reason.
function createPr({ branch, title, bodyFile, draft, cwd, env }) {
  const created = ghPrCreate({ title, bodyFile, head: branch, draft, cwd, env });
  if (!draft || created.ok || created.missing || ALREADY_EXISTS.test(created.stderr)) return { created, draft };
  return { created: ghPrCreate({ title, bodyFile, head: branch, draft: false, cwd, env }), draft: false, draftRefusal: failureLine(created) };
}

// The pull request of the branch and what it now is: the one gh opens, or the one the branch already has, whose body is then replaced.
function openOrUpdatePr({ branch, title, bodyFile, draft, ownedDraft, listedFailures, cwd, env }) {
  const { created, draft: openedDraft, draftRefusal } = createPr({ branch, title, bodyFile, draft, cwd, env });
  if (created.missing) throw new UserError(`\`${branch}\` is pushed, but the GitHub CLI is not installed: open the pull request by hand`);
  if (created.ok) return { url: created.url, draft: openedDraft, draftRefusal, draftPrUrl: openedDraft ? created.url : null };
  if (!ALREADY_EXISTS.test(created.stderr)) throw new UserError(`\`${branch}\` is pushed, but gh could not open the pull request: ${failureLine(created)}`);
  const existing = ghPrUrlOfBranch({ head: branch, cwd, env });
  if (!existing.url) throw new UserError(`\`${branch}\` is pushed and gh says its pull request exists, but no pull request with that head branch was found: ${failureLine(existing)}`);
  const edited = ghPrEditBody({ url: existing.url, bodyFile, cwd, env });
  if (!edited.ok) throw new UserError(`\`${branch}\` is pushed, but gh could not update its pull request ${existing.url}: ${failureLine(edited)}`);
  const { url } = existing;
  return { url, ...(draft ? convertedToDraft({ url, cwd, env }) : readiedOwnDraft({ url, ownedDraft, listedFailures, cwd, env })) };
}

// Records the commit phase on the run once its pull request is open; a refused record is reported, never fatal.
function recordCommitPhase(run, draft, ctx) {
  const verdict = draft ? "Draft PR opened" : "PR opened";
  const recorded = recordPhaseDone({ projectId: run.projectId, slug: run.slug, phase: "commit", verdict, by: RUNTIME_AUTHOR, claim: run.claim, env: ctx.env });
  if (recorded.status !== "written") ctx.err(`nightqueue: the commit phase was not recorded on the run: ${recorded.reason}`);
}

// Removes the worktree of the run from the checkout that owns it; the pull request is already open, so a refusal is reported, never fatal.
function worktreeRemoval(run, path, env) {
  const removed = runGit({ args: ["worktree", "remove", path], cwd: projectCheckout(run.project, env), env });
  return removed.ok ? `WORKTREE REMOVED: ${path}` : `WORKTREE KEPT: ${failureLine(removed)}`;
}

// Refuses a publication whose claim is over, before any side effect: its record is set aside and the session told to end; the exit code, or null when the claim still holds.
function lateClaimExit(run, ctx) {
  if (run.claim?.over !== true) return null;
  const recorded = recordOutcome({ projectId: run.projectId, slug: run.slug, status: "done", claim: run.claim, env: ctx.env });
  ctx.out(`REFUSED: ${recorded.reason}`);
  ctx.out("nothing was committed or pushed, and no pull request was opened");
  return 1;
}

// Renames the branch to its final name, pushes it, opens the pull request and prints what happened; the body is already checked.
export async function openPullRequest({ run, cwd, bodyFile, body, title, removeWorktree, failures = 0, ctx }) {
  const late = lateClaimExit(run, ctx);
  if (late !== null) return late;
  const state = readRunState({ projectId: run.projectId, slug: run.slug, env: ctx.env });
  const published = publishedBodyFile({ bodyFile, runDir: run.runDir, jobId: run.jobId, origins: run.origins ?? [] });
  const current = currentBranch(cwd, ctx.env);
  const final = publishedBranchName(current, { type: state?.type, slug: run.slug, commitType: headCommitType(cwd, ctx.env) });
  const branch = renameBranch({ cwd, current, final, env: ctx.env });
  recordPublishedBranch({ run, branch, ctx });
  const files = headPaths(cwd, ctx.env);
  if (files === null) ctx.err("nightqueue: the delivered files could not be read from HEAD, so the outcome records none");
  const { url, draft, keptDraft, remaining, draftRefusal, readied, staysDraft, recorded, prRecorded } = publishBranch({ run, cwd, branch, title: prTitle(title, body), bodyFile: published, files, failures, listedFailures: remainingFailures(body), ownedDraft: state?.draftPrUrl, env: ctx.env });
  ctx.out(`BRANCH: ${branch}${branch === current ? "" : ` (renamed from ${current})`}`);
  ctx.out(`PR: ${url ?? "opened"}`);
  if (draft) ctx.out(`DRAFT: ${draftLine(remaining)}${keptDraft ? KEPT_DRAFT_NOTE : ""}`);
  if (readied) ctx.out(`READY: ${url}`);
  if (draftRefusal) ctx.err(`nightqueue: gh could not turn ${url} into a draft: ${draftRefusal}`);
  if (staysDraft) ctx.err(`nightqueue: ${url} stays a draft: ${staysDraft}`);
  if (recorded.status !== "written") ctx.err(`nightqueue: the run was not recorded as done: ${recorded.reason}`);
  if (prRecorded.status !== "written") ctx.err(`nightqueue: the pull request was not recorded on the run: ${prRecorded.reason}`);
  recordCommitPhase(run, draft, ctx);
  ctx.out(`WORKTREE: ${cwd}`);
  if (removeWorktree) ctx.out(worktreeRemoval(run, cwd, ctx.env));
  return 0;
}

// True when every path is clean, nothing is staged and the branch is ahead of its base: a retry after the commit already happened.
function alreadyCommitted(cwd, paths, env) {
  if (paths.length === 0) return false;
  const status = runGit({ args: ["status", "--porcelain", "--", ...paths], cwd, env });
  if (!status.ok || outputLines(status).length > 0) return false;
  if (!runGit({ args: ["diff", "--cached", "--quiet"], cwd, env }).ok) return false;
  const ahead = runGit({ args: ["rev-list", "--count", `${baseRef(cwd, env)}..HEAD`], cwd, env });
  return ahead.ok && Number(ahead.stdout.trim()) > 0;
}

// Prints the lines of a refused step and the sentence saying what was left untouched; answers the exit code.
function refuse(lines, ctx) {
  for (const line of lines) ctx.out(line);
  ctx.out("nothing was committed or pushed: fix the problems above and call `nightqueue run publish` again");
  return 1;
}

// Commits the list, or answers the commit a previous attempt of this same publication already made; a fold always commits.
async function commitOnce({ run, cwd, paths, messageFile, fold, ctx }) {
  if (fold || !alreadyCommitted(cwd, paths, ctx.env)) {
    if (nothingToCommit(paths, fold)) throw new UserError(`the artifact lists no file under \`${FILE_LIST}\`: there is nothing to commit`);
    return await commitPaths({ run, cwd, paths, messageFile, fold, ctx });
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
    draft: { type: "boolean" },
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

// Whether a failure text holds only the template's hint or a word that stands for no failure; any other text with a word names one, however it opens or is wrapped.
function holdsNoFailure(text) {
  const plain = plainQuestion(text).replace(/^\((.*)\)$/, "$1").replace(/[.,;:!]+$/, "");
  return NO_FAILURE_WORDS.includes(plain) || ANGLE_PLACEHOLDER.exec(plain)?.[0] === plain;
}

// Whether a body line names a failure, which a `Remaining failure:` line with no word or no failure does not.
function namesFailure(line) {
  const named = REMAINING_FAILURE_LINE.exec(line);
  return named !== null && comparableQuestion(named[1]) !== "" && !holdsNoFailure(named[1]);
}

// How many failures the body names on its `Remaining failure:` lines.
function remainingFailures(body) {
  return unfencedLines(withoutHtmlComments(body)).filter(namesFailure).length;
}

// The refusal of a `--draft` whose body lists no failure, which is the only source of the count the draft reports.
function draftProblemLines(isDraft, failures) {
  return isDraft && failures === 0 ? ["REJECTED: a draft pull request lists each failure on a Remaining failure: <what> line of its QA/verification section"] : [];
}

// The exact line a body owes for the run's recorded QA skip, its text from the state and never from an agent; null when the QA was not skipped.
function requiredQaSkipLine(state) {
  return state?.qaMode?.mode === "skip" ? `QA: skipped — ${state.qaMode.reason}` : null;
}

// The refusal of a body without the owed line, which a fenced or commented copy does not satisfy.
function qaSkipProblemLines(required, body) {
  if (required === null) return [];
  const carried = unfencedLines(withoutHtmlComments(body)).some((line) => line.trim() === required);
  return carried ? [] : [`REJECTED: the QA of this run was skipped, so the body carries this exact line under its test section's heading: ${required}`];
}

// The body the template's rules read: the owed line is the runtime's own text, so a word of its reason never makes the body unpublishable.
function withoutQaSkipLine(body, required) {
  return required === null ? body : body.split("\n").filter((line) => line.trim() !== required).join("\n");
}

// Runs `run publish`: checks the message and the body, commits the list once, refuses scratch files, then pushes and opens the pull request.
export async function runPublish(argv, ctx) {
  const values = publishOptions(argv);
  const messageFile = requireMessageFile(values["message-file"], PUBLISH_USAGE);
  const run = await resolveRun(values, ctx);
  const late = lateClaimExit(run, ctx);
  if (late !== null) return late;
  const cwd = worktreeOf(run, ctx.env);
  const bodyFile = resolve(values["body-file"]);
  const body = readRequiredFile(bodyFile, "--body-file");
  const title = publishTitle(values.title, body, messageFile);
  const isDraft = values.draft === true;
  const failures = isDraft ? remainingFailures(body) : 0;
  const qaSkipLine = requiredQaSkipLine(readRunState({ projectId: run.projectId, slug: run.slug, env: ctx.env }));
  const templateBody = withoutQaSkipLine(body, qaSkipLine);
  const problems = [...messageProblemLines(cwd, messageFile, ctx.env), ...bodyProblemLines({ run, template: findPrTemplate(cwd), body: templateBody }), ...qaSkipProblemLines(qaSkipLine, body), ...draftProblemLines(isDraft, failures)];
  if (problems.length > 0) return refuse(problems, ctx);
  const { listed } = listedFromArtifact(run, values["files-from"]);
  const wips = branchWips(cwd, run, ctx.env);
  if (wips.problems.length > 0) return refuse(wips.problems, ctx);
  const { paths, refused, fold } = stageable({ cwd, listed, extras: values.extra ?? [], env: ctx.env, fold: wips.fold, runDir: run.runDir });
  if (refused.length > 0) return refuse(refusedLines(refused), ctx);
  const scratch = scratchProblemLines(cwd, run, ctx.env, paths, fold?.parent);
  if (scratch.length > 0) return refuse(scratch, ctx);
  const committed = await commitOnce({ run, cwd, paths, messageFile, fold, ctx });
  if (committed !== 0) return committed;
  return await openPullRequest({ run, cwd, bodyFile, body, title, removeWorktree: values["remove-worktree"] === true, failures, ctx });
}
