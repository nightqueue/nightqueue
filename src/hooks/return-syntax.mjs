import { readFileSync } from "node:fs";
import { unfencedLines } from "../queue/stream.mjs";

const HEAD_DECLARATION_RE = /^RETURN-HEAD:[ \t]*(.*\S)[ \t]*$/gm;
const MAX_LINES_DECLARATION_RE = /^RETURN-MAX-LINES:[ \t]*(\d+)[ \t]*$/gm;
const PLACEHOLDER_RE = /<[^<>]+>/;

// The text of a transcript message, whichever of the host's two shapes carries it.
function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("\n");
}

// The subagent's own prompt: the first user event of its transcript, or an empty text when it has none.
function firstUserText(transcriptPath) {
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const event = JSON.parse(line);
    if (event?.type === "user") return messageText(event.message?.content);
  }
  return "";
}

// The value on the last line a declaration pattern matches, so a note quoted earlier in the prompt never overrides the block's own.
function lastDeclared(text, pattern) {
  return [...text.matchAll(pattern)].at(-1)?.[1] ?? null;
}

// The return syntax a prompt declares on its own lines outside a code fence, or null, so a declaration only quoted in a fence holds nobody to it.
function declaredSyntax(prompt) {
  const unfenced = unfencedLines(prompt).join("\n");
  const head = lastDeclared(unfenced, HEAD_DECLARATION_RE);
  const maxLines = lastDeclared(unfenced, MAX_LINES_DECLARATION_RE);
  if (head === null && maxLines === null) return null;
  return { head, maxLines: maxLines === null ? null : Number(maxLines) };
}

// A whole-line pattern of a declared head: its text literal, each `<…>` placeholder any non-empty text.
function headPattern(head) {
  const literals = head.split(new RegExp(PLACEHOLDER_RE.source)).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${literals.join(".+")}$`, "u");
}

// Whether a final message follows a declared syntax: its first line shaped like the head, within the line limit.
function followsSyntax(message, { head, maxLines }) {
  const lines = message.trim().split("\n");
  const headFits = head === null || headPattern(head).test(lines[0].trim());
  return headFits && (maxLines === null || lines.length <= maxLines);
}

// The instruction a blocked subagent receives, quoting what its own prompt declared.
function blockReason({ head, maxLines }) {
  const parts = [...(head === null ? [] : [`open with one line shaped like \`${head}\``]), ...(maxLines === null ? [] : [`have at most ${maxLines} lines`])];
  return `Your final message must ${parts.join(" and ")}, as your prompt declares. Send the final message again in that syntax; change nothing else.`;
}

// The decision for one stop event: a block only when the subagent's first stop breaks what its prompt declares.
function stopDecision(input) {
  if (input?.stop_hook_active === true) return "";
  if (typeof input?.last_assistant_message !== "string" || typeof input?.agent_transcript_path !== "string") return "";
  const syntax = declaredSyntax(firstUserText(input.agent_transcript_path));
  if (syntax === null || followsSyntax(input.last_assistant_message, syntax)) return "";
  return JSON.stringify({ decision: "block", reason: blockReason(syntax) });
}

// Enforces the return syntax a subagent's prompt declares, blocking its first stop once; any failure lets the stop pass.
export function runReturnSyntax({ input }) {
  try {
    return stopDecision(input);
  } catch {
    return "";
  }
}
