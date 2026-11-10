#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const JOB_SCOPED = ["NIGHTQUEUE_JOB_ID", "NIGHTQUEUE_JOB_HOME", "NIGHTQUEUE_JOB_CLAUDE_DIR", "NIGHTQUEUE_JOB_CLAIM", "NIGHTQUEUE_CLOSE_WORKER"];

// The value that follows a flag, or null when the flag is absent.
function flagValue(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

// Writes the transcript a real claude leaves after a first message, unless the test asks for a session quit before one.
function writeTranscript() {
  const sessionId = flagValue("--session-id");
  if (!sessionId || process.env.NIGHTQUEUE_FAKE_NO_TRANSCRIPT === "1") return;
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "-fake");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "user", cwd: process.cwd(), sessionId })}\n`);
}

// Records one interactive launch, with what the chat guard reads from its environment, in the file the test reads back.
function recordLaunch() {
  const path = process.env.NIGHTQUEUE_FAKE_CALLS;
  if (!path) {
    process.stderr.write("fake claude: NIGHTQUEUE_FAKE_CALLS is not set\n");
    process.exit(2);
  }
  const call = {
    argv: args,
    cwd: process.cwd(),
    mode: process.env.NIGHTQUEUE_MODE ?? null,
    chatWorktree: process.env.NIGHTQUEUE_CHAT_WORKTREE ?? null,
    operatorSession: process.env.NIGHTQUEUE_OPERATOR_SESSION ?? null,
    jobScoped: JOB_SCOPED.filter((key) => process.env[key] !== undefined),
  };
  appendFileSync(path, `${JSON.stringify(call)}\n`);
}

if (args[0] === "--help") process.stdout.write("Usage: claude [options]\n\nOptions:\n  --agent <agent>  Agent for the current session\n");
else {
  recordLaunch();
  writeTranscript();
}
