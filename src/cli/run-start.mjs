import { setTimeout as sleep } from "node:timers/promises";
import { UserError } from "../config/errors.mjs";
import { PIPELINE_TASK_TYPES, PIPELINE_TIERS } from "../memory/runs.mjs";
import { COMMIT_TYPES } from "../queue/branch-name.mjs";
import { isSafeSegment, isStateObject, readRunState } from "../queue/resume.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { phasesFor, routingRow, routingTable, tasksFor } from "../queue/routing.mjs";
import { recordPrTemplate, recordRunFields } from "../queue/run-state.mjs";
import { openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { findPrTemplate } from "./pr-template.mjs";
import { commitConvention } from "./run-publish.mjs";
import { resolveRun, RUN_OPTIONS, worktreeOf } from "./run-context.mjs";

export const START_USAGE =
  "nightqueue run start --tier <trivial|simple|complex> --type <bug/error|feature/refactor> --commit-type <type> [--expect-slug <slug>] [--project <name> --slug <slug>] | --routing";

// How long `run start` waits for the runner to bind a slug the orchestrator just declared, and how often it looks.
const SLUG_WAIT_MS = 10000;
const SLUG_POLL_MS = 250;

// The options `run start` reads, with the three the row of the run cannot be answered without.
function startOptions(argv) {
  const options = {
    tier: { type: "string" },
    type: { type: "string" },
    "commit-type": { type: "string" },
    "expect-slug": { type: "string" },
  };
  const { values, positionals } = parseCommand(argv, { ...RUN_OPTIONS, ...options });
  checkArgs(positionals, { max: 0, usage: START_USAGE });
  const commitType = (values["commit-type"] ?? "").trim();
  if (!COMMIT_TYPES.includes(commitType)) {
    throw new UserError(`unknown commit type \`${commitType}\`; accepted: ${COMMIT_TYPES.join(", ")}`);
  }
  const expected = (values["expect-slug"] ?? "").trim() || null;
  if (expected !== null && !isSafeSegment(expected)) {
    throw new UserError(`invalid \`--expect-slug\` \`${expected}\`: a run slug is one path segment of letters, digits and \`. _ + -\``);
  }
  const tier = (values.tier ?? "").trim();
  const type = (values.type ?? "").trim();
  phasesFor(tier, type);
  return { values, tier, type, commitType, expected };
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

// The tier and type the run goes on with: a recorded tier is never lowered and a recorded type wins over the requested one.
function effectiveClassification(state, { tier, type }) {
  const recordedTier = stateText(state, "tier");
  const recordedType = stateText(state, "type");
  const raised = PIPELINE_TIERS.indexOf(recordedTier) > PIPELINE_TIERS.indexOf(tier);
  return {
    tier: raised ? recordedTier : tier,
    type: PIPELINE_TASK_TYPES.includes(recordedType) ? recordedType : type,
  };
}

// Records the type and the tier of the run, the same write `run_set` makes; a refusal is reported, never fatal.
function recordTypeAndTier(run, { type, tier }, ctx) {
  const recorded = recordRunFields({ projectId: run.projectId, slug: run.slug, fields: { type, tier }, env: ctx.env });
  if (recorded.status !== "written") ctx.err(`nightqueue: the type and tier were not recorded on the run: ${recorded.reason}`);
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

// True when the call asks for the whole routing table, refusing `--routing` combined with anything else.
function wantsRoutingTable(argv) {
  if (!argv.includes("--routing")) return false;
  if (argv.length > 1) throw new UserError(`\`--routing\` takes no other option or argument; usage: ${START_USAGE}`);
  return true;
}

// Runs `run start`: answers, as one JSON line, everything Phase 0 used to derive by hand for THIS run; `--routing` prints the whole table instead.
export async function runStart(argv, ctx) {
  if (wantsRoutingTable(argv)) {
    ctx.out(routingTable());
    return 0;
  }
  const options = startOptions(argv);
  await awaitDeclaredSlug(options.expected, ctx);
  const run = await resolveRun(options.values, ctx);
  const prior = readRunState({ projectId: run.projectId, slug: run.slug, env: ctx.env });
  const { tier, type } = effectiveClassification(prior, options);
  recordTypeAndTier(run, { tier, type }, ctx);
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
    tier,
    type,
    commitType: options.commitType,
    routing: routingRow(tier),
    phases: phasesFor(tier, type),
    tasks: tasksFor(tier, type),
    prTemplate,
    commitConvention: commitConvention(cwd, ctx.env),
  };
  ctx.out(JSON.stringify(answer));
  return 0;
}
