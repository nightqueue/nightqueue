import { rmSync } from "node:fs";
import { queuePausedPath, queueResumePath } from "../config/paths.mjs";
import { ensureHome, writeFileAtomic } from "../config/store.mjs";

// Writes the pause sentinel, which stops new claims without touching any job.
export function pauseQueue(env = process.env) {
  ensureHome(env);
  writeFileAtomic(queuePausedPath(env), `${new Date().toISOString()}\n`);
}

// Removes the pause sentinel and stamps the instant every runner waiting out a rate limit compares its own pause against.
export function resumeQueue(env = process.env) {
  ensureHome(env);
  rmSync(queuePausedPath(env), { force: true });
  writeFileAtomic(queueResumePath(env), `${new Date().toISOString()}\n`);
}
