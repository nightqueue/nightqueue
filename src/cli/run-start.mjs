import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { UserError } from "../config/errors.mjs";
import { packageRoot } from "../host/paths.mjs";
import { PIPELINE_TASK_TYPES } from "../memory/runs.mjs";
import { COMMIT_TYPES } from "../queue/branch-name.mjs";
import { jobPromptText } from "../queue/job-prompt.mjs";
import { DEFAULT_PIPELINE, installedPipelineVersion, pipelineVersionBlock } from "../queue/pipeline-version.mjs";
import { isSafeSegment, isStateObject, readRunState } from "../queue/resume.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { agentModels, modelTable, phasesFor } from "../queue/routing.mjs";
import { isProvisionalSlug } from "../queue/run-slug.mjs";
import { recordPipeline, recordPipelineUnpinned, recordPrTemplate, recordRunFields } from "../queue/run-state.mjs";
import { briefStageLines } from "../queue/triage-brief.mjs";
import { openStore } from "../store/open.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { findCommitTemplate } from "./commit-template.mjs";
import { findPrTemplate } from "./pr-template.mjs";
import { baseRef, commitConvention } from "./run-publish.mjs";
import { resolveRun, RUN_OPTIONS, worktreeOf } from "./run-context.mjs";

export const START_USAGE =
  "nightqueue run start [--type <bug/error|feature/refactor>] [--commit-type <type>] [--expect-slug <slug>] [--project <name> --slug <slug>] | --routing";

const PROMPT_FILE = "00-prompt.md";
const DELIVERY_DRAFTS = ["commit-message.txt", "pr-body.md"];
const PHASES_BEFORE_DELIVERY = ["verification", "runtime"];
const NO_DEMO_REPO = "none configured";
const BRIEF_FILE = "00-brief.md";

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

// Says on stderr why the run has no pipeline version and marks the state with it, so the run's notice says so too; never fatal.
function noteUnpinned(run, reason, ctx) {
  ctx.err(`nightqueue: the pipeline version was not recorded on the run: ${reason}`);
  const noted = recordPipelineUnpinned({ projectId: run.projectId, slug: run.slug, reason, env: ctx.env });
  if (noted.status === "kept") ctx.err(`nightqueue: the run's notice will not say it has no pipeline version: ${noted.reason}`);
}

// Records the pipeline version the run starts under; an unknown version or a refused write leaves the run unpinned and says so, never fatal.
function recordStartPipeline(run, ctx) {
  const version = installedPipelineVersion(ctx.env);
  if (version === null) {
    noteUnpinned(run, "the plugin manifest could not be read", ctx);
    return;
  }
  const recorded = recordPipeline({ projectId: run.projectId, slug: run.slug, pipeline: { name: DEFAULT_PIPELINE, version }, env: ctx.env });
  if (recorded.status === "kept") noteUnpinned(run, recorded.reason, ctx);
}

// Finds and records the pull request template in effect, the one Phase 8 writes the body for.
function recordTemplate(run, cwd, ctx) {
  const template = findPrTemplate(cwd);
  const recorded = recordPrTemplate({ projectId: run.projectId, slug: run.slug, template, env: ctx.env });
  if (recorded.status !== "written") ctx.err(`nightqueue: the pull request template was not recorded on the run: ${recorded.reason}`);
  return { source: template.source, label: template.source === "repo" ? template.label : "nightqueue (fallback)", headings: template.headings };
}

// Writes the job's own prompt and current operator note to `00-prompt.md`, the text the architect quotes; answers its path, or null outside a job or on any failure, which never fails the start.
async function writePromptFile(run, ctx) {
  const text = await jobPromptText(run, ctx.env);
  if (text === null) return null;
  const path = join(run.runDir, PROMPT_FILE);
  try {
    mkdirSync(run.runDir, { recursive: true });
    writeFileSync(path, `${text}\n`);
    return path;
  } catch (error) {
    ctx.err(`nightqueue: ${PROMPT_FILE} was not written: ${error?.message ?? String(error)}`);
    return null;
  }
}

// Deletes the delivery drafts of a previous attempt, which this session must write anew without reading them; a failure is reported, never fatal.
function removeDeliveryDrafts(run, ctx) {
  for (const file of DELIVERY_DRAFTS) {
    try {
      rmSync(join(run.runDir, file), { force: true });
    } catch (error) {
      ctx.err(`nightqueue: the stale ${file} was not removed: ${error?.message ?? String(error)}`);
    }
  }
}

// Whether the run recorded a phase Phase 8 follows, the only way a draft of its own can exist.
function reachedDelivery(state) {
  return isStateObject(state) && Array.isArray(state.phases) && state.phases.some((entry) => PHASES_BEFORE_DELIVERY.includes(entry?.phase));
}

// The drafts an earlier Phase 8 of this run left, kept for the resumed session; with no such phase recorded they are a previous attempt's and go.
function settleDeliveryDrafts(run, state, ctx) {
  if (reachedDelivery(state)) return DELIVERY_DRAFTS.filter((file) => existsSync(join(run.runDir, file)));
  removeDeliveryDrafts(run, ctx);
  return [];
}

// Whether the triager must name the run: true while the slug is the provisional one the runtime derived for this job; false outside a job or when the row cannot be read.
async function needsSlugOf(run, ctx) {
  const own = callerJobId(ctx.env);
  if (own === null) return false;
  try {
    return isProvisionalSlug(await openStore(ctx.env).jobs.getJob(own), run.slug);
  } catch (error) {
    ctx.err(`nightqueue: this job's row could not be read, answering needsSlug false: ${error?.message ?? String(error)}`);
    return false;
  }
}

// The demo repository of the run's project as a request shows it: its path, or `none configured`.
async function demoRepoOf(run, ctx) {
  if (!run.projectId) return NO_DEMO_REPO;
  try {
    return (await openStore(ctx.env).projects.demoRepo(run.projectId)) || NO_DEMO_REPO;
  } catch (error) {
    ctx.err(`nightqueue: the project's demo repository could not be read: ${error?.message ?? String(error)}`);
    return NO_DEMO_REPO;
  }
}

// The base branch the QA triage compares the diff with: `HEAD`, said on stderr, when none can be found.
function baseRefOf(cwd, ctx) {
  try {
    return baseRef(cwd, ctx.env);
  } catch (error) {
    ctx.err(`nightqueue: answering \`HEAD\` as the base branch: ${error?.message ?? String(error)}`);
    return "HEAD";
  }
}

// The numbered stages of the run's Brief, what a resumed orchestrator launches its coders by; none before the triage wrote the Brief.
function briefStages(run, ctx) {
  let text;
  try {
    text = readFileSync(join(run.runDir, BRIEF_FILE), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") ctx.err(`nightqueue: the stages of the Brief could not be read: ${error?.message ?? String(error)}`);
    return [];
  }
  return briefStageLines(text);
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
  const versionBlock = pipelineVersionBlock(prior, ctx.env);
  if (versionBlock !== null) throw new UserError(versionBlock.message);
  const type = effectiveType(prior, options.type);
  recordType(run, type, ctx);
  recordStartPipeline(run, ctx);
  const cwd = worktreeOf(run, ctx.env);
  const prTemplate = recordTemplate(run, cwd, ctx);
  const promptFile = await writePromptFile(run, ctx);
  const state = readRunState({ projectId: run.projectId, slug: run.slug, env: ctx.env });
  const drafts = settleDeliveryDrafts(run, state, ctx);
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
    prTemplate,
    commitConvention: commitConvention(cwd, ctx.env),
    commitTemplate: findCommitTemplate(cwd, ctx.env),
    promptFile,
    needsSlug: await needsSlugOf(run, ctx),
    demoRepo: await demoRepoOf(run, ctx),
    baseRef: baseRefOf(cwd, ctx),
    pluginRoot: join(packageRoot(), "plugin"),
    stages: briefStages(run, ctx),
    drafts,
  };
  ctx.out(JSON.stringify(answer));
  return 0;
}
