import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { saveProject } from "../cli/project.mjs";
import { StoreUnavailableError, storeWarningLine, UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { defaultOrg, requireOrg } from "../config/orgs.mjs";
import {
  gitRootOrNull,
  mainCheckoutOf,
  registrationOffer,
  requireProject,
  resolveProjectRef,
  suggestName,
} from "../config/projects.mjs";
import { loadConfig, saveConfig } from "../config/store.mjs";
import {
  MAX_ATTEMPTS_RANGE,
  PRIORITY_RANGE,
  TIMEOUT_RANGE,
} from "../memory/jobs.mjs";
import { LESSON_TARGETS, lessonView } from "../memory/lessons.mjs";
import { memoryView } from "../memory/memory.mjs";
import { jobRef, parseJobRef, parseRecordId, requireKey } from "../memory/refs.mjs";
import { startAdvisoryLines } from "../queue/advisory.mjs";
import { claimingRunners, noRunnerWait, onceOnlyLine, parkedBacklogLine, pausedRunnerLine, pendingJobs, runnersOnline, runnersOnlineSplit, staleRuntimeHint, windowWaitingLine } from "../queue/hints.mjs";
import { refuseHomeWriteInsideJob, refuseMemoryDeleteInsideJob } from "../queue/home-guard.mjs";
import { blockerLines } from "../queue/claim.mjs";
import { lastMaintenance } from "../queue/maintenance.mjs";
import { jobIdOfPrUrl } from "../queue/pr-lookup.mjs";
import { createPrStateCache } from "../queue/pr-state.mjs";
import { liveRunnersReport, unreadableRegistry } from "../queue/registry.mjs";
import { failedCoreSection, jobDetailView, prUrlsOf, queueView } from "../queue/view.mjs";
import { isSafeSegment, readRunState, RESUME_PHASE_ORDER } from "../queue/resume.mjs";
import { resolveJobRun } from "../queue/job-run.mjs";
import { composeGateNotice } from "../queue/gate-notice.mjs";
import { runDir as runDirOf } from "../config/paths.mjs";
import { appendPendingWrite, PENDING_KEYS } from "../queue/pending-writes.mjs";
import { applyRetry, callerJobId } from "../queue/retry.mjs";
import { refuseDependentPrompt } from "../queue/dependent-prompt.mjs";
import { resolveJobSession } from "../queue/session.mjs";
import { startCloseDetached } from "../queue/close-start.mjs";
import { cancelJobAndWorktree, stopAndCancelJob } from "../queue/cancel.mjs";
import { stopReport, stopRunners } from "../queue/stop.mjs";
import { queueWorkers } from "../queue/close-view.mjs";
import {
  recordOutcome,
  recordPhaseDone,
  recordRunFields,
  recordSkip,
  recordTermination,
  RUN_OUTCOME_STATUSES,
  SKIP_AGENTS,
} from "../queue/run-state.mjs";
import { startQueueRunner } from "../queue/start.mjs";
import {
  OPERATOR_PIPELINE_OUTCOMES,
  PIPELINE_GATE_STOPS,
  PIPELINE_OUTCOMES,
  PIPELINE_PHASE_STATUSES,
  PIPELINE_TASK_TYPES,
} from "../memory/runs.mjs";
import { ensureStoreExists, openStore, withReadOnlyStore } from "../store/open.mjs";
import { coverageField, coverageLabel, jobOriginCoverage } from "../integrations/coverage.mjs";
import { changeProjectIntegrations, INTEGRATION_ACTIONS, integrationsView } from "../integrations/settings.mjs";
import { redactSecrets, redactValue } from "../integrations/redact.mjs";
import { CONNECTION_CALL_BOUNDS, connectionCall } from "../integrations/connection-call.mjs";
import { CONSENT_KINDS, operatorSession, recordConsent } from "../queue/operator-consent.mjs";
import {
  TRACKER_BOUNDS,
  TRACKER_LIMIT,
  TRACKER_STATES,
  trackerComment,
  trackerCreate,
  trackerInstructionLines,
  trackerIssues,
  trackerRead,
  trackerUpdate,
} from "../integrations/tracker.mjs";
import { callerContext, PHASE_TARGETS, phaseContextBlock, recallFreshLessons, runInjectedLessonIds } from "./phase-context.mjs";
import { phasePrompt, PROMPT_TARGETS } from "./phase-prompt.mjs";
import { readVersion } from "../cli/version.mjs";
import {
  newContractState,
  refuseOldShapes,
  refuseRemovedTool,
  refuseRenamedFields,
  refuseRetiredFields,
  STALE_CONTRACT_ADVISORY,
  StaleContractError,
  TOOL_CONTRACT,
  withContract,
} from "./tool-contract.mjs";

const SERVER_NAME = "nightqueue";
const OPERATE_THROUGH_TOOLS = "Operate nightqueue through these MCP tools only - never the CLI, the database file, the home directory or the project's files.";
const OPERATOR_MODE_LINE =
  "In a `nightqueue open` session the operator reads freely, and edits, creates, runs or writes git in a registered checkout only after the person's explicit answer recorded with `operator_consent` (kind and scope exactly as consented); it never deletes files, force-pushes, writes the nightqueue home or touches Claude/Codex settings.";
const OPERATOR_CONNECTION_LINE =
  "In a `nightqueue open` session `connection_call` sends a POST, PATCH or PUT only when a live `operator_consent` of kind `connection-write` (`<connection> <METHOD> <path>`) covers it, else it answers `needs-consent` and sends nothing.";
const SERVER_INSTRUCTION_LINES = [
  `tool contract ${TOOL_CONTRACT}: every answer carries \`contract\`; a tool refused with "your client has the tool definitions of an older nightqueue" means this session cached old definitions - start a new session or restart the MCP client.`,
  "nightqueue is a backlog of unattended coding jobs, not a synchronous executor: `queue_add` records work, it never runs it.",
  "Never queue a job on your own initiative: present the brief first (title and detail) and call `queue_add` only after the person gives an explicit go.",
  "One job is one self-contained deliverable, and a large plan is ONE job with numbered stages written in the prompt, never several jobs that depend on each other.",
  "`queue_add` refuses a prompt that conditions the work on another job or pull request (`after J-<n>`, `once PR #<n> is merged`, `depends on J-<n>`/`depends on job`, `when #<n> lands`), and `queue_retry` refuses a closed job or a done job whose pull request merged: queue a new one.",
  OPERATE_THROUGH_TOOLS,
  "Start a single job now, with `queue_run` and its `job_id`, only when the person asks for that one job now; the whole batch starts with `queue_run` without `job_id`.",
  "Every job ends as an open pull request (`done`), as `done` with no pull request when the run concluded on purpose that no code change is needed (its conclusion in `notice_md`), or stopped at a gate with its reason in `notice_md`.",
  "At a gate, read `notice_md` whole with `queue_status`, present it to the person, and answer with `queue_retry` only after the person answers; a done job is closed with `queue_close`.",
  "Call `queue_status` to see what is pending before suggesting a batch.",
  "`lesson_save` and `memory_save` record what a session learned - a lesson for an error or correction, a memory (`key`/`value`) for a fact of the project's code; both are allowed inside a queue job.",
  "At the end of a session that changed or learned something, offer `/nightqueue:reflect` once: it proposes lessons and memories and saves only the ones the person confirms.",
  ...trackerInstructionLines(),
  "`connection_call` calls the API behind a stored connection by its name, with the secret injected by the runtime and never shown; a GET reads, any other method only after the person said yes to the exact request (connection, method, path, body), and it is refused inside a queue job",
];

// The server's instructions: the operator-mode lines in place of the tools-only line when the server serves a `nightqueue open` session, else the plain ones.
function serverInstructions(env) {
  if (operatorSession(env) === null) return SERVER_INSTRUCTION_LINES.join("\n");
  const lines = SERVER_INSTRUCTION_LINES.map((line) => (line === OPERATE_THROUGH_TOOLS ? OPERATOR_MODE_LINE : line));
  return [...lines, OPERATOR_CONNECTION_LINE].join("\n");
}
const PROMPT_SOURCE_MISSING = "queue_add needs `prompt`, the whole request as prose";
const RECALL_LIMIT = 8;
const INDEX_LIMIT = 40;
const JOB_LIST_LIMIT = { min: 1, max: 50, fallback: 10 };

// One cache of pull request states per server process, shared by every session and request it serves; it never touches the database.
const serverPrStates = createPrStateCache();

const target = z.enum(LESSON_TARGETS).nullable().optional();
const optionalText = z.string().nullable().optional();
const ignoredOldField = z.unknown().optional().describe("ignored: accepted from an older plugin");
const jobRefInput = z.union([z.number().int().min(1), z.string()]);
const jobIdField = jobRefInput.describe("The job's ref (`J-77`) or its plain id.");

const phaseSchema = z.object({
  phase: z.string(),
  model: z.string().nullable().optional(),
  status: z.enum(PIPELINE_PHASE_STATUSES).nullable().optional(),
  retry: z.boolean().nullable().optional(),
  duration_s: z.number().int().min(0).nullable().optional(),
  note: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});

// The registered project a lesson, memory, index or run call scopes to: a name, or an absolute path inside a checkout; null (global) for
// a path inside none, and an unknown name refused, so nothing is ever written under a project that does not exist.
async function memoryProject(ref, env) {
  return await resolveProjectRef(openStore(env), ref);
}

// The registered project a delete is scoped to: required, so an id is never deleted without saying whose it is.
async function deleteProject(ref, tool, env) {
  const project = await memoryProject(ref, env);
  if (project === null) throw new UserError(`\`${tool}\` requires \`project\`: the registered name or key of the project that owns the id`);
  return project;
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
  return {
    taskType: state?.type ?? null,
    phases: Array.isArray(state?.phases) ? state.phases : [],
  };
}

// The `reason` each recorded phase carries, queued per phase name in the order the run recorded them.
function recordedReasonsByPhase(recordedPhases) {
  const queues = new Map();
  for (const entry of recordedPhases) {
    const name = typeof entry?.phase === "string" ? entry.phase : "";
    const reason = typeof entry?.reason === "string" && entry.reason.trim() !== "" ? entry.reason : null;
    queues.set(name, [...(queues.get(name) ?? []), reason]);
  }
  return queues;
}

// The trimmed phase name of a sent `pipeline_log` row.
function sentPhaseName(phase) {
  return String(phase?.phase ?? "").trim();
}

// The phase names whose recorded reasons cannot be paired: the call lists a different number of launches than the run recorded.
function unpairedPhaseNames(phases, queues) {
  const sentCounts = new Map();
  for (const phase of phases) sentCounts.set(sentPhaseName(phase), (sentCounts.get(sentPhaseName(phase)) ?? 0) + 1);
  return [...queues]
    .filter(([name, reasons]) => (sentCounts.get(name) ?? 0) !== reasons.length)
    .filter(([, reasons]) => reasons.some((reason) => reason !== null))
    .map(([name]) => name);
}

// The sent phases with the reason state.json recorded for each, paired in order only when both sides list the same launches; a sent reason wins.
function withRecordedReasons(phases, recordedPhases) {
  const queues = recordedReasonsByPhase(recordedPhases);
  const unpaired = unpairedPhaseNames(phases, queues);
  const paired = phases.map((phase) => {
    const name = sentPhaseName(phase);
    const recorded = unpaired.includes(name) ? null : (queues.get(name)?.shift() ?? null);
    const sent = typeof phase?.reason === "string" && phase.reason.trim() !== "" ? phase.reason : null;
    return sent !== null || recorded === null ? phase : { ...phase, reason: recorded };
  });
  return { phases: paired, unpaired };
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

// Tells whether a `run_outcome` call asks the runtime to compose its notice, refusing the combinations that have no single source of truth.
function wantsComposedNotice(args) {
  const composed = (typeof args.question === "string" && args.question.trim() !== "") || Boolean(args.from_artifact);
  if (!composed) return false;
  if (args.status !== "gate") throw new UserError("`question` and `from_artifact` only compose a `gate` notice: nothing was recorded");
  if (typeof args.notice === "string" && args.notice.trim() !== "") {
    throw new UserError("send either `notice` or `question`/`from_artifact`, never both: nothing was recorded");
  }
  return true;
}

// The gate notice the runtime composes from the run's own artifact and/or the question.
function composedGateNotice(args, run, env) {
  if (typeof run.projectId !== "string" || run.projectId === "") {
    throw new UserError(`the run directory of \`${run.project}/${run.slug}\` is unknown, so no artifact can compose the notice: nothing was recorded`);
  }
  return composeGateNotice({
    runDir: runDirOf(run.projectId, run.slug, env),
    jobId: callerJobId(env),
    question: args.question,
    fromArtifact: args.from_artifact ?? null,
  });
}

// The fields of state.json `run_set` writes, in the argument names the plugin sends.
const RUN_SET_FIELDS = {
  type: "type",
  branch: "branch",
  worktree: "worktree",
};

// The fields `run_set` was asked to change, under the names state.json uses; an absent or empty one is not a change.
function runSetFields(args) {
  const asked = Object.entries(RUN_SET_FIELDS).filter(([arg]) => typeof args[arg] === "string" && args[arg].trim() !== "");
  const fields = Object.fromEntries(asked.map(([arg, field]) => [field, args[arg].trim()]));
  return args.qa_stage_a ? { ...fields, qaStageA: args.qa_stage_a } : fields;
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

// Tells whether an optional argument was sent: an explicit null is treated exactly like an absent one.
function sent(value) {
  return value !== undefined && value !== null;
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

// Tells whether an optional text argument carries text.
function filled(value) {
  return typeof value === "string" && value.trim() !== "";
}

// The answer of `project_register`, the same shape whether the project was created or already there.
function projectRegisterAnswer({ registered, project, org }) {
  const verb = registered ? "registered" : "already registered";
  return {
    registered,
    project: project.name,
    key: project.key,
    org,
    path: project.path,
    hint: `${verb} project ${project.name} (${project.path}) in org ${org} with key ${project.key}. Nothing was queued.`,
  };
}

// Registers the repository at `path` inside the configuration lock, writing nothing when a project already holds that path.
async function registerRepositoryLocked(args, path, env) {
  const store = openStore(env);
  const orgName = filled(args.org) ? args.org.trim() : null;
  const org = orgName ? await requireOrg(store, orgName) : await defaultOrg(store, loadConfig(env, { warn: () => {} }));
  const existing = (await store.projects.list()).find((project) => project.path === path);
  if (existing) return projectRegisterAnswer({ registered: false, project: existing, org: existing.org ?? org.name });
  const name = filled(args.name) ? args.name.trim() : suggestName((await store.projects.list()).map((project) => project.name), path);
  if (name === null) throw new UserError(`cannot derive a free project name for ${path}; pass \`name\``);
  const key = filled(args.key) ? requireKey(args.key) : await store.projects.suggestKey(name);
  const ctx = { env, out: () => {}, err: () => {}, saveConfig };
  const { project } = await saveProject(ctx, { path, name, org: org.name, key });
  return projectRegisterAnswer({ registered: true, project, org: org.name });
}

// Registers the repository of `cwd` (a linked worktree goes to its main checkout) without queueing a job.
async function registerRepository(args, env) {
  const cwd = requireCwd(args.cwd);
  refuseRegistrationInsideJob(cwd, env);
  const root = gitRootOrNull(cwd);
  if (root === null) throw new UserError(`${cwd} is not inside a git repository`);
  const path = mainCheckoutOf(root);
  return await withLock(env, () => registerRepositoryLocked(args, path, env));
}

// The answer of `project_integrations` show: the project's stored settings, read only.
async function showProjectIntegrations(args, env) {
  await ensureStoreExists(env);
  return await withReadOnlyStore(env, async (store) => {
    const project = await requireProject(store, args.project);
    return integrationsView(project, await store.projects.integrations(project.id));
  });
}

// The one change `project_integrations` set or unset asks for; a set needs a value.
function integrationChange(args) {
  if (!filled(args.key)) throw new UserError(`\`${args.action}\` needs \`key\`, written <kind>.<key>`);
  if (args.action === "set" && !filled(args.value)) throw new UserError("`set` needs `value`");
  return args.action === "set" ? { key: args.key, value: args.value } : { key: args.key };
}

// Applies `project_integrations` set or unset inside the configuration lock and answers the stored result; refused inside a job.
async function changeProjectIntegrationsAnswer(args, env) {
  refuseHomeWriteInsideJob(env);
  const change = integrationChange(args);
  return await withLock(env, async () => {
    const store = openStore(env);
    const project = await requireProject(store, args.project);
    const integrations = await changeProjectIntegrations({ store, project, action: args.action, changes: [change], env });
    return integrationsView(project, integrations);
  });
}

// Refuses a `queue_add` without the text of the job's prompt.
function requirePrompt(args) {
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") throw new UserError(PROMPT_SOURCE_MISSING);
}

// The closing sentence of the `queue_add` hint: what happens to the job given who is online right now - and, when the
// live runner is waiting out a rate limit, that wait instead of a promise it will be picked up before the reset.
function queuedRunnerLine(env, jobId) {
  const report = liveRunnersReport(env);
  if (report.error !== null) return "Start the batch with queue_run when you are ready.";
  const workers = queueWorkers(report.runners);
  const runners = claimingRunners(workers, jobId);
  if (workers.length > 0 && runners.length === 0) return `${onceOnlyLine(workers)}.`;
  if (runners.length === 0) return `${noRunnerWait()}.`;
  const paused = pausedRunnerLine(runners);
  if (paused) return `${runnersOnline(runners.length)} - nothing to start: ${paused}; it claims again by itself when the limit resets.`;
  const waiting = windowWaitingLine(runners);
  if (waiting) return `${waiting}; it claims once the window opens.`;
  return `${runnersOnline(runners.length)} - it will be picked up.`;
}

// The answer of `queue_add`: the job it recorded.
async function queuedAnswer({ job, registered = null }, env) {
  const store = openStore(env);
  const pending = (await store.jobs.countsByStatus()).pending;
  const done = registered ? `registered project \`${registered.name}\` (${registered.path}). ` : "";
  const stale = staleRuntimeHint(env);
  const coverages = await jobOriginCoverage({ origins: job.origin, projectId: job.projectId, store, env });
  const origin = coverages.length ? ` Origins: ${coverages.map(coverageLabel).join("; ")}.` : "";
  return {
    ok: true,
    id: job.id,
    ref: jobRef(job.id),
    project: job.project,
    priority: job.priority,
    timeoutS: job.timeoutS,
    ...(job.startBranch ? { start_branch: job.startBranch } : {}),
    ...(job.startWorktree ? { start_worktree: job.startWorktree } : {}),
    origin: coverages.map(coverageField),
    hint: `${done}queued ${jobRef(job.id)} for \`${job.project}\` (${pending} pending).${origin} ${queuedRunnerLine(env, job.id)}${stale ? ` ${stale}` : ""}`,
  };
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

// Bumps `violated` when a job's save dedups onto a lesson its run was given, answering whether it did; a failed bump never fails the save.
async function violatedGivenLesson(saved, env) {
  if (!saved.deduped || callerJobId(env) === null) return false;
  try {
    const { sessionId } = await callerContext(env);
    if (!runInjectedLessonIds(sessionId, env).includes(saved.id)) return false;
    await openStore(env).lessons.bumpViolation(saved.id);
    return true;
  } catch (error) {
    process.stderr.write(`nightqueue: lesson_save could not count the violation of L${saved.id}: ${error?.message ?? String(error)}\n`);
    return false;
  }
}

// `lesson_save` alone: a missing/empty `title` answers a one-line error naming it, never the multi-line zod dump.
function lessonSaveTitleError(args) {
  const title = typeof args?.title === "string" ? args.title.trim() : "";
  if (title) return null;
  return 'lesson_save: missing required field(s): title. Minimal payload: {"title":"...","root_cause":"...","solution":"...","prevention":"..."}';
}

// Validates the arguments here instead of leaving it to the SDK, so the refusal names every problem, the whole contract and what was received - an agent fixes that on the next call instead of repeating the same payload.
function validateArgs(name, inputSchema, args) {
  if (name === "lesson_save") {
    const oneLine = lessonSaveTitleError(args);
    if (oneLine) throw new McpError(ErrorCode.InvalidParams, oneLine);
  }
  const parsed = z.object(inputSchema).safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((problem) => `${problem.path.join(".") || "(root)"}: ${problem.message}`).join("; ");
  const received = Object.keys(args ?? {}).join(", ") || "nothing";
  throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for tool ${name}: ${problems}\n${name} contract:\n${describeSchema(inputSchema)}\nreceived: ${received}`);
}

// The machine-readable error a tool answers when the home database cannot be used at all.
function storeUnavailableAnswer(err) {
  const payload = withContract({ ok: false, error: "store-unavailable", code: err.code, home: err.home, hint: err.hint, message: err.message });
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
      return asText(withContract(await handler(args ?? {})));
    } catch (err) {
      if (err instanceof StoreUnavailableError) return storeUnavailableAnswer(err);
      const message = redactSecrets(err instanceof StaleContractError ? err.message : `${name}: ${err?.message ?? String(err)}`, session.env);
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
    return `${runnersOnlineSplit(runners)} - ${backlog} — ${paused}.`;
  }
  if (runners.length > 0) return `${runnersOnlineSplit(runners)} - ${counts.pending} pending after this one`;
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
async function jobStatusAnswer(id, { store, warning, env }) {
  const job = await jobDetailView(store, id, { prStates: serverPrStates, env });
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
  if (asked.jobId !== undefined) return await jobStatusAnswer(asked.jobId, { store, warning, env });
  if (asked.prUrl !== undefined) return await jobStatusAnswer(await jobIdOfPrUrl(store, asked.prUrl), { store, warning, env });
  const view = await queueView(store, { env, limit: jobLimit(args.limit), prStates: serverPrStates });
  const unread = failedCoreSection(view);
  if (unread?.unavailable) throw unread.unavailable;
  if (unread) throw new UserError(`the queue cannot be read: ${unread.error}`);
  if (view.registryError !== null) throw unreadableRegistry(view.registryError, env);
  const { runners, advisories, jobs, counts, suggestions, closes, activeJobs, sections } = view;
  const stale = staleRuntimeHint(env);
  const advisoriesWithStale = [...advisories, ...(stale ? [stale] : []), ...(state.sawOldShape ? [STALE_CONTRACT_ADVISORY] : [])];
  return {
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

// Reads the queue answer of `queue_status` on a store opened read-only for this read alone; `decorate` runs on the same store before it closes.
// It never creates the store, and never refreshes the pull request cache: the caller does that outside its own frame.
export async function readQueueStatus(env, { limit, decorate = null } = {}) {
  const warning = lastMaintenance(env)?.warning ?? null;
  return await withReadOnlyStore(env, async (store) => {
    const answer = await queueStatusAnswer({ limit }, { store, warning, env, state: newContractState() });
    return decorate ? await decorate(answer, store) : answer;
  });
}

// Refreshes the pull request cache about the URLs an answer showed, outside the frame of that answer.
export function refreshAnsweredPrStates(answer, env) {
  return serverPrStates.refresh(answeredPrUrls(answer), env);
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

// Runs one tracker call with the home's stored secrets redacted from its input before any cut and from its whole answer.
async function trackerAnswer(call, args, env) {
  const answer = await call(redactValue(args, env), { env });
  return redactValue(answer, env);
}

// One tool that writes to the issue tracker, its description ending with the explicit-ok rule and the in-job refusal.
function trackerWriteTool({ name, lead, inputSchema, run }, env) {
  return {
    name,
    config: {
      description:
        `${lead} ` +
        "Writes to the home's issue tracker: call it only after showing the person exactly what will change and getting an explicit ok, never on your own initiative. Refused inside a queue job, and nothing is sent. Never deletes or archives. " +
        "Answers `{ok: false, error: \"no-connection\" | \"invalid-input\" | \"not-found\" | \"provider-unavailable\", hint, provider}` as a normal answer; a `provider-unavailable` hint saying the write may still have been applied means read the issue before trying again.",
      inputSchema,
    },
    handler: (args) => trackerAnswer(run, args, env),
  };
}

// The tracker tools that write: create, comment and update, never delete or archive.
function trackerWriteTools(env) {
  const issueRef = z.string().describe("The issue reference, e.g. `MK-49` or its link.");
  const title = z.string().max(TRACKER_BOUNDS.title);
  const description = z.string().max(TRACKER_BOUNDS.body);
  const priority = z.number().int().min(0).max(4).nullable().optional().describe("0 none, 1 urgent, 2 high, 3 medium, 4 low.");
  const names = z.array(z.string().max(TRACKER_BOUNDS.label)).nullable().optional();
  return [
    {
      name: "tracker_create",
      lead: "Creates one issue in a team of the tracker, with only the fields given. Answers `{ok: true, provider, issue: {ref, title, url}}`. A state, label or assignee name that is unknown or names several is refused with the valid names, and nothing is created.",
      inputSchema: {
        team: z.string().describe("The tracker team key, e.g. `MK`."),
        title: title.describe("The issue title, at most 255 characters."),
        description: description.nullable().optional().describe("The issue description (markdown), at most 50,000 characters."),
        priority,
        state: optionalText.describe("The team state name, e.g. `Todo`."),
        labels: names.describe("Label names, each matched exactly, case-insensitively."),
        assignee: optionalText.describe("A person's name, display name or email, or `me`."),
      },
      run: trackerCreate,
    },
    {
      name: "tracker_comment",
      lead: "Posts one comment on an issue. Answers `{ok: true, provider, ref, comment: {url}}`.",
      inputSchema: {
        ref: issueRef,
        body: description.describe("The whole comment text (markdown), at most 50,000 characters."),
      },
      run: trackerComment,
    },
    {
      name: "tracker_update",
      lead:
        "Changes the given fields of one issue and leaves the rest: `title`, `description` (replaces the whole text), `priority`, `state`, `assignee` (`none` unassigns), `labels_add`, `labels_remove`. " +
        "Answers `{ok: true, provider, issue, changed}` with the issue as the tracker holds it after the edit. A name that is unknown or names several is refused with the valid names, and nothing is changed.",
      inputSchema: {
        ref: issueRef,
        title: title.nullable().optional(),
        description: description.nullable().optional(),
        priority,
        state: optionalText.describe("The team state name, e.g. `In Progress`."),
        assignee: optionalText.describe("A person's name, display name or email, `me`, or `none`."),
        labels_add: names.describe("Label names to add."),
        labels_remove: names.describe("Label names to remove."),
      },
      run: trackerUpdate,
    },
  ].map((tool) => trackerWriteTool(tool, env));
}

// The tool that calls the API behind a stored connection, with the home's secrets redacted from its input and its whole answer.
function connectionCallTool(env) {
  return {
    name: "connection_call",
    config: {
      description:
        "Calls the API behind a stored connection by its name; the runtime injects the secret and never shows it, and the host is fixed by the connection's kind. " +
        "`method` is GET (the default), POST, PATCH or PUT; any other is refused. `path` is relative to the connection's API root (empty for a kind that takes none; a webhook connection takes empty or `messages/<id>` to GET or PATCH a posted message): no scheme, no leading `//`, no `.` or `..` segment, no `\\`, `?` or `#`; query parameters only come through `query`. `body` is JSON, at most 50,000 characters serialized, never on a GET. " +
        "Call any method other than GET only after showing the person exactly what will be sent (connection, method, path, body) and getting an explicit ok, never on your own initiative. Refused inside a queue job, and nothing is sent; a GET is allowed inside a job. In a `nightqueue open` session a non-GET also needs a live `operator_consent` of kind `connection-write` covering it, else it answers `needs-consent` and nothing is sent. " +
        "Answers `{ok: true, status, body, body_truncated?}` with the body redacted and cut at 50,000 characters, or `{ok: false, error: \"no-connection\" | \"invalid-input\" | \"provider-unavailable\" | \"needs-consent\", status, detail}` as a normal answer; a detail saying the call may still have been applied means check before trying again.",
      inputSchema: {
        connection: z.string().describe("A stored connection's name."),
        method: optionalText.describe("GET (default), POST, PATCH or PUT."),
        path: z.string().max(CONNECTION_CALL_BOUNDS.path).nullable().optional().describe("The path under the connection's API root."),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).nullable().optional().describe("Query parameters."),
        body: z.unknown().optional().describe("The JSON body of a POST, PATCH or PUT."),
      },
    },
    handler: async (args) => redactValue(await connectionCall(redactValue(args, env), { env }), env),
  };
}

// Refuses a consent outside a `nightqueue open` session: inside a queue job, or on a server that serves no operator session.
function consentSession(env) {
  const own = callerJobId(env);
  if (own !== null) throw new UserError(`refused: \`operator_consent\` inside job \`${own}\`: a consent is the person's answer in a \`nightqueue open\` session, and a job has no person to ask`);
  const session = operatorSession(env);
  if (session === null) throw new UserError("refused: only a `nightqueue open` session records a consent, and this server serves none");
  return session;
}

// The tool that records what the person consented to in this operator session, the record the operator guard reads.
function operatorConsentTool(env) {
  return {
    name: "operator_consent",
    config: {
      description:
        "Records what the person consented to in this `nightqueue open` session, so the operator guard lets exactly that through: never call it without the person's explicit answer, quoted in `answer`, to an ask that named what, where and how to undo it; never widen a scope the person did not say; `revoke: true` withdraws it. " +
        "`kind` is edit or create (`scope` an absolute path: a file or a directory of the project's checkout; a create outside it names one file), run (one bare command, e.g. `npm test`), git-write (a git subcommand that writes, e.g. `commit`) or connection-write (`<connection> <POST|PATCH|PUT> <path>`, `-` for no path). " +
        "`project` is the registered project (required but for connection-write). Answers `{ok: true, consent, line}` or `{ok: true, revoked, line}`; refused inside a queue job and outside an operator session.",
      inputSchema: {
        project: optionalText,
        kind: z.enum(CONSENT_KINDS),
        scope: z.string().max(2000).describe("Exactly what the person consented to."),
        reason: optionalText.describe("Why the consent is asked (required on a grant)."),
        answer: optionalText.describe("The person's own answer, quoted verbatim (required on a grant)."),
        revoke: z.boolean().nullable().optional(),
      },
    },
    handler: async (args) => {
      const session = consentSession(env);
      const project = args.kind === "connection-write" && !args.project ? null : await memoryProject(args.project, env);
      const result = recordConsent({ session, project, kind: args.kind, scope: args.scope, reason: args.reason, answer: args.answer, revoke: args.revoke === true, env });
      return { ok: true, ...result };
    },
  };
}

// The thirty-three tools of the plugin contract, with the parameter names the plugin actually sends.
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
          "The complete prompt of one /resolve subagent for THIS run, rendered by the runtime from the plugin's templates: the handoff contract, the model of its agent (the default or the project's override) and the context block. " +
          "`triager` renders from the request: inside a job the job's own prompt (plus the operator's gate answer), outside a job the `request` argument, required there. Every other target reads the Brief of `<RUN_DIR>/00-brief.md`, written by `nightqueue run check 01`, and refuses `request`. " +
          "Pass `prompt` to the `Agent` tool verbatim, with the answered `subagent_type` and `model`, then gate the answered `artifact` with `nightqueue run check <check>`. " +
          "`reflector` (Phase 9) renders with no artifact and `check` null: launch it and gate nothing. " +
          "`coder` and `verifier` render the fast-track prompt on trivial/simple; `note` is relaunch context (a fix loop, a re-architect, a re-triage), `raw_evidence` is accepted and ignored, `group` the hypotheses of one prover. " +
          "Inside a job the run is resolved from the job's own row — passing `project` or `slug` there is refused; outside a job both are required.",
        inputSchema: {
          target: z.enum(PROMPT_TARGETS),
          query: optionalText,
          request: optionalText,
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
        description:
          "Records a lesson after fixing an error that was not caught on the first attempt. " +
          "Re-saving an existing lesson's exact title answers `deduped: true` and bumps its `attempts`; inside a job, when the run was given that lesson, it also bumps `violated` and answers `violated: true`.",
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
          violated: await violatedGivenLesson(saved, env),
        };
      },
    },
    {
      name: "lesson_delete",
      config: {
        description:
          "Deletes one lesson by `id` (`L344` or the plain number) of `project` (the registered name or key, required), with its search entry, so it never comes back in `lesson_recall` or `context_for_phase`. " +
          "An unknown id and an id of another project are refused and nothing is deleted. Refused inside a queue job: deleting is the operator's call. The answer names the id and the title that went.",
        inputSchema: { id: z.union([z.number().int(), z.string()]), project: z.string() },
      },
      handler: async (args) => {
        refuseMemoryDeleteInsideJob(env, "`lesson_delete`");
        const project = await deleteProject(args.project, "lesson_delete", env);
        const deleted = await openStore(env).lessons.deleteLesson({ id: parseRecordId(args.id, "L"), projectId: project.id });
        return { ok: true, deleted: true, id: deleted.id, ref: `L${deleted.id}`, title: deleted.title, project: deleted.project };
      },
    },
    {
      name: "memory_recall",
      config: {
        description: "Recalls project facts from the shared memory.",
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
      name: "memory_save",
      config: {
        description:
          "Records one project fact of the code as `key`/`value`. A key the project already has is kept, never overwritten: the answer says `deduped: true` with the stored value. Allowed inside a job.",
        inputSchema: { project: optionalText, key: z.string(), value: z.string() },
      },
      handler: async (args) => {
        const project = await memoryProject(args.project, env);
        const saved = await openStore(env).memory.saveMemoryDeduped({
          projectId: project?.id ?? null,
          key: args.key,
          value: args.value,
        });
        return { ok: true, id: saved.id, ref: `M${saved.id}`, project: project?.name ?? null, deduped: saved.deduped, value: saved.value };
      },
    },
    {
      name: "memory_delete",
      config: {
        description:
          "Deletes one memory by `id` (`M446` or the plain number) of `project` (the registered name or key, required), with its search entry, so it never comes back in `memory_recall` or `context_for_phase`. " +
          "An unknown id and an id of another project are refused and nothing is deleted. Refused inside a queue job: deleting is the operator's call. The answer names the id and the key that went.",
        inputSchema: { id: z.union([z.number().int(), z.string()]), project: z.string() },
      },
      handler: async (args) => {
        refuseMemoryDeleteInsideJob(env, "`memory_delete`");
        const project = await deleteProject(args.project, "memory_delete", env);
        const deleted = await openStore(env).memory.deleteMemory({ id: parseRecordId(args.id, "M"), projectId: project.id });
        return { ok: true, deleted: true, id: deleted.id, ref: `M${deleted.id}`, key: deleted.key, project: deleted.project };
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
          "`task_type` may be left out when the run already recorded it with `run_set`; the durations and the models the runtime measured in the stream are filled in afterwards and always win over the ones sent here. " +
          "`investigated` and `queued` are the operator's outcomes (a session that investigated only, or queued a job): outside a job they are recorded, inside a job they are refused. " +
          "A `reason` recorded with `run_phase_done` is copied onto the rows of the same phase only when `phases` lists exactly as many rows of that phase as the run recorded. Otherwise none of that phase's reasons are copied and `reasons_unpaired` names the phase. Send `reason` on those rows yourself.",
        inputSchema: {
          project: optionalText,
          slug: optionalText,
          tier: ignoredOldField,
          tier_operator: ignoredOldField,
          tier_raise_reason: ignoredOldField,
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
        const reasons = withRecordedReasons(args.phases ?? [], recorded.phases);
        const unpairedField = reasons.unpaired.length > 0 ? { reasons_unpaired: reasons.unpaired } : {};
        const spec = {
          projectId: run.projectId,
          slug: run.slug,
          taskType: args.task_type ?? recorded.taskType,
          outcome: args.outcome,
          gateStop: args.gate_stop,
          durationS: args.duration_s,
          phases: reasons.phases,
        };
        try {
          const logged = await openStore(env).runs.logPipelineRun(spec);
          return { ok: true, runId: logged.runId, project: logged.projectId ? run.project : null, phases: logged.phases, ...unpairedField };
        } catch (err) {
          return { ...queuedPipelineLog(err, spec, env), ...unpairedField };
        }
      },
    },
    {
      name: "queue_add",
      guardsHome: true,
      config: {
        description:
          "Enqueues an unattended /nightqueue:resolve run for a registered project. `project` is the registered NAME, never a path. One job is one self-contained deliverable that can be reviewed and merged on its own. Large work is ONE job with numbered stages written in the prompt — never several jobs that depend on each other. A job that needs another job's pull request merged first is cut wrong: fold it into that job. A prompt that conditions the work on another job or pull request (`after J-<n>`, `once PR #<n> is merged`, `depends on J-<n>` / `depends on job`, `when #<n> lands`, outside code blocks and quoted comment threads) is refused and nothing is queued. Independent jobs may run in parallel and merge in any order. " +
          "This tool only records the job; it never runs it. Queue it now and start the whole batch later with `queue_run` (no `job_id`); start a single job now only when the user asks for that one job now. The hint reports how many runners are live right now, and a job queued with none online waits until `nightqueue queue run` starts one. " +
          "With `project` omitted, `cwd` (the absolute working directory of the caller) resolves the project. When no project is registered for it, the answer is `needs_registration`: ask the user to confirm, then call again with the same `cwd` and `register: true`. Registration never happens without `register: true`.",
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
          title: optionalText.describe(
            "A short human title of the job: one sentence naming the outcome in product language (at most 120 characters, one line; blank means none). `queue_status` lists the job by it until its pull request exists.",
          ),
          priority: z.number().int().min(PRIORITY_RANGE.min).max(PRIORITY_RANGE.max).nullable().optional(),
          max_attempts: z.number().int().min(MAX_ATTEMPTS_RANGE.min).max(MAX_ATTEMPTS_RANGE.max).nullable().optional(),
          timeout_s: z.number().int().min(TIMEOUT_RANGE.min).max(TIMEOUT_RANGE.max).nullable().optional(),
          origin: z
            .array(z.object({ kind: z.string(), ref: z.string() }))
            .nullable()
            .optional()
            .describe(
              "The services the job came from, as a list of `{kind, ref}`; omitted or null, the runtime detects every recognised link of the prompt (outside `<comment-thread>` blocks) with the registered providers; `[]` queues the job with no origin and skips detection. The answer carries `origin` as a list, one entry per origin with the connection that covers it, or `none`.",
            ),
          start_branch: optionalText.describe(
            "An existing branch of the project the job starts on, with its commits. Exclusive with `start_worktree`; only the name is checked now, its existence when the job starts. Omitted means a fresh isolated worktree from the base branch.",
          ),
          start_worktree: optionalText.describe(
            "The absolute path of an existing linked worktree of the project the job works in. Exclusive with `start_branch`; checked when the job starts. Omitted means a fresh isolated worktree from the base branch.",
          ),
        },
      },
      handler: async (args) => {
        requirePrompt(args);
        refuseDependentPrompt(args.prompt);
        const target = await resolveQueueTarget(args, env);
        if (target.offer && args.register !== true) return needsRegistration(target);
        const registered = target.offer ? await registerOffer(target.offer, args.key, env) : null;
        const project = registered ?? target.project;
        const job = await openStore(env).jobs.addJob({
          projectId: project.id,
          prompt: args.prompt,
          priority: args.priority,
          maxAttempts: args.max_attempts,
          timeoutS: args.timeout_s,
          origin: args.origin,
          title: args.title,
          startBranch: args.start_branch,
          startWorktree: args.start_worktree,
        });
        return await queuedAnswer({ job, registered }, env);
      },
    },
    {
      name: "project_register",
      guardsHome: true,
      config: {
        description:
          "Registers the git repository of `cwd` as a project without queueing anything, so its lessons and memories can be used before any job. Call it only after the person said yes to registering it - never on your own initiative. " +
          "`cwd` is the absolute working directory; the repository root is resolved from it, and a linked worktree resolves to its main checkout. `name` defaults to the folder's suggested name, `key` to the suggested key, `org` to the default org (an unknown org is refused with the list of orgs). " +
          "A directory already registered is answered with `registered: false` and the existing project, and nothing is written. Refused from inside a job.",
        inputSchema: {
          cwd: z.string().describe("Absolute path of the working directory of the caller."),
          name: optionalText.describe("The project name; defaults to the suggested name of the folder."),
          key: optionalText.describe("The project key (2 to 5 uppercase letters or digits, starting with a letter); defaults to the suggested key."),
          org: optionalText.describe("The org the project joins; defaults to the default org."),
        },
      },
      handler: async (args) => await registerRepository(args, env),
    },
    {
      name: "project_integrations",
      config: {
        description:
          "Shows or changes the per-provider integration settings of a registered project - what the runtime does with the service a job came from and where it posts after a close. " +
          "`action` `show` reads; `set` stores `value` under `key`, validated against the provider that declares it (a connection value must be a stored connection of that provider bound to the project's org); `unset` removes `key`, and removing the last one leaves the project without integrations, behaving exactly as before. " +
          "`key` is `<kind>.<setting>` as listed in `providers` of every answer. Answers `{project, integrations, providers: [{kind, keys}]}`; never a secret. `set` and `unset` change the operator's home: call them only after the person said yes, and they are refused from inside a job.",
        inputSchema: {
          project: z.string().describe("The registered project name."),
          action: z.enum(INTEGRATION_ACTIONS).describe("`show`, `set` or `unset`."),
          key: optionalText.describe("The setting, `<kind>.<setting>`; required by `set` and `unset`."),
          value: optionalText.describe("The value `set` stores, as text: a list is comma-separated, a boolean is `true` or `false`."),
        },
      },
      handler: async (args) => (args.action === "show" ? await showProjectIntegrations(args, env) : await changeProjectIntegrationsAnswer(args, env)),
    },
    {
      name: "tracker_issues",
      config: {
        description:
          "Read-only: lists the issues of the home's issue-tracker connection, newest update first, filtered by the service's own `team` key and `project` name - no nightqueue project argument. " +
          "`state` is `open` (default), `closed` or `all`; `limit` 1..50 (default 25), `truncated: true` when more matched; `include_filters: true` adds `filters` (`teams`, `projects`), cached for five minutes. " +
          "`text` searches the title or the description, case-insensitively, and a text that is an issue id (`DLW-136`, `dlw 136`, `DLW136`, or a bare `136` for that number in the `team` or in every team) finds that issue instead; `label` keeps the issues carrying that one label, matched exactly, case-insensitively; both combine with every other filter. " +
          "Answers `{ok: true, provider, items: [{ref, title, team, state, priority, priorityLabel, labels, labelDetails: [{name, color}], url, updatedAt}], truncated}`, or `{ok: false, error: \"no-connection\" | \"provider-unavailable\", hint, provider}` as a normal answer. " +
          "Queueing from an item is `queue_add` with `origin: [{kind: provider, ref}]` and the nightqueue `project`, after the person said yes.",
        inputSchema: {
          team: optionalText.describe("The tracker team key, e.g. `MK`."),
          project: optionalText.describe("The tracker project name."),
          state: z.enum(TRACKER_STATES).nullable().optional(),
          limit: z.number().int().min(TRACKER_LIMIT.min).max(TRACKER_LIMIT.max).nullable().optional(),
          include_filters: z.boolean().nullable().optional(),
          text: z.string().max(TRACKER_BOUNDS.text).nullable().optional().describe("Text the title or the description contains."),
          label: z.string().max(TRACKER_BOUNDS.label).nullable().optional().describe("One label name."),
        },
      },
      handler: (args) => trackerAnswer(trackerIssues, args, env),
    },
    {
      name: "tracker_read",
      config: {
        description:
          "Read-only: reads one issue of the home's issue-tracker connection whole - no nightqueue project argument, allowed inside a queue job. " +
          "Answers `{ok: true, provider, issue: {ref, title, url, team: {key, name}, project, state: {name, type}, priority, priorityLabel, assignee, labels, parent, description, description_truncated, attachments: [{title, url}], comments: [{author, createdAt, body}], comments_truncated, createdAt, updatedAt}}`; " +
          "an empty field is `null` or `[]`, up to 50 comments are returned oldest first, each cut at 10,000 characters, `comments_truncated` true when there are more, and the description is cut at 50,000. " +
          "Answers `{ok: false, error: \"no-connection\" | \"invalid-input\" | \"not-found\" | \"provider-unavailable\", hint, provider}` as a normal answer.",
        inputSchema: {
          ref: z.string().describe("The issue reference, e.g. `MK-49` or its link."),
        },
      },
      handler: (args) => trackerAnswer(trackerRead, args, env),
    },
    ...trackerWriteTools(env),
    connectionCallTool(env),
    operatorConsentTool(env),
    {
      name: "queue_status",
      config: {
        description:
          "State of the queue: one job by `job_id` (its ref `J-77` or plain id) or by `pr_url` (the pull request it opened), or the most recent ones plus the counts per status and every live runner in `runners` (`runnersOnline` is the count of `runners`; there is no singular `runner` key). The `hint` leads with the live-runner count, and says that a job queued with none online waits until `nightqueue queue run` starts one. " +
          "The `hint` ends with the advisory lines when they apply - a five-hour window close to its limit while runners are live, or two or more runners on one repository - also listed under `advisories`; they never block anything. Never returns the prompt. " +
          "`notice_md` is the reason a job stopped - a job in `gate` always carries one; answer it with `queue_retry`; a gate with `blocked_code` is a preflight block: fix the cause and `queue_retry` it with no note. " +
          "The listing cuts `notice_md` and `result` at 500 characters and marks a cut row with `notice_truncated: true` or `result_truncated: true` (the key is absent when the text fits); call again with that `job_id` for the whole text. " +
          "`sections` carries each part of the read with `ok`, `error` and elapsed `ms`, and `pr_state` of each job comes from a cache refreshed outside the answer (`unknown` until gh answered); " +
          "a `running` job carries `live` (agent, lane intent, last action, partial tokens, `source: \"log-tail\"`), every other job `live: null`, and `sections` has a `live` entry; " +
          "a merged pull request on a `done` job is listed in `suggestions`, and closing it is `queue_close`. `closes` groups the closes in flight, failed and stalled. " +
          "`resolution` is `no-change` on a done or closed job resolved without a code change, else null. " +
          "`tokens_*`, `cache_*`, `cost_usd` and the host/orchestrator counters are totals across every attempt; `attempts_log` lists one row per claim of the job (released, parked and lost ones included, `spawns` counts the runner's inner re-spawns inside that claim, `fresh: true` after a `--fresh` retry); `attempts` stays the retry budget counter, which inner re-spawns also increment; `active_s` is the sum of the rows' durations and `wall_s` the span from the first start.",
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
        void refreshAnsweredPrStates(answer, env);
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
          "A done job resolved without change is cancelled like any done job; nothing is sent to its origins. " +
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
          "Closes a job: takes its open pull request to merged and the job to `closed`, through the code pipeline preflight, conflict, merge, settle, then the post-close steps ota, origin and log, which never stop a close (a failure is a line in `notice_md`) - run by code, never by an agent; the conflict step may hand a small textual conflict to the bounded merger agent (see the runtime contract). " +
          "A `done` job with no pull request, resolved without change, closes too: preflight, conflict and merge are recorded as skipped, it ends `closed` with `resolution: no-change`, and origin and log tell the origins it was resolved without a code change with the run's conclusion. `closed` means the pull request was merged through this pipeline OR the job was resolved without change through it. " +
          "It starts DETACHED and returns immediately with the pid and the log path; it never waits for the merge. Follow it with `queue_status` and the job id. " +
          "Only a `done` job is closed. `closed`, `running`, `pending`, `gate`, `failed`, `cancelled`, a job already being closed under a live lease, and `force` on a job with no pull request are refused by name, and nothing is written. Refused inside an unattended run. " +
          "A close that stopped keeps its checklist and its reason on the job (`close`, `close_status: failed`); calling this tool again resumes it at the step that failed. " +
          "`force` skips the pull request checks and the rebase test suite only, and never runs the merger; conflicts, a pull request that is not the job's own and the job's status still stop the close. " +
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
          "Sends a gated, failed or cancelled job back to the queue. A gated job only moves with `note`, which reaches the run as the answer to its gate - except a job the preflight gated (its `blocked_code` is set: dirty checkout, wrong branch, missing checkout or `claude`, or `store-unavailable`: the session could not reach this server), which moves without one once its cause is fixed. A finished job never resumes: a `closed` job, or a `done` job whose pull request is merged, is refused with \"a finished job does not resume; queue a new one\". " +
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
        const answer = started ? runnerAnswer(started, env, await startAdvisoryLines({ env })) : { runner: null, hint: queuedRunnerLine(env, job.id) };
        return { ok: true, job, runDir, ...answer };
      },
    },
    {
      name: "run_phase_done",
      config: {
        description:
          "Records one completed phase of the run in `state.json`, so a retry resumes from the next one. The runtime stamps the time and owns the file: never hand-write `state.json`. " +
          "Inside a job the run is resolved from the job's own row — passing `project` or `slug` there is refused; outside a job both are required. " +
          "`reason` = why this phase ran again (a fix loop, a relaunch after `MISSING`, a re-architect, a re-triage); omit it on the first run of a phase.",
        inputSchema: {
          phase: z.enum(RESUME_PHASE_ORDER),
          artifact: optionalText,
          verdict: optionalText,
          note: optionalText,
          reason: optionalText,
          project: optionalText,
          slug: optionalText,
        },
      },
      handler: async (args) => {
        const run = await callerRun(args, env);
        const done = { phase: args.phase, artifact: args.artifact, verdict: args.verdict, note: args.note, reason: args.reason };
        return runAnswer(recordPhaseDone({ ...run, ...done, env }), run);
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
      name: "run_skip",
      config: {
        description:
          "Records that an agent skips a later phase of the run, with who decided it and why, so the studio track shows the slot as skipped. " +
          "It only records: it changes no routing and no resume, and a phase that still runs shows as run. A phase that already ran is refused. " +
          "Inside a job the run is resolved from the job's own row — passing `project` or `slug` there is refused; outside a job both are required.",
        inputSchema: { phase: z.enum(RESUME_PHASE_ORDER), by: z.enum(SKIP_AGENTS), reason: z.string(), project: optionalText, slug: optionalText },
      },
      handler: async (args) => {
        const run = await callerRun(args, env);
        return runAnswer(recordSkip({ ...run, phase: args.phase, by: args.by, reason: args.reason, env }), run);
      },
    },
    {
      name: "run_outcome",
      config: {
        description:
          "Records how the run ended: `done` when the pull request exists, `gate` with the `notice` the operator has to answer, `no_change` with the run's conclusion as `notice` when the run concluded on purpose that no code change is needed (the job ends `done` with no pull request). " +
          "A `gate` may instead send `question` and/or `from_artifact: {file, section}` (a run artifact such as `03-plan.md` and a heading such as `## Requires user confirmation`): the runtime composes the whole `## Notice` body - the section verbatim under `## Requires user confirmation`, the question, and the answer line - and returns it as `notice`; then end the turn, with no `## Notice` in the final text. `notice` together with either is refused. " +
          "The pull request URL is NOT a parameter: the runtime writes it from what the session really published. " +
          "Inside a job the run is resolved from the job's own row — passing `project` or `slug` there is refused; outside a job both are required.",
        inputSchema: {
          status: z.enum(RUN_OUTCOME_STATUSES),
          notice: optionalText,
          question: optionalText,
          from_artifact: z.object({ file: z.string(), section: z.string() }).nullable().optional(),
          project: optionalText,
          slug: optionalText,
        },
      },
      handler: async (args) => {
        const run = await callerRun(args, env);
        if (!wantsComposedNotice(args)) return runAnswer(recordOutcome({ ...run, status: args.status, notice: args.notice, env }), run);
        const notice = composedGateNotice(args, run, env);
        return { ...runAnswer(recordOutcome({ ...run, status: args.status, notice, env }), run), notice };
      },
    },
    {
      name: "run_set",
      config: {
        description:
          "Records the fields of the run itself in `state.json` as the pipeline discovers them: its `type` and the branch and worktree the code lives in. Only the fields sent are touched. " +
          "`qa_stage_a` records the one sub-phase with a marker of its own — sent when the QA stage A gate closes, it is what makes a resume re-enter the QA phase straight at stage B instead of paying the analyst again. " +
          "Inside a job the run is resolved from the job's own row — passing `project` or `slug` there is refused; outside a job both are required.",
        inputSchema: {
          type: z.enum(PIPELINE_TASK_TYPES).nullable().optional(),
          branch: optionalText,
          worktree: optionalText,
          qa_stage_a: z.object({ artifact: z.string(), verdict: optionalText }).optional(),
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

// Puts the older-definitions refusal in front of the SDK's tool call, so a removed tool is never answered as an unknown one.
function refuseRemovedToolCalls(server, state) {
  const callTool = server.server._requestHandlers?.get("tools/call");
  if (typeof callTool !== "function") throw new Error("nightqueue: the MCP SDK has no tools/call handler to wrap, so a removed tool cannot be refused");
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      refuseRemovedTool(request.params?.name, state);
    } catch (err) {
      if (!(err instanceof StaleContractError)) throw err;
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    return await callTool(request, extra);
  });
}

// Builds the MCP server with the thirty-three tools of the plugin contract.
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
    { instructions: serverInstructions(env) },
  );
  const state = newContractState();
  const session = { env, state };
  const schemas = new Map();
  for (const tool of toolDefinitions(env, state)) {
    schemas.set(tool.name, tool.config.inputSchema);
    server.registerTool(tool.name, tool.config, guard(tool.name, toolHandler(tool, env), session));
  }
  refuseRemovedToolCalls(server, state);
  // The SDK validates the call before the handler and refuses with one problem; this refusal carries every problem, the whole contract and what was received, which is what lets an agent fix the next call instead of repeating the same payload.
  server.validateToolInput = async (tool, args, toolName) => {
    refuseRenamedFields(toolName, args, state);
    refuseOldShapes(toolName, args, state);
    refuseRetiredFields(toolName, args);
    return validateArgs(toolName, schemas.get(toolName) ?? tool.inputSchema, args);
  };
  return server;
}
