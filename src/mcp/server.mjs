import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { UserError } from "../config/errors.mjs";
import { projectByName } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { saveLessonDeduped } from "../memory/dedup.mjs";
import { recallProjectIndex, saveProjectIndex } from "../memory/index.mjs";
import {
  addJob,
  cancelJob,
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
import { launchDetachedRunner } from "../queue/runner.mjs";
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
const RECALL_LIMIT = 8;
const INDEX_LIMIT = 40;
const JOB_LIST_LIMIT = { min: 1, max: 50, fallback: 10 };

const target = z.enum(LESSON_TARGETS).nullable().optional();
const optionalText = z.string().nullable().optional();

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
    `unknown project \`${name}\`: pass the registered project NAME, not a path; list them with \`shift project list\``,
  );
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

// The ten tools of the plugin contract, with the parameter names the plugin actually sends.
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
        description: "Records the telemetry of one /resolve run, gate terminations included. One call per run.",
        inputSchema: {
          project: optionalText,
          slug: z.string(),
          tier: z.enum(PIPELINE_TIERS),
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
      config: {
        description:
          "Enqueues an unattended /nightshift:resolve run for a registered project. `project` is the registered NAME, never a path. One job is one self-contained deliverable that can be reviewed and merged on its own. Large work is ONE job with numbered stages written in the prompt — never several jobs that depend on each other. A job that needs another job's pull request merged first is cut wrong: fold it into that job. Independent jobs may run in parallel and merge in any order.",
        inputSchema: {
          project: z.string(),
          prompt: z
            .string()
            .describe(
              "The whole request, as prose. One self-contained deliverable that can be reviewed and merged on its own; large work goes here as ONE prompt with numbered stages (`Stages: 1) ... 2) ...`), never as several jobs that depend on each other.",
            ),
          priority: z.number().int().min(PRIORITY_RANGE.min).max(PRIORITY_RANGE.max).nullable().optional(),
          max_attempts: z.number().int().min(MAX_ATTEMPTS_RANGE.min).max(MAX_ATTEMPTS_RANGE.max).nullable().optional(),
          timeout_s: z.number().int().min(TIMEOUT_RANGE.min).max(TIMEOUT_RANGE.max).nullable().optional(),
        },
      },
      handler: async (args) => {
        const job = addJob(
          {
            project: requireProjectName(args.project, env),
            prompt: args.prompt,
            priority: args.priority,
            maxAttempts: args.max_attempts,
            timeoutS: args.timeout_s,
          },
          env,
        );
        return { ok: true, id: job.id, project: job.project, priority: job.priority, timeoutS: job.timeoutS };
      },
    },
    {
      name: "queue_status",
      config: {
        description:
          "State of the queue: one job by id, or the most recent ones plus the counts per status. Never returns the prompt.",
        inputSchema: {
          job_id: z.number().int().min(1).nullable().optional(),
          limit: z.number().int().min(JOB_LIST_LIMIT.min).max(JOB_LIST_LIMIT.max).nullable().optional(),
        },
      },
      handler: async (args) => {
        if (Number.isInteger(args.job_id)) {
          const job = jobView(getJob(args.job_id, env));
          if (!job) throw new UserError(`unknown job \`${args.job_id}\``);
          return { job };
        }
        return { jobs: listJobs({ limit: jobLimit(args.limit) }, env).map(jobView), counts: countsByStatus(env) };
      },
    },
    {
      name: "queue_run",
      config: {
        description:
          "Starts the queue runner detached, with its output going to a log file, and returns immediately with that path.",
        inputSchema: { job_id: z.number().int().min(1).nullable().optional() },
      },
      handler: async (args) => {
        const started = launchDetachedRunner({ jobId: Number.isInteger(args.job_id) ? args.job_id : null, env });
        return { ok: true, pid: started.pid, logPath: started.logPath };
      },
    },
    {
      name: "queue_cancel",
      config: {
        description:
          "Cancels a pending or orphaned job. A job running under a live lease is refused, with the exact reason and no write.",
        inputSchema: { job_id: z.number().int().min(1), reason: optionalText },
      },
      handler: async (args) => ({ ok: true, job: cancelJob(args.job_id, { reason: args.reason }, env) }),
    },
  ];
}

// Builds the MCP server with the ten tools of the plugin contract.
export function createServer(env = process.env) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of toolDefinitions(env)) server.registerTool(tool.name, tool.config, guard(tool.name, tool.handler));
  return server;
}

// Starts the server over stdio, the only stream the protocol may use in this process.
export async function startServer(env = process.env) {
  const server = createServer(env);
  await server.connect(new StdioServerTransport());
  return server;
}
