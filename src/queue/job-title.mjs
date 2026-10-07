import { briefBody } from "./prompt-brief.mjs";

// A runtime header line the operator writes above the brief, which says nothing about the task itself.
const RUNTIME_HEADER = /^\s*tier(\s+raised)?\s*:/i;

const TITLE_LIMIT = 120;
const HEADING_MARKER = /^#{1,6}\s+/;
const BARE_HEADINGS = new Set(["brief", "task"]);

// The prompt text without its leading blank and runtime-header lines.
function withoutRuntimeHeader(text) {
  const lines = String(text ?? "").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "" && !RUNTIME_HEADER.test(line));
  return first < 0 ? "" : lines.slice(first).join("\n");
}

// The text a provisional slug is taken from: the brief of the prompt when it has one, the whole prompt otherwise, never a runtime header.
export function slugSource(prompt) {
  const brief = withoutRuntimeHeader(briefBody(prompt));
  return brief.trim() ? brief : withoutRuntimeHeader(prompt);
}

// Whether a prompt line is a heading that only names a section (`## Brief`, `# Task`) and says nothing itself.
function isBareHeading(line) {
  return HEADING_MARKER.test(line) && BARE_HEADINGS.has(line.replace(HEADING_MARKER, "").trim().toLowerCase());
}

// Cuts a title to the limit, the ellipsis included in it.
function clipTitle(text) {
  const points = Array.from(text);
  return points.length <= TITLE_LIMIT ? text : `${points.slice(0, TITLE_LIMIT - 1).join("")}…`;
}

// The readable title of a job, derived on read: its issue's title, else the first meaningful line of its prompt, else null.
export function jobTitle(job, issue) {
  const issueTitle = typeof issue?.title === "string" ? issue.title.trim() : "";
  if (issueTitle) return clipTitle(issueTitle.replace(/\s+/g, " "));
  const line = slugSource(job?.prompt)
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "" && !isBareHeading(entry));
  const title = line?.replace(HEADING_MARKER, "").trim();
  return title ? clipTitle(title) : null;
}
