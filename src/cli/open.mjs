import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { UserError } from "../config/errors.mjs";
import { homeDir } from "../config/paths.mjs";
import { normalizePath } from "../config/projects.mjs";
import { launchOperator, operatorPrompt } from "../host/operator.mjs";
import { sessionTranscriptPath } from "../queue/orchestrator-scope.mjs";
import { isSessionIdSafe } from "../queue/stream.mjs";
import { openRegistryReader } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const USAGE = "nightqueue open [project] [--resume <session>] [--prompt <text>]";
const OPTIONS = { resume: { type: "string" }, prompt: { type: "string" } };
const TRANSCRIPT_HEAD_BYTES = 1024 * 1024;

// The project the session preselects: the one named (by name, else id), else the one registered for the current directory, else none.
async function openProject(name, ctx) {
  const store = await openRegistryReader(ctx.env);
  if (name !== undefined) {
    const named = store ? ((await store.projects.byName(name)) ?? (await store.projects.byId(name))) : null;
    if (!named) throw new UserError(`unknown project \`${name}\`; run \`nightqueue project list\` to see the registered ones`);
    return named;
  }
  return store ? ((await store.projects.at(normalizePath(ctx.cwd))) ?? null) : null;
}

// Tells whether a directory is the checkout itself or lies inside it (a worktree of it included).
function insideCheckout(checkout, dir) {
  const rest = relative(checkout, dir);
  return rest === "" || (!isAbsolute(rest) && rest.split(/[\\/]/)[0] !== "..");
}

// The first bytes of a file as text, or an empty string when it cannot be read.
function fileHead(path) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const read = readSync(fd, buffer, 0, TRANSCRIPT_HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// The cwd of one transcript line, or null when the line is not JSON or carries none.
function lineCwd(line) {
  try {
    const cwd = JSON.parse(line)?.cwd;
    return typeof cwd === "string" && cwd ? cwd : null;
  } catch {
    return null;
  }
}

// The directory a session was born in, read from its transcript; null when it cannot be read or no longer exists.
function transcriptCwd(env, sessionId) {
  const path = sessionTranscriptPath(env, sessionId);
  if (!path) return null;
  for (const line of fileHead(path).split("\n")) {
    const cwd = lineCwd(line);
    if (cwd) return existsSync(cwd) ? cwd : null;
  }
  return null;
}

// The directory a resumed session runs in (a session is found only where it was born): its transcript's, else the current one inside the preselected checkout, else the home.
function resumeCwd({ resumeSession, project, ctx, home }) {
  const recorded = transcriptCwd(ctx.env, resumeSession);
  if (recorded) return recorded;
  const current = normalizePath(ctx.cwd);
  const checkout = project?.path ? normalizePath(project.path) : null;
  return checkout && insideCheckout(checkout, current) ? current : home;
}

// The nightqueue home the session runs in, refused when it does not exist.
function sessionHome(env) {
  const home = homeDir(env);
  if (!existsSync(home)) throw new UserError(`no nightqueue home at ${home}; run \`nightqueue setup\``);
  return home;
}

// Runs `nightqueue open`: the operator as the main thread of an interactive `claude` in the nightqueue home, a project only preselected.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, OPTIONS);
  checkArgs(positionals, { max: 1, usage: USAGE });
  const resumeSession = values.resume ?? null;
  if (resumeSession !== null && !isSessionIdSafe(resumeSession)) {
    throw new UserError(`\`--resume ${resumeSession}\` is not a session id; usage: ${USAGE}`);
  }
  const prompt = operatorPrompt(values.prompt, USAGE);
  const home = sessionHome(ctx.env);
  const project = await openProject(positionals[0], ctx);
  const cwd = resumeSession === null ? home : resumeCwd({ resumeSession, project, ctx, home });
  return await launchOperator({ cwd, resumeSession, prompt, project, ctx });
}
