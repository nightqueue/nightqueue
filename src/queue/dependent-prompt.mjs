import { withoutCommentThreads } from "../integrations/origin.mjs";
import { unfencedLines } from "./stream.mjs";

// The phrases that condition a job on another job or pull request, matched case-insensitively and whole-word, anywhere in
// the prompt outside fenced code blocks and quoted `<comment-thread>` blocks: `after J-<n>` (or `after job J-<n>`),
// `once PR #<n> is merged` (also `pull request`, `has been`, `gets`), `depends on J-<n>` / `depends on job`, and
// `when #<n> lands` (or `when PR #<n> lands`). A bare `J-<n>` or `<KEY>-<n>` never matches: tracker keys look the same.
export const DEPENDENT_PROMPT_PATTERNS = [
  /\bafter\s+(?:job\s+)?J-\d+\b/i,
  /\bonce\s+(?:PR|pull request)\s+#\d+\s+(?:is|has been|gets)\s+merged\b/i,
  /\bdepends\s+on\s+(?:J-\d+\b|job\b)/i,
  /\bwhen\s+(?:PR\s+)?#\d+\s+lands\b/i,
];

// The refusal of a prompt that depends on another job, worded as the resolve skill's step 2.5.
export const DEPENDENT_PROMPT_REFUSAL =
  "This brief depends on another job's pull request. A job must be self-contained: fold this work into that job (as a stage) or make it independent. Nothing was changed.";

// The part of a prompt the dependency phrases are searched in: no fenced code, no quoted comment thread.
function searchableText(prompt) {
  return unfencedLines(withoutCommentThreads(prompt)).join("\n");
}

// The first phrase of a prompt that makes it depend on another job or pull request, or null when it is self-contained.
export function dependentPromptMatch(prompt) {
  if (typeof prompt !== "string" || prompt.trim() === "") return null;
  const text = searchableText(prompt);
  const found = DEPENDENT_PROMPT_PATTERNS.map((pattern) => pattern.exec(text)).filter(Boolean);
  if (found.length === 0) return null;
  return found.sort((a, b) => a.index - b.index)[0][0].replace(/\s+/g, " ");
}
