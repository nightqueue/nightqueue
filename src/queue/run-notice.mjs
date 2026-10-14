import { ABANDONED_COMMAND_PREFIX, NO_CHANGE_NEXT_STEP_LINE, NOTHING_TO_CLOSE_LINE, STRAY_PR_PREFIX, trailingStripped } from "./classify.mjs";
import { CLOSED_PREFIX, POST_CLOSE_PREFIX } from "./close-view.mjs";
import { KEPT_PREFIX } from "./worktree.mjs";

// The line appended once when the last attempt shows the host backgrounding a task despite the disable env var the runtime sets.
export const DISABLED_BACKGROUND_ESCAPE_LINE =
  "⚠️ the host moved a command to the background although background tasks are disabled - the CLI may have dropped CLAUDE_CODE_DISABLE_BACKGROUND_TASKS";

// The lines the runtime itself appends to a row's notice after a run finishes, never text a run wrote.
const RUNTIME_APPENDED_LINE_PREFIXES = [
  KEPT_PREFIX,
  ABANDONED_COMMAND_PREFIX,
  DISABLED_BACKGROUND_ESCAPE_LINE,
  CLOSED_PREFIX,
  POST_CLOSE_PREFIX,
  NOTHING_TO_CLOSE_LINE,
  NO_CHANGE_NEXT_STEP_LINE,
];

// The runtime lines never told to the origins, which also exclude the line naming another pull request.
const ORIGIN_EXCLUDED_LINE_PREFIXES = [...RUNTIME_APPENDED_LINE_PREFIXES, STRAY_PR_PREFIX];

// A row's notice with every trailing paragraph the runtime itself appended stripped off, so only what a run actually wrote remains.
export function withoutRuntimeAppendedLines(notice) {
  return trailingStripped(notice, RUNTIME_APPENDED_LINE_PREFIXES);
}

// The run's own notice as told to the origins, trimmed and without any runtime line, or null when nothing of the run's own is left.
export function runOwnNotice(notice) {
  return trailingStripped(notice, ORIGIN_EXCLUDED_LINE_PREFIXES).trim() || null;
}
