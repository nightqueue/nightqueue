import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { saveLessonDeduped } from "../memory/dedup.mjs";
import { recallProjectIndex, saveProjectIndex } from "../memory/index.mjs";
import { LESSON_TARGETS, lessonView } from "../memory/lessons.mjs";
import { memoryView } from "../memory/memory.mjs";
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

// The six tools of the plugin contract, with the parameter names the plugin actually sends.
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
  ];
}

// Builds the MCP server with the six tools of the plugin contract.
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
