import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The two Claude Code paths left untracked in a checkout, with the exclude line and the probe of each; never `.claude/` as a whole.
export const CLAUDE_EXCLUDE_RULES = Object.freeze([
  Object.freeze({ line: "/.claude/worktrees/", probe: ".claude/worktrees/x" }),
  Object.freeze({ line: "/.claude/settings.local.json", probe: ".claude/settings.local.json" }),
]);

const DEFAULT_FS = { readFileSync, appendFileSync, mkdirSync };

// Tells whether a checkout-relative path is one of the Claude Code paths the exclude rules cover.
export function isClaudeLocalPath(path) {
  return CLAUDE_EXCLUDE_RULES.some(({ line }) => {
    const relative = line.slice(1);
    return relative.endsWith("/") ? path.startsWith(relative) : path === relative;
  });
}

// Whether git ignores one path of the checkout: `covered` (exit 0), `missing` (exit 1) or `unknown` (anything else).
export function probeIgnored({ cwd, gitImpl, probe }) {
  try {
    gitImpl({ args: ["check-ignore", "-q", "--no-index", probe], cwd });
    return "covered";
  } catch (err) {
    return err?.status === 1 ? "missing" : "unknown";
  }
}

// The exclude lines the checkout does not ignore yet, or null when git did not answer for one of them.
export function missingClaudeExcludes({ cwd, gitImpl }) {
  const missing = [];
  for (const rule of CLAUDE_EXCLUDE_RULES) {
    const coverage = probeIgnored({ cwd, gitImpl, probe: rule.probe });
    if (coverage === "unknown") return null;
    if (coverage === "missing") missing.push(rule.line);
  }
  return missing;
}

// The local exclude file of the checkout, in the common git dir every linked worktree shares, or null when git failed.
export function claudeExcludeFile({ cwd, gitImpl }) {
  try {
    const commonDir = String(gitImpl({ args: ["rev-parse", "--git-common-dir"], cwd }) ?? "").trim();
    return commonDir ? join(resolve(cwd, commonDir), "info", "exclude") : null;
  } catch {
    return null;
  }
}

// The text of an exclude file that may not exist yet; a missing file reads as empty.
function readExcludeText(file, fs) {
  try {
    return String(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

// Appends the missing lines to the exclude file, on a line of their own even when the file does not end in a newline.
function appendLines(file, text, lines, fs) {
  fs.mkdirSync(dirname(file), { recursive: true });
  const separator = text && !text.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(file, `${separator}${lines.map((line) => `${line}\n`).join("")}`);
}

// Makes the checkout's local `.git/info/exclude` ignore the Claude Code paths git does not ignore yet, never throwing.
export function ensureClaudeExcluded({ cwd, gitImpl, fs = DEFAULT_FS }) {
  let file = null;
  try {
    const missing = missingClaudeExcludes({ cwd, gitImpl });
    if (missing === null) return { status: "unknown" };
    if (!missing.length) return { status: "covered" };
    file = claudeExcludeFile({ cwd, gitImpl });
    if (!file) return { status: "unknown" };
    const text = readExcludeText(file, fs);
    const present = new Set(text.split("\n").map((line) => line.trim()));
    const lines = missing.filter((line) => !present.has(line));
    if (!lines.length) return { status: "overridden", file };
    appendLines(file, text, lines, fs);
    return { status: "added", file, lines };
  } catch (err) {
    return { status: "unwritable", file, error: err?.message ?? String(err) };
  }
}
