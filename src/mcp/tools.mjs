import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { saveProject } from "../cli/project.mjs";
import { StoreUnavailableError, storeWarningLine, UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { requireOrg } from "../config/orgs.mjs";
import { registrationOffer, requireProject, resolveProjectRef, roadmapQueueTarget } from "../config/projects.mjs";
import { loadConfig, saveConfig } from "../config/store.mjs";
import { DECISION_STATUSES, decisionFullView, decisionView } from "../memory/decisions.mjs";
import {
  SCOPE_CONFLICT,
  SCOPE_MISSING,
  orgTargetOf,
  ownerDescription,
  ownerNames,
  ownerRef,
  projectTargetOf,
  rowOwner,
} from "../memory/scope.mjs";
import {
  MAX_ATTEMPTS_RANGE,
  PRIORITY_RANGE,
  TIMEOUT_RANGE,
} from "../memory/jobs.mjs";
import { LESSON_TARGETS, lessonView } from "../memory/lessons.mjs";
import { memoryView } from "../memory/memory.mjs";
import { itemRef, jobRef, parseJobRef, requireKey } from "../memory/refs.mjs";
import { ROADMAP_SEARCH_LIMIT } from "../memory/roadmap-search.mjs";
import {
  PROMPT_SOURCE_CONFLICT,
  PROMPT_SOURCE_MISSING,
  MANUAL_STATUSES,
  ROADMAP_STATUSES,
  ROADMAP_TYPES,
  roadmapItemView,
} from "../memory/roadmap.mjs";
import { OPERATOR_AUTHOR, TIER_BY_TYPE, jobAuthor } from "../memory/roadmap-workflow.mjs";
import { startAdvisoryLines } from "../queue/advisory.mjs";
import { noRunnerWait, parkedBacklogLine, pausedRunnerLine, pendingJobs, runnersOnline, staleRuntimeHint, windowWaitingLine } from "../queue/hints.mjs";
import { refuseHomeWriteInsideJob } from "../queue/home-guard.mjs";
import { blockerLines } from "../queue/claim.mjs";
import { lastMaintenance } from "../queue/maintenance.mjs";
import { jobIdOfPrUrl } from "../queue/pr-lookup.mjs";
import { createPrStateCache } from "../queue/pr-state.mjs";
import { liveRunnersReport, STOPPED_RUNNER, unreadableRegistry } from "../queue/registry.mjs";
import { failedCoreSection, jobDetailView, prUrlsOf, queueView } from "../queue/view.mjs";
import { isSafeSegment, readRunState, RESUME_PHASE_ORDER } from "../queue/resume.mjs";
import { resolveJobRun } from "../queue/job-run.mjs";
import { appendPendingWrite, PENDING_KEYS } from "../queue/pending-writes.mjs";
import { applyRetry, callerJobId } from "../queue/retry.mjs";
import { priorRunBlock, resolveOperatorRunDir, withPriorRun } from "../queue/operator-run.mjs";
import { resolveJobSession } from "../queue/session.mjs";
import { startCloseDetached } from "../queue/close-start.mjs";
import { cancelJobAndWorktree, stopAndCancelJob } from "../queue/cancel.mjs";
import { stopReport, stopRunners } from "../queue/stop.mjs";
import { queueWorkers } from "../queue/close-view.mjs";
import {
  recordOutcome,
  recordPhaseDone,
  recordRunFields,
  recordTermination,
  RUN_OUTCOME_STATUSES,
} from "../queue/run-state.mjs";
import { startQueueRunner } from "../queue/start.mjs";
import {
  OPERATOR_PIPELINE_OUTCOMES,
  PIPELINE_GATE_STOPS,
  PIPELINE_OUTCOMES,
  PIPELINE_PHASE_STATUSES,
  PIPELINE_TASK_TYPES,
  PIPELINE_TIERS,
} from "../memory/runs.mjs";
import { ensureStoreExists, openStore, withReadOnlyStore } from "../store/open.mjs";
import { callerContext, PHASE_TARGETS, phaseContextBlock, recallFreshLessons } from "./phase-context.mjs";
import { phasePrompt, PROMPT_TARGETS } from "./phase-prompt.mjs";
import { readVersion } from "../cli/version.mjs";
import { newContractState, STALE_CONTRACT_ADVISORY, StaleContractError, TOOL_CONTRACT, upgradeOldShapes, withContract } from "./tool-contract.mjs";

const SERVER_NAME = "nightqueue";
const SERVER_INSTRUCTIONS = [
  `tool contract ${TOOL_CONTRACT}: every answer carries \`contract\`; a tool refused with "your client has the tool definitions of an older nightqueue" means this session cached old definitions - start a new session or restart the MCP client.`,
  "nightqueue is a backlog of unattended coding jobs, not a synchronous executor: `queue_add` records work, it never runs it.",
  "Never queue a job on your own initiative: present the brief first (title and detail, or the roadmap item it will be queued from) and call `queue_add` only after the person gives an explicit go.",
  "One job is one self-contained deliverable, and a large plan is ONE job with numbered stages written in the prompt, never several jobs that depend on each other.",
  "Operate nightqueue through these MCP tools only - never the CLI, the database file, the home directory or the project's files.",
  "Start a single job now, with `queue_run` and its `job_id`, only when the person asks for that one job now; the whole batch starts with `queue_run` without `job_id`.",
  "Every job ends as an open pull request (`done`) or stopped at a gate with its reason in `notice_md`.",
  "At a gate, read `notice_md` whole with `queue_status`, present it to the person, and answer with `queue_retry` only after the person answers; a done job is closed with `queue_close`.",
  "Call `queue_status` to see what is pending before suggesting a batch.",
  "decisions are the project's standing constraints - recall them before proposing architecture and save one when the user settles a design question",
  "the roadmap is where \"what next\" lives - read it before suggesting work, and queue from it with `roadmap_item_id` (the item's ref)",
  "a constraint the conversation states for two or more repos of the same org is saved ONCE with `org`, never once per repo: a project reads its own decisions and its org's",
].join("\n");
const RECALL_LIMIT = 8;
const INDEX_LIMIT = 40;
const JOB_LIST_LIMIT = { min: 1, max: 50, fallback: 10 };

// One cache of pull request states per server process, shared by every session and request it serves; it never touches the database.
const serverPrStates = createPrStateCache();

const target = z.enum(LESSON_TARGETS).nullable().optional();
const optionalText = z.string().nullable().optional();
const optionalId = z.number().int().min(1).nullable().optional();
const optionalNumbers = z.array(z.union([z.number().int().min(1), z.string()])).nullable().optional();
const jobRefInput = z.union([z.number().int().min(1), z.string()]);
const jobIdField = jobRefInput.describe("The job's ref (`J-77`) or its plain id.");
const itemRefInput = z.union([z.string(), z.number().int()]);
const decisionRefInput = z.union([z.string(), z.number().int()]);
const optionalDecisionStatus = z.enum(DECISION_STATUSES).nullable().optional();
const looseDecisionStatus = z.string().nullable().optional();
const optionalManualRoadmapStatus = z
  .enum(ROADMAP_STATUSES)
  .nullable()
  .optional()
  .describe(`Set by hand: ${MANUAL_STATUSES.join("|")}; \`in_progress\` is refused, only a job sets it.`);
const optionalRoadmapPriority = z.number().int().min(PRIORITY_RANGE.min).max(PRIORITY_RANGE.max).nullable().optional();
const retiredHorizon = z.unknown().optional().describe("Removed in schema v17 and refused by name: use `priority` and `position`.");
const roadmapType = z
  .enum(ROADMAP_TYPES)
  .describe(
    `What the item is; it sets the default tier of its job (${ROADMAP_TYPES.map((type) => `${type}→${TIER_BY_TYPE[type]}`).join(", ")}) and the commit type the job uses.`,
  );

const phaseSchema = z.object({
  phase: z.string(),
  model: z.string().nullable().optional(),
  status: z.enum(PIPELINE_PHASE_STATUSES).nullable().optional(),
  retry: z.boolean().nullable().optional(),
  duration_s: z.number().int().min(0).nullable().optional(),
  note: z.string().nullable().optional(),
});

// The registered project a lesson, memory, index or run call scopes to: a name, or an absolute path inside a checkout; null (global) for
// a path inside none, and an unknown name refused, so nothing is ever written under a project that does not exist.
async function memoryProject(ref, env) {
  return await resolveProjectRef(openStore(env), ref);
}

// Refuses to register a project from inside an unattended run: there is no user there to confirm it.
function refuseRegistrationInsideJob(cwd, env) {
  const own = callerJobId(env);
  if (own === null) return;
  throw new UserError(
    `refusing to register ${cwd} from inside job \`${own}\`: an unattended run never registers a project; ` +
      "ask the operator to run `nightqueue init` there",
  );
}

// Project of the run this process belongs to, as `{ id, name }`; null outside a job, and null too when the job id names no job.
async function callerProject(own, env) {
  const job = await openStore(env).jobs.getJob(own);
  return job?.project_id ? { id: job.project_id, name: job.project } : null;
}

// Refuses a row of ANOTHER owner from inside an unattended run: a job may only rewrite the decisions and the roadmap of its own project, never its org's.
async function requireOwnProject({ kind, id, row }, env) {
  const own = callerJobId(env);
  if (own === null) return;
  const mine = await callerProject(own, env);
  if (mine !== null && row?.scope !== "org" && mine.id === (row?.project_id ?? null)) return;
  throw new UserError(
    `refusing to update ${kind} \`${id}\` from inside job \`${own}\`: it belongs to ${ownerDescription(row)}, ` +
      `not \`${mine?.name ?? "unknown"}\`; an unattended run may only update its own project, ` +
      "so ask the operator to do it outside the queue",
  );
}

// Who is reading or writing the roadmap: the operator outside a job, or the job and the project (by id) it runs for, which bounds what it sees.
async function roadmapCaller(env) {
  const own = callerJobId(env);
  if (own === null) return { author: OPERATOR_AUTHOR, viewer: null, viewerName: null };
  const mine = await callerProject(own, env);
  if (mine === null) {
    throw new UserError(`job \`${own}\` is not in the queue, so its project is unknown; the roadmap cannot be read or commented from it`);
  }
  return { author: jobAuthor(own), viewer: mine.id, viewerName: mine.name };
}

// Refuses to write a run named from the outside while inside a job: the state.json of a run belongs to the job that owns it.
function refuseNamedRun(named, own) {
  const what = named.map(([name, value]) => `${name} \`${value}\``).join(" and ");
  throw new UserError(
    `refusing to act on ${what} from inside job \`${own}\`: the run of a job is resolved from its own row, ` +
      "so drop them and call again",
  );
}

// Refuses to guess a run directory: a job whose row carries no slug yet has nothing to write into.
function refuseMissingRunSlug(own) {
  throw new UserError(
    `job \`${own}\` has no run slug on its row yet: print \`SLUG: <slug>\` (\`QUEUE_SLUG: <slug>\` on an older plugin) ` +
      "once, so the runtime binds the run directory, then call this tool again",
  );
}

// The run of the job this process belongs to: its own row, or its job block on disk when the database is unavailable.
async function jobRun(own, args, env) {
  const named = [
    ["project", args.project],
    ["slug", args.slug],
  ].filter(([, value]) => typeof value === "string" && value.trim() !== "");
  if (named.length > 0) refuseNamedRun(named.map(([name, value]) => [name, value.trim()]), own);
  const run = await resolveJobRun(own, env);
  if (!isSafeSegment(run.slug)) refuseMissingRunSlug(own);
  return { project: run.project, projectId: run.projectId, slug: run.slug };
}

// The run an operator names from outside a job, where nothing else can tell which one it is.
async function operatorRun(args, env) {
  const project = typeof args.project === "string" ? args.project.trim() : "";
  const slug = typeof args.slug === "string" ? args.slug.trim() : "";
  if (!project || !slug) {
    throw new UserError(
      "outside a job, `project` (the registered NAME) and `slug` (the `<slug>` of runs/<project_id>/<slug>) are both required",
    );
  }
  if (!isSafeSegment(slug)) {
    throw new UserError(`invalid slug \`${slug}\`: a run slug is one path segment of letters, digits and \`. _ + -\``);
  }
  const registered = await requireProject(openStore(env), project);
  return { project: registered.name, projectId: registered.id, slug };
}

// The run every `run_*` tool writes into: the caller's own job run, or the one an operator named.
async function callerRun(args, env) {
  const own = callerJobId(env);
  return own === null ? await operatorRun(args, env) : await jobRun(own, args, env);
}

// The run a `pipeline_log` call records: inside a job the job's own row names it, whatever the call sent, and outside one only the call can say which run it is.
async function pipelineLogRun(args, env) {
  const own = callerJobId(env);
  const run = own === null ? null : await resolveJobRun(own, env);
  if (isSafeSegment(run?.slug)) return { project: run.project, projectId: run.projectId ?? null, slug: run.slug };
  const slug = typeof args.slug === "string" ? args.slug.trim() : "";
  if (!slug) {
    throw new UserError(
      "this run cannot be identified: send `project` (the registered NAME) and `slug` (the `<slug>` of runs/<project_id>/<slug>); " +
        "only a call from inside a job, whose row already carries them, may omit the pair",
    );
  }
  const project = await memoryProject(args.project, env);
  return { project: project?.name ?? args.project, projectId: project?.id ?? null, slug };
}

// What the RUN already recorded about itself, the source of every field a `pipeline_log` call may now omit.
function runFacts({ projectId, slug }, env) {
  const state = readRunState({ projectId, slug, env });
  return { tier: state?.tier ?? null, taskType: state?.type ?? null, tierRaiseReason: state?.tierRaiseReason ?? null };
}

// Queues a pipeline run the unavailable database refused into the run's pending-writes file, fully resolved, and answers ok with the warning;
// any other failure, or a run it cannot be queued into, is raised as it came.
function queuedPipelineLog(err, spec, env) {
  if (!(err instanceof StoreUnavailableError)) throw err;
  const at = new Date().toISOString();
  const payload = { ...spec, model: env?.NIGHTQUEUE_MODEL ?? null, sessionId: env?.NIGHTQUEUE_SESSION_ID ?? null };
  const entry = { key: PENDING_KEYS.pipelineLog(spec.projectId, spec.slug, at), kind: "pipeline_log", at, jobId: callerJobId(env), payload };
  const queued = appendPendingWrite({ projectId: spec.projectId, slug: spec.slug, entry, env });
  if (queued.status !== "queued") throw err;
  return { ok: true, queued: true, warning: `recorded in ${queued.path}; replayed once the database is back`, pending: queued.path };
}

// Requires a field neither the call nor the run resolved, saying which tool would have recorded it during the run.
function requireLogged(field, value) {
  if (value !== null && value !== undefined && value !== "") return value;
  throw new UserError(
    `\`${field}\` is required: send it, or record it during the run with \`run_set\` so this call can leave it out`,
  );
}

// Refuses an operator outcome sent from inside a job, whose run always ends on one of the pipeline's own.
function refuseOperatorOutcomeInsideJob(outcome, env) {
  if (callerJobId(env) === null || !OPERATOR_PIPELINE_OUTCOMES.includes(outcome)) return;
  throw new UserError(`outcome \`${outcome}\` is the operator's: a job records pr_opened, local_commit or no_commit`);
}

// The answer of a `run_*` tool; a refused write comes back as an error, because a silent `kept` would let the run believe it was recorded.
function runAnswer(result, { project, slug }) {
  if (result.status !== "written") {
    throw new UserError(`nothing was recorded in the state.json of \`${project}/${slug}\`: ${result.reason}`);
  }
  return { ok: true, project, slug, path: result.path };
}

// The fields of state.json `run_set` writes, in the argument names the plugin sends.
const RUN_SET_FIELDS = {
  type: "type",
  tier: "tier",
  tier_raise_reason: "tierRaiseReason",
  branch: "branch",
  worktree: "worktree",
  origin: "origin",
  plan_status: "planStatus",
};

// The fields `run_set` was asked to change, under the names state.json uses; an absent or empty one is not a change.
function runSetFields(args) {
  const asked = Object.entries(RUN_SET_FIELDS).filter(([arg]) => typeof args[arg] === "string" && args[arg].trim() !== "");
  const fields = Object.fromEntries(asked.map(([arg, field]) => [field, args[arg].trim()]));
  const withLevel = args.evidence_level === undefined || args.evidence_level === null ? fields : { ...fields, evidenceLevel: args.evidence_level };
  return args.qa_stage_a ? { ...withLevel, qaStageA: args.qa_stage_a } : withLevel;
}

// Requires the absolute working directory of the caller, because the directory of this server is never the user's.
function requireCwd(cwd) {
  const path = typeof cwd === "string" ? cwd.trim() : "";
  if (path === "" || !isAbsolute(path)) {
    throw new UserError(
      "pass the registered project NAME in `project`, or the absolute path of the working directory in `cwd`",
    );
  }
  return path;
}

// Answer of a decision save the gate held back: nothing was written, and every candidate must be named.
function needsReviewAnswer(candidates) {
  return {
    ok: false,
    status: "needs_review",
    candidates,
    hint: "nothing was saved: save again naming every candidate by its `number`, in `supersedes` (replaced whole) or in `unrelated` (left untouched)",
  };
}

// Answer of a saved decision, with the rows it superseded and the job that proposed it.
function savedDecisionAnswer(saved) {
  return {
    ok: true,
    id: saved.id,
    number: saved.number,
    ref: saved.ref,
    scope: saved.scope,
    owner: saved.org ?? saved.project,
    ...(saved.superseded.length ? { superseded: saved.superseded } : {}),
    ...(saved.jobId !== null ? { job_id: saved.jobId } : {}),
    ...(saved.statusDefaulted ? { status_defaulted: true } : {}),
  };
}

// Owner a decisions or roadmap tool names: `project` (the registered NAME) XOR `org`, refusing both and neither; resolved once to its ids.
async function ownerArgs(args, env) {
  const project = typeof args.project === "string" && args.project.trim() !== "" ? args.project.trim() : null;
  const org = typeof args.org === "string" && args.org.trim() !== "" ? args.org.trim() : null;
  if (project && org) throw new UserError(SCOPE_CONFLICT);
  const store = openStore(env);
  if (org) return orgTargetOf(await requireOrg(store, org));
  if (!project) throw new UserError(SCOPE_MISSING);
  return projectTargetOf(await requireProject(store, project));
}

// Tells whether an optional argument was sent: an explicit null is treated exactly like an absent one.
function sent(value) {
  return value !== undefined && value !== null;
}

// The project a bare `D-<n>` linked from an owner is read in: the project of a project owner, none for an org or the global owner.
function projectContext({ scope, projectId }) {
  return { projectId: scope === "project" ? (projectId ?? null) : null };
}

// Resolves an optional decision ref linked from an owner to the decision id, leaving an absent one absent.
async function linkedDecisionId(value, owner, env) {
  return sent(value) ? await openStore(env).decisions.decisionIdOfRef(value, projectContext(owner)) : value;
}

// The project a bare `D-<n>` of `decision_update` is read in: the `project` named, else the caller job's project, else none.
async function decisionUpdateContext(args, env) {
  const named = typeof args.project === "string" && args.project.trim() !== "" ? args.project.trim() : null;
  if (named) return { projectId: (await requireProject(openStore(env), named)).id };
  return { projectId: (await callerContext(env)).projectId };
}

// Project row the job goes to, or the offer to register the directory of the caller when nothing is registered for it.
async function resolveQueueTarget({ project, cwd }, env) {
  const store = openStore(env);
  if (typeof project === "string" && project.trim() !== "") return { project: await requireProject(store, project) };
  const path = requireCwd(cwd);
  const resolved = await store.projects.at(path);
  if (resolved) return { project: resolved };
  refuseRegistrationInsideJob(path, env);
  const offer = await registrationOffer(store, loadConfig(env, { warn: () => {} }), path);
  if (!offer) {
    throw new UserError(
      `no project registered for ${path}, and it is not inside a git repository; pass the registered project NAME (\`nightqueue project list\`)`,
    );
  }
  return { cwd: path, offer };
}

// The answer that asks the agent to confirm the registration with the user, without queueing anything.
function needsRegistration({ cwd, offer }) {
  return {
    needs_registration: true,
    cwd,
    suggested_name: offer.name,
    suggested_key: offer.key,
    org: offer.org,
    hint:
      `no project is registered for \`${cwd}\`; ask the user to confirm registering it as \`${offer.name}\` with key ` +
      `\`${offer.key}\` in org \`${offer.org}\` (the key prefixes its refs, e.g. \`${offer.key}-1\`; the user may type another), ` +
      "then call queue_add again with the same `cwd` and `register: true`, plus `key` when the user chose another key. Nothing was queued.",
  };
}

// Registers the repository the offer names under the key the user chose or the suggested one, taking the configuration lock this server never takes for itself.
async function registerOffer(offer, key, env) {
  const ctx = { env, out: () => {}, err: () => {}, saveConfig };
  const chosen = typeof key === "string" && key.trim() !== "" ? requireKey(key) : offer.key;
  const { project } = await withLock(env, () => saveProject(ctx, { path: offer.path, name: offer.name, key: chosen }));
  return project;
}

// Tells whether `queue_add` was asked to seed the job from an operator run.
function hasRunDir(args) {
  return typeof args.run_dir === "string" && args.run_dir.trim() !== "";
}

// The prompt and the run slug of a job queued from an operator run: the run is checked and its block is built by the runtime; `addJob` refuses a run already bound.
function operatorRunSeed({ args, project, env }) {
  const run = resolveOperatorRunDir({ runDir: args.run_dir, project: project.name, projectId: project.id, env });
  const block = priorRunBlock({ projectId: project.id, slug: run.slug, state: run.state, env });
  return { prompt: withPriorRun(args.prompt, block), slug: run.slug };
}

// Requires exactly one source for the prompt of a job: the text itself, or the roadmap item that builds it.
function wantsRoadmapItem(args) {
  const hasPrompt = typeof args.prompt === "string" && args.prompt.trim() !== "";
  const hasItem = args.roadmap_item_id !== undefined && args.roadmap_item_id !== null;
  if (hasPrompt && hasItem) throw new UserError(PROMPT_SOURCE_CONFLICT);
  if (!hasPrompt && !hasItem) throw new UserError(PROMPT_SOURCE_MISSING);
  return hasItem;
}

// The closing sentence of the `queue_add` hint: what happens to the job given who is online right now - and, when the
// live runner is waiting out a rate limit, that wait instead of a promise it will be picked up before the reset.
function queuedRunnerLine(env) {
  const report = liveRunnersReport(env);
  if (report.error !== null) return "Start the batch with queue_run when you are ready.";
  const runners = queueWorkers(report.runners);
  if (runners.length === 0) return `${noRunnerWait()}.`;
  const paused = pausedRunnerLine(runners);
  if (paused) return `${runnersOnline(runners.length)} - nothing to start: ${paused}; it claims again by itself when the limit resets.`;
  const waiting = windowWaitingLine(runners);
  if (waiting) return `${waiting}; it claims once the window opens.`;
  return `${runnersOnline(runners.length)} - it will be picked up.`;
}

// The answer of `queue_add`: the job it recorded, and the roadmap item behind it when there is one.
async function queuedAnswer({ job, registered = null, roadmapItem = null, note = "" }, env) {
  const pending = (await openStore(env).jobs.countsByStatus()).pending;
  const done = registered ? `registered project \`${registered.name}\` (${registered.path}). ` : "";
  const stale = staleRuntimeHint(env);
  return {
    ok: true,
    id: job.id,
    ref: jobRef(job.id),
    project: job.project,
    priority: job.priority,
    timeoutS: job.timeoutS,
    ...(roadmapItem === null ? {} : { roadmapItemId: roadmapItem.id, roadmap_ref: itemRef(roadmapItem) }),
    ...(job.tier ? { tier: job.tier } : {}),
    hint: `${done}queued ${jobRef(job.id)} for \`${job.project}\` (${pending} pending).${note} ${queuedRunnerLine(env)}${stale ? ` ${stale}` : ""}`,
  };
}

// What the answer of a roadmap-built job adds: an org item fathers one job per project, each on its own project row, and its status is derived from the rows.
function roadmapNote({ item, jobs, skipped }) {
  if (item.scope !== "org") return "";
  const queued = jobs.map((job) => `${jobRef(job.id)} for \`${job.project}\``).join(", ");
  const held = skipped.length ? ` Skipped, a live job already holds them: ${skipped.map((entry) => `\`${entry.project}\``).join(", ")}.` : "";
  return (
    ` Roadmap item ${itemRef(item)} of org \`${item.org}\` queued as ${queued}; each project row follows its job, and the item is ` +
    `\`in_progress\` while any row is, \`done\` once every row is done or cancelled, otherwise the lowest open row status.${held}`
  );
}

// The answer of `queue_add` for a roadmap-built job: the first job as before, plus every job and every skipped project of an org item.
async function roadmapQueuedAnswer(queued, env) {
  const answer = await queuedAnswer({ job: queued.job, roadmapItem: queued.item, note: roadmapNote(queued) }, env);
  if (queued.item.scope !== "org") return answer;
  return {
    ...answer,
    jobs: queued.jobs.map((job) => ({ id: job.id, ref: jobRef(job.id), project: job.project })),
    skipped: queued.skipped,
  };
}

// The one item `roadmap_get` reads by `id`, as the caller may see it; an owner beside the id is refused, because the id already names the item.
async function roadmapItemDetail(args, env) {
  const named = [args.project, args.org].some((value) => typeof value === "string" && value.trim() !== "");
  if (named) throw new UserError("pass `id` alone to read one roadmap item, or `project`/`org` without `id` to list a roadmap");
  const { viewer } = await roadmapCaller(env);
  const store = openStore(env);
  return await store.roadmap.getRoadmapItemDetail(await store.roadmap.itemIdOfRef(args.id), { viewer });
}

// The owner `roadmap_search` reads: the named one outside a job; inside a job always the job's own project, refusing any other owner.
async function roadmapSearchOwner(args, env) {
  const { viewer, viewerName } = await roadmapCaller(env);
  if (viewer === null) return ownerArgs(args, env);
  const named = [args.project, args.org].filter((value) => typeof value === "string" && value.trim() !== "");
  if (named.some((value) => value.trim() !== viewerName)) {
    throw new UserError(
      `inside a job \`roadmap_search\` reads the job's project \`${viewerName}\` (and its org's items): omit \`project\`/\`org\` or pass \`${viewerName}\``,
    );
  }
  const project = await openStore(env).projects.byId(viewer);
  if (!project) throw new UserError(`the project of this job is no longer registered; the roadmap cannot be searched from it`);
  return projectTargetOf(project);
}

// Clamps the size of a job listing into the accepted window.
function jobLimit(limit) {
  if (!Number.isInteger(limit)) return JOB_LIST_LIMIT.fallback;
  return Math.min(Math.max(limit, JOB_LIST_LIMIT.min), JOB_LIST_LIMIT.max);
}

// Wraps a tool result as the JSON text every tool of this server returns.
function asText(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// One line describing a zod field of an input schema, so a refused call learns the whole contract instead of one missing key.
function describeField(name, schema) {
  const optional = schema.isOptional?.() || schema.isNullable?.();
  let inner = schema;
  while (inner?.def?.innerType) inner = inner.def.innerType;
  const def = inner?.def ?? {};
  const kind = def.type === "enum" ? Object.values(def.entries ?? {}).join(" | ") : def.type === "array" ? "array" : def.type ?? "value";
  return `${name}${optional ? "?" : ""}: ${kind}`;
}

// The contract of a tool as one readable block: required fields first, then the optional ones.
function describeSchema(inputSchema) {
  const entries = Object.entries(inputSchema ?? {});
  const required = entries.filter(([, schema]) => !(schema.isOptional?.() || schema.isNullable?.()));
  const optional = entries.filter(([, schema]) => schema.isOptional?.() || schema.isNullable?.());
  return [
    `required: ${required.map(([name, schema]) => describeField(name, schema)).join(", ") || "none"}`,
    `optional: ${optional.map(([name, schema]) => describeField(name, schema)).join(", ") || "none"}`,
  ].join("\n");
}

// `lesson_save` alone: a missing/empty `title` answers a one-line error naming it, never the multi-line zod dump.
function lessonSaveTitleError(args) {
  const title = typeof args?.title === "string" ? args.title.trim() : "";
  if (title) return null;
  return 'lesson_save: missing required field(s): title. Minimal payload: {"title":"...","root_cause":"...","solution":"...","prevention":"..."}';
}

// Validates the arguments here instead of leaving it to the SDK, so the refusal names every issue, the whole contract and what was received - an agent fixes that on the next call instead of repeating the same payload.
function validateArgs(name, inputSchema, args) {
  if (name === "lesson_save") {
    const oneLine = lessonSaveTitleError(args);
    if (oneLine) throw new McpError(ErrorCode.InvalidParams, oneLine);
  }
  const parsed = z.object(inputSchema).safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
  const received = Object.keys(args ?? {}).join(", ") || "nothing";
  throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for tool ${name}: ${issues}\n${name} contract:\n${describeSchema(inputSchema)}\nreceived: ${received}`);
}

// The machine-readable error a tool answers when the home database cannot be used at all.
function storeUnavailableAnswer(err) {
  const payload = withContract({ ok: false, error: "store-unavailable", code: err.code, home: err.home, hint: err.hint });
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}

// Builds a phase's context block, degrading to an empty block plus one warning line when the home database is unavailable.
async function degradedPhaseContext(args, build) {
  try {
    return await build();
  } catch (err) {
    if (!(err instanceof StoreUnavailableError)) throw err;
    return { project: args.project ?? null, block: "", warning: storeWarningLine(err) };
  }
}

// Wraps a handler so a business failure comes back as a clear message instead of a raw exception.
function guard(name, handler, session) {
  return async (args) => {
    try {
      const upgraded = await upgradeOldShapes(name, args ?? {}, session);
      return asText(withContract(await handler(upgraded.args), upgraded.deprecated));
    } catch (err) {
      if (err instanceof StoreUnavailableError) return storeUnavailableAnswer(err);
      const message = err instanceof StaleContractError ? err.message : `${name}: ${err?.message ?? String(err)}`;
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
}

// The one-line nudge queue_status answers with, leading with the live-runner count; a rate limit is what the agent hears
// next - the one a live runner waits out, or the one a backlog was parked by after its runner exited - so it never starts
// a batch that would only sleep.
function queueHint({ activeJobs, counts, runners: registered, jobs = [] }) {
  const runners = queueWorkers(registered);
  const paused = pausedRunnerLine(runners);
  if (paused) {
    const backlog = counts.pending === 0 ? "nothing is pending" : `${pendingJobs(counts.pending)} waiting`;
    return `${runnersOnline(runners.length)} - ${backlog} — ${paused}.`;
  }
  if (runners.length > 0) return `${runnersOnline(runners.length)} - ${counts.pending} pending after this one`;
  if (activeJobs > 0) {
    return `${runnersOnline(0)} - a job is running under a one-shot runner, nothing will pick up the pending jobs after it - start a drain with \`nightqueue queue run\``;
  }
  const parked = parkedBacklogLine({ jobs, pending: counts.pending });
  if (parked) return `${runnersOnline(0)} - ${pendingJobs(counts.pending)} waiting — ${parked}.`;
  return noRunnerWait();
}

// What a tool that was asked to start a runner answers: the runner that started, or why the job it was asked for would claim nothing.
function runnerAnswer(started, env, advisories) {
  return {
    started: started.started,
    pid: started.pid,
    logPath: started.logPath,
    runner: { pid: started.pid, mode: started.mode, logPath: started.logPath },
    waiting: started.waiting ?? null,
    message: started.waiting ? blockerLines(started.waiting, env).join("; ") : null,
    advisories,
  };
}

// What a status answer says about a repair the database refused: the same line the CLI warns with, and nothing at all when every repair went through.
function warningAnswer(warning) {
  return warning ? { warning } : {};
}

// The answer of `queue_status` for one job: the job in full with the state of its pull request.
async function jobStatusAnswer(id, { store, warning }) {
  const job = await jobDetailView(store, id, { prStates: serverPrStates });
  if (!job) throw new UserError(`unknown job \`${id}\``);
  return { job, ...warningAnswer(warning) };
}

// The one job `queue_status` was asked about, by `job_id` (a ref or a plain id) or by `pr_url`, never both; neither asks for the queue.
function statusJobAsked(args) {
  const prUrl = sent(args.pr_url) ? String(args.pr_url).trim() : undefined;
  if (prUrl === "") throw new UserError("`pr_url` is blank: pass the URL of the pull request, or leave `pr_url` out for the queue");
  if (sent(args.job_id) && prUrl !== undefined) throw new UserError("pass either `job_id` or `pr_url`, never both: each names one job");
  if (sent(args.job_id)) return { jobId: parseJobRef(args.job_id) };
  return { prUrl };
}

// The answer of `queue_status` for the tail of the queue, mapped from the one queue view every surface renders.
async function queueStatusAnswer(args, { store, warning, env, state }) {
  const asked = statusJobAsked(args);
  if (asked.jobId !== undefined) return await jobStatusAnswer(asked.jobId, { store, warning });
  if (asked.prUrl !== undefined) return await jobStatusAnswer(await jobIdOfPrUrl(store, asked.prUrl), { store, warning });
  const view = await queueView(store, { env, limit: jobLimit(args.limit), prStates: serverPrStates });
  const unread = failedCoreSection(view);
  if (unread?.unavailable) throw unread.unavailable;
  if (unread) throw new UserError(`the queue cannot be read: ${unread.error}`);
  if (view.registryError !== null) throw unreadableRegistry(view.registryError, env);
  const { runners, advisories, jobs, counts, suggestions, closes, activeJobs, sections } = view;
  const stale = staleRuntimeHint(env);
  const advisoriesWithStale = [...advisories, ...(stale ? [stale] : []), ...(state.sawOldShape ? [STALE_CONTRACT_ADVISORY] : [])];
  return {
    runner: runners[0] ?? STOPPED_RUNNER,
    runners,
    runnersOnline: runners.length,
    advisories: advisoriesWithStale,
    jobs,
    counts,
    suggestions,
    closes,
    sections,
    hint: [queueHint({ activeJobs, counts, runners, jobs }), ...advisoriesWithStale, ...suggestions].join(" "),
    ...warningAnswer(warning),
  };
}

// The pull request URLs an answer of `queue_status` shows, the ones its cache is refreshed about after the answer left.
function answeredPrUrls(answer) {
  return prUrlsOf(answer.job ? [answer.job] : answer.jobs);
}

// The answer of `queue_stop`: one `{ outcome, pid, message }` per runner, with the CLI's `--stop` line as the message.
async function queueStopAnswer(args, env) {
  const reports = await stopRunners({ pid: Number.isInteger(args.pid) ? args.pid : null, env });
  const lines = reports.map(stopReport);
  const runners = reports.map((report, index) => ({
    outcome: report.outcome,
    pid: report.pid ?? null,
    ...(report.path ? { path: report.path } : {}),
    message: lines[index].line,
  }));
  return { ok: lines.every((line) => line.code === 0), runners };
}

// The answer of `queue_cancel`: the plain cancel, or with `stop: true` the one-call cancel of a running job and the stop of its runner.
async function queueCancelAnswer(args, env) {
  const stop = args.stop === true;
  if (args.release_worktree === true && !stop) throw new UserError("`release_worktree` only has meaning with `stop: true`");
  const cancel = { store: openStore(env), id: parseJobRef(args.job_id), reason: args.reason, env };
  if (!stop) return { ok: true, ...(await cancelJobAndWorktree(cancel)) };
  return { ok: true, ...(await stopAndCancelJob({ ...cancel, releaseWorktree: args.release_worktree === true })) };
}

// The twenty-nine tools of the plugin contract, with the parameter names the plugin actually sends.
function toolDefinitions(env, state) {
  return [
    {
      name: "lesson_recall",
      config: {
        description:
          "Recall of the lessons already learned, before acting. Filters by project and/or query. " +
          "Inside a job, the lessons this run was already given are excluded on their own - no `exclude_ids` bookkeeping is needed - and a query only they would answer is asked again without the exclusion. " +
          'An item with via "fallback" did not match the query: it is recent context, never an answer.',
        inputSchema: {
          query: optionalText,
          project: optionalText,
          target,
          exclude_ids: z.array(z.unknown()).nullable().optional(),
        },
      },
      handler: async (args) => {
        const { sessionId } = await callerContext(env);
        const rows = await recallFreshLessons(
          {
            query: args.query,
            projectId: (await memoryProject(args.project, env))?.id ?? null,
            target: args.target,
            excludeIds: args.exclude_ids,
            sessionId,
            limit: RECALL_LIMIT,
          },
          env,
        );
        return rows.map(lessonView);
      },
    },
    {
      name: "context_for_phase",
      config: {
        description:
          "The context block of one pipeline phase, already formatted: `## Applicable lessons` ([L<id>]), `## Project memory` ([M<id>]) and, for `target: \"explore\"`, `## Structural index`. " +
          "Paste `block` into the subagent's prompt as it comes; an empty `block` means there is genuinely nothing to inject, so the sections are omitted. " +
          "Inside a job the project and the already-injected lessons come from the job's own run: the same lesson is not handed to two phases, unless it is all this run has to give.",
        inputSchema: {
          target: z.enum(PHASE_TARGETS),
          query: optionalText,
          project: optionalText,
          repo_root: optionalText,
          exclude_ids: z.array(z.unknown()).nullable().optional(),
        },
      },
      handler: async (args) =>
        degradedPhaseContext(args, () =>
          phaseContextBlock(
            {
              target: args.target,
              query: args.query,
              project: args.project,
              repoRoot: args.repo_root,
              excludeIds: args.exclude_ids,
            },
            env,
          ),
        ),
    },
    {
      name: "phase_prompt",
      config: {
        description:
          "The complete prompt of one /resolve subagent for THIS run, rendered by the runtime from the plugin's templates: the handoff contract, the Brief of `<RUN_DIR>/00-brief.md`, the routing of the run's tier, the context block and, for the architect, the standing decisions. " +
          "Pass `prompt` to the `Agent` tool verbatim, with the answered `subagent_type` and `model`, then gate the answered `artifact` with `nightqueue run check <check>`. " +
          "`coder` and `verifier` render the fast-track prompt on trivial/simple; `note` is relaunch context (a fix loop, a re-architect, a re-triage), `raw_evidence` is the bug's raw error block (triager only), `group` the hypotheses of one prover. " +
          "Inside a job the run is resolved from the job's own row — passing `project` or `slug` there is refused; outside a job both are required.",
        inputSchema: {
          target: z.enum(PROMPT_TARGETS),
          query: optionalText,
          stage: optionalText,
          delivery_constraints: optionalText,
          raw_evidence: optionalText,
          group: optionalText,
          note: optionalText,
          artifact: optionalText,
          project: optionalText,
          slug: optionalText,
        },
      },
      handler: async (args) => phasePrompt(args, { run: await callerRun(args, env), env }),
    },
    {
      name: "lesson_save",
      config: {
        description: "Records a lesson after fixing an error that was not caught on the first attempt.",
        inputSchema: {
          title: z.string(),
          root_cause: optionalText,
          solution: optionalText,
          prevention: optionalText,
          attempts: z.number().int().nullable().optional(),
          project: optionalText,
          target,
        },
      },
      handler: async (args) => {
        const attempts = Number.isInteger(args.attempts) && args.attempts >= 2 ? args.attempts : null;
        const project = await memoryProject(args.project, env);
        const saved = await openStore(env).lessons.saveLessonDeduped({
          projectId: project?.id ?? null,
          title: args.title,
          root_cause: args.root_cause,
          solution: args.solution,
          prevention: args.prevention,
          attempts,
          target: args.target,
        });
        return {
          ok: true,
          id: saved.id,
          project: project?.name ?? null,
          deduped: saved.deduped,
          attempts: saved.attempts,
          incomplete: saved.incomplete,
        };
      },
    },
    {
      name: "memory_recall",
      config: {
        description: "Recalls project facts and decisions from the shared memory.",
        inputSchema: { query: optionalText, project: optionalText },
      },
      handler: async (args) => {
        const rows = await openStore(env).memory.recallMemories({
          query: args.query,
          projectId: (await memoryProject(args.project, env))?.id ?? null,
          limit: RECALL_LIMIT,
        });
        return rows.map(memoryView);
      },
    },
    {
      name: "index_save",
      config: {
        description:
          "Persists the structural map produced by the Explore: file -> responsibility plus libs with the resolved version. Incremental upsert.",
        inputSchema: {
          project: z.string(),
          repo_root: z.string(),
          files: z.array(z.object({ path: z.string(), responsibility: z.string() })),
          libs: z.array(z.object({ lib: z.string(), version: z.string() })).nullable().optional(),
        },
      },
      handler: async (args) => {
        const saved = await openStore(env).index.saveProjectIndex({
          projectId: (await memoryProject(args.project, env))?.id ?? null,
          repoRoot: args.repo_root,
          files: args.files,
          libs: args.libs ?? [],
        });
        return { ok: true, files: saved.files, libs: saved.libs };
      },
    },
    {
      name: "index_recall",
      config: {
        description:
          "Known structural map of the project with real freshness: stale or missing means revalidate, the rest are fresh.",
        inputSchema: { project: z.string(), repo_root: optionalText, query: optionalText },
      },
      handler: async (args) =>
        openStore(env).index.recallProjectIndex({
          projectId: (await memoryProject(args.project, env))?.id ?? null,
          repoRoot: args.repo_root,
          query: args.query,
          limit: INDEX_LIMIT,
        }),
    },
    {
      name: "pipeline_log",
      config: {
        description:
          "Records the telemetry of one /resolve run, gate terminations included. One call per run. " +
          "Inside a job, `project` and `slug` come from the job's own row and are ignored here; outside one, both name the run. " +
          "`tier` is the FINAL tier the run executed, `tier_operator` is the tier the operator declared (omit it when there was none) and `tier_raise_reason` carries the evidence of a raise. " +
          "`tier`, `task_type` and `tier_raise_reason` may be left out when the run already recorded them with `run_set`; the durations and the models the runtime measured in the stream are filled in afterwards and always win over the ones sent here. " +
          "`investigated` and `queued` are the operator's outcomes (a session that investigated only, or queued a job): outside a job they are recorded, inside a job they are refused.",
        inputSchema: {
          project: optionalText,
          slug: optionalText,
          tier: z.enum(PIPELINE_TIERS).nullable().optional(),
          tier_operator: z.enum(PIPELINE_TIERS).nullable().optional(),
          tier_raise_reason: z.string().nullable().optional(),
          task_type: z.enum(PIPELINE_TASK_TYPES).nullable().optional(),
          outcome: z.enum(PIPELINE_OUTCOMES),
          gate_stop: z.enum(PIPELINE_GATE_STOPS).nullable().optional(),
          duration_s: z.number().int().min(0).nullable().optional(),
          phases: z.array(phaseSchema).nullable().optional(),
        },
      },
      handler: async (args) => {
        refuseOperatorOutcomeInsideJob(args.outcome, env);
        const run = await pipelineLogRun(args, env);
        const recorded = runFacts(run, env);
        const spec = {
          projectId: run.projectId,
          slug: run.slug,
          tier: requireLogged("tier", args.tier ?? recorded.tier),
          tierOperator: args.tier_operator,
          tierRaiseReason: args.tier_raise_reason ?? recorded.tierRaiseReason,
          taskType: args.task_type ?? recorded.taskType,
          outcome: args.outcome,
          gateStop: args.gate_stop,
          durationS: args.duration_s,
          phases: args.phases ?? [],
        };
        try {
          const logged = await openStore(env).runs.logPipelineRun(spec);
          return { ok: true, runId: logged.runId, project: logged.projectId ? run.project : null, phases: logged.phases };
        } catch (err) {
          return queuedPipelineLog(err, spec, env);
        }
      },
    },
    {
      name: "queue_add",
      guardsHome: true,
      config: {
        description:
          "Enqueues an unattended /nightqueue:resolve run for a registered project. `project` is the registered NAME, never a path. One job is one self-contained deliverable that can be reviewed and merged on its own. Large work is ONE job with numbered stages written in the prompt — never several jobs that depend on each other. A job that needs another job's pull request merged first is cut wrong: fold it into that job. Independent jobs may run in parallel and merge in any order. " +
          "This tool only records the job; it never runs it. Queue it now and start the whole batch later with `queue_run` (no `job_id`); start a single job now only when the user asks for that one job now. The hint reports how many runners are live right now, and a job queued with none online waits until `nightqueue queue run` starts one. " +
          "With `project` omitted, `cwd` (the absolute working directory of the caller) resolves the project. When no project is registered for it, the answer is `needs_registration`: ask the user to confirm, then call again with the same `cwd` and `register: true`. Registration never happens without `register: true`. " +
          "With `roadmap_item_id` (the item's ref, `NQ-12`) and no `prompt`, the job prompt is built from that roadmap item, its linked decision and the accepted decisions related to it; a project item moves to `in_progress` and then follows its job: `in_review` once the job is done, `done` once the job is closed - its pull request merged through `queue_close` - and back to `todo` when the job fails or is cancelled (a close that finds the pull request closed without merge cancels the job)." +
          "An ORG roadmap item needs an explicit `project` of that org, or `all` for every project of the org, because a job is always one project's: each project gets its own row linked to its own job (a project whose row still has a live job is skipped and reported in `skipped`; the answer lists every job in `jobs`), and the item's status is derived from its rows - `in_progress` while any row is, `done` once every row is done or cancelled, otherwise the lowest open row status. Closing it by hand cancels its open rows.",
        inputSchema: {
          project: z.string().nullable().optional(),
          cwd: z
            .string()
            .nullable()
            .optional()
            .describe("Absolute path of the working directory of the caller, used to resolve the project when `project` is omitted."),
          register: z
            .boolean()
            .nullable()
            .optional()
            .describe("Registers the git repository of `cwd` as a project before queueing. Only ever sent after the user confirmed it."),
          key: optionalText.describe(
            "The key of the project `register: true` creates (2 to 5 uppercase letters or digits, starting with a letter), when the user chose one other than `suggested_key`. Ignored without `register: true`.",
          ),
          prompt: z
            .string()
            .nullable()
            .optional()
            .describe(
              "The whole request, as prose. One self-contained deliverable that can be reviewed and merged on its own; large work goes here as ONE prompt with numbered stages (`Stages: 1) ... 2) ...`), never as several jobs that depend on each other.",
            ),
          roadmap_item_id: itemRefInput
            .nullable()
            .optional()
            .describe("The ref of the roadmap item that builds the prompt (`NQ-12`, an org item `DLW-3`; an old key still resolves), never an internal id."),
          priority: z.number().int().min(PRIORITY_RANGE.min).max(PRIORITY_RANGE.max).nullable().optional(),
          max_attempts: z.number().int().min(MAX_ATTEMPTS_RANGE.min).max(MAX_ATTEMPTS_RANGE.max).nullable().optional(),
          timeout_s: z.number().int().min(TIMEOUT_RANGE.min).max(TIMEOUT_RANGE.max).nullable().optional(),
          tier: z
            .enum(PIPELINE_TIERS)
            .nullable()
            .optional()
            .describe("Risk tier of the job, set by the operator. The pipeline may only raise it, with evidence, never lower it."),
          run_dir: z
            .string()
            .nullable()
            .optional()
            .describe(
              "The RUN_DIR of an operator run (`~/.nightqueue/runs/<project_id>/<slug>`, as `nightqueue run dir` prints it, absolute or `~/`) this job continues: the job writes into that run, and the runtime places the `## PRIOR RUN (operator)` block right after the prompt's `## Brief` section. Never write that block yourself. A run already bound to an open job is refused; `queue_retry --fresh` of the job discards the run.",
            ),
        },
      },
      handler: async (args) => {
        if (wantsRoadmapItem(args)) {
          if (hasRunDir(args)) throw new UserError("`run_dir` needs the operator's `prompt`: it cannot seed a job built from `roadmap_item_id`");
          const store = openStore(env);
          const queued = await store.roadmap.queueRoadmapItem({
            id: await store.roadmap.itemIdOfRef(args.roadmap_item_id),
            ...(await roadmapQueueTarget(store, args.project)),
            priority: args.priority,
            maxAttempts: args.max_attempts,
            timeoutS: args.timeout_s,
            tier: args.tier,
          });
          return await roadmapQueuedAnswer(queued, env);
        }
        const target = await resolveQueueTarget(args, env);
        if (target.offer && args.register !== true) return needsRegistration(target);
        const registered = target.offer ? await registerOffer(target.offer, args.key, env) : null;
        const project = registered ?? target.project;
        const seeded = hasRunDir(args) ? operatorRunSeed({ args, project, env }) : { prompt: args.prompt, slug: null };
        const job = await openStore(env).jobs.addJob({
          projectId: project.id,
          prompt: seeded.prompt,
          priority: args.priority,
          maxAttempts: args.max_attempts,
          timeoutS: args.timeout_s,
          tier: args.tier,
          slug: seeded.slug,
        });
        return await queuedAnswer({ job, registered }, env);
      },
    },
    {
      name: "queue_status",
      config: {
        description:
          "State of the queue: one job by `job_id` (its ref `J-77` or plain id) or by `pr_url` (the pull request it opened), or the most recent ones plus the counts per status and every live runner in `runners` (`runner` is the first of them, kept for one release; `runnersOnline` is the count of `runners`). The `hint` leads with the live-runner count, and says that a job queued with none online waits until `nightqueue queue run` starts one. " +
          "The `hint` ends with the advisory lines when they apply - a five-hour window close to its limit while runners are live, or two or more runners on one repository - also listed under `advisories`; they never block anything. Never returns the prompt. " +
          "`notice_md` is the reason a job stopped - a job in `gate` always carries one; answer it with `queue_retry`; a gate with `blocked_code` is a preflight block: fix the cause and `queue_retry` it with no note. " +
          "The listing cuts `notice_md` and `result` at 500 characters and marks a cut row with `notice_truncated: true` or `result_truncated: true` (the key is absent when the text fits); call again with that `job_id` for the whole text. " +
          "`sections` carries each part of the read with `ok`, `error` and elapsed `ms`, and `pr_state` of each job comes from a cache refreshed outside the answer (`unknown` until gh answered); " +
          "a merged pull request on a `done` job is listed in `suggestions`, and closing it is `queue_close`. `closes` groups the closes in flight, failed and stalled.",
        inputSchema: {
          job_id: jobRefInput.nullable().optional().describe("One job by its ref (`J-77`) or its plain id."),
          pr_url: optionalText.describe(
            "One job by the pull request it opened (a GitHub pull request URL; a trailing `/files` or slash still matches). Never together with `job_id`; a URL opened by more than one job is refused with their refs.",
          ),
          limit: z.number().int().min(JOB_LIST_LIMIT.min).max(JOB_LIST_LIMIT.max).nullable().optional(),
        },
      },
      handler: async (args) => {
        await ensureStoreExists(env);
        const warning = lastMaintenance(env)?.warning ?? null;
        const answer = await withReadOnlyStore(env, (store) => queueStatusAnswer(args, { store, warning, env, state }));
        void serverPrStates.refresh(answeredPrUrls(answer), env);
        return answer;
      },
    },
    {
      name: "queue_run",
      config: {
        description:
          "starts a detached runner that drains the queue: every pending job, in priority order, until nothing is pending - the runner registers itself, so queue_status shows it. Pass job_id only to start a single job. " +
          "The batch runs DETACHED, with its output going to a log file, and this tool returns immediately with that path. Any number of runners may be live at once: a start is never refused because another one is. " +
          "A single job that cannot be claimed right now answers `started: false` with `waiting` and starts nothing. " +
          "The runner exits by itself once the queue is empty; `queue_stop` (or `nightqueue queue run --stop`) ends every runner, with a pid only that one. " +
          "Each runner works one job at a time; parallel jobs come from starting more runners. `advisories` warns, from the provider's real five-hour utilization and the live leases, when another runner would likely hit the rate limit or fight over one repository - it never blocks a start.",
        inputSchema: { job_id: jobIdField.nullable().optional() },
      },
      handler: async (args) => {
        const started = await startQueueRunner({ jobId: sent(args.job_id) ? parseJobRef(args.job_id) : null, env });
        const advisories = await startAdvisoryLines({ env });
        const stale = staleRuntimeHint(env);
        return { ok: true, ...runnerAnswer(started, env, stale ? [...advisories, stale] : advisories) };
      },
    },
    {
      name: "queue_stop",
      guardsHome: true,
      config: {
        description:
          "Ends queue runners, the MCP mirror of `nightqueue queue run --stop [pid]`: without `pid` it ends EVERY registered runner, with `pid` only that one. " +
          "Each runner gets SIGTERM, then all of them are polled together for up to 10 s; a runner that was holding a job releases it back to `pending` with its lease dropped and its attempt given back, and its registration is removed. " +
          "`runners` carries one `{ outcome, pid, message }` per runner: `stopped`, `stale` (registration removed), `absent`, `foreign` (another user's, never signalled) or `alive` (still there after the 10 s wait, expected when its heartbeat is long; it finishes the job it is running and exits by itself). " +
          "`ok` is false when any of them is `foreign` or `alive`. An unknown `pid` is refused. " +
          "To cancel one running job, call `queue_cancel` with `stop: true` instead - it stops only that job's runner and no other runner can pick the job up.",
        inputSchema: { pid: z.number().int().min(1).nullable().optional() },
      },
      handler: async (args) => await queueStopAnswer(args, env),
    },
    {
      name: "queue_session",
      config: {
        description:
          "The claude session of a job's last attempt: its attempt number, session id and the cwd it ran in (the run's worktree, or the project's checkout when that worktree was already released, with `worktree_released: true`). " +
          "Never resumes it - this tool only reads; resume it yourself with `nightqueue open --resume <session>` in `cwd`, or run `nightqueue queue session <job_id>` in a terminal (the same operator launch). " +
          "`pending` and `running` are refused by name: a live runner owns a running job, and a pending one has not run yet. A job that never reached the agent has no session to answer with, and is refused too.",
        inputSchema: { job_id: jobIdField },
      },
      handler: async (args) => {
        const id = parseJobRef(args.job_id);
        const job = await openStore(env).jobs.getJob(id);
        if (!job) throw new UserError(`unknown job \`${id}\``);
        const resolved = resolveJobSession(job, env);
        return { job_id: resolved.jobId, ref: jobRef(resolved.jobId), attempt: resolved.attempt, session: resolved.session, cwd: resolved.cwd, worktree_released: resolved.worktreeReleased };
      },
    },
    {
      name: "queue_cancel",
      guardsHome: true,
      config: {
        description:
          "Cancels a pending, gated, done, failed or orphaned job. A job running under a live lease, a done job being closed under a live close lease, and a done job whose close was interrupted (resume that one with queue_close), are refused with the exact reason and no write; `closed` and `cancelled` jobs are refused as already finished. " +
          "Cancelling a `done` or `failed` job also releases its worktree: removed when clean and published, otherwise kept with the reason. The answer carries `worktree` (`{ path, status, reason? }`, or null when nothing was released). " +
          "With `stop: true` a job running on a runner of this host is cancelled in one call: the job goes from `running` straight to `cancelled` in one write that only succeeds while that runner still owns it - no other runner can claim it in between - and its attempt is given back; then that runner alone is stopped exactly like `queue_stop` with its pid (SIGTERM, up to 10 s), and `runner` answers `{ outcome, pid, message }`. " +
          "The runner notices the stop only at its next heartbeat, so `alive` is an expected answer when `queue.leaseHeartbeatS` is long: that runner ends by itself and the job stays cancelled.`release_worktree: true` (only with `stop`) then releases the job's worktree by the same rule as a done or failed cancel, once the runner is gone. " +
          "A worker of another host, a pid that is not a live registered runner of this home, and a registration of another user are refused with the reason, with nothing signalled or written. A job that is not running is cancelled by the rules above and `runner` is null.",
        inputSchema: {
          job_id: jobIdField,
          reason: optionalText,
          stop: z.boolean().nullable().optional(),
          release_worktree: z.boolean().nullable().optional(),
        },
      },
      handler: async (args) => await queueCancelAnswer(args, env),
    },
    {
      name: "queue_close",
      guardsHome: true,
      config: {
        description:
          "Closes a job: takes its open pull request to merged and the job to `closed`, through the code pipeline preflight, conflict, merge, settle - never an agent. `closed` always means the pull request was merged through this pipeline. " +
          "It starts DETACHED and returns immediately with the pid and the log path; it never waits for the merge. Follow it with `queue_status` and the job id. " +
          "Only a `done` job with a pull request is closed. `closed`, `running`, `pending`, `gate`, `failed`, `cancelled`, a `done` job with no pull request and a job already being closed under a live lease are refused by name, and nothing is written. Refused inside an unattended run. " +
          "A close that stopped keeps its checklist and its reason on the job (`close`, `close_status: failed`); calling this tool again resumes it at the step that failed. " +
          "`force` skips the pull request checks and the rebase test suite only; conflicts, a pull request that is not the job's own and the job's status still stop the close. " +
          "A pull request closed without merge cancels the job and releases its worktree; one merged by hand is recorded as `merged outside a close`.",
        inputSchema: { job_id: jobIdField, force: z.boolean().nullable().optional() },
      },
      handler: async (args) => {
        const id = parseJobRef(args.job_id);
        const started = await startCloseDetached({ store: openStore(env), id, force: args.force === true, env });
        return { ok: true, started: true, job_id: id, ref: jobRef(id), pid: started.pid, logPath: started.logPath, follow: `nightqueue queue status ${jobRef(id)}` };
      },
    },
    {
      name: "queue_retry",
      config: {
        description:
          "Sends a gated, failed or cancelled job back to the queue. A gated job only moves with `note`, which reaches the run as the answer to its gate - except a job the preflight gated (its `blocked_code` is set: dirty checkout, wrong branch, missing checkout or `claude`, or `store-unavailable`: the session could not reach this server), which moves without one once its cause is fixed. " +
          "Without `fresh` the run resumes from the last phase, keeping slug, branch, session and run directory; with `fresh` it starts from phase 0 and the run directory is dropped. " +
          "`run` starts a DETACHED runner, the same one `queue_run` starts - and the same one the `--run` of the CLI starts, unless it is asked for `--foreground`; a job that cannot be claimed right now answers `waiting` and starts nothing. " +
          "Inside an unattended run this tool only accepts the id of the job it is running: retrying another job is refused, because the note is delivered as a human answer in that job's next prompt.",
        inputSchema: {
          job_id: jobIdField,
          note: optionalText,
          fresh: z.boolean().nullable().optional(),
          run: z.boolean().nullable().optional(),
        },
      },
      handler: async (args) => {
        const { job, runDir } = await applyRetry({ id: parseJobRef(args.job_id), note: args.note, fresh: args.fresh === true, env });
        const started = args.run === true ? await startQueueRunner({ jobId: job.id, env }) : null;
        return { ok: true, job, runDir, ...(started ? runnerAnswer(started, env, await startAdvisoryLines({ env })) : { runner: null }) };
      },
    },
    {
      name: "decision_save",
      config: {
        description:
          "Records one architecture decision: the context that forced it, what was decided and what it costs. " +
          "Owned by `project` (the registered NAME, never a path) or by `org`, never both — an org decision binds every project of that org and is the right shape when the constraint holds for more than one repo of the same product. " +
          "Numbered inside its owner, and named by its ref (`D-1`, `D-2` per project; `DLW/D-1`, `DLW/D-2` per org, after the org's key); a missing or invalid `status` falls back to `proposed` (the answer then carries `status_defaulted: true`). " +
          "Before saving, the title is searched against the owner's accepted and proposed decision titles, and the title plus decision text against their meaning. " +
          'When it overlaps any, nothing is saved and the answer is `status: "needs_review"` with `candidates` (id, number, title, status, via). ' +
          "Save again naming EVERY candidate by its `number` or its `ref` (a ref must name a decision of the same owner): in `supersedes` the ones this decision replaces WHOLE (they become `superseded` and point at the new row, so restate in the new text what still holds), in `unrelated` the ones it leaves untouched. " +
          "Any candidate left unnamed refuses again. Inside a queue job `supersedes` is refused, and a job proposes at most one decision.",
        inputSchema: {
          project: optionalText,
          org: optionalText,
          title: z.string(),
          context: z.string(),
          decision: z.string(),
          consequences: optionalText,
          status: looseDecisionStatus,
          supersedes: optionalNumbers,
          unrelated: optionalNumbers,
        },
      },
      handler: async (args) => {
        const store = openStore(env);
        const owner = ownerRef(await ownerArgs(args, env));
        const saved = await store.decisions.saveReviewedDecision({
          ...owner,
          title: args.title,
          context: args.context,
          decision: args.decision,
          consequences: args.consequences,
          status: args.status,
          supersedes: await store.decisions.ownDecisionNumbers(args.supersedes, owner),
          unrelated: await store.decisions.ownDecisionNumbers(args.unrelated, owner),
          jobId: callerJobId(env),
        });
        return saved.needsReview ? needsReviewAnswer(saved.candidates) : savedDecisionAnswer(saved);
      },
    },
    {
      name: "decision_update",
      config: {
        description:
          "Changes a decision by its ref in `id` (`D-7`, `DLW/D-3`, `NQ/D-7`): accept or reject a proposed one, correct its text, or point `superseded_by` at the ref of the decision that replaced it. " +
          "A bare `D-<n>` is read in `project` (the registered NAME), or inside a job in the job's project; `superseded_by` is read in the updated decision's owner. " +
          "Only the fields present are touched; an explicit `null` is treated exactly like an absent one. " +
          '`status: "superseded"` requires `superseded_by`, unless the decision already names its successor.',
        inputSchema: {
          id: decisionRefInput,
          project: optionalText,
          title: optionalText,
          context: optionalText,
          decision: optionalText,
          consequences: optionalText,
          status: optionalDecisionStatus,
          superseded_by: decisionRefInput.nullable().optional(),
        },
      },
      handler: async (args) => {
        const store = openStore(env);
        const id = await store.decisions.decisionIdOfRef(args.id, await decisionUpdateContext(args, env));
        const current = await store.decisions.getDecision(id);
        if (current) await requireOwnProject({ kind: "decision", id: String(args.id).trim(), row: current }, env);
        const row = await store.decisions.updateDecision(id, {
          title: args.title,
          context: args.context,
          decision: args.decision,
          consequences: args.consequences,
          status: args.status,
          superseded_by: await linkedDecisionId(args.superseded_by, rowOwner(current), env),
        });
        return { ok: true, decision: decisionView(row) };
      },
    },
    {
      name: "decision_list",
      config: {
        description:
          "The decisions log in numbering order, optionally filtered by status. With `project`, the project's own rows plus the rows of its org, org rows first, each carrying its `scope` and its `owner`; with `org`, only that org's rows. " +
          "Compact rows: the full text of one decision comes from `decision_recall`.",
        inputSchema: { project: optionalText, org: optionalText, status: optionalDecisionStatus },
      },
      handler: async (args) => {
        const owner = await ownerArgs(args, env);
        const rows = await openStore(env).decisions.listDecisions({ ...ownerRef(owner), status: args.status });
        return { ...ownerNames(owner), decisions: rows.map(decisionView) };
      },
    },
    {
      name: "decision_recall",
      config: {
        description:
          "Standing constraints, before proposing architecture. With `project`, the project's decisions and its org's, org rows first, each carrying its `scope` and its `owner`; with `org`, only that org's. " +
          "Only accepted decisions come back, with their text untruncated, because this feeds prompts. " +
          'An item with via "fallback" did not match the query: it is recent context, never an answer.',
        inputSchema: {
          project: optionalText,
          org: optionalText,
          query: optionalText,
          limit: z.number().int().min(1).max(20).nullable().optional(),
        },
      },
      handler: async (args) => {
        const rows = await openStore(env).decisions.recallDecisions({
          ...ownerRef(await ownerArgs(args, env)),
          query: args.query,
          limit: Number.isInteger(args.limit) ? args.limit : RECALL_LIMIT,
        });
        return rows.map(decisionFullView);
      },
    },
    {
      name: "roadmap_save",
      config: {
        description:
          "Adds one intent to a roadmap, at the end of its `priority` group (1-9, default 5, 1 first like a job's). Owned by `project` or by `org`, never both: an org item is work every project of the org has to do, and names the project its job goes to at queue time. " +
          `\`type\` (${ROADMAP_TYPES.join("|")}) is required. ` +
          `\`status\` defaults to \`todo\`; by hand it may be ${MANUAL_STATUSES.join("|")}, never \`in_progress\`, which only a job sets. ` +
          "`decision_id` links it to the decision that motivated it, by its ref (`D-7` of the item's project, `DLW/D-3`). `horizon` was removed in schema v17 and is refused by name.",
        inputSchema: {
          project: optionalText,
          org: optionalText,
          title: z.string(),
          type: roadmapType,
          detail: optionalText,
          priority: optionalRoadmapPriority,
          status: optionalManualRoadmapStatus,
          decision_id: decisionRefInput.nullable().optional(),
          horizon: retiredHorizon,
        },
      },
      handler: async (args) => {
        const owner = await ownerArgs(args, env);
        const saved = await openStore(env).roadmap.saveRoadmapItem({
          ...ownerRef(owner),
          title: args.title,
          type: args.type,
          detail: args.detail,
          priority: args.priority,
          status: args.status,
          decision_id: await linkedDecisionId(args.decision_id, owner, env),
          horizon: args.horizon,
        });
        return { ok: true, id: saved.id, ref: saved.ref, type: saved.type, priority: saved.priority, position: saved.position, status: saved.status };
      },
    },
    {
      name: "roadmap_update",
      config: {
        description:
          "Changes a roadmap item by its ref in `id` (`NQ-12`; an old key still resolves): its text, its `type`, its `priority` (a change moves it to the end of the new priority group), its position inside the priority group, its `decision_id` (a decision ref, `D-7` read in the item's project), or its status. " +
          `By hand the status may be ${MANUAL_STATUSES.join("|")}; \`in_progress\` is refused because only a job sets it, and moving back from \`in_review\` or \`done\` is allowed and leaves a \`reopened\` comment. ` +
          "A linked item follows its job: `in_progress` while it runs or waits at a gate, `in_review` once it is done, `done` once it is closed - its pull request merged through `queue_close` - and `todo` when it fails or is cancelled (a close that finds the pull request closed without merge cancels the job)." +
          "An org item's status is derived from its project rows; setting it to `done` or `cancelled` by hand cancels every open row, with a `closed` comment per row. " +
          "`horizon` was removed in schema v17 and is refused by name.",
        inputSchema: {
          id: itemRefInput,
          title: optionalText,
          detail: optionalText,
          type: roadmapType.nullable().optional(),
          status: optionalManualRoadmapStatus,
          priority: optionalRoadmapPriority,
          position: optionalId,
          decision_id: decisionRefInput.nullable().optional(),
          horizon: retiredHorizon,
        },
      },
      handler: async (args) => {
        const store = openStore(env);
        const id = await store.roadmap.itemIdOfRef(args.id);
        const current = await store.roadmap.getRoadmapItem(id);
        if (current) await requireOwnProject({ kind: "roadmap item", id: String(args.id).trim(), row: current }, env);
        const { author } = await roadmapCaller(env);
        const row = await store.roadmap.updateRoadmapItem(id, {
          title: args.title,
          detail: args.detail,
          type: args.type,
          status: args.status,
          priority: args.priority,
          position: args.position,
          decision_id: await linkedDecisionId(args.decision_id, rowOwner(current), env),
          horizon: args.horizon,
          author,
        });
        return { ok: true, item: roadmapItemView(row) };
      },
    },
    {
      name: "roadmap_get",
      config: {
        description:
          "The roadmap of an owner as one list of `items`, in workflow order (backlog, todo, in_progress, in_review, done, cancelled), then org items first, then by `priority` (1 first) and `position`; each item carries its linked decision, the status of the job it was queued as and `closed_at`. " +
          "With `project`, the project's items plus its org's, each carrying its `scope` and its `owner`, and each org item the `project_status` of that project's own row; with `org`, only that org's items, each with `projects` (every project row: `project`, `status`, `job_id`, `job_status`). " +
          "`status`, `priority` and `type` narrow the list to the values given; without them every item is returned. " +
          "With `id` alone (the item's ref, `NQ-12`), that one item with its text untruncated and its comment thread in chronological order (the job events the runtime recorded and the notes); inside a job only an item of the job's project or of its org is readable.",
        inputSchema: {
          id: itemRefInput.nullable().optional(),
          project: optionalText,
          org: optionalText,
          status: z.array(z.enum(ROADMAP_STATUSES)).nullable().optional(),
          priority: z.array(z.number().int().min(PRIORITY_RANGE.min).max(PRIORITY_RANGE.max)).nullable().optional(),
          type: z.array(z.enum(ROADMAP_TYPES)).nullable().optional(),
        },
      },
      handler: async (args) => {
        if (args.id !== undefined && args.id !== null) return await roadmapItemDetail(args, env);
        return await openStore(env).roadmap.listRoadmap(ownerRef(await ownerArgs(args, env)), {
          status: args.status,
          priority: args.priority,
          type: args.type,
        });
      },
    },
    {
      name: "roadmap_comment",
      config: {
        description:
          "Appends a `note` to the comment thread of a roadmap item by its ref in `id` (`NQ-12`); comments are append-only, never edited nor deleted. " +
          "Outside a job the author is `operator`; inside a job it is `job:<id>`, and only an item of the job's project or of its org may be commented.",
        inputSchema: { id: itemRefInput, body: z.string() },
      },
      handler: async (args) => {
        const { author, viewer } = await roadmapCaller(env);
        const store = openStore(env);
        const id = await store.roadmap.itemIdOfRef(args.id);
        const comment = await store.roadmap.addRoadmapComment({ id, body: args.body, author, viewer });
        return { ok: true, comment };
      },
    },
    {
      name: "roadmap_search",
      config: {
        description:
          `Finds at most ${ROADMAP_SEARCH_LIMIT} roadmap items an owner sees: \`query\` matches their title, detail and comment thread; \`file\` matches a path a job of theirs touched, exactly or as a directory above it (\`src/queue\` never matches \`src/queue2/\`).` +
          "File matches come first, then by relevance; each hit is `{id, ref, title, status, priority, type, via}`. " +
          "Outside a job name the owner with `project` or `org`; inside a job the search always reads the job's own project and its org's items, never a sibling project's comments.",
        inputSchema: {
          query: optionalText,
          file: optionalText,
          project: optionalText,
          org: optionalText,
          limit: z.number().int().min(1).max(ROADMAP_SEARCH_LIMIT).nullable().optional(),
        },
      },
      handler: async (args) => {
        const owner = await roadmapSearchOwner(args, env);
        const hits = await openStore(env).roadmap.searchRoadmap({ ...ownerRef(owner), query: args.query, file: args.file, limit: args.limit });
        return { ...ownerNames(owner), hits };
      },
    },
    {
      name: "run_phase_done",
      config: {
        description:
          "Records one completed phase of the run in `state.json`, so a retry resumes from the next one. The runtime stamps the time and owns the file: never hand-write `state.json`. " +
          "Inside a job the run is resolved from the job's own row — passing `project` or `slug` there is refused; outside a job both are required.",
        inputSchema: {
          phase: z.enum(RESUME_PHASE_ORDER),
          artifact: optionalText,
          verdict: optionalText,
          note: optionalText,
          project: optionalText,
          slug: optionalText,
        },
      },
      handler: async (args) => {
        const run = await callerRun(args, env);
        return runAnswer(recordPhaseDone({ ...run, phase: args.phase, artifact: args.artifact, verdict: args.verdict, note: args.note, env }), run);
      },
    },
    {
      name: "run_terminate",
      config: {
        description:
          "Records that the run stopped on purpose at a phase, with the reason; a run terminated this way is never resumed by a retry. " +
          "Inside a job the run is resolved from the job's own row — passing `project` or `slug` there is refused; outside a job both are required.",
        inputSchema: { phase: z.enum(RESUME_PHASE_ORDER), reason: z.string(), project: optionalText, slug: optionalText },
      },
      handler: async (args) => {
        const run = await callerRun(args, env);
        return runAnswer(recordTermination({ ...run, phase: args.phase, reason: args.reason, env }), run);
      },
    },
    {
      name: "run_outcome",
      config: {
        description:
          "Records how the run ended: `done` when the pull request exists, `gate` with the `notice` the operator has to answer. " +
          "The pull request URL is NOT a parameter: the runtime writes it from what the session really published. " +
          "Inside a job the run is resolved from the job's own row — passing `project` or `slug` there is refused; outside a job both are required.",
        inputSchema: { status: z.enum(RUN_OUTCOME_STATUSES), notice: optionalText, project: optionalText, slug: optionalText },
      },
      handler: async (args) => {
        const run = await callerRun(args, env);
        return runAnswer(recordOutcome({ ...run, status: args.status, notice: args.notice, env }), run);
      },
    },
    {
      name: "run_set",
      config: {
        description:
          "Records the fields of the run itself in `state.json` as the pipeline discovers them: its `type`, its `tier`, the evidence of a tier raise, and the branch and worktree the code lives in. Only the fields sent are touched. " +
          "`qa_stage_a` records the one sub-phase with a marker of its own — sent when the QA stage A gate closes, it is what makes a resume re-enter the QA phase straight at stage B instead of paying the analyst again. " +
          "`origin: operator` marks a run an operator session recorded; `evidence_level` (1-4) is the level its triage reached and `plan_status` whether its plan was approved. A job queued from that run (`queue_add` with `run_dir`) skips its triage only at level 3 or more on a bug, and its architecture only with `plan_status: approved`. " +
          "Inside a job the run is resolved from the job's own row — passing `project` or `slug` there is refused; outside a job both are required.",
        inputSchema: {
          type: z.enum(PIPELINE_TASK_TYPES).nullable().optional(),
          tier: z.enum(PIPELINE_TIERS).nullable().optional(),
          tier_raise_reason: optionalText,
          branch: optionalText,
          worktree: optionalText,
          qa_stage_a: z.object({ artifact: z.string(), verdict: optionalText }).optional(),
          origin: z.enum(["operator"]).nullable().optional(),
          evidence_level: z.number().int().min(1).max(4).nullable().optional(),
          plan_status: z.enum(["draft", "approved"]).nullable().optional(),
          project: optionalText,
          slug: optionalText,
        },
      },
      handler: async (args) => {
        const run = await callerRun(args, env);
        return runAnswer(recordRunFields({ ...run, fields: runSetFields(args), env }), run);
      },
    },
  ];
}

// Handler of one tool, refusing first the ones that would change the home the unattended runner itself uses.
function toolHandler(tool, env) {
  if (tool.guardsHome !== true) return tool.handler;
  return async (args) => {
    refuseHomeWriteInsideJob(env);
    return await tool.handler(args);
  };
}

// Builds the MCP server with the twenty-nine tools of the plugin contract.
export function createServer(env = process.env) {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: `nightqueue (tool contract ${TOOL_CONTRACT})`,
      version: readVersion(),
      websiteUrl: "https://nightqueue.github.io",
      // MCP spec 2025-11-25: clients that support server icons render this next to the server name.
      icons: [{ src: "https://nightqueue.github.io/avatar.png", mimeType: "image/png", sizes: ["1024x1024"] }],
    },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const state = newContractState();
  const session = { env, state };
  const schemas = new Map();
  for (const tool of toolDefinitions(env, state)) {
    schemas.set(tool.name, tool.config.inputSchema);
    server.registerTool(tool.name, tool.config, guard(tool.name, toolHandler(tool, env), session));
  }
  // The SDK validates the call before the handler and refuses with one issue; this refusal carries every issue, the whole contract and what was received, which is what lets an agent fix the next call instead of repeating the same payload.
  server.validateToolInput = async (tool, args, toolName) => validateArgs(toolName, schemas.get(toolName) ?? tool.inputSchema, args);
  return server;
}
