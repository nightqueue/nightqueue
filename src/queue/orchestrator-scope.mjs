import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homeDir } from "../config/paths.mjs";
import { claudeConfigDir, claudePluginsDir, hostPackageRoot, packageRoot } from "../host/paths.mjs";

export const PLUGIN_DIR_ENV = "NIGHTQUEUE_PLUGIN_DIR";
const JOB_HOME_ENV = "NIGHTQUEUE_JOB_HOME";
const SPILL_DIR = "tool-results";

// Freezes one rule of a closed list, with its argv.
function freezeRule(rule) {
  return Object.freeze({ ...rule, argv: Object.freeze(rule.argv) });
}

// The closed list of commands the orchestrator of a queued job may run: one frozen row per allowed program and subcommand,
// the subcommand right after the bare program name (so a global flag such as `git -C`/`-c`/`--git-dir` never matches a row).
export const ORCHESTRATOR_BASH_RULES = Object.freeze(
  [
    { argv: ["git", "rev-parse"] },
    { argv: ["git", "worktree"] },
    { argv: ["git", "status"], anyOf: ["--short", "-s", "--porcelain"] },
    { argv: ["git", "add"] },
    { argv: ["git", "commit"], noneOf: ["--amend"] },
    {
      argv: ["git", "push"],
      noneOf: ["--force", "-f", "--force-with-lease", "--force-if-includes", "--delete", "-d", "--mirror", "--all", "--prune", "--receive-pack", "--exec"],
      noPrefix: ["+", ":"],
    },
    { argv: ["git", "fetch"], noneOf: ["--upload-pack"] },
    { argv: ["git", "branch"], anyOf: ["--show-current"] },
    { argv: ["git", "diff"], anyOf: ["--stat", "--shortstat", "--name-only", "--name-status"], noneOf: ["-p", "-u", "--patch"] },
    { argv: ["gh", "pr"], next: ["view", "list", "status", "checks", "create"] },
    { argv: ["nightqueue", "run"], next: ["check", "log", "index-save", "commit", "pr"] },
  ].map(freezeRule),
);

// A QA worktree of the operator: a relative path of one segment under `.claude/worktrees/operator-qa-`, so `..`, `~` and an absolute path never match.
const OPERATOR_QA_WORKTREE = /^\.claude\/worktrees\/operator-qa-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const COMMIT_ISH = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,199}$/;
const QA_WORKTREE_SHOWN = ".claude/worktrees/operator-qa-<slug>";

// The closed list of commands the operator of `nightqueue open` may run: read-only git, its own QA worktree, and nothing that commits, pushes or fetches.
export const OPERATOR_BASH_RULES = Object.freeze(
  [
    { argv: ["git", "rev-parse"] },
    { argv: ["git", "status"], anyOf: ["--short", "-s", "--porcelain"] },
    { argv: ["git", "branch"], anyOf: ["--show-current"] },
    { argv: ["git", "log"], exact: [/^--oneline$/, /^-n$/, /^[1-9]\d{0,3}$/], describe: "git log --oneline -n <N>" },
    {
      argv: ["git", "diff"],
      anyOf: ["--stat", "--shortstat", "--name-only", "--name-status"],
      noneOf: ["-p", "-u", "--patch", "--output", "--ext-diff", "--no-index"],
    },
    {
      argv: ["git", "worktree", "add"],
      flags: ["--detach", "-q", "--quiet"],
      positionals: [OPERATOR_QA_WORKTREE, COMMIT_ISH],
      minPositionals: 2,
      describe: `git worktree add ${QA_WORKTREE_SHOWN} <commit-ish>`,
    },
    {
      argv: ["git", "worktree", "remove"],
      flags: ["--force", "-f"],
      positionals: [OPERATOR_QA_WORKTREE],
      minPositionals: 1,
      describe: `git worktree remove [--force] ${QA_WORKTREE_SHOWN}`,
    },
    { argv: ["git", "worktree", "list"], flags: ["--porcelain", "-v", "--verbose"], positionals: [] },
    { argv: ["git", "worktree", "prune"], flags: ["-n", "--dry-run", "-v", "--verbose"], positionals: [] },
    { argv: ["gh", "pr"], next: ["view", "list", "status", "checks"] },
    { argv: ["gh", "issue"], next: ["list", "view"] },
    { argv: ["adb", "devices"], exact: [] },
    { argv: ["nightqueue", "run"], next: ["check", "log", "index-save"] },
  ].map(freezeRule),
);

const FORBIDDEN_SHELL_CHARS = /[\n\r;&|`<>$]/;
const GLOB_CHARS = /[*?[{]/;
const SHORT_FLAG_CLUSTER = /^-[A-Za-z]{2,}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

// Splits a command into whitespace-separated tokens, keeping a single- or double-quoted run inside one token.
function tokenize(command) {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) => token.replace(/"([^"]*)"|'([^']*)'/g, (_, double, single) => double ?? single ?? ""));
}

// Tells whether one argument is the flag itself, its `--flag=value` form, or a short-flag cluster (`-fu`) carrying it.
function isFlag(token, flag) {
  if (token === flag || token.startsWith(`${flag}=`)) return true;
  return flag.length === 2 && SHORT_FLAG_CLUSTER.test(token) && token.includes(flag[1]);
}

// Tells whether one argument is a denied flag, including the unambiguous abbreviation git accepts for a long one (`--mir`).
function isDeniedFlag(token, flag) {
  if (isFlag(token, flag)) return true;
  const name = token.split("=")[0];
  return flag.startsWith("--") && name.length > 2 && name.startsWith("--") && flag.startsWith(name);
}

// Tells whether the arguments are exactly as many as the patterns, each matching its own in order.
function matchesExactly(patterns, rest) {
  return rest.length === patterns.length && patterns.every((pattern, index) => pattern.test(rest[index]));
}

// Tells whether every flag among the arguments is one of the closed list.
function onlyListedFlags(flags, rest) {
  return rest.every((token) => !token.startsWith("-") || flags.includes(token));
}

// Tells whether the non-flag arguments are between the minimum and the pattern count, each matching the pattern of its position.
function positionalsMatch({ positionals, minPositionals = 0 }, rest) {
  const values = rest.filter((token) => !token.startsWith("-"));
  if (values.length < minPositionals || values.length > positionals.length) return false;
  return values.every((value, index) => positionals[index].test(value));
}

// Tells whether the arguments after the subcommand satisfy the constraints of one rule.
function ruleAccepts(rule, rest) {
  if (rule.anyOf && !rest.some((token) => rule.anyOf.some((flag) => isFlag(token, flag)))) return false;
  if (rule.noneOf && rest.some((token) => rule.noneOf.some((flag) => isDeniedFlag(token, flag)))) return false;
  if (rule.noPrefix && rest.some((token) => rule.noPrefix.some((prefix) => token.startsWith(prefix)))) return false;
  if (rule.next && !rule.next.includes(rest[0])) return false;
  if (rule.exact && !matchesExactly(rule.exact, rest)) return false;
  if (rule.flags && !onlyListedFlags(rule.flags, rest)) return false;
  if (rule.positionals && !positionalsMatch(rule, rest)) return false;
  return true;
}

// The row whose argv opens the command, the longest one when several do; null when none does.
function matchingRule(rules, tokens) {
  const matches = rules.filter(({ argv }) => argv.every((word, index) => tokens[index] === word));
  return matches.reduce((best, rule) => (best === null || rule.argv.length > best.argv.length ? rule : best), null);
}

// Tells whether a Bash command is one row of a closed list: no shell operator, the bare program name, the row's own constraints.
function bashAllowed(rules, command) {
  if (typeof command !== "string" || FORBIDDEN_SHELL_CHARS.test(command)) return false;
  const tokens = tokenize(command.trim());
  const rule = matchingRule(rules, tokens);
  return rule ? ruleAccepts(rule, tokens.slice(rule.argv.length)) : false;
}

// Tells whether a Bash command is one of the closed list the orchestrator of a queued job may run.
export function orchestratorBashAllowed(command) {
  return bashAllowed(ORCHESTRATOR_BASH_RULES, command);
}

// Tells whether a Bash command is one of the closed list the operator of `nightqueue open` may run.
export function operatorBashAllowed(command) {
  return bashAllowed(OPERATOR_BASH_RULES, command);
}

// Human rendering of one rule: the program and subcommand, what must follow, and what never may.
function describeRule({ argv, anyOf, noneOf, noPrefix, next, describe }) {
  if (describe) return describe;
  const allowed = next ?? anyOf;
  const never = [...(noneOf ?? []), ...(noPrefix ?? []).map((prefix) => `a ${prefix}refspec`)];
  const head = allowed ? `${argv.join(" ")} ${allowed.join("|")}` : argv.join(" ");
  return never.length ? `${head} (never ${never.join("/")})` : head;
}

// Human rendering of the closed list, one entry per rule, for a deny reason or a document.
export function describeOrchestratorBashRules() {
  return ORCHESTRATOR_BASH_RULES.map(describeRule).join(", ");
}

// Human rendering of the operator's closed list, one entry per rule, for a deny reason.
export function describeOperatorBashRules() {
  return OPERATOR_BASH_RULES.map(describeRule).join(", ");
}

// Real path of a path, or of its nearest existing ancestor with the missing rest appended, so a symlink never hides where a path really points.
function canonicalPath(path) {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  try {
    return join(realpathSync(existing), relative(existing, absolute));
  } catch {
    return absolute;
  }
}

// The home of the job the hook runs for: the one the runtime pinned on the child, else the configuration home.
function jobHome(env) {
  const pinned = typeof env?.[JOB_HOME_ENV] === "string" ? env[JOB_HOME_ENV].trim() : "";
  return pinned ? resolve(pinned) : homeDir(env);
}

// The directory where the host spills a large tool result of one session, next to its transcript; null without both.
export function sessionSpillRoot({ transcriptPath, sessionId } = {}) {
  if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) return null;
  if (typeof transcriptPath !== "string" || !isAbsolute(transcriptPath)) return null;
  return join(dirname(transcriptPath), sessionId, SPILL_DIR);
}

// The transcript the host wrote for one session under its projects directory; null when none is found.
export function sessionTranscriptPath(env, sessionId) {
  if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) return null;
  const projects = join(claudeConfigDir(env), "projects");
  try {
    const project = readdirSync(projects, { withFileTypes: true }).find(
      (entry) => entry.isDirectory() && existsSync(join(projects, entry.name, `${sessionId}.jsonl`)),
    );
    return project ? join(projects, project.name, `${sessionId}.jsonl`) : null;
  } catch {
    return null;
  }
}

// Directories the orchestrator of a queued job may read: the runs of its home, every copy of the plugin it may load the skill from, and the host's spill of a large tool result of its own sessions only.
export function orchestratorRoots(env = process.env, sessions = []) {
  const pluginEnv = typeof env?.[PLUGIN_DIR_ENV] === "string" ? env[PLUGIN_DIR_ENV].trim() : "";
  const candidates = [
    join(jobHome(env), "runs"),
    pluginEnv,
    join(packageRoot(), "plugin"),
    join(hostPackageRoot(env), "plugin"),
    claudePluginsDir(env),
    ...(Array.isArray(sessions) ? sessions : []).map(sessionSpillRoot),
  ];
  return [...new Set(candidates.filter(Boolean).map(canonicalPath))];
}

// Static directory prefix of an absolute glob pattern, up to the first segment carrying a glob character.
function globStaticPrefix(pattern) {
  const segments = pattern.split("/");
  const firstGlob = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  const kept = firstGlob === -1 ? segments : segments.slice(0, firstGlob);
  return kept.join("/") || "/";
}

// Resolves a path value of a tool call against the session cwd; null when it cannot be resolved.
function resolveAgainst(value, cwd) {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (isAbsolute(value)) return resolve(value);
  return typeof cwd === "string" && isAbsolute(cwd) ? resolve(cwd, value) : null;
}

// The Glob target: its path, else the static prefix of an absolute pattern, else the cwd; null for a pattern that climbs with `..`.
function globTarget(toolInput, cwd) {
  const pattern = typeof toolInput?.pattern === "string" ? toolInput.pattern : "";
  if (pattern.split(/[\\/]/).includes("..")) return null;
  if (typeof toolInput?.path === "string" && toolInput.path.trim() !== "") return resolveAgainst(toolInput.path, cwd);
  if (isAbsolute(pattern)) return globStaticPrefix(pattern);
  return resolveAgainst(cwd, cwd);
}

// The absolute path a Read, Grep or Glob call touches; null when the call names none that can be resolved.
export function readTarget(toolName, toolInput, cwd) {
  if (toolName === "Read") return resolveAgainst(toolInput?.file_path, cwd);
  if (toolName === "Grep") return resolveAgainst(toolInput?.path ?? cwd, cwd);
  if (toolName === "Glob") return globTarget(toolInput, cwd);
  return null;
}

// Tells whether a canonical path is the root or lies below it.
function underRoot(root, target) {
  if (typeof root !== "string" || root === "") return false;
  const rest = relative(root, target);
  return rest === "" || (!isAbsolute(rest) && rest.split(sep)[0] !== "..");
}

// Tells whether a path lies inside one of the roots once both are canonical; a null path is never inside.
export function insideRoots(path, roots) {
  if (typeof path !== "string" || !Array.isArray(roots)) return false;
  const target = canonicalPath(path);
  return roots.some((root) => underRoot(root, target));
}

// Tells whether a hook payload comes from the orchestrator's own main thread: only a subagent's call carries an agent_id.
export function isOrchestratorCall(input) {
  return !(typeof input?.agent_id === "string" && input.agent_id !== "");
}
