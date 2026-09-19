import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";

// The sections of nightshift's own pull request template, in the order it fixes them; it applies only when the repository declares none.
export const NIGHTSHIFT_SECTIONS = ["## Report", "## Cause", "## Changes", "## QA"];

// An ATX heading line, matched on the trimmed line.
const HEADING = /^(#{1,6})\s+(\S.*)$/;

// A heading that opens a section about pull requests, matched on whole words so `aprovação` or `Express` never count.
const PR_HEADING = /\bpull requests?\b|\bPRs?\b/i;

// The info strings a fenced block may carry and still be a markdown template, never a shell or code example.
const TEMPLATE_FENCE_INFO = new Set(["", "markdown", "md"]);

// Where a repository declares its pull request template, in precedence order: the first one found wins.
const CANDIDATES = [
  { path: ".github/PULL_REQUEST_TEMPLATE.md", embedded: false },
  { path: ".github/pull_request_template.md", embedded: false },
  { path: "docs/PR_TEMPLATE.md", embedded: false },
  { path: "CONTRIBUTING.md", embedded: true },
  { path: "CLAUDE.md", embedded: true },
];

// The template in effect when the repository declares none.
const NIGHTSHIFT_TEMPLATE = { source: "nightshift", path: null, label: "fallback", headings: NIGHTSHIFT_SECTIONS };

// A heading line with its level and text, or null when the line is not a heading.
function headingOf(line) {
  const match = HEADING.exec(line);
  return match ? { level: match[1].length, text: match[2].trim(), line } : null;
}

// The fence a line opens, with its marker and its lowercased info string, or null when it opens none.
function openingFence(line) {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(line);
  return match ? { marker: match[1], info: match[2].trim().toLowerCase(), lines: [] } : null;
}

// Whether a line closes the open fence: the same marker character, at least as long, and nothing after it.
function closesFence(line, fence) {
  const match = /^(`{3,}|~{3,})$/.exec(line);
  return match !== null && match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length;
}

// The text of a line outside HTML comments, trimmed, and whether a comment is still open at its end.
function visiblePart(line, inComment) {
  const closeAt = inComment ? line.indexOf("-->") : -1;
  if (inComment && closeAt < 0) return { visible: "", open: true };
  const rest = (inComment ? line.slice(closeAt + 3) : line).replace(/<!--[\s\S]*?-->/g, "");
  const openAt = rest.indexOf("<!--");
  return openAt < 0 ? { visible: rest.trim(), open: false } : { visible: rest.slice(0, openAt).trim(), open: true };
}

// The lines of a block with every single- or multi-line HTML comment removed.
function uncommentedLines(lines) {
  let open = false;
  return lines.map((line) => {
    const part = visiblePart(line, open);
    open = part.open;
    return part.visible;
  });
}

// The fenced block as the scan keeps it: its info string and the headings written inside it, outside comments.
function fenceBlock(fence) {
  const headings = uncommentedLines(fence.lines).map(headingOf).filter(Boolean);
  return { kind: "fence", info: fence.info, headings: headings.map((heading) => heading.line) };
}

// Feeds one line inside an open fence to the scan: either it closes the fence or it belongs to the block.
function scanFencedLine(state, line) {
  if (!closesFence(line, state.fence)) {
    state.fence.lines.push(line);
    return;
  }
  state.blocks.push(fenceBlock(state.fence));
  state.fence = null;
}

// Feeds one line outside any fence to the scan, dropping HTML comments and keeping headings and fence openings.
function scanOpenLine(state, line) {
  const { visible, open } = visiblePart(line, state.comment);
  state.comment = open;
  const fence = openingFence(visible);
  const heading = headingOf(visible);
  if (fence) state.fence = fence;
  else if (heading) state.blocks.push({ kind: "heading", ...heading });
}

// The headings and fenced blocks of a markdown text, in document order; a fence never closed runs to the end of the file.
function markdownBlocks(text) {
  const state = { blocks: [], fence: null, comment: false };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (state.fence) scanFencedLine(state, line);
    else scanOpenLine(state, line);
  }
  if (state.fence) state.blocks.push(fenceBlock(state.fence));
  return state.blocks;
}

// The template a whole file declares: every heading outside fences and comments, in file order.
function fileTemplate(text, path) {
  const headings = markdownBlocks(text).filter((block) => block.kind === "heading").map((block) => block.line);
  return { label: path, headings };
}

// The blocks of the section a heading opens, up to the next heading of the same or a higher level.
function sectionBlocks(blocks, start) {
  const level = blocks[start].level;
  const end = blocks.findIndex((block, index) => index > start && block.kind === "heading" && block.level <= level);
  return blocks.slice(start + 1, end < 0 ? blocks.length : end);
}

// The first fenced markdown block of a section that carries at least one heading, or undefined when the section has none.
function templateFence(section) {
  return section.find((block) => block.kind === "fence" && TEMPLATE_FENCE_INFO.has(block.info) && block.headings.length > 0);
}

// The template a pull request section of a file embeds, or null when no such section holds one.
function embeddedTemplate(text, path) {
  const blocks = markdownBlocks(text);
  for (const [index, block] of blocks.entries()) {
    if (block.kind !== "heading" || !PR_HEADING.test(block.text)) continue;
    const fence = templateFence(sectionBlocks(blocks, index));
    if (fence) return { label: `${path} § ${block.text}`, headings: fence.headings };
  }
  return null;
}

// The text of a candidate file, or null when the checkout has no regular file there; any other failure is named, never skipped.
function readCandidate(checkout, path) {
  const absolute = join(checkout, path);
  try {
    return statSync(absolute).isFile() ? readFileSync(absolute, "utf8") : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw new UserError(`the pull request template candidate ${absolute} cannot be read: ${error?.message ?? String(error)}`);
  }
}

// The template one candidate declares, or null when the checkout does not carry it.
function candidateTemplate(checkout, { path, embedded }) {
  const text = readCandidate(checkout, path);
  if (text === null) return null;
  const found = embedded ? embeddedTemplate(text, path) : fileTemplate(text, path);
  return found ? { source: "repo", path, ...found } : null;
}

// The pull request template in effect for a checkout: the repository's own, first match wins, or nightshift's when it declares none.
export function findPrTemplate(checkout) {
  for (const candidate of CANDIDATES) {
    const template = candidateTemplate(checkout, candidate);
    if (template) return template;
  }
  return NIGHTSHIFT_TEMPLATE;
}
