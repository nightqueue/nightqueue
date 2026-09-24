import { UserError } from "../config/errors.mjs";
import { checkArgs, fileList, parseCommand } from "./args.mjs";
import { CHECK_ORDER, detectChecks } from "./detect.mjs";
import { makeThrowawayHome } from "./throwaway-home.mjs";

const USAGE = "nightqueue verify [--scope touched|full|+poc] [--files <list>]";
const SCOPES = new Set(["touched", "full", "+poc"]);
const CHECK_TIMEOUT_MS = 900000;
const SNIPPET_LINES = 20;
// The process's OWN resolution failure, each anchored to the line the runtime that printed it writes: a check whose output
// merely quotes one of these phrases inside a sentence of its own is reporting its real failure, not a missing dependency.
const MISSING_DEPS_RES = [
  /^\s*(?:[A-Za-z]*Error): Cannot find module /m,
  /^\s*(?:code: )?'?ERR_MODULE_NOT_FOUND'?/m,
  /^.*: command not found\s*$/m,
  /^.*is not recognized as an internal or external command/m,
  /^.*executable file not found in \$PATH/m,
];
const MISSING_DEPS_REASON = "dependencies not installed — nightqueue verify never installs";
const INTRUDER_RE = /(^|\/)\.claude\/|(^|\/)tmp\/|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|bun\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/;

// Seconds one check took, at the precision the block prints.
function elapsed(startedAt) {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

// Result of a check that passed.
function pass(name, startedAt, snippet = []) {
  return { name, status: "PASSED", seconds: elapsed(startedAt), snippet };
}

// Result of a check that failed, carrying the snippet the coder needs.
function fail(name, startedAt, snippet) {
  return { name, status: "FAILED", seconds: elapsed(startedAt), snippet };
}

// Result of a check the project does not declare, which never fails the run.
function skip(name, startedAt) {
  return { name, status: "SKIPPED", seconds: elapsed(startedAt), snippet: [] };
}

// Last lines of a check's output, capped so a failure never dumps its whole log.
function snippetOf(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  return lines.slice(-SNIPPET_LINES);
}

// Spawns one command without ever throwing: a missing binary and a timeout are results this command reports, not crashes.
function spawnCheck(ctx, file, args, env, cwd = ctx.cwd) {
  let result;
  try {
    result = ctx.spawnSyncImpl(file, args, { cwd, encoding: "utf8", timeout: CHECK_TIMEOUT_MS, env });
  } catch (err) {
    return { status: null, stdout: "", stderr: err?.message ?? String(err), missing: err?.code === "ENOENT", timedOut: false };
  }
  const failure = result?.error ?? null;
  return {
    status: typeof result?.status === "number" ? result.status : null,
    stdout: typeof result?.stdout === "string" ? result.stdout : "",
    stderr: typeof result?.stderr === "string" && result.stderr ? result.stderr : (failure?.message ?? ""),
    missing: failure?.code === "ENOENT",
    timedOut: failure?.code === "ETIMEDOUT",
  };
}

// Whether the process itself could not be resolved: the spawn found no binary, or the runtime printed its own resolution failure.
function isMissingDependency(result, output) {
  return result.missing || MISSING_DEPS_RES.some((pattern) => pattern.test(output));
}

// The runs one detected check is made of: one per workspace member that declares it, and a single one for a plain project.
function commandRuns(command, files) {
  const runs = Array.isArray(command.runs) ? command.runs : [{ args: command.args, cwd: null, member: null }];
  if (!command.acceptsFiles || !files.length) return runs;
  return runs.map((run) => ({ ...run, args: [...run.args, "--", ...files] }));
}

// The snippet of one failed run, named after the workspace member it ran in so a monorepo failure says where it happened.
function runSnippet(run, lines) {
  return run.member ? [`in ${run.member}`, ...lines].slice(0, SNIPPET_LINES) : lines.slice(0, SNIPPET_LINES);
}

// Runs one detected check and classifies its outcome; a check that cannot resolve its dependencies is reported, never repaired.
function runCheck(ctx, name, command, env, files) {
  const startedAt = Date.now();
  const runs = commandRuns(command, files);
  if (!runs.length) return skip(name, startedAt);
  for (const run of runs) {
    const result = spawnCheck(ctx, command.file, run.args, env, run.cwd ?? ctx.cwd);
    if (result.timedOut) return fail(name, startedAt, runSnippet(run, [`timed out after ${CHECK_TIMEOUT_MS / 1000}s`]));
    if (result.status === 0) continue;
    const output = `${result.stdout}\n${result.stderr}`;
    const lines = isMissingDependency(result, output) ? [MISSING_DEPS_REASON, ...snippetOf(output)] : snippetOf(output);
    return fail(name, startedAt, runSnippet(run, lines));
  }
  return pass(name, startedAt);
}

// Path one `git status --short` line names, the destination when the line reports a rename.
function statusPath(line) {
  const path = line.slice(3).trim();
  const arrow = path.indexOf(" -> ");
  return arrow === -1 ? path : path.slice(arrow + 4);
}

// Paths the working tree changed, every untracked file named one by one so an intruder is never hidden behind its directory.
function changedPaths(ctx, env) {
  const result = spawnCheck(ctx, "git", ["status", "--short", "--untracked-files=all"], env);
  if (result.status !== 0) return null;
  return result.stdout.split("\n").filter((line) => line.trim()).map(statusPath);
}

// Summary line of `git diff --stat`: how large the tracked change is, which the block reports beside the intruders.
function diffScale(ctx, env) {
  const result = spawnCheck(ctx, "git", ["diff", "--stat"], env);
  if (result.status !== 0) return [];
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return [lines.length ? lines.at(-1) : "no tracked file changed"];
}

// Runs the diff-hygiene check: the working tree must carry no host configuration, lockfile or scratch path the brief did not ask for.
function diffHygiene(ctx, env) {
  const startedAt = Date.now();
  const paths = changedPaths(ctx, env);
  if (paths === null) return skip("diff-hygiene", startedAt);
  const scale = diffScale(ctx, env);
  const intruders = paths.filter((path) => INTRUDER_RE.test(path));
  if (!intruders.length) return pass("diff-hygiene", startedAt, scale);
  return fail("diff-hygiene", startedAt, [...scale, "paths the brief did not ask for", ...intruders].slice(0, SNIPPET_LINES));
}

// Files the working tree changed, the list the `touched` scope narrows the checks it can honestly narrow to.
function touchedFiles(ctx, env) {
  const diff = spawnCheck(ctx, "git", ["diff", "--name-only"], env);
  const paths = [...(changedPaths(ctx, env) ?? []), ...diff.stdout.split("\n").map((line) => line.trim())];
  return [...new Set(paths.filter(Boolean))];
}

// Scope the caller asked for, refusing any value that is not one of the three the command defines.
function chosenScope(values) {
  const scope = values.scope ?? "full";
  if (!SCOPES.has(scope)) throw new UserError(`unknown scope \`${scope}\`; usage: ${USAGE}`);
  return scope;
}

// Result of every check of the block, in the fixed order; the PoC check only runs when the caller asked for it.
function runChecks(ctx, { checks, scope, files, env }) {
  return CHECK_ORDER.map((name) => {
    if (name === "diff-hygiene") return diffHygiene(ctx, env);
    const command = checks.get(name);
    if (!command || (name === "poc" && scope !== "+poc")) return skip(name, Date.now());
    return runCheck(ctx, name, command, env, scope === "touched" ? files : []);
  });
}

// Prints the block: one line per check, and under a failure the snippet that explains it.
function printBlock(ctx, results) {
  for (const result of results) {
    ctx.out(`${result.status} ${result.name} ${result.seconds}s`);
    for (const line of result.snippet) ctx.out(`  ${line}`);
  }
}

// Tells the caller what the run did with the arguments it could not honour, so a narrowing that never happened is never silently discarded.
function noteIgnoredFiles(ctx, scope, named) {
  if (scope === "touched" || !named.length) return;
  ctx.err(`nightqueue verify: \`--files\` is ignored under \`--scope ${scope}\`; only \`--scope touched\` narrows a check, and this run checked everything`);
}

// Tells the caller that the block reports nothing verified, which is not the same event as every check having passed.
function noteNothingDetected(ctx, results) {
  if (results.some((result) => result.name !== "diff-hygiene" && result.status !== "SKIPPED")) return;
  ctx.err(`nightqueue verify: no check was detected in ${ctx.cwd}; every line below is SKIPPED, which is "nothing was verified", not a clean pass`);
}

// Runs `nightqueue verify`: detects the project's own checks, runs them in the fixed order against a throwaway home, and exits 1 on any failure.
export function run(argv, ctx) {
  const options = { scope: { type: "string" }, files: { type: "string", multiple: true } };
  const { values, positionals } = parseCommand(argv, options);
  checkArgs(positionals, { max: 0, usage: USAGE });
  const scope = chosenScope(values);
  const checks = detectChecks(ctx.cwd, { warn: (message) => ctx.err(`nightqueue verify: ${message}`) });
  const home = makeThrowawayHome("nightqueue-verify-");
  try {
    const env = { ...ctx.env, ...home.env };
    const named = fileList(values);
    noteIgnoredFiles(ctx, scope, named);
    const files = scope === "touched" ? (named.length ? named : touchedFiles(ctx, env)) : named;
    const results = runChecks(ctx, { checks, scope, files, env });
    printBlock(ctx, results);
    noteNothingDetected(ctx, results);
    return results.some((result) => result.status === "FAILED") ? 1 : 0;
  } finally {
    home.remove();
  }
}
