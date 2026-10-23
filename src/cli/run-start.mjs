import { setTimeout as sleep } from "node:timers/promises";
import { UserError } from "../config/errors.mjs";
import { PIPELINE_TASK_TYPES } from "../memory/runs.mjs";
import { COMMIT_TYPES } from "../queue/branch-name.mjs";
import { isSafeSegment, isStateObject, readRunState } from "../queue/resume.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { agentModels, modelTable, phasesFor } from "../queue/routing.mjs";
import { recordPrTemplate, recordRunFields } from "../queue/run-state.mjs";
import { openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { findCommitTemplate } from "./commit-template.mjs";
import { findPrTemplate } from "./pr-template.mjs";
import { commitConvention } from "./run-publish.mjs";
import { resolveRun, RUN_OPTIONS, worktreeOf } from "./run-context.mjs";

export const START_USAGE =
  "nightqueue run start [--type <bug/error|feature/refactor>] [--commit-type <type>] [--expect-slug <slug>] [--project <name> --slug <slug>] | --routing";

const TIER_REMOVED = "`--tier` was removed: every run executes the one pipeline; run `nightqueue run start` without it";

// How long `run start` waits for the runner to bind a slug the orchestrator just declared, and how often it looks.
const SLUG_WAIT_MS = 10000;
const SLUG_POLL_MS = 250;

// The options `run start` reads: the type and the commit type are validated only when given, and a `--tier` is refused.
function startOptions(argv) {
  const options = {
    tier: { type: "string" },
    type: { type: "string" },
    "commit-type": { type: "string" },
    "expect-slug": { type: "string" },
  };
  const { values, positionals } = parseCommand(argv, { ...RUN_OPTIONS, ...options });
  if (values.tier !== undefined) throw new UserError(TIER_REMOVED);
  checkArgs(positionals, { max: 0, usage: START_USAGE });
  const commitType = optionalText(values["commit-type"]);
  if (commitType !== null && !COMMIT_TYPES.includes(commitType)) {
    throw new UserError(`unknown commit type \`${commitType}\`; accepted: ${COMMIT_TYPES.join(", ")}`);
  }
  const expected = optionalText(values["expect-slug"]);
  if (expected !== null && !isSafeSegment(expected)) {
    throw new UserError(`invalid \`--expect-slug\` \`${expected}\`: a run slug is one path segment of letters, digits and \`. _ + -\``);
  }
  const type = optionalText(values.type);
  phasesFor(type);
  return { values, type, commitType, expected };
}

// The agent models of the run's project, its overrides applied; a store failure answers the defaults and says so on stderr.
async function runModels(run, ctx) {
  try {
    return agentModels(run.projectId ? await openStore(ctx.env).projects.agents(run.projectId) : null);
  } catch (error) {
    ctx.err(`nightqueue: the project's agent models could not be read, answering the defaults: ${error?.message ?? String(error)}`);
    return agentModels(null);
  }
}

// The trimmed value of an optional flag, or null when it was not given or is blank.
function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Waits, inside a job, for the runner to bind the slug the orchestrator just declared; it never renames anything itself.
async function awaitDeclaredSlug(expected, ctx) {
  const own = callerJobId(ctx.env);
  if (own === null || expected === null) return;
  const deadline = Date.now() + (ctx.slugWaitMs ?? SLUG_WAIT_MS);
  while (Date.now() < deadline) {
    const row = await openStore(ctx.env).jobs.getJob(own);
    if (row?.slug === expected) return;
    await sleep(ctx.slugPollMs ?? SLUG_POLL_MS);
  }
}

// The type the run goes on with: a recorded type wins over the requested one, and no type yet is null.
function effectiveType(state, type) {
  const recordedType = stateText(state, "type");
  return PIPELINE_TASK_TYPES.includes(recordedType) ? recordedType : type;
}

// Records the type of the run when one is known, the same write `run_set` makes; a refusal is reported, never fatal.
function recordType(run, type, ctx) {
  if (type === null) return;
  const recorded = recordRunFields({ projectId: run.projectId, slug: run.slug, fields: { type }, env: ctx.env });
  if (recorded.status !== "written") ctx.err(`nightqueue: the type was not recorded on the run: ${recorded.reason}`);
}

// Finds and records the pull request template in effect, the one Phase 7 writes the body for.
function recordTemplate(run, cwd, ctx) {
  const template = findPrTemplate(cwd);
  const recorded = recordPrTemplate({ projectId: run.projectId, slug: run.slug, template, env: ctx.env });
  if (recorded.status !== "written") ctx.err(`nightqueue: the pull request template was not recorded on the run: ${recorded.reason}`);
  return { source: template.source, label: template.source === "repo" ? template.label : "nightqueue (fallback)", headings: template.headings };
}

// A text field of state.json, or null when the run never recorded it.
function stateText(state, field) {
  return isStateObject(state) && typeof state[field] === "string" && state[field].trim() ? state[field].trim() : null;
}

// True when the call asks for the agent model table, refusing `--routing` combined with anything else.
function wantsRoutingTable(argv) {
  if (!argv.includes("--routing")) return false;
  if (argv.length > 1) throw new UserError(`\`--routing\` takes no other option or argument; usage: ${START_USAGE}`);
  return true;
}

// Runs `run start`: answers, as one JSON line, everything Phase 0 used to derive by hand for THIS run; `--routing` prints the default agent model table instead.
export async function runStart(argv, ctx) {
  if (wantsRoutingTable(argv)) {
    ctx.out(modelTable());
    return 0;
  }
  const options = startOptions(argv);
  await awaitDeclaredSlug(options.expected, ctx);
  const run = await resolveRun(options.values, ctx);
  const prior = readRunState({ projectId: run.projectId, slug: run.slug, env: ctx.env });
  const type = effectiveType(prior, options.type);
  recordType(run, type, ctx);
  const cwd = worktreeOf(run, ctx.env);
  const prTemplate = recordTemplate(run, cwd, ctx);
  const state = readRunState({ projectId: run.projectId, slug: run.slug, env: ctx.env });
  const answer = {
    project: run.project,
    slug: run.slug,
    slugDeclared: options.expected,
    slugBound: options.expected === null ? null : options.expected === run.slug,
    runDir: run.runDir,
    worktree: stateText(state, "worktree"),
    branch: stateText(state, "branch"),
    type,
    commitType: options.commitType ?? stateText(state, "commitType"),
    models: await runModels(run, ctx),
    phases: phasesFor(type),
    tasks: phasesFor(type),
    prTemplate,
    commitConvention: commitConvention(cwd, ctx.env),
    commitTemplate: findCommitTemplate(cwd, ctx.env),
  };
  ctx.out(JSON.stringify(answer));
  return 0;
}
