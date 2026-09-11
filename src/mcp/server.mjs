import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { saveProject } from "../cli/project.mjs";
import { UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { projectByName, registrationOffer, resolveProject } from "../config/projects.mjs";
import { loadConfig, saveConfig } from "../config/store.mjs";
import {
  DECISION_STATUSES,
  decisionFullView,
  decisionView,
  getDecision,
  listDecisions,
  recallDecisions,
  saveDecision,
  updateDecision,
} from "../memory/decisions.mjs";
import { saveLessonDeduped } from "../memory/dedup.mjs";
import { recallProjectIndex, saveProjectIndex } from "../memory/index.mjs";
import {
  addJob,
  cancelJob,
  countActiveJobs,
  countsByStatus,
  getJob,
  jobView,
  listJobs,
  MAX_ATTEMPTS_RANGE,
  PRIORITY_RANGE,
  TIMEOUT_RANGE,
} from "../memory/jobs.mjs";
import { LESSON_TARGETS, lessonView } from "../memory/lessons.mjs";
import { memoryView } from "../memory/memory.mjs";
import {
  getRoadmapItem,
  listRoadmap,
  PROMPT_SOURCE_CONFLICT,
  PROMPT_SOURCE_MISSING,
  queueRoadmapItem,
  ROADMAP_HORIZONS,
  ROADMAP_STATUSES,
  roadmapItemView,
  saveRoadmapItem,
  updateRoadmapItem,
} from "../memory/roadmap.mjs";
import { isQueueIdle, pendingJobs } from "../queue/hints.mjs";
import { refuseHomeWriteInsideJob } from "../queue/home-guard.mjs";
import { refreshMergedJobs } from "../queue/merged.mjs";
import { runnerPidfileState, runnerView } from "../queue/pidfile.mjs";
import { repairWarningLine } from "../queue/reconcile.mjs";
import { applyRetry, callerJobId } from "../queue/retry.mjs";
import { runnerBusyLine, startQueueRunner } from "../queue/start.mjs";
import {
  logPipelineRun,
  PIPELINE_GATE_STOPS,
  PIPELINE_OUTCOMES,
  PIPELINE_PHASE_STATUSES,
  PIPELINE_TASK_TYPES,
  PIPELINE_TIERS,
} from "../memory/runs.mjs";
import { recallLessons, recallMemories } from "../memory/search.mjs";

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
].join("\n");
const RECALL_LIMIT = 8;
const INDEX_LIMIT = 40;
const JOB_LIST_LIMIT = { min: 1, max: 50, fallback: 10 };

const target = z.enum(LESSON_TARGETS).nullable().optional();
const optionalText = z.string().nullable().optional();
const optionalId = z.number().int().min(1).nullable().optional();
const optionalDecisionStatus = z.enum(DECISION_STATUSES).nullable().optional();
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
function callerProject(own, env) {
  return getJob(own, env)?.project ?? null;
}

// Refuses a row of ANOTHER project from inside an unattended run: a job may only rewrite the decisions and the roadmap of its own project.
function requireOwnProject({ kind, id, project }, env) {
  const own = callerJobId(env);
  if (own === null) return;
  const mine = callerProject(own, env);
  if (mine !== null && mine === (project ?? null)) return;
  throw new UserError(
    `refusing to update ${kind} \`${id}\` from inside job \`${own}\`: it belongs to project \`${project ?? "global"}\`, ` +
      `not \`${mine ?? "unknown"}\`; an unattended run may only update its own project, ` +
      "so ask the operator to do it outside the queue",
  );
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

// The answer of `queue_add`: the job it recorded, and the roadmap item behind it when there is one.
function queuedAnswer({ job, registered = null, roadmapItemId = null }, env) {
  const pending = countsByStatus(env).pending;
  const done = registered ? `registered project \`${registered.name}\` (${registered.path}). ` : "";
  return {
    ok: true,
    id: job.id,
    project: job.project,
    priority: job.priority,
    timeoutS: job.timeoutS,
    ...(roadmapItemId === null ? {} : { roadmapItemId }),
    ...(job.tier ? { tier: job.tier } : {}),
    hint: `${done}queued job #${job.id} for \`${job.project}\` (${pending} pending). Start the batch with queue_run when you are ready.`,
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

// Validates the arguments here instead of leaving it to the SDK, so the refusal names every issue, the whole contract and what was received - an agent fixes that on the next call instead of repeating the same payload.
function validateArgs(name, inputSchema, args) {
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

// The one-line nudge queue_status answers with, or null when the queue has nothing to suggest.
function queueHint({ activeJobs, counts, runner }) {
  if (!isQueueIdle({ activeJobs, runner })) return `runner active — ${counts.pending} pending after this one`;
  if (counts.pending === 0) return null;
  return `${pendingJobs(counts.pending)} waiting — start the batch with queue_run.`;
}

// What a tool that was asked to start a runner answers: the runner that started, or the live one that already owns the queue.
function runnerAnswer(started) {
  return {
    started: started.started,
    pid: started.pid,
    logPath: started.logPath,
    runner: { pid: started.pid, mode: started.mode, logPath: started.logPath },
    message: started.started ? null : runnerBusyLine(started.pid, started.mode),
  };
}

// What a status answer says about a repair the database refused: the same line the CLI warns with, and nothing at all when every repair went through.
function warningAnswer(warning) {
  return warning ? { warning } : {};
}

// The eighteen tools of the plugin contract, with the parameter names the plugin actually sends.
function toolDefinitions(env) {
  return [
    {
      name: "lesson_recall",
      config: {
        description:
          "Recall of the lessons already learned, before acting. Filters by project and/or query. " +
          'An item with via "fallback" did not match the query: it is recent context, never an answer.',
        inputSchema: {
          query: optionalText,
          project: optionalText,
          target,
          exclude_ids: z.array(z.unknown()).nullable().optional(),
        },
      },
      handler: async (args) => {
        const rows = await recallLessons(
          {
            query: args.query,
            project: args.project,
            target: args.target,
            excludeIds: args.exclude_ids,
            limit: RECALL_LIMIT,
          },
          env,
        );
        return rows.map(lessonView);
      },
    },
    {
      name: "lesson_save",
      config: {
        description: "Records a lesson after fixing an error that was not caught on the first attempt.",
        inputSchema: {
          title: z.string(),
          root_cause: z.string(),
          solution: z.string(),
          prevention: z.string(),
          attempts: z.number().int().min(2).nullable().optional(),
          project: optionalText,
          target,
        },
      },
      handler: async (args) => {
        const saved = await saveLessonDeduped(
          {
            project: args.project,
            title: args.title,
            root_cause: args.root_cause,
            solution: args.solution,
            prevention: args.prevention,
            attempts: args.attempts,
            target: args.target,
          },
          env,
        );
        return { ok: true, id: saved.id, project: saved.project, deduped: saved.deduped, attempts: saved.attempts };
      },
    },
    {
      name: "memory_recall",
      config: {
        description: "Recalls project facts and decisions from the shared memory.",
        inputSchema: { query: optionalText, project: optionalText },
      },
      handler: async (args) => {
        const rows = await recallMemories({ query: args.query, project: args.project, limit: RECALL_LIMIT }, env);
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
        const saved = saveProjectIndex(
          { project: args.project, repoRoot: args.repo_root, files: args.files, libs: args.libs ?? [] },
          env,
        );
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
        recallProjectIndex(
          { project: args.project, repoRoot: args.repo_root, query: args.query, limit: INDEX_LIMIT },
          env,
        ),
    },
    {
      name: "pipeline_log",
      config: {
        description:
          "Records the telemetry of one /resolve run, gate terminations included. One call per run. " +
          "`tier` is the FINAL tier the run executed, `tier_operator` is the tier the operator declared (omit it when there was none) and `tier_raise_reason` carries the evidence of a raise — send it when, and only when, the tier was raised.",
        inputSchema: {
          project: optionalText,
          slug: z.string(),
          tier: z.enum(PIPELINE_TIERS),
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
        const logged = logPipelineRun(
          {
            project: args.project,
            slug: args.slug,
            tier: args.tier,
            tierOperator: args.tier_operator,
            tierRaiseReason: args.tier_raise_reason,
            taskType: args.task_type,
            outcome: args.outcome,
            gateStop: args.gate_stop,
            durationS: args.duration_s,
            phases: args.phases ?? [],
          },
          env,
        );
        return { ok: true, runId: logged.runId, project: logged.project, phases: logged.phases };
      },
    },
    {
      name: "queue_add",
      guardsHome: true,
      config: {
        description:
          "Enqueues an unattended /nightshift:resolve run for a registered project. `project` is the registered NAME, never a path. One job is one self-contained deliverable that can be reviewed and merged on its own. Large work is ONE job with numbered stages written in the prompt — never several jobs that depend on each other. A job that needs another job's pull request merged first is cut wrong: fold it into that job. Independent jobs may run in parallel and merge in any order. " +
          "This tool only records the job; it never runs it. Queue it now and start the whole batch later with `queue_run` (no `job_id`); start a single job now only when the user asks for that one job now. " +
          "With `project` omitted, `cwd` (the absolute working directory of the caller) resolves the project. When no project is registered for it, the answer is `needs_registration`: ask the user to confirm, then call again with the same `cwd` and `register: true`. Registration never happens without `register: true`. " +
          "With `roadmap_item_id` and no `prompt`, the job prompt is built from that roadmap item, its linked decision and the accepted decisions related to it; the item is marked `queued` and flips to `done` when the job finishes.",
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
          const queued = await queueRoadmapItem(
            {
              id: args.roadmap_item_id,
              project: namedProject(args.project, env),
              priority: args.priority,
              maxAttempts: args.max_attempts,
              timeoutS: args.timeout_s,
              tier: args.tier,
            },
            env,
          );
          return queuedAnswer({ job: queued.job, roadmapItemId: queued.item.id }, env);
        }
        const target = resolveQueueTarget(args, env);
        if (target.offer && args.register !== true) return needsRegistration(target);
        const registered = target.offer ? await registerOffer(target.offer, env) : null;
        const job = addJob(
          {
            project: registered?.name ?? target.project,
            prompt: args.prompt,
            priority: args.priority,
            maxAttempts: args.max_attempts,
            timeoutS: args.timeout_s,
            tier: args.tier,
          },
          env,
        );
        return queuedAnswer({ job, registered }, env);
      },
    },
    {
      name: "queue_status",
      config: {
        description:
          "State of the queue: one job by id, or the most recent ones plus the counts per status and the state of the runner. Never returns the prompt. " +
          "`notice_md` is the reason a job stopped - a job in `gate` always carries one; answer it with `queue_retry`.",
        inputSchema: {
          job_id: z.number().int().min(1).nullable().optional(),
          limit: z.number().int().min(JOB_LIST_LIMIT.min).max(JOB_LIST_LIMIT.max).nullable().optional(),
        },
      },
      handler: async (args) => {
        refreshMergedJobs({ env });
        const warning = repairWarningLine(env);
        if (Number.isInteger(args.job_id)) {
          const job = jobView(getJob(args.job_id, env));
          if (!job) throw new UserError(`unknown job \`${args.job_id}\``);
          return { job, ...warningAnswer(warning) };
        }
        const runner = runnerView(runnerPidfileState(env));
        const counts = countsByStatus(env);
        return {
          runner,
          jobs: listJobs({ limit: jobLimit(args.limit) }, env).map(jobView),
          counts,
          hint: queueHint({ activeJobs: countActiveJobs(env), counts, runner }),
          ...warningAnswer(warning),
        };
      },
    },
    {
      name: "queue_run",
      config: {
        description:
          "starts a detached runner that drains the queue: every pending job, in priority order, until nothing is pending - the runner registers itself, so queue_status shows it. Pass job_id only to start a single job. " +
          "The batch runs DETACHED, with its output going to a log file, and this tool returns immediately with that path. " +
          "The runner exits by itself once the queue is empty; `nightshift queue run --stop` ends it earlier, and also ends a watcher started from the CLI.",
        inputSchema: { job_id: z.number().int().min(1).nullable().optional() },
      },
      handler: async (args) => {
        const started = await startQueueRunner({ jobId: Number.isInteger(args.job_id) ? args.job_id : null, env });
        return { ok: true, ...runnerAnswer(started) };
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
      handler: async (args) => ({ ok: true, job: cancelJob(args.job_id, { reason: args.reason }, env) }),
    },
    {
      name: "queue_retry",
      config: {
        description:
          "Sends a gated, failed or cancelled job back to the queue. A gated job only moves with `note`, which reaches the run as the answer to its gate. " +
          "Without `fresh` the run resumes from the last phase, keeping slug, branch, session and run directory; with `fresh` it starts from phase 0 and the run directory is dropped. " +
          "`run` starts a DETACHED runner, the same one `queue_run` starts - and the same one the `--run` of the CLI starts, unless it is asked for `--foreground`. " +
          "Inside an unattended run this tool only accepts the id of the job it is running: retrying another job is refused, because the note is delivered as a human answer in that job's next prompt.",
        inputSchema: {
          job_id: z.number().int().min(1),
          note: optionalText,
          fresh: z.boolean().nullable().optional(),
          run: z.boolean().nullable().optional(),
        },
      },
      handler: async (args) => {
        const { job, runDir } = applyRetry({ id: args.job_id, note: args.note, fresh: args.fresh === true, env });
        const started = args.run === true ? await startQueueRunner({ jobId: job.id, env }) : null;
        return { ok: true, job, runDir, ...(started ? runnerAnswer(started) : { runner: null }) };
      },
    },
    {
      name: "decision_save",
      config: {
        description:
          "Records one architecture decision of a project: the context that forced it, what was decided and what it costs. " +
          "Numbered per project and `accepted` unless another status is given. `project` is the registered NAME, never a path.",
        inputSchema: {
          project: z.string(),
          title: z.string(),
          context: z.string(),
          decision: z.string(),
          consequences: optionalText,
          status: optionalDecisionStatus,
        },
      },
      handler: async (args) => {
        const saved = saveDecision(
          {
            project: requireProjectName(args.project, env),
            title: args.title,
            context: args.context,
            decision: args.decision,
            consequences: args.consequences,
            status: args.status,
          },
          env,
        );
        return { ok: true, id: saved.id, number: saved.number };
      },
    },
    {
      name: "decision_update",
      config: {
        description:
          "Changes a decision by its `id`: accept or reject a proposed one, correct its text, or point `superseded_by` at the decision that replaced it. " +
          "Only the fields present are touched; an explicit `null` is treated exactly like an absent one.",
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
        const current = getDecision(args.id, env);
        if (current) requireOwnProject({ kind: "decision", id: args.id, project: current.project }, env);
        const row = updateDecision(
          args.id,
          {
            title: args.title,
            context: args.context,
            decision: args.decision,
            consequences: args.consequences,
            status: args.status,
            superseded_by: args.superseded_by,
          },
          env,
        );
        return { ok: true, decision: decisionView(row) };
      },
    },
    {
      name: "decision_list",
      config: {
        description:
          "The decisions log of a project in numbering order, optionally filtered by status. Compact rows: the full text of one decision comes from `decision_recall`.",
        inputSchema: { project: z.string(), status: optionalDecisionStatus },
      },
      handler: async (args) => {
        const project = requireProjectName(args.project, env);
        return { project, decisions: listDecisions({ project, status: args.status }, env).map(decisionView) };
      },
    },
    {
      name: "decision_recall",
      config: {
        description:
          "Standing constraints of a project, before proposing architecture. Only accepted decisions come back, with their text untruncated, because this feeds prompts. " +
          'An item with via "fallback" did not match the query: it is recent context, never an answer.',
        inputSchema: { project: z.string(), query: optionalText, limit: z.number().int().min(1).max(20).nullable().optional() },
      },
      handler: async (args) => {
        const rows = await recallDecisions(
          {
            project: requireProjectName(args.project, env),
            query: args.query,
            limit: Number.isInteger(args.limit) ? args.limit : RECALL_LIMIT,
          },
          env,
        );
        return rows.map(decisionFullView);
      },
    },
    {
      name: "roadmap_save",
      config: {
        description:
          "Adds one intent to the roadmap of a project, at the end of its horizon (`now`, `next` or `later`). `decision_id` links it to the decision that motivated it.",
        inputSchema: {
          project: z.string(),
          horizon: z.enum(ROADMAP_HORIZONS),
          title: z.string(),
          detail: optionalText,
          decision_id: optionalId,
        },
      },
      handler: async (args) => {
        const saved = saveRoadmapItem(
          {
            project: requireProjectName(args.project, env),
            horizon: args.horizon,
            title: args.title,
            detail: args.detail,
            decision_id: args.decision_id,
          },
          env,
        );
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
        const current = getRoadmapItem(args.id, env);
        if (current) requireOwnProject({ kind: "roadmap item", id: args.id, project: current.project }, env);
        const row = updateRoadmapItem(
          args.id,
          {
            horizon: args.horizon,
            title: args.title,
            detail: args.detail,
            status: args.status,
            position: args.position,
            decision_id: args.decision_id,
          },
          env,
        );
        return { ok: true, item: roadmapItemView(row) };
      },
    },
    {
      name: "roadmap_get",
      config: {
        description:
          "The whole roadmap of a project: the `now`, `next` and `later` horizons in order, each item with its position, its linked decision and the live status of the job it was queued as.",
        inputSchema: { project: z.string() },
      },
      handler: async (args) => listRoadmap(requireProjectName(args.project, env), env),
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

// Builds the MCP server with the eighteen tools of the plugin contract.
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

// Starts the server over stdio, the only stream the protocol may use in this process.
export async function startServer(env = process.env) {
  const server = createServer(env);
  await server.connect(new StdioServerTransport());
  return server;
}
