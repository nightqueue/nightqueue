import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeDir } from "../config/paths.mjs";
import { ensureHome } from "../config/store.mjs";

const WORKER_PATH = fileURLToPath(new URL("./reflect-worker.mjs", import.meta.url));
const EMPTY_ANSWER = "{}";

// Payload of the worker in base64, or null when the event carries no transcript to read.
function workerPayload(input) {
  const transcriptPath = typeof input?.transcript_path === "string" ? input.transcript_path.trim() : "";
  if (!transcriptPath) return null;
  const cwd = typeof input?.cwd === "string" ? input.cwd : "";
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  return Buffer.from(JSON.stringify({ transcript_path: transcriptPath, cwd, session_id: sessionId })).toString(
    "base64",
  );
}

// Records an asynchronous spawn failure in the reflection log, the file the worker itself writes to.
function recordWorkerFailure(logPath, err) {
  try {
    appendFileSync(logPath, `the reflection worker could not be started: ${err?.message ?? String(err)}\n`);
  } catch {}
}

// Starts the detached worker with its output going to the reflection log; tells whether it went out.
function spawnWorker(payload, env, spawnImpl) {
  try {
    ensureHome(env);
    const logPath = join(homeDir(env), "reflect.log");
    const logFd = openSync(logPath, "a");
    try {
      const child = spawnImpl(process.execPath, [WORKER_PATH, payload], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...env, NIGHTQUEUE_REFLECT: "1" },
      });
      child?.on?.("error", (err) => recordWorkerFailure(logPath, err));
      child?.unref?.();
    } finally {
      closeSync(logFd);
    }
    return true;
  } catch {
    return false;
  }
}

// Answers the SessionEnd hook immediately and leaves the reflection worker running detached.
export function runReflect({ input, env = process.env, spawnImpl = spawn }) {
  if (env?.NIGHTQUEUE_REFLECT === "1") return EMPTY_ANSWER;
  const payload = workerPayload(input);
  if (payload && !spawnWorker(payload, env, spawnImpl)) {
    process.stderr.write("nightqueue: the reflection worker could not be started\n");
  }
  return EMPTY_ANSWER;
}
