import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const SKILL = read("plugin/skills/resolve/SKILL.md");
const ARCHITECT = read("plugin/agents/architect.md");
const SERVER = read("src/mcp/tools.mjs");
const ARCHITECT_PROMPT = read("plugin/skills/resolve/references/prompts/architect.md");
const PHASE_PROMPT = read("src/mcp/phase-prompt.mjs");

// Reflect files the pipeline must keep away from the decisions table.
const REFLECT_FILES = ["src/hooks/reflect.mjs", "src/hooks/reflect-worker.mjs", "src/cli/reflect.mjs", "src/memory/dedup.mjs"];

test("the Phase 0 preflight pings only lesson_recall and takes the decisions from the session block", () => {
  assert.ok(SKILL.includes("Call `lesson_recall` (MCP\n   `nightqueue`) ONCE, with `project` = the current project"), SKILL);
  assert.ok(SKILL.includes("`nightqueue memory unavailable: run nightqueue setup and retry`"), SKILL);
  assert.ok(
    SKILL.includes("the `## Standing decisions`\n     section of the `# Nightqueue context` block injected at the start of the session carries\n     them"),
    "step 0.1 does not say where the standing decisions already are",
  );
  assert.ok(SKILL.includes("them: EVERY accepted title of the project and of its org, org rows first"), SKILL);
  assert.ok(SKILL.includes("No preflight\n     call fetches them; `decision_recall` stays the way to refine them by query (`phase_prompt` does it for the architect)."), SKILL);
  assert.ok(
    SKILL.includes("**A `phase_prompt` answer whose `open_items` names the decision tools**"),
    "the fail-open bullet of the decision tools is missing from step 0.1",
  );
  assert.ok(SKILL.includes("→ the architect ran WITHOUT a `## Standing decisions` section: record it\n     as an open item of Phase 8."), SKILL);
  assert.ok(SKILL.includes("An empty log is different: the section is simply omitted, with\n     no open item."), SKILL);
  assert.ok(PHASE_PROMPT.includes('"the decision tools (the architect got no `## Standing decisions`)"'), "a failing decision tool no longer becomes an open item");
});

test("the architect prompt carries the proposed titles as a section that binds nothing", () => {
  assert.ok(ARCHITECT_PROMPT.includes("{{#PROPOSED_TITLES}}\n## Proposed (not binding)\n{{PROPOSED_TITLES}}\n"), ARCHITECT_PROMPT);
  assert.ok(ARCHITECT_PROMPT.includes("they bind nothing, and a design\nmay go against them without a confirmation."), ARCHITECT_PROMPT);
  assert.ok(PHASE_PROMPT.includes('decisions.decisionTitles({ projectId: run.projectId, status: "proposed" })'), "the proposed titles no longer come from the store");
  assert.ok(SKILL.includes("The architect's `## Standing decisions`\n   and `## Proposed (not binding)` sections are built by `phase_prompt` from the store"), SKILL);
  assert.ok(ARCHITECT.includes("A `## Proposed (not binding)` section lists, by title\nonly, decisions proposed and not accepted yet: they bind nothing"), ARCHITECT);
});

test("the architect prompt carries every accepted title plus the 8 closest decisions in full", () => {
  assert.ok(ARCHITECT_PROMPT.includes("{{#STANDING_TITLES}}\n## Standing decisions\n{{STANDING_TITLES}}\n"), ARCHITECT_PROMPT);
  assert.ok(ARCHITECT_PROMPT.includes("### In full (the 8 closest to this Brief)\n{{STANDING_DETAIL}}"), ARCHITECT_PROMPT);
  assert.ok(PHASE_PROMPT.includes('decisions.decisionTitles({ projectId: run.projectId, status: "accepted" })'), "the titles are no longer every accepted one");
  assert.ok(PHASE_PROMPT.includes("const DECISION_LIMIT = 8;"), "the full part is no longer the 8 closest");
  assert.ok(PHASE_PROMPT.includes('`${briefField(brief, "Affected area")} ${briefField(brief, "Objective")}`'), "the recall no longer queries the Affected area plus the Objective");
  assert.ok(PHASE_PROMPT.includes('row?.via !== "fallback"'), "a fallback row reaches the full part");
  assert.ok(PHASE_PROMPT.includes("decisionTitleLine"), "the titles are not rendered by the session block's own line");
  assert.equal(SKILL.includes("copy EVERY title from it, in the order it came."), false, "the skill still tells the orchestrator to copy the titles by hand");
  assert.equal(SKILL.includes("Take at most 5"), false, "the Brief still caps the standing decisions at five");
});

test("the architect prompt receives standing decisions as binding constraints, not as design", () => {
  assert.ok(
    ARCHITECT_PROMPT.includes(
      "These are the standing constraints of the project and of its org, decided before this task\n(a ref written `<ORGKEY>/D-<n>` belongs to the org and binds every project of it).\nThey are binding context, never a proposed solution: a design that contradicts one either\nfollows the decision or takes the conflict to `## Requires user confirmation` naming its\nref.",
    ),
    ARCHITECT_PROMPT,
  );
  assert.ok(SKILL.includes("The `## Standing decisions` section of the prompt below is NOT an exception to this\nprohibition"), SKILL);
});

test("a proposed decision is saved right after the Phase 3 gate, fail-open, and only when the block exists", () => {
  assert.ok(SKILL.includes("if\n`03-plan.md` contains a `## Proposed decision` block, call `decision_save` (MCP `nightqueue`)"), SKILL);
  assert.ok(SKILL.includes('`status: "proposed"`'), SKILL);
  assert.ok(SKILL.includes("A failed `decision_save` NEVER blocks the run —"), SKILL);
  assert.ok(
    SKILL.includes("no block → nothing is saved, nothing is recorded, and the run proceeds"),
    "the Phase 3 post-gate does not say that a plan without the block is the normal case",
  );
  assert.ok(
    SKILL.includes("`` Proposed decision <ref>: <title> — recorded as `proposed`; accept or reject it with `decision_update`. ``"),
    "the Phase 8 report does not carry the proposed-decision line",
  );
  assert.ok(
    SKILL.includes("**A decision proposed by this run is NOT part of the PR body.**"),
    "Phase 7 does not keep the proposed decision out of the pull request body",
  );
});

test("a needs_review proposal is saved again only with the plan's unrelated numbers, never superseding", () => {
  assert.equal(SKILL.includes("Save it ONCE per run"), false, "the prose still carries the run-side once-per-run rule");
  assert.ok(SKILL.includes("The runtime refuses a second proposal from the same job while the first is still `proposed`;"), SKILL);
  assert.ok(SKILL.includes('**A `needs_review` answer:** `decision_save` answers `status: "needs_review"` with `candidates`'), SKILL);
  assert.ok(
    SKILL.includes(
      "If the\nblock has an `**Unrelated to:**` line whose refs cover EVERY candidate, call\n`decision_save` again ONCE with `unrelated` = those refs.",
    ),
    SKILL,
  );
  assert.ok(
    SKILL.includes(
      "`Proposed decision not saved: it touches D-a, D-b (needs_review); the operator decides\nit with decision_save outside the queue`",
    ),
    SKILL,
  );
  assert.ok(SKILL.includes("Never pass\n`supersedes` from a run"), SKILL);
});

test("the architect's Proposed decision block may name the standing decisions it leaves untouched", () => {
  assert.ok(
    ARCHITECT.includes(
      "- **Unrelated to:** [D-<n> or <ORGKEY>/D-<n> — why this decision leaves it untouched, one line each; omit when no standing decision touches the subject]",
    ),
    ARCHITECT,
  );
  assert.ok(ARCHITECT.includes("A decision that CHANGES a standing one is not proposed from a run"), ARCHITECT);
});

test("the architect may read decisions but never writes one", () => {
  const [, frontmatter] = ARCHITECT.split("---");
  assert.ok(frontmatter.includes("mcp__nightqueue__decision_recall"), frontmatter);
  assert.equal(frontmatter.includes("decision_save"), false, "the architect must not be granted `decision_save`");
  assert.ok(ARCHITECT.includes("**Standing decisions are binding.**"), ARCHITECT);
  assert.ok(ARCHITECT.includes("naming the decision's ref (`D-<n>`)"), ARCHITECT);
  assert.ok(ARCHITECT.includes("The section lists EVERY accepted title plus the 8 closest to the task in full;"), ARCHITECT);
});

test("the architect's Proposed decision block is optional and carries the four fields decision_save takes", () => {
  assert.ok(ARCHITECT.includes("## Proposed decision   (only when this plan takes a structural decision no standing decision covers)"), ARCHITECT);
  for (const field of ["- **Title:**", "- **Context:**", "- **Decision:**", "- **Consequences:**"]) {
    assert.ok(ARCHITECT.includes(field), `the Proposed decision block is missing ${field}`);
  }
  assert.ok(ARCHITECT.includes("Omit the whole section when every structural choice of this plan is already covered by a\nstanding decision."), ARCHITECT);
  assert.ok(
    ARCHITECT.includes("a plan without it is complete and valid"),
    "nothing in architect.md says a plan without the block is still valid",
  );
  assert.ok(ARCHITECT.includes("## Proposed decision when this plan takes one"), "Step 5 lists the block as if it were mandatory");
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
