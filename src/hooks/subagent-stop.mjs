import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { projectByIdOrNull } from "../memory/registry-access.mjs";
import { agentRole } from "../queue/operator-scope.mjs";
import { dropQaWorktree, qaWorktreeEntry, qaWorktreeTarget } from "../queue/qa-worktree.mjs";
import { lockPid } from "../queue/worktree.mjs";

const TRANSCRIPT_CAP_BYTES = 2 * 1024 * 1024;
const ANNOUNCE_LINE = /^QA_WORKTREE: (.+)$/;
const TRAILING_PUNCTUATION = /[.,;:)`]+$/;

// Tells whether the hook runs in an operator session of `nightqueue open`, never inside a queued job.
function operatorSession(env) {
  if (typeof env?.NIGHTQUEUE_JOB_ID === "string" && env.NIGHTQUEUE_JOB_ID.trim() !== "") return false;
  return typeof env?.NIGHTQUEUE_MODE === "string" && env.NIGHTQUEUE_MODE.trim() === "operator";
}

// The last bytes of a file as text, up to the cap, or an empty string when it cannot be read.
function fileTail(path) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_CAP_BYTES);
    const buffer = Buffer.alloc(length);
    return buffer.subarray(0, readSync(fd, buffer, 0, length, size - length)).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// The path an announcement line names, with the backticks and trailing punctuation prose wraps it in removed.
function announcedPath(line) {
  const match = ANNOUNCE_LINE.exec(line.trim());
  return match ? match[1].trim().replace(/^`+/, "").replace(TRAILING_PUNCTUATION, "") : null;
}

// The worktree the subagent announced on the first line of its final message, if any.
function announcedInMessage(message) {
  const path = announcedPath(message.trim().split("\n")[0]);
  return path ? [path] : [];
}

// One transcript line as an object, or null when it is not JSON.
function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// The text of an assistant transcript entry, or an empty string for any other entry.
function assistantText(entry) {
  if (entry?.type !== "assistant" && entry?.message?.role !== "assistant") return "";
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

// The text of the subagent's final assistant entry in its transcript, read from the file's last bytes.
function finalAssistantText(path) {
  const lines = fileTail(path).split("\n").reverse();
  for (const line of lines) {
    const text = assistantText(parseLine(line));
    if (text) return text;
  }
  return "";
}

// The worktree the first announcement line of the subagent's final assistant text in its transcript names, if any.
function announcedInTranscript(path) {
  if (typeof path !== "string" || !path || !existsSync(path)) return [];
  const announced = finalAssistantText(path).split("\n").map(announcedPath).find(Boolean);
  return announced ? [announced] : [];
}

// The one worktree the subagent announced: the first line of its final message, else its transcript when the host sent no message.
function announcedWorktrees(input) {
  if (typeof input.last_assistant_message === "string") return announcedInMessage(input.last_assistant_message);
  return announcedInTranscript(input.agent_transcript_path);
}

// Tells whether this session may drop the worktree: it holds the lock, or nobody does.
function ownedHere(entry, env) {
  if (entry.locked === null || entry.locked === undefined) return true;
  const pid = lockPid(entry.locked);
  return pid !== null && String(pid) === String(env.NIGHTQUEUE_OPERATOR_PID ?? "").trim();
}

// Drops one announced qa worktree when it belongs to this home and to this session; anything else is left alone.
function dropAnnounced(path, env) {
  const target = qaWorktreeTarget(path, env);
  const checkout = target ? projectByIdOrNull(target.projectId, env)?.path : null;
  if (!checkout || !existsSync(checkout)) return;
  const entry = qaWorktreeEntry({ path: target.path, checkout, env });
  if (entry && ownedHere(entry, env)) dropQaWorktree({ path: target.path, checkout, env });
}

// SubagentStop hook: when the operator's qa subagent ends, drops the qa worktree it announced; best-effort, always answers nothing.
export function runSubagentStop({ input, env = process.env }) {
  if (!operatorSession(env) || input?.hook_event_name !== "SubagentStop" || agentRole(input?.agent_type) !== "qa") return "";
  for (const path of announcedWorktrees(input)) {
    try {
      dropAnnounced(path, env);
    } catch {
      continue;
    }
  }
  return "";
}
