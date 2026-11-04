import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "plugin", "skills", "resolve");

export const LAZY_REFERENCES = Object.freeze([
  "phases.md",
  "phase-8.md",
  "phase-9.md",
  "interactive-worktree.md",
  "qa-phase.md",
  "pr-template.md",
  "commit-template.md",
]);

export const RUNTIME_RENDERED = Object.freeze(["report.md"]);

// The bytes of one file read from disk.
export function fileBytes(path) {
  return Buffer.byteLength(readFileSync(path, "utf8"));
}

// The skill files every run loads: SKILL.md alone.
export function alwaysLoadedFiles(skillDir = SKILL_DIR) {
  return [join(skillDir, "SKILL.md")];
}

// The references a run reads only when its phase says so.
export function lazyFiles(skillDir = SKILL_DIR) {
  return LAZY_REFERENCES.map((name) => join(skillDir, "references", name));
}

// The bytes every run loads from the skill.
export function alwaysLoadedBytes(skillDir = SKILL_DIR) {
  return alwaysLoadedFiles(skillDir).reduce((sum, path) => sum + fileBytes(path), 0);
}

export const SNIPPET_NAMES = Object.freeze(["RETURN", "LANE", "ROUND"]);
const FILL_BOUNDARY = "NOTE:";
const PLACEHOLDER_RE = /<[^<>]+>/g;

// The shared snippets of a `## Phase prompts` section, each the lines of its named fence.
function snippetsOf(section) {
  const snippets = {};
  for (const name of SNIPPET_NAMES) {
    snippets[name] = new RegExp(`^\`\`\`${name}\\n([^]*?)\\n\`\`\`$`, "m").exec(section)?.[1].split("\n") ?? [];
  }
  return snippets;
}

// The lines of one written block with every snippet line replaced by the snippet's own lines.
function expanded(written, snippets) {
  return written.flatMap((line) => {
    const name = /^<([A-Z]+)>$/.exec(line)?.[1];
    return name !== undefined && SNIPPET_NAMES.includes(name) ? snippets[name] : [line];
  });
}

// The `## Phase prompts` of a SKILL text: the shared snippets, each block as written and as launched with its snippets written out.
export function phasePrompts(text = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8")) {
  const at = text.indexOf("## Phase prompts");
  if (at < 0) throw new Error("the SKILL text has no `## Phase prompts` section");
  const section = text.slice(at);
  const snippets = snippetsOf(section);
  const blocks = {};
  const written = {};
  for (const [, target, body] of section.matchAll(/^### (\S+)\n```\n([^]*?)\n```$/gm)) {
    written[target] = body.split("\n");
    blocks[target] = expanded(written[target], snippets);
  }
  return { returnLines: snippets.RETURN, snippets, blocks, written };
}

// The value of one placeholder: a `models.<role>` key reads `values.models`, an unknown key is `none`.
function placeholderValue(placeholder, values) {
  const key = placeholder.slice(1, -1);
  if (key.startsWith("models.")) return values.models?.[key.slice("models.".length)] ?? "none";
  return values[key] ?? "none";
}

// A block filled the way the orchestrator does: placeholders filled up to and including `NOTE:`, every later line copied as written.
export function fillBlock(lines, values = {}) {
  const boundary = lines.findIndex((line) => line.startsWith(FILL_BOUNDARY));
  if (boundary < 0) throw new Error(`the block has no \`${FILL_BOUNDARY}\` line: ${lines[0]}`);
  return lines.map((line, index) => (index > boundary ? line : line.replace(PLACEHOLDER_RE, (placeholder) => placeholderValue(placeholder, values))));
}

// The heading name of one `## ` line of a Deliver fence, cut at its first `:` or at a two-space parenthetical.
function headingName(line) {
  return line.split(":")[0].split(/ {2}\(/)[0].trim();
}

// The artifact a block writes and the `## ` headings of the `~~~` fence after its `## Deliver` line.
export function deliverOf(lines) {
  const artifactLine = lines.find((line) => line.startsWith("ARTIFACT_PATH:"));
  const artifact = artifactLine === undefined ? null : artifactLine.slice("ARTIFACT_PATH:".length).trim().split("/").pop();
  const deliver = lines.findIndex((line) => line.startsWith("## Deliver"));
  const open = deliver < 0 ? -1 : lines.findIndex((line, index) => index > deliver && line.startsWith("~~~"));
  const close = open < 0 ? -1 : lines.findIndex((line, index) => index > open && line.startsWith("~~~"));
  if (open >= 0 && close < 0) throw new Error(`the Deliver fence of the block is never closed: ${lines[0]}`);
  const headings = open < 0 ? [] : lines.slice(open + 1, close).filter((line) => line.startsWith("## ")).map(headingName);
  return { artifact, headings };
}

// The markdown heading a line opens, or null for a body line.
function headingOf(line) {
  const match = /^(#{1,3}) (.+)$/.exec(line);
  return match ? match[2].trim() : null;
}

// The sections of a skill text split at its headings outside fenced blocks, each with its bytes and line count.
export function skillSections(text) {
  const sections = [{ title: "(preamble)", lines: [] }];
  let fenced = false;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : headingOf(line);
    if (heading !== null) sections.push({ title: heading, lines: [] });
    sections[sections.length - 1].lines.push(line);
  }
  return sections
    .filter((section) => section.lines.length > 0)
    .map(({ title, lines }) => ({ title, bytes: Buffer.byteLength(`${lines.join("\n")}\n`), lines: lines.length }));
}
