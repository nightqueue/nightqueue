import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { logsDir } from "../config/paths.mjs";
import { MERGER_DIR_ENV, MERGER_FILES_ENV } from "../hooks/merger-guard.mjs";
import { mergerSettings } from "../host/settings.mjs";
import { CLOSE_WORKER_ENV } from "./close-deps.mjs";
import { compactStamp } from "./runner.mjs";
import { pluginDir, spawnClaude } from "./spawn.mjs";
import { extractResultText } from "./stream.mjs";

const MERGER_STOP_POLL_MS = 1000;

// The argv of the merger agent: Read and Edit only, sonnet, no MCP server, and only the guard's settings.
export function mergerArgs({ prompt, env = process.env }) {
  return [
    "-p",
    String(prompt ?? ""),
    "--agent",
    "nightqueue:merger",
    "--model",
    "sonnet",
    "--tools",
    "Read,Edit",
    "--permission-mode",
    "acceptEdits",
    "--output-format",
    "stream-json",
    "--verbose",
    "--plugin-dir",
    pluginDir(),
    "--strict-mcp-config",
    "--setting-sources",
    "project",
    "--settings",
    JSON.stringify(mergerSettings(env)),
  ];
}

// The environment of the merger: the close's own, plus the fence its guard reads, without the job id nor the lease token.
export function mergerEnv({ env = process.env, dir, files }) {
  const own = { ...env, [MERGER_DIR_ENV]: dir, [MERGER_FILES_ENV]: JSON.stringify(files.map((file) => resolve(dir, file))) };
  delete own.NIGHTQUEUE_JOB_ID;
  delete own[CLOSE_WORKER_ENV];
  return own;
}

// The log path of one merger run, never named like a job log.
export function mergerLogPath(env, jobId) {
  return join(logsDir(env), `merger-${jobId}-${compactStamp()}.log`);
}

// Runs the merger agent in the stopped rebase and answers how it ended with its final text.
export async function runMerger({ cwd, files, prompt, timeoutMs, signal, jobId, env = process.env, spawnImpl = spawn, holdJobAwakeImpl }) {
  const timeoutS = Math.max(1, timeoutMs / 1000);
  const run = await spawnClaude({
    prompt,
    cwd,
    args: mergerArgs({ prompt, env }),
    env: mergerEnv({ env, dir: cwd, files }),
    jobId: null,
    timeoutS,
    idleTimeoutS: timeoutS,
    logPath: mergerLogPath(env, jobId),
    stopSignalImpl: async () => signal?.aborted === true,
    stopPollMs: MERGER_STOP_POLL_MS,
    spawnImpl,
    ...(holdJobAwakeImpl ? { holdJobAwakeImpl } : {}),
  });
  return { exitCode: run.exitCode, timedOut: run.timedOut, stopped: run.stopped, spawnError: run.spawnError, resultText: extractResultText(run.log) ?? "" };
}
