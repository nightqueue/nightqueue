import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { saveProject } from "../cli/project.mjs";
import { UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { projectByName, registrationOffer, resolveProject } from "../config/projects.mjs";
import { loadConfig, saveConfig } from "../config/store.mjs";
import { DECISION_STATUSES, decisionFullView, decisionView } from "../memory/decisions.mjs";
import { SCOPE_CONFLICT, SCOPE_MISSING, ownerDescription } from "../memory/scope.mjs";
import {
  MAX_ATTEMPTS_RANGE,
  PRIORITY_RANGE,
  TIMEOUT_RANGE,
} from "../memory/jobs.mjs";
import { LESSON_TARGETS, lessonView } from "../memory/lessons.mjs";
import { memoryView } from "../memory/memory.mjs";
import {
  PROMPT_SOURCE_CONFLICT,
  PROMPT_SOURCE_MISSING,
  ROADMAP_HORIZONS,
  ROADMAP_STATUSES,
  roadmapItemView,
} from "../memory/roadmap.mjs";
import { startAdvisoryLines } from "../queue/advisory.mjs";
import { noRunnerWait, parkedBacklogLine, pausedRunnerLine, pendingJobs, runnersOnline, windowWaitingLine } from "../queue/hints.mjs";
import { refuseHomeWriteInsideJob } from "../queue/home-guard.mjs";
import { blockerLines } from "../queue/claim.mjs";
import { closeJobAndWorktree } from "../queue/close.mjs";
import { lastMaintenance } from "../queue/maintenance.mjs";
import { createPrStateCache } from "../queue/pr-state.mjs";
import { liveRunnersReport, STOPPED_RUNNER, unreadableRegistry } from "../queue/registry.mjs";
import { failedCoreSection, jobDetailView, prUrlsOf, queueView } from "../queue/view.mjs";
import { isSafeSegment, readRunState, RESUME_PHASE_ORDER } from "../queue/resume.mjs";
import { applyRetry, callerJobId } from "../queue/retry.mjs";
import { resolveJobSession } from "../queue/session.mjs";
import {
  recordOutcome,
  recordPhaseDone,
  recordRunFields,
  recordTermination,
  RUN_OUTCOME_STATUSES,
} from "../queue/run-state.mjs";
import { startQueueRunner } from "../queue/start.mjs";
import {
  PIPELINE_GATE_STOPS,
  PIPELINE_OUTCOMES,
  PIPELINE_PHASE_STATUSES,
  PIPELINE_TASK_TYPES,
  PIPELINE_TIERS,
} from "../memory/runs.mjs";
import { ensureStoreExists, openStore, withReadOnlyStore } from "../store/open.mjs";
import { callerContext, PHASE_TARGETS, phaseContextBlock, recallFreshLessons } from "./phase-context.mjs";

const SERVER_NAME = "nightshift";
const SERVER_VERSION = "0.1.0";
const SERVER_INSTRUCTIONS = [
  "nightshift is a backlog of unattended coding jobs, not a synchronous executor: `queue_add` records work, it never runs it.",
  "Queue every task or plan the moment it comes up - one job is one self-contained deliverable, and a large plan is ONE job with numbered stages written in the prompt, never several jobs that depend on each other.",
  "Do not start jobs as they are queued: the whole batch starts with `queue_run` without `job_id`, when the user is about to step away.",
  "Start a single job now, with `queue_run` and its `job_id`, only when the user asks for that one job now.",
  "Every job ends as an open pull request (`done`) or stopped at a gate with its reason in `notice_md`, which is answered with `queue_retry`.",
  "Call `queue_status` to see what is pending before suggesting a batch.",
  "decisions are the project's standing constraints - recall them before proposing architecture and save one when the user settles a design question",
  'the roadmap is where "what next" lives - read it before suggesting work, and queue from it with `roadmap_item_id`',
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
const optionalNumbers = z.array(z.number().int().min(1)).nullable().optional();
const optionalDecisionStatus = z.enum(DECISION_STATUSES).nullable().optional();
const looseDecisionStatus = z.string().nullable().optional();
const optionalRoadmapStatus = z.enum(ROADMAP_STATUSES).nullable().optional();

const phaseSchema = z.object({
  phase: z.string(),
  model: z.string().nullable().optional(),
  status: z.enum(PIPELINE_PHASE_STATUSES).nullable().optional(),
  retry: z.boolean().nullable().optional(),
  duration_s: z.number().int().min(0).nullable().optional(),
  note: z.string().nullable().optional(),
});

// Requires the project of a job to be a registered NAME, because a path never resolves to a project.
function requireProjectName(name, env) {
  const project = projectByName(loadConfig(env, { warn: () => {} }), name);
  if (project) return project.name;
  throw new UserError(
    `unknown project \`${name}\`: pass the registered project NAME, not a path; list them with \`nightshift project list\``,
  );
}

// Refuses to register a project from inside an unattended run: there is no user there to confirm it.
function refuseRegistrationInsideJob(cwd, env) {
  const own = callerJobId(env);
  if (own === null) return;
  throw new UserError(
    `refusing to register ${cwd} from inside job \`${own}\`: an unattended run never registers a project; ` +
      "ask the operator to run `nightshift init` there",
  );
}

// Project of the run this process belongs to; null outside a job, and null too when the job id names no job.
async function callerProject(own, env) {
  return (await openStore(env).jobs.getJob(own))?.project ?? null;
}

// Refuses a row of ANOTHER owner from inside an unattended run: a job may only rewrite the decisions and the roadmap of its own project, never its org's.
async function requireOwnProject({ kind, id, row }, env) {
  const own = callerJobId(env);
  if (own === null) return;
  const mine = await callerProject(own, env);
  if (mine !== null && row?.scope !== "org" && mine === (row?.project ?? null)) return;
  throw new UserError(
    `refusing to update ${kind} \`${id}\` from inside job \`${own}\`: it belongs to ${ownerDescription(row)}, ` +
      `not \`${mine ?? "unknown"}\`; an unattended run may only update its own project, ` +
      "so ask the operator to do it outside the queue",
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

// The run of the job this process belongs to, read from its own row.
async function jobRun(own, args, env) {
  const named = [
    ["project", args.project],
    ["slug", args.slug],
  ].filter(([, value]) => typeof value === "string" && value.trim() !== "");
  if (named.length > 0) refuseNamedRun(named.map(([name, value]) => [name, value.trim()]), own);
  const row = await openStore(env).jobs.getJob(own);
  if (!isSafeSegment(row?.slug)) refuseMissingRunSlug(own);
  return { project: row.project, slug: row.slug };
}

// The run an operator names from outside a job, where nothing else can tell which one it is.
function operatorRun(args, env) {
  const project = typeof args.project === "string" ? args.project.trim() : "";
  const slug = typeof args.slug === "string" ? args.slug.trim() : "";
  if (!project || !slug) {
    throw new UserError(
      "outside a job, `project` (the registered NAME) and `slug` (the `<slug>` of runs/<project>/<slug>) are both required",
    );
  }
  if (!isSafeSegment(slug)) {
    throw new UserError(`invalid slug \`${slug}\`: a run slug is one path segment of letters, digits and \`. _ + -\``);
  }
  return { project: requireProjectName(project, env), slug };
}

// The run every `run_*` tool writes into: the caller's own job run, or the one an operator named.
async function callerRun(args, env) {
  const own = callerJobId(env);
  return own === null ? operatorRun(args, env) : await jobRun(own, args, env);
}

// The run a `pipeline_log` call records: inside a job the job's own row names it, whatever the call sent, and outside one only the call can say which run it is.
async function pipelineLogRun(args, env) {
  const own = callerJobId(env);
  const row = own === null ? null : await openStore(env).jobs.getJob(own);
  if (isSafeSegment(row?.slug)) return { project: row.project, slug: row.slug };
  const slug = typeof args.slug === "string" ? args.slug.trim() : "";
  if (!slug) {
    throw new UserError(
      "this run cannot be identified: send `project` (the registered NAME) and `slug` (the `<slug>` of runs/<project>/<slug>); " +
        "only a call from inside a job, whose row already carries them, may omit the pair",
    );
  }
  return { project: args.project, slug };
}

// What the RUN already recorded about itself, the source of every field a `pipeline_log` call may now omit.
function runFacts({ project, slug }, env) {
  const state = readRunState({ project, slug, env });
  return { tier: state?.tier ?? null, taskType: state?.type ?? null, tierRaiseReason: state?.tierRaiseReason ?? null };
}

// Requires a field neither the call nor the run resolved, saying which tool would have recorded it during the run.
function requireLogged(field, value) {
  if (value !== null && value !== undefined && value !== "") return value;
  throw new UserError(
    `\`${field}\` is required: send it, or record it during the run with \`run_set\` so this call can leave it out`,
  );
}

// Closes the roadmap item of the job this process belongs to, once its run recorded a delivery; outside a job there is no item to close.
async function closeCallerRoadmapItem(env) {
  const own = callerJobId(env);
  if (own === null) return;
  await openStore(env).roadmap.closeForJob(own);
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

// The registered NAME the caller asked for, or null when it named no project at all.
function namedProject(project, env) {
  if (typeof project !== "string" || project.trim() === "") return null;
  return requireProjectName(project, env);
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
    scope: saved.scope,
    owner: saved.org ?? saved.project,
    ...(saved.superseded.length ? { superseded: saved.superseded } : {}),
    ...(saved.jobId !== null ? { job_id: saved.jobId } : {}),
    ...(saved.statusDefaulted ? { status_defaulted: true } : {}),
  };
}

// Owner a decisions or roadmap tool names: `project` (the registered NAME) XOR `org`, refusing both and neither.
function ownerArgs(args, env) {
  const project = typeof args.project === "string" && args.project.trim() !== "" ? args.project.trim() : null;
  const org = typeof args.org === "string" && args.org.trim() !== "" ? args.org.trim() : null;
  if (project && org) throw new UserError(SCOPE_CONFLICT);
  if (org) return { org };
  if (!project) throw new UserError(SCOPE_MISSING);
  return { project: requireProjectName(project, env) };
}

// Project the job goes to, or the offer to register the directory of the caller when nothing is registered for it.
function resolveQueueTarget({ project, cwd }, env) {
  const named = namedProject(project, env);
  if (named) return { project: named };
  const path = requireCwd(cwd);
  const config = loadConfig(env, { warn: () => {} });
  const resolved = resolveProject(config, { cwd: path });
  if (resolved) return { project: resolved.name };
  refuseRegistrationInsideJob(path, env);
  const offer = registrationOffer(config, path);
  if (!offer) {
    throw new UserError(
      `no project registered for ${path}, and it is not inside a git repository; pass the registered project NAME (\`nightshift project list\`)`,
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
    org: offer.org,
    hint:
      `no project is registered for \`${cwd}\`; ask the user to confirm registering it as \`${offer.name}\` in org ` +
      `\`${offer.org}\`, then call queue_add again with the same \`cwd\` and \`register: true\`. Nothing was queued.`,
  };
}

// Registers the repository the offer names, taking the configuration lock this server never takes for itself.
async function registerOffer(offer, env) {
  const ctx = { env, out: () => {}, err: () => {}, saveConfig };
  const { project } = await withLock(env, () => saveProject(ctx, { path: offer.path, name: offer.name }));
  return project;
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
  const { runners, error } = liveRunnersReport(env);
  if (error !== null) return "Start the batch with queue_run when you are ready.";
  if (runners.length === 0) return `${noRunnerWait()}.`;
  const paused = pausedRunnerLine(runners);
  if (paused) return `${runnersOnline(runners.length)} - nothing to start: ${paused}; it claims again by itself when the limit resets.`;
  const waiting = windowWaitingLine(runners);
  if (waiting) return `${waiting}; it claims once the window opens.`;
  return `${runnersOnline(runners.length)} - it will be picked up.`;
}

// The answer of `queue_add`: the job it recorded, and the roadmap item behind it when there is one.
async function queuedAnswer({ job, registered = null, roadmapItemId = null, note = "" }, env) {
  const pending = (await openStore(env).jobs.countsByStatus()).pending;
  const done = registered ? `registered project \`${registered.name}\` (${registered.path}). ` : "";
  return {
    ok: true,
    id: job.id,
    project: job.project,
    priority: job.priority,
    timeoutS: job.timeoutS,
    ...(roadmapItemId === null ? {} : { roadmapItemId }),
    ...(job.tier ? { tier: job.tier } : {}),
    hint: `${done}queued job #${job.id} for \`${job.project}\` (${pending} pending).${note} ${queuedRunnerLine(env)}`,
  };
}

// What the answer of a roadmap-built job adds: an org item fathers one job per project and is closed by the operator.
function roadmapNote(item) {
  if (item.scope !== "org") return "";
  return ` Roadmap item #${item.id} belongs to org \`${item.org}\`: it stays \`open\` and unlinked, so queue it for the other projects of the org too and mark it done yourself.`;
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

// Wraps a handler so a business failure comes back as a clear message instead of a raw exception.
function guard(name, handler) {
  return async (args) => {
    try {
      return asText(await handler(args ?? {}));
    } catch (err) {
      return { content: [{ type: "text", text: `${name}: ${err?.message ?? String(err)}` }], isError: true };
    }
  };
}

// The one-line nudge queue_status answers with, leading with the live-runner count; a rate limit is what the agent hears
// next - the one a live runner waits out, or the one a backlog was parked by after its runner exited - so it never starts
// a batch that would only sleep.
function queueHint({ activeJobs, counts, runners, jobs = [] }) {
  const paused = pausedRunnerLine(runners);
  if (paused) {
    const backlog = counts.pending === 0 ? "nothing is pending" : `${pendingJobs(counts.pending)} waiting`;
    return `${runnersOnline(runners.length)} - ${backlog} — ${paused}.`;
  }
  if (runners.length > 0) return `${runnersOnline(runners.length)} - ${counts.pending} pending after this one`;
  if (activeJobs > 0) {
    return `${runnersOnline(0)} - a job is running under a one-shot runner, nothing will pick up the pending jobs after it - start a drain with \`nightshift queue run\``;
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

// The answer of `queue_status` for the tail of the queue, mapped from the one queue view every surface renders.
async function queueStatusAnswer(args, { store, warning, env }) {
  if (Number.isInteger(args.job_id)) return await jobStatusAnswer(args.job_id, { store, warning });
  const view = await queueView(store, { env, limit: jobLimit(args.limit), prStates: serverPrStates });
  const unread = failedCoreSection(view);
  if (unread) throw new UserError(`the queue cannot be read: ${unread.error}`);
  if (view.registryError !== null) throw unreadableRegistry(view.registryError, env);
  const { runners, advisories, jobs, counts, suggestions, activeJobs, sections } = view;
  return {
    runner: runners[0] ?? STOPPED_RUNNER,
    runners,
    runnersOnline: runners.length,
    advisories,
    jobs,
    counts,
    suggestions,
    sections,
    hint: [queueHint({ activeJobs, counts, runners, jobs }), ...advisories, ...suggestions].join(" "),
    ...warningAnswer(warning),
  };
}

// The pull request URLs an answer of `queue_status` shows, the ones its cache is refreshed about after the answer left.
function answeredPrUrls(answer) {
  return prUrlsOf(answer.job ? [answer.job] : answer.jobs);
}

// The twenty-five tools of the plugin contract, with the parameter names the plugin actually sends.
function toolDefinitions(env) {
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
            project: args.project,
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
        const saved = await openStore(env).lessons.saveLessonDeduped({
          project: args.project,
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
          project: saved.project,
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
          project: args.project,
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
          project: args.project,
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
          project: args.project,
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
          "`tier`, `task_type` and `tier_raise_reason` may be left out when the run already recorded them with `run_set`; the durations and the models the runtime measured in the stream are filled in afterwards and always win over the ones sent here.",
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
        const run = await pipelineLogRun(args, env);
        const recorded = runFacts(run, env);
        const logged = await openStore(env).runs.logPipelineRun({
          project: run.project,
          slug: run.slug,
          tier: requireLogged("tier", args.tier ?? recorded.tier),
          tierOperator: args.tier_operator,
          tierRaiseReason: args.tier_raise_reason ?? recorded.tierRaiseReason,
          taskType: args.task_type ?? recorded.taskType,
          outcome: args.outcome,
          gateStop: args.gate_stop,
          durationS: args.duration_s,
          phases: args.phases ?? [],
        });
        return { ok: true, runId: logged.runId, project: logged.project, phases: logged.phases };
      },
    },
    {
      name: "queue_add",
      guardsHome: true,
      config: {
        description:
          "Enqueues an unattended /nightshift:resolve run for a registered project. `project` is the registered NAME, never a path. One job is one self-contained deliverable that can be reviewed and merged on its own. Large work is ONE job with numbered stages written in the prompt — never several jobs that depend on each other. A job that needs another job's pull request merged first is cut wrong: fold it into that job. Independent jobs may run in parallel and merge in any order. " +
          "This tool only records the job; it never runs it. Queue it now and start the whole batch later with `queue_run` (no `job_id`); start a single job now only when the user asks for that one job now. The hint reports how many runners are live right now, and a job queued with none online waits until `nightshift queue run` starts one. " +
          "With `project` omitted, `cwd` (the absolute working directory of the caller) resolves the project. When no project is registered for it, the answer is `needs_registration`: ask the user to confirm, then call again with the same `cwd` and `register: true`. Registration never happens without `register: true`. " +
          "With `roadmap_item_id` and no `prompt`, the job prompt is built from that roadmap item, its linked decision and the accepted decisions related to it; a project item is marked `queued` and flips to `done` when the job finishes. " +
          "An ORG roadmap item needs an explicit `project` of that org, because a job is always one project's: it stays `open` and unlinked, so the same item may be queued for every project of the org and only the operator closes it.",
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
          prompt: z
            .string()
            .nullable()
            .optional()
            .describe(
              "The whole request, as prose. One self-contained deliverable that can be reviewed and merged on its own; large work goes here as ONE prompt with numbered stages (`Stages: 1) ... 2) ...`), never as several jobs that depend on each other.",
            ),
          roadmap_item_id: optionalId,
          priority: z.number().int().min(PRIORITY_RANGE.min).max(PRIORITY_RANGE.max).nullable().optional(),
          max_attempts: z.number().int().min(MAX_ATTEMPTS_RANGE.min).max(MAX_ATTEMPTS_RANGE.max).nullable().optional(),
          timeout_s: z.number().int().min(TIMEOUT_RANGE.min).max(TIMEOUT_RANGE.max).nullable().optional(),
          tier: z
            .enum(PIPELINE_TIERS)
            .nullable()
            .optional()
            .describe("Risk tier of the job, set by the operator. The pipeline may only raise it, with evidence, never lower it."),
        },
      },
      handler: async (args) => {
        if (wantsRoadmapItem(args)) {
          const queued = await openStore(env).roadmap.queueRoadmapItem({
            id: args.roadmap_item_id,
            project: namedProject(args.project, env),
            priority: args.priority,
            maxAttempts: args.max_attempts,
            timeoutS: args.timeout_s,
            tier: args.tier,
          });
          return await queuedAnswer({ job: queued.job, roadmapItemId: queued.item.id, note: roadmapNote(queued.item) }, env);
        }
        const target = resolveQueueTarget(args, env);
        if (target.offer && args.register !== true) return needsRegistration(target);
        const registered = target.offer ? await registerOffer(target.offer, env) : null;
        const job = await openStore(env).jobs.addJob({
          project: registered?.name ?? target.project,
          prompt: args.prompt,
          priority: args.priority,
          maxAttempts: args.max_attempts,
          timeoutS: args.timeout_s,
          tier: args.tier,
        });
        return await queuedAnswer({ job, registered }, env);
      },
    },
    {
      name: "queue_status",
      config: {
        description:
          "State of the queue: one job by id, or the most recent ones plus the counts per status and every live runner in `runners` (`runner` is the first of them, kept for one release; `runnersOnline` is the count of `runners`). The `hint` leads with the live-runner count, and says that a job queued with none online waits until `nightshift queue run` starts one. " +
          "The `hint` ends with the advisory lines when they apply - a five-hour window close to its limit while runners are live, or two or more runners on one repository - also listed under `advisories`; they never block anything. Never returns the prompt. " +
          "`notice_md` is the reason a job stopped - a job in `gate` always carries one; answer it with `queue_retry`. " +
          "The listing cuts `notice_md` and `result` at 500 characters and marks a cut row with `notice_truncated: true` or `result_truncated: true` (the key is absent when the text fits); call again with that `job_id` for the whole text. " +
          "`sections` carries each part of the read with `ok`, `error` and elapsed `ms`, and `pr_state` of each job comes from a cache refreshed outside the answer (`unknown` until gh answered); " +
          "a merged pull request on a terminal job (`done`, `failed`, `gate` or `cancelled`) is listed in `suggestions`, and closing it is `queue_close`.",
        inputSchema: {
          job_id: z.number().int().min(1).nullable().optional(),
          limit: z.number().int().min(JOB_LIST_LIMIT.min).max(JOB_LIST_LIMIT.max).nullable().optional(),
        },
      },
      handler: async (args) => {
        await ensureStoreExists(env);
        const warning = lastMaintenance(env)?.warning ?? null;
        const answer = await withReadOnlyStore(env, (store) => queueStatusAnswer(args, { store, warning, env }));
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
          "The runner exits by itself once the queue is empty; `nightshift queue run --stop` ends every runner, `--stop <pid>` ends one. " +
          "Each runner works one job at a time; parallel jobs come from starting more runners. `advisories` warns, from the provider's real five-hour utilization and the live leases, when another runner would likely hit the rate limit or fight over one repository - it never blocks a start.",
        inputSchema: { job_id: z.number().int().min(1).nullable().optional() },
      },
      handler: async (args) => {
        const started = await startQueueRunner({ jobId: Number.isInteger(args.job_id) ? args.job_id : null, env });
        return { ok: true, ...runnerAnswer(started, env, await startAdvisoryLines({ env })) };
      },
    },
    {
      name: "queue_session",
      config: {
        description:
          "The claude session of a job's last attempt: its attempt number, session id and the cwd it ran in (the run's worktree, or the project's checkout when that worktree was already released, with `worktree_released: true`). " +
          "Never resumes it - this tool only reads; resume it yourself with `claude --resume <session>` in `cwd`, or run `nightshift queue session <job_id>` in a terminal. " +
          "`pending` and `running` are refused by name: a live runner owns a running job, and a pending one has not run yet. A job that never reached the agent has no session to answer with, and is refused too.",
        inputSchema: { job_id: z.number().int().min(1) },
      },
      handler: async (args) => {
        const job = await openStore(env).jobs.getJob(args.job_id);
        if (!job) throw new UserError(`unknown job \`${args.job_id}\``);
        const resolved = resolveJobSession(job, env);
        return { job_id: resolved.jobId, attempt: resolved.attempt, session: resolved.session, cwd: resolved.cwd, worktree_released: resolved.worktreeReleased };
      },
    },
    {
      name: "queue_cancel",
      guardsHome: true,
      config: {
        description:
          "Cancels a pending, gated or orphaned job. A job running under a live lease is refused, with the exact reason and no write.",
        inputSchema: { job_id: z.number().int().min(1), reason: optionalText },
      },
      handler: async (args) => ({ ok: true, job: await openStore(env).jobs.cancelJob(args.job_id, { reason: args.reason }) }),
    },
    {
      name: "queue_close",
      guardsHome: true,
      config: {
        description:
          "Closes a job from any terminal status (`done`, `failed`, `gate` or `cancelled`) to `closed`: the operator's act that ends a job's life. `pending` and `running` are refused by name and nothing is written. " +
          "Closing never happens by observing a pull request; `queue_status` only suggests it when the pull request of a terminal job is merged. The CLI also offers `nightshift queue close --merged`, which closes every such job in one call. " +
          "Closing also removes the job's worktree when it is clean and its branch is pushed or a pull request is recorded: `worktree.status` is then `removed`; otherwise it is `kept` with the `reason`, and the close still succeeds. `worktree` is null when the job has none.",
        inputSchema: { job_id: z.number().int().min(1) },
      },
      handler: async (args) => ({ ok: true, ...(await closeJobAndWorktree({ store: openStore(env), id: args.job_id, env })) }),
    },
    {
      name: "queue_retry",
      config: {
        description:
          "Sends a gated, failed or cancelled job back to the queue. A gated job only moves with `note`, which reaches the run as the answer to its gate. " +
          "Without `fresh` the run resumes from the last phase, keeping slug, branch, session and run directory; with `fresh` it starts from phase 0 and the run directory is dropped. " +
          "`run` starts a DETACHED runner, the same one `queue_run` starts - and the same one the `--run` of the CLI starts, unless it is asked for `--foreground`; a job that cannot be claimed right now answers `waiting` and starts nothing. " +
          "Inside an unattended run this tool only accepts the id of the job it is running: retrying another job is refused, because the note is delivered as a human answer in that job's next prompt.",
        inputSchema: {
          job_id: z.number().int().min(1),
          note: optionalText,
          fresh: z.boolean().nullable().optional(),
          run: z.boolean().nullable().optional(),
        },
      },
      handler: async (args) => {
        const { job, runDir } = await applyRetry({ id: args.job_id, note: args.note, fresh: args.fresh === true, env });
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
          "Numbered inside its owner (`#1`, `#2` per project; `acme#1`, `acme#2` per org); a missing or invalid `status` falls back to `proposed` (the answer then carries `status_defaulted: true`). " +
          "Before saving, the title is searched against the owner's accepted and proposed decision titles, and the title plus decision text against their meaning. " +
          'When it overlaps any, nothing is saved and the answer is `status: "needs_review"` with `candidates` (id, number, title, status, via). ' +
          "Save again naming EVERY candidate by its `number`: in `supersedes` the ones this decision replaces WHOLE (they become `superseded` and point at the new row, so restate in the new text what still holds), in `unrelated` the ones it leaves untouched. " +
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
        const saved = await openStore(env).decisions.saveReviewedDecision({
          ...ownerArgs(args, env),
          title: args.title,
          context: args.context,
          decision: args.decision,
          consequences: args.consequences,
          status: args.status,
          supersedes: args.supersedes,
          unrelated: args.unrelated,
          jobId: callerJobId(env),
        });
        return saved.needsReview ? needsReviewAnswer(saved.candidates) : savedDecisionAnswer(saved);
      },
    },
    {
      name: "decision_update",
      config: {
        description:
          "Changes a decision by its `id`: accept or reject a proposed one, correct its text, or point `superseded_by` at the decision that replaced it. " +
          "Only the fields present are touched; an explicit `null` is treated exactly like an absent one. " +
          '`status: "superseded"` requires `superseded_by`, unless the decision already names its successor.',
        inputSchema: {
          id: z.number().int().min(1),
          title: optionalText,
          context: optionalText,
          decision: optionalText,
          consequences: optionalText,
          status: optionalDecisionStatus,
          superseded_by: optionalId,
        },
      },
      handler: async (args) => {
        const store = openStore(env);
        const current = await store.decisions.getDecision(args.id);
        if (current) await requireOwnProject({ kind: "decision", id: args.id, row: current }, env);
        const row = await store.decisions.updateDecision(args.id, {
          title: args.title,
          context: args.context,
          decision: args.decision,
          consequences: args.consequences,
          status: args.status,
          superseded_by: args.superseded_by,
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
        const owner = ownerArgs(args, env);
        const rows = await openStore(env).decisions.listDecisions({ ...owner, status: args.status });
        return { ...owner, decisions: rows.map(decisionView) };
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
          ...ownerArgs(args, env),
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
          "Adds one intent to a roadmap, at the end of its horizon (`now`, `next` or `later`). Owned by `project` or by `org`, never both: an org item is work every project of the org has to do, and names the project its job goes to at queue time. " +
          "`decision_id` links it to the decision that motivated it.",
        inputSchema: {
          project: optionalText,
          org: optionalText,
          horizon: z.enum(ROADMAP_HORIZONS),
          title: z.string(),
          detail: optionalText,
          decision_id: optionalId,
        },
      },
      handler: async (args) => {
        const saved = await openStore(env).roadmap.saveRoadmapItem({
          ...ownerArgs(args, env),
          horizon: args.horizon,
          title: args.title,
          detail: args.detail,
          decision_id: args.decision_id,
        });
        return { ok: true, id: saved.id, position: saved.position };
      },
    },
    {
      name: "roadmap_update",
      config: {
        description:
          "Changes a roadmap item by its `id`: its text, its horizon, its position inside the horizon, its `decision_id`, or its status. " +
          "`queued` is not one of the statuses that can be set by hand: an item becomes `queued` only through `queue_add` with `roadmap_item_id`.",
        inputSchema: {
          id: z.number().int().min(1),
          horizon: z.enum(ROADMAP_HORIZONS).nullable().optional(),
          title: optionalText,
          detail: optionalText,
          status: optionalRoadmapStatus,
          position: optionalId,
          decision_id: optionalId,
        },
      },
      handler: async (args) => {
        const store = openStore(env);
        const current = await store.roadmap.getRoadmapItem(args.id);
        if (current) await requireOwnProject({ kind: "roadmap item", id: args.id, row: current }, env);
        const row = await store.roadmap.updateRoadmapItem(args.id, {
          horizon: args.horizon,
          title: args.title,
          detail: args.detail,
          status: args.status,
          position: args.position,
          decision_id: args.decision_id,
        });
        return { ok: true, item: roadmapItemView(row) };
      },
    },
    {
      name: "roadmap_get",
      config: {
        description:
          "The whole roadmap of an owner: the `now`, `next` and `later` horizons in order, each item with its position, its linked decision and the live status of the job it was queued as. " +
          "With `project`, the project's items plus its org's, org items first, each carrying its `scope` and its `owner`; with `org`, only that org's items.",
        inputSchema: { project: optionalText, org: optionalText },
      },
      handler: async (args) => openStore(env).roadmap.listRoadmap(ownerArgs(args, env)),
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
        const answer = runAnswer(recordOutcome({ ...run, status: args.status, notice: args.notice, env }), run);
        if (args.status === "done") await closeCallerRoadmapItem(env);
        return answer;
      },
    },
    {
      name: "run_set",
      config: {
        description:
          "Records the fields of the run itself in `state.json` as the pipeline discovers them: its `type`, its `tier`, the evidence of a tier raise, and the branch and worktree the code lives in. Only the fields sent are touched. " +
          "`qa_stage_a` records the one sub-phase with a marker of its own — sent when the QA stage A gate closes, it is what makes a resume re-enter the QA phase straight at stage B instead of paying the analyst again. " +
          "Inside a job the run is resolved from the job's own row — passing `project` or `slug` there is refused; outside a job both are required.",
        inputSchema: {
          type: z.enum(PIPELINE_TASK_TYPES).nullable().optional(),
          tier: z.enum(PIPELINE_TIERS).nullable().optional(),
          tier_raise_reason: optionalText,
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

// Builds the MCP server with the twenty-five tools of the plugin contract.
export function createServer(env = process.env) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const schemas = new Map();
  for (const tool of toolDefinitions(env)) {
    schemas.set(tool.name, tool.config.inputSchema);
    server.registerTool(tool.name, tool.config, guard(tool.name, toolHandler(tool, env)));
  }
  // The SDK validates the call before the handler and refuses with one issue; this refusal carries every issue, the whole contract and what was received, which is what lets an agent fix the next call instead of repeating the same payload.
  server.validateToolInput = async (tool, args, toolName) => validateArgs(toolName, schemas.get(toolName) ?? tool.inputSchema, args);
  return server;
}
