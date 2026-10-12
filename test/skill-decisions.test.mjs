import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const SKILL = read("plugin/skills/resolve/SKILL.md");
const ARCHITECT = read("plugin/agents/architect.md");
const SERVER = read("src/mcp/tools.mjs");
const ARCHITECT_PROMPT = read("plugin/skills/resolve/references/prompts/architect.md");
const PR_TEMPLATE = read("plugin/skills/resolve/references/pr-template.md");
const PHASE_PROMPT = read("src/mcp/phase-prompt.mjs");

// Reflect files the pipeline must keep away from the decisions table.
const REFLECT_FILES = ["src/hooks/reflect.mjs", "src/hooks/reflect-worker.mjs", "src/cli/reflect.mjs", "src/memory/dedup.mjs"];

const PIPELINE_FILES = {
  "plugin/skills/resolve/SKILL.md": SKILL,
  "plugin/agents/architect.md": ARCHITECT,
  "plugin/skills/resolve/references/prompts/architect.md": ARCHITECT_PROMPT,
};

test("no pipeline file asks a run to propose a decision", () => {
  for (const [file, text] of Object.entries(PIPELINE_FILES)) {
    assert.equal(text.includes("Proposed decision"), false, `${file} still carries a Proposed decision`);
    assert.equal(text.includes("Proposed (not binding)"), false, `${file} still carries a Proposed (not binding) section`);
  }
  assert.equal(PR_TEMPLATE.includes("proposed by this run"), false, "the PR template still mentions a decision proposed by the run");
});

test("neither architect file presents decisions as binding", () => {
  for (const [file, text] of [["agents/architect.md", ARCHITECT], ["prompts/architect.md", ARCHITECT_PROMPT]]) {
    assert.equal(text.includes("## Standing decisions"), false, `${file} still carries a Standing decisions section`);
    assert.equal(text.includes("Standing decisions are binding"), false, `${file} still says standing decisions are binding`);
  }
  assert.equal(ARCHITECT_PROMPT.includes("STANDING_TITLES"), false, "the architect template still has the standing titles placeholder");
  assert.equal(ARCHITECT_PROMPT.includes("PROPOSED_TITLES"), false, "the architect template still has the proposed titles placeholder");
});

test("the phase prompt builder renders no decision values", () => {
  assert.equal(PHASE_PROMPT.includes("decisionValues"), false, "src/mcp/phase-prompt.mjs still builds decision values");
  assert.equal(PHASE_PROMPT.includes("STANDING_TITLES"), false, "src/mcp/phase-prompt.mjs still fills STANDING_TITLES");
});

test("the resolve skill reads decisions as optional context and never writes one", () => {
  assert.ok(SKILL.includes("**Decisions are the operator's record, never a constraint of this run.**"), SKILL);
  assert.ok(SKILL.includes("A run never saves or updates a decision"), SKILL);
  assert.ok(SKILL.includes("a conflict with one is never, by\n     itself, a gate."), SKILL);
});

test("the architect may read decisions but never writes one", () => {
  const [, frontmatter] = ARCHITECT.split("---");
  assert.ok(frontmatter.includes("mcp__nightqueue__decision_recall"), frontmatter);
  assert.equal(frontmatter.includes("decision_save"), false, "the architect must not be granted `decision_save`");
  assert.equal(frontmatter.includes("decision_update"), false, "the architect must not be granted `decision_update`");
});

test("every decisions tool the pipeline markdown names is a tool the server really registers", () => {
  const named = new Set([...SKILL.matchAll(/decision_(?:save|recall|update|list)\b/g)].map((m) => m[0]));
  for (const file of [ARCHITECT]) for (const m of file.matchAll(/decision_(?:save|recall|update|list)\b/g)) named.add(m[0]);
  assert.ok(named.size >= 3, `the pipeline markdown names only ${[...named].join(", ")}`);
  for (const tool of named) {
    assert.ok(SERVER.includes(`name: "${tool}"`), `the markdown names \`${tool}\`, which src/mcp/tools.mjs does not register`);
  }
});

test("the reflect worker stays out of the decisions table", () => {
  for (const file of REFLECT_FILES) {
    const source = read(file);
    assert.equal(source.includes("decisions.mjs"), false, `${file} imports the decisions module`);
  }
});
