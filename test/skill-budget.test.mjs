import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  alwaysLoadedBytes,
  alwaysLoadedFiles,
  fileBytes,
  LAZY_REFERENCES,
  lazyFiles,
  phasePrompts,
  RUNTIME_RENDERED,
  SKILL_DIR,
  skillSections,
} from "../test-support/skill-size.mjs";

// Ratchet: lower these ceilings when the skill shrinks, never raise them to fit a change.
const ALWAYS_LOADED_CEILING = 8949;
const LAZY_CEILINGS = Object.freeze({
  "phases.md": 14450,
  "phase-8.md": 6853,
  "phase-9.md": 7725,
  "interactive-worktree.md": 2895,
  "qa-phase.md": 4106,
  "pr-template.md": 8852,
  "commit-template.md": 2457,
});
const SKILL_MAX_LINES = 248;
const ALWAYS_LOADED_BUDGET = 56173;
const SKILL_LINE_BUDGET = 350;
const PHASE_MAX_LINES = 40;
const PHASE_ZERO_MAX_LINES = 70;
const BLOCK_MAX_LINES = 12;
const FIRST_LAUNCH_SHARE = 0.6;
const BLOCK_TARGETS = ["triager", "explore", "architect", "coder", "coder-fix", "verifier", "runtime", "qa-triage", "qa-lite", "qa-analyst", "qa-prover", "reflector"];
const HOST_TERMS = /TaskCreate|bypassPermissions|isolation: worktree|EnterWorktree|ExitWorktree|nstest-demo|Measured 20|tool_use|TRIAGER ·|00-main-measure/;
const AGENTS_DIR = join(SKILL_DIR, "..", "..", "agents");
const SKILL_PATH = join(SKILL_DIR, "SKILL.md");
const PHASES_PATH = join(SKILL_DIR, "references", "phases.md");
const INTERACTIVE_PATH = join(SKILL_DIR, "references", "interactive-worktree.md");
const MAIN_DIR = fileURLToPath(new URL("fixtures/skill-main/", import.meta.url));

// Reads the text of one file of the plugin.
function textOf(path) {
  return readFileSync(path, "utf8");
}

test("every always-loaded and lazy file exists, so a moved file cannot drop out of the budget", () => {
  for (const path of [...alwaysLoadedFiles(), ...lazyFiles()]) assert.ok(existsSync(path), `the budget counts ${path}, which is not on disk`);
});

test("every top-level reference is either lazy-loaded or rendered by the runtime", () => {
  const listed = new Set([...LAZY_REFERENCES, ...RUNTIME_RENDERED]);
  for (const name of readdirSync(join(SKILL_DIR, "references")).filter((entry) => entry.endsWith(".md"))) {
    assert.ok(listed.has(name), `references/${name} is in neither LAZY_REFERENCES nor RUNTIME_RENDERED`);
  }
});

test("a run always loads no more resolve skill bytes than its ceiling", () => {
  assert.ok(ALWAYS_LOADED_CEILING <= ALWAYS_LOADED_BUDGET, `the always-loaded ceiling ${ALWAYS_LOADED_CEILING} was raised over the budget of ${ALWAYS_LOADED_BUDGET}`);
  const bytes = alwaysLoadedBytes();
  assert.ok(bytes <= ALWAYS_LOADED_CEILING, `a run always loads ${bytes} bytes of the resolve skill, over its ceiling of ${ALWAYS_LOADED_CEILING}`);
});

test("every lazy reference has its own ceiling and stays under it", () => {
  assert.deepEqual(Object.keys(LAZY_CEILINGS).sort(), [...LAZY_REFERENCES].sort(), "LAZY_CEILINGS and LAZY_REFERENCES name different files");
  for (const name of LAZY_REFERENCES) {
    const bytes = fileBytes(join(SKILL_DIR, "references", name));
    assert.ok(bytes <= LAZY_CEILINGS[name], `references/${name} is ${bytes} bytes, over its ceiling of ${LAZY_CEILINGS[name]}`);
  }
});

test("a queued job reads at most 60% of main's bytes before its first launch", () => {
  const before = fileBytes(join(MAIN_DIR, "SKILL.md"));
  const after = fileBytes(SKILL_PATH);
  assert.ok(after / before <= FIRST_LAUNCH_SHARE, `${after} bytes against main's ${before}`);
});

test("an interactive /resolve reads at most 60% of main's bytes before its first launch", () => {
  const before = fileBytes(join(MAIN_DIR, "SKILL.md")) + fileBytes(join(MAIN_DIR, "interactive-worktree.md"));
  const after = fileBytes(SKILL_PATH) + fileBytes(INTERACTIVE_PATH);
  assert.ok(after / before <= FIRST_LAUNCH_SHARE, `${after} bytes against main's ${before}`);
});

test("every target has one block in `## Phase prompts`, at most 12 lines with its return written out", () => {
  const { returnLines, blocks } = phasePrompts();
  assert.equal(returnLines.length, 3, "the section no longer states the shared return syntax");
  assert.deepEqual(Object.keys(blocks).sort(), [...BLOCK_TARGETS].sort());
  for (const [target, lines] of Object.entries(blocks)) {
    assert.ok(lines.length <= BLOCK_MAX_LINES, `the ${target} block has ${lines.length} lines`);
    assert.ok(lines.some((line) => line.startsWith("RETURN-HEAD: ")), `the ${target} block declares no return head`);
    assert.ok(lines[0].startsWith(`TARGET: ${target} · AGENT: nightqueue:`), `the ${target} block does not open with its target and agent`);
  }
});

test("SKILL.md stays a skeleton under its line ceiling, itself within 350 lines", () => {
  assert.ok(SKILL_MAX_LINES <= SKILL_LINE_BUDGET, `the SKILL.md line ceiling ${SKILL_MAX_LINES} was raised over ${SKILL_LINE_BUDGET}`);
  const lines = textOf(SKILL_PATH).split("\n").length;
  assert.ok(lines <= SKILL_MAX_LINES, `SKILL.md has ${lines} lines, over ${SKILL_MAX_LINES}`);
});

test("every Phase section of SKILL.md and of references/phases.md fits its line cap", () => {
  for (const path of [SKILL_PATH, PHASES_PATH]) {
    for (const { title, lines } of skillSections(textOf(path)).filter((section) => /^Phase \d+ /.test(section.title))) {
      const cap = title.startsWith("Phase 0 ") ? PHASE_ZERO_MAX_LINES : PHASE_MAX_LINES;
      assert.ok(lines <= cap, `"${title}" has ${lines} lines, over ${cap}`);
    }
  }
});

// A `disallowedTools:` frontmatter line names host tools only to deny them, so it is no use of a host term.
test("SKILL.md and the agents name no host or machine term", () => {
  const agents = readdirSync(AGENTS_DIR).filter((name) => name.endsWith(".md")).map((name) => join(AGENTS_DIR, name));
  for (const path of [SKILL_PATH, ...agents]) {
    const hit = textOf(path).split("\n").find((line) => !line.startsWith("disallowedTools:") && HOST_TERMS.test(line));
    assert.equal(hit, undefined, `${path} names a host or machine term: ${hit}`);
  }
});
