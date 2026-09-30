import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TIERS = ["trivial", "simple", "complex"];
export const SKILL_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "plugin", "skills", "resolve");

// The skill files the orchestrator reads for a tier: SKILL.md and the PR template always, the QA reference and attack brief on complex only.
export function loadedFiles(tier, skillDir = SKILL_DIR) {
  if (!TIERS.includes(tier)) throw new Error(`unknown tier \`${tier}\`; expected one of ${TIERS.join(", ")}`);
  const files = [join(skillDir, "SKILL.md"), join(skillDir, "references", "pr-template.md")];
  if (tier !== "complex") return files;
  return [...files, join(skillDir, "references", "qa-phase.md"), join(skillDir, "references", "prompts", "_qa-attack-brief.md")];
}

// The bytes a tier loads from the skill, read from disk.
export function loadedBytes(tier, skillDir = SKILL_DIR) {
  return loadedFiles(tier, skillDir).reduce((sum, path) => sum + Buffer.byteLength(readFileSync(path, "utf8")), 0);
}

// The markdown heading a line opens, or null for a body line.
function headingOf(line) {
  const match = /^(#{1,3}) (.+)$/.exec(line);
  return match ? match[2].trim() : null;
}

// The sections of a skill text split at its headings outside fenced blocks, each with its bytes.
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
    .map(({ title, lines }) => ({ title, bytes: Buffer.byteLength(`${lines.join("\n")}\n`) }));
}
