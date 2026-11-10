import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { UserError } from "../config/errors.mjs";
import { homeDir, worktreesDir } from "../config/paths.mjs";
import { operatorPrompt, promptOperand } from "../host/operator.mjs";
import { worktreeEntry } from "../host/worktree-entry.mjs";
import { OPERATOR_NAMES, PLUGIN_AGENT_PREFIX, resolveAgent } from "../sessions/agents.mjs";
import { chatBin, launchChat } from "../sessions/launch.mjs";
import { createSession, readSession, refuseOpenSession, transcriptPath } from "../sessions/registry.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { openProject, run as runOpen } from "./open.mjs";

const USAGE = "nightqueue chat [agent] [--project <p>] [--worktree <path>] [--resume <id>] [--prompt <text>]";
const OPTIONS = { project: { type: "string" }, worktree: { type: "string" }, resume: { type: "string" }, prompt: { type: "string" } };
const GITDIR_LINE = /^gitdir:\s*(.+)$/m;

// Tells whether a path is an existing directory.
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Tells whether a real path is a directory or lies inside it.
function insideDir(dir, path) {
  const rest = relative(dir, path);
  return rest === "" || (!isAbsolute(rest) && rest.split(/[\\/]/)[0] !== "..");
}

// The real path of the nightqueue home, refused when it does not exist.
function realHome(env) {
  const home = homeDir(env);
  if (!existsSync(home)) throw new UserError(`no nightqueue home at ${home}; run \`nightqueue setup\``);
  return realpathSync(home);
}

// The git directory a worktree's `.git` file points to (a relative one resolved against the worktree), or null when `.git` is no file with a `gitdir:` line.
function pointedGitDir(dir) {
  try {
    const match = GITDIR_LINE.exec(readFileSync(join(dir, ".git"), "utf8"));
    return match ? resolve(dir, match[1].trim()) : null;
  } catch {
    return null;
  }
}

// Where a session runs from a real directory: outside the home as is, inside a git worktree entry of the home with that entry, else null; a dangling worktree is refused.
function directoryPlacement(real, { env, home, label }) {
  if (!insideDir(home, real)) return { cwd: real, worktree: null };
  const entry = worktreeEntry(real, env);
  const gitDir = entry === null ? null : pointedGitDir(entry);
  if (gitDir === null) return null;
  if (!isDirectory(gitDir)) throw new UserError(`${label} is a git worktree whose git directory ${gitDir} no longer exists`);
  return { cwd: real, worktree: entry };
}

// Where a `--worktree` session runs: the directory given, outside the home or inside a git worktree entry of the home; anything else under the home is refused.
function worktreePlacement(value, { ctx, home }) {
  const path = resolve(ctx.cwd, value);
  if (!isDirectory(path)) throw new UserError(`\`--worktree ${value}\` is not an existing directory; usage: ${USAGE}`);
  const placement = directoryPlacement(realpathSync(path), { env: ctx.env, home, label: `--worktree ${value}` });
  if (placement === null) throw new UserError(`--worktree must be a git worktree under ${worktreesDir(ctx.env)} or a directory outside the nightqueue home`);
  return placement;
}

// Where a session with no project nor worktree runs: the current directory, judged by the `--worktree` rules; the rest of the home is refused.
function cwdPlacement(ctx, home) {
  if (!isDirectory(ctx.cwd)) throw new UserError(`the current directory ${ctx.cwd} does not exist`);
  const real = realpathSync(ctx.cwd);
  const placement = directoryPlacement(real, { env: ctx.env, home, label: `the current directory ${real}` });
  if (placement !== null) return placement;
  throw new UserError(`a chat does not run in the nightqueue home; pass --project, --worktree <git worktree under ${worktreesDir(ctx.env)}> or run it from another directory`);
}

// Where a fresh session runs: its worktree when given, else the project's checkout, else the current directory.
function freshPlacement({ values, project, ctx }) {
  const home = realHome(ctx.env);
  if (values.worktree !== undefined) return worktreePlacement(values.worktree, { ctx, home });
  if (!project?.path) return cwdPlacement(ctx, home);
  if (!isDirectory(project.path)) throw new UserError(`the checkout of project \`${project.name}\` (${project.path}) does not exist`);
  return { cwd: project.path, worktree: null };
}

// Starts a new chat session: resolves the agent and the directory, records the session, then launches it.
async function freshChat({ name, values, operand, ctx }) {
  const agent = resolveAgent(name, ctx.env);
  const project = await openProject(values.project, ctx);
  const placement = freshPlacement({ values, project, ctx });
  const bin = chatBin(ctx);
  const record = createSession({ agent: agent?.name ?? null, agentSource: agent?.kind ?? null, ...placement, project }, ctx.env);
  return launchChat({ record, agent, resume: false, operand, bin, ctx });
}

// Resumes a recorded chat session in its recorded directory, refusing one still open, moved away or never started.
function resumeChat({ id, name, values, operand, ctx }) {
  if (name !== undefined || values.project !== undefined || values.worktree !== undefined) {
    throw new UserError(`\`--resume\` reuses the agent, project and directory the session recorded; drop the agent, \`--project\` and \`--worktree\`; usage: ${USAGE}`);
  }
  const record = readSession(id, ctx.env);
  refuseOpenSession(record, { env: ctx.env, killImpl: ctx.killImpl, action: "resuming" });
  if (!isDirectory(record.cwd)) throw new UserError(`the directory of session \`${id}\` (${record.cwd}) no longer exists; start a new one with \`nightqueue chat\``);
  if (transcriptPath(record, ctx.env) === null) throw new UserError(`session \`${id}\` has no Claude transcript (it ended before its first message); start a new one with \`nightqueue chat\``);
  const agent = resolveAgent(record.agent, ctx.env);
  const bin = chatBin(ctx);
  return launchChat({ record, agent, resume: true, operand, bin, ctx });
}

// Routes `chat operator` to `open`, unchanged: the operator keeps its own launch and guard, and never enters the session registry.
function operatorChat(values, ctx) {
  if (values.worktree !== undefined) throw new UserError("`--worktree` does not apply to the operator, which runs in the nightqueue home");
  const argv = [
    ...(values.project !== undefined ? [values.project] : []),
    ...(values.resume !== undefined ? [`--resume=${values.resume}`] : []),
    ...(values.prompt !== undefined ? [`--prompt=${values.prompt}`] : []),
  ];
  return runOpen(argv, ctx);
}

// Runs `nightqueue chat`: an interactive claude with an optional agent as the main thread, recorded so it can be listed and resumed.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, OPTIONS);
  checkArgs(positionals, { max: 1, usage: USAGE });
  const name = positionals[0];
  if (resolvesToOperator(name)) return operatorChat(values, ctx);
  const prompt = operatorPrompt(values.prompt, USAGE);
  const operand = prompt === null ? null : promptOperand(prompt);
  if (values.resume !== undefined) return resumeChat({ id: values.resume, name, values, operand, ctx });
  return freshChat({ name, values, operand, ctx });
}

// Tells whether the agent named is the operator, under any of its spellings.
function resolvesToOperator(name) {
  if (name === undefined) return false;
  const bare = name.startsWith(PLUGIN_AGENT_PREFIX) ? name.slice(PLUGIN_AGENT_PREFIX.length) : name;
  return OPERATOR_NAMES.includes(bare);
}
