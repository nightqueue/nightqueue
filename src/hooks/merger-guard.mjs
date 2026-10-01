import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const MERGER_DIR_ENV = "NIGHTQUEUE_MERGER_DIR";
export const MERGER_FILES_ENV = "NIGHTQUEUE_MERGER_FILES";

const ONLY_READ_EDIT = "the merger has Read and Edit only";

// PreToolUse answer that allows or denies a tool call with the reason the agent reads.
function decision(permissionDecision, reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason } });
}

export const MERGER_DENY_ALL = decision("deny", "the merger guard could not run; every tool is denied");

// The real path of a path, or its plain resolved form when it does not exist yet.
function realOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// The worktree and the conflicted files the merger may touch, or null when the environment does not carry them.
function mergerFence(env) {
  const dir = typeof env?.[MERGER_DIR_ENV] === "string" ? env[MERGER_DIR_ENV].trim() : "";
  if (!dir || !isAbsolute(dir)) return null;
  let files;
  try {
    files = JSON.parse(env[MERGER_FILES_ENV] ?? "");
  } catch {
    return null;
  }
  if (!Array.isArray(files) || !files.length || !files.every((file) => typeof file === "string" && isAbsolute(file))) return null;
  return { dir: realOrResolved(dir), files: files.map(realOrResolved) };
}

// The real path a tool call targets, resolved from the session's directory, or null when it names none.
function targetPath(input, fence) {
  const path = input?.tool_input?.file_path;
  if (typeof path !== "string" || !path.trim()) return null;
  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : fence.dir;
  return realOrResolved(resolve(cwd, path));
}

// Tells whether a path lies inside a directory or is the directory itself.
function inside(dir, path) {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Answers a Read: allowed inside the throwaway worktree only.
function readDecision(target, fence) {
  if (target && inside(fence.dir, target)) return decision("allow", "read inside the throwaway worktree");
  return decision("deny", `the merger reads only inside ${fence.dir}`);
}

// Answers an Edit: allowed on a conflicted file whose real path stays inside the worktree only.
function editDecision(target, fence) {
  if (target && !inside(fence.dir, target)) return decision("deny", `the merger edits only inside ${fence.dir}`);
  if (target && fence.files.includes(target)) return decision("allow", "edit of a conflicted file");
  return decision("deny", `the merger edits only the conflicted files: ${fence.files.join(", ")}`);
}

// Fences the merger agent's tool calls: Read inside the worktree, Edit on the conflicted files, everything else denied.
export function runMergerGuard({ input, env = process.env }) {
  const fence = mergerFence(env);
  if (!fence) return MERGER_DENY_ALL;
  const tool = input?.tool_name;
  if (tool === "Read") return readDecision(targetPath(input, fence), fence);
  if (tool === "Edit") return editDecision(targetPath(input, fence), fence);
  return decision("deny", ONLY_READ_EDIT);
}
