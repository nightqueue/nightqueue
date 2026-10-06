import { UserError } from "../config/errors.mjs";
import { childExitCode } from "../host/child-exit.mjs";
import { createQaWorktree, dropQaWorktree, qaWorktreeTarget, refuseForeignOwner } from "../queue/qa-worktree.mjs";
import { refuseHomeWriteInsideJob } from "../queue/home-guard.mjs";
import { openRegistryReader } from "../store/open.mjs";
import { makeThrowawayHome } from "./throwaway-home.mjs";

const USAGE = "nightqueue sandbox <command> [args...]";
const WORKTREE_USAGE = "nightqueue sandbox worktree <project> | --drop <path>";

// Runs one command, verbatim, against a throwaway NIGHTQUEUE_HOME and CLAUDE_CONFIG_DIR, forwarding stdio and the exit code unchanged; `worktree` manages the qa worktrees instead.
export function run(argv, ctx) {
  if (!argv.length) throw new UserError(`missing argument; usage: ${USAGE}`);
  const [command, ...args] = argv;
  if (command === "worktree") return runWorktree(args, ctx);
  const home = makeThrowawayHome("nightqueue-sandbox-");
  try {
    const result = ctx.spawnSyncImpl(command, args, { stdio: "inherit", env: { ...ctx.env, ...home.env }, cwd: ctx.cwd });
    if (result.error) {
      ctx.err(`nightqueue sandbox: failed to run \`${command}\`: ${result.error.message}`);
      return 127;
    }
    return childExitCode(result);
  } finally {
    home.remove();
  }
}

// The registered project named (by name, else id), refused when unknown.
async function registeredProject(ref, env) {
  const store = await openRegistryReader(env);
  let project = null;
  try {
    project = store ? ((await store.projects.byName(ref)) ?? (await store.projects.byId(ref))) : null;
  } finally {
    await store?.close();
  }
  if (!project) throw new UserError(`unknown project \`${ref}\`; run \`nightqueue project list\` to see the registered ones`);
  return project;
}

// Creates a qa worktree of a project and prints its path on one line.
async function createWorktree(ref, ctx) {
  const project = await registeredProject(ref, ctx.env);
  const path = createQaWorktree({ project, env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
  ctx.out(`QA_WORKTREE: ${path}`);
  return 0;
}

// Drops a qa worktree, resolving its project from the path, refused when another live session holds it; prints whether it was dropped or already gone.
async function dropWorktree(path, ctx) {
  const target = qaWorktreeTarget(path, ctx.env);
  if (!target) throw new UserError(`refused: ${path} is not a qa worktree of this home; usage: ${WORKTREE_USAGE}`);
  const project = await registeredProject(target.projectId, ctx.env);
  refuseForeignOwner({ path: target.path, checkout: project.path, env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
  const dropped = dropQaWorktree({ path: target.path, checkout: project.path, env: ctx.env, spawnSyncImpl: ctx.spawnSyncImpl });
  ctx.out(`${dropped.dropped ? "dropped" : "gone"} ${path}`);
  return 0;
}

// Runs `nightqueue sandbox worktree`: creates a detached qa worktree of a project, or drops one with `--drop`.
async function runWorktree(args, ctx) {
  refuseHomeWriteInsideJob(ctx.env);
  if (args.length === 2 && args[0] === "--drop") return await dropWorktree(args[1], ctx);
  if (args.length === 1 && !args[0].startsWith("-")) return await createWorktree(args[0], ctx);
  throw new UserError(`usage: ${WORKTREE_USAGE}`);
}
