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

// The `## Phase prompts` of a SKILL text: the shared return lines and each target's block, its `<RETURN>` written out.
export function phasePrompts(text = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8")) {
  const section = text.slice(text.indexOf("## Phase prompts"));
  const returnLines = /^```\n(RETURN-HEAD:[^]*?)\n```$/m.exec(section)?.[1].split("\n") ?? [];
  const blocks = {};
  for (const [, target, body] of section.matchAll(/^### (\S+)\n```\n([^]*?)\n```$/gm)) {
    blocks[target] = body.split("\n").flatMap((line) => (line === "<RETURN>" ? returnLines : [line]));
  }
  return { returnLines, blocks };
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
