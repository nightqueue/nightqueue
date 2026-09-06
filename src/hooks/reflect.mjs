import { spawn } from "node:child_process";
import { openSync } from "node:fs";
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

// Starts the detached worker with its output going to the reflection log; tells whether it went out.
function spawnWorker(payload, env, spawnImpl) {
  try {
    ensureHome(env);
    const logFd = openSync(join(homeDir(env), "reflect.log"), "a");
    const child = spawnImpl(process.execPath, [WORKER_PATH, payload], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...env, NIGHTSHIFT_REFLECT: "1" },
    });
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}

// Answers the SessionEnd hook immediately and leaves the reflection worker running detached.
export function runReflect({ input, env = process.env, spawnImpl = spawn }) {
  if (env?.NIGHTSHIFT_REFLECT === "1") return EMPTY_ANSWER;
  const payload = workerPayload(input);
  if (payload && !spawnWorker(payload, env, spawnImpl)) {
    process.stderr.write("nightshift: the reflection worker could not be started\n");
  }
  return EMPTY_ANSWER;
}
