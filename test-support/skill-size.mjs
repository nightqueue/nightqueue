import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "plugin", "skills", "resolve");

export const LAZY_REFERENCES = Object.freeze([
  "phases.md",
  "phase-8.md",
  "phase-9.md",
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

export const SNIPPET_NAMES = Object.freeze(["LAUNCH", "RETURN", "REFLECTION", "LANE", "ROUND"]);
export const STEP_LINES = Object.freeze(["Receives", "Wanted", "Verdict"]);
const FILL_BOUNDARY = "NOTE:";
const PLACEHOLDER_RE = /<[^<>]+>/g;
const NO_ARTIFACT = "no artifact";
const ROUND_ARTIFACT_RE = /^0[567]-/;

// The shared snippets of a `## Phase prompts` section, each the lines of its named fence.
function snippetsOf(section) {
  const snippets = {};
  for (const name of SNIPPET_NAMES) {
    snippets[name] = new RegExp(`^\`\`\`${name}\\n([^]*?)\\n\`\`\`$`, "m").exec(section)?.[1].split("\n") ?? [];
  }
  return snippets;
}

// The full lines the section's prose gives each bare extra, keyed by the extra's name.
function bareExtrasOf(section) {
  const prose = /\(bare: (.+?)\)\./.exec(section)?.[1] ?? "";
  return Object.fromEntries([...prose.matchAll(/`([A-Z_]+): ([^`]+)`/g)].map(([, key, value]) => [key, `${key}: ${value}`]));
}

// One step of the section: its heading fields and its three lines, or an error naming what is malformed.
function stepOf(heading, body, bareExtras) {
  const [target, agent, model, artifact, ...extras] = heading.split(" · ");
  if (artifact === undefined) throw new Error(`the step heading names no artifact: ${heading}`);
  const lines = body.split("\n");
  const fields = {};
  for (const [index, name] of STEP_LINES.entries()) {
    const prefix = `- ${name}: `;
    if (!lines[index]?.startsWith(prefix)) throw new Error(`the ${target} step has no \`${prefix.trim()}\` line ${index + 1}`);
    fields[name] = lines[index].slice(prefix.length);
  }
  const extraLines = extras.map((extra) => bareExtras[extra] ?? extra);
  return { target, agent, model, artifact, extras: extraLines, lines, ...fields };
}

// A text with each named placeholder replaced by its value, by callback so a `$` in a value stays literal.
function substituted(line, values) {
  return line.replace(PLACEHOLDER_RE, (placeholder) => (Object.hasOwn(values, placeholder.slice(1, -1)) ? values[placeholder.slice(1, -1)] : placeholder));
}

// The launch of one step: the LAUNCH fence filled from the step, its extra lines after `TARGET:`, then its shared snippets.
function composed(step, snippets) {
  const values = { target: step.target, agent: step.agent, model: step.model, artifact: step.artifact, Receives: step.Receives, Wanted: step.Wanted, Verdict: step.Verdict };
  const launch = snippets.LAUNCH.filter((line) => !(step.artifact === NO_ARTIFACT && line.startsWith("ARTIFACT_PATH:"))).map((line) => substituted(line, values));
  const round = ROUND_ARTIFACT_RE.test(step.artifact) ? snippets.ROUND : [];
  const ending = step.artifact === NO_ARTIFACT ? snippets.REFLECTION : snippets.RETURN;
  return [launch[0], ...step.extras, ...launch.slice(1), ...round, ...snippets.LANE, ...ending];
}

// The `## Phase prompts` of a SKILL text: the shared snippets, each step as written, parsed, and as launched.
export function phasePrompts(text = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8")) {
  const at = text.indexOf("## Phase prompts");
  if (at < 0) throw new Error("the SKILL text has no `## Phase prompts` section");
  const section = text.slice(at);
  const snippets = snippetsOf(section);
  if (snippets.LAUNCH.length === 0) throw new Error("the `## Phase prompts` section has no LAUNCH fence");
  const bareExtras = bareExtrasOf(section);
  const blocks = {};
  const written = {};
  const steps = {};
  for (const [, heading, body] of section.matchAll(/^### (.+)\n((?:- .*\n?)+)/gm)) {
    const step = stepOf(heading, body.trimEnd(), bareExtras);
    steps[step.target] = step;
    written[step.target] = step.lines;
    blocks[step.target] = composed(step, snippets);
  }
  return { returnLines: snippets.RETURN, snippets, blocks, written, steps };
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
