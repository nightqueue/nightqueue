import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const SKILL = read("plugin/skills/resolve/SKILL.md");
const ARCHITECT = read("plugin/agents/architect.md");
const SERVER = read("src/mcp/tools.mjs");

// Reflect files the pipeline must keep away from the decisions and roadmap tables.
const REFLECT_FILES = ["src/hooks/reflect.mjs", "src/hooks/reflect-worker.mjs", "src/cli/reflect.mjs", "src/memory/dedup.mjs"];

test("the Phase 0 preflight pings only lesson_recall and takes the decisions from the session block", () => {
  assert.ok(SKILL.includes("Call `lesson_recall` (MCP\n   `nightshift`) ONCE, with `project` = the current project"), SKILL);
  assert.ok(SKILL.includes("`nightshift memory unavailable: run nightshift setup and retry`"), SKILL);
  assert.ok(
    SKILL.includes("the `## Standing decisions`\n     section of the `# Nightshift context` block injected at the start of the session carries\n     them"),
    "step 0.1 does not say where the standing decisions already are",
  );
  assert.ok(SKILL.includes("No preflight\n     call fetches them; `decision_recall` stays the way to refine them by query (step 1)."), SKILL);
  assert.ok(
    SKILL.includes("**`decision_recall` failed or is unavailable while `lesson_recall` answered**"),
    "the fail-open bullet of decision_recall is missing from step 0.1",
  );
  assert.ok(SKILL.includes("→ continue WITHOUT a `## Standing decisions` section and record it as an open\n     item of Phase 8."), SKILL);
  assert.ok(SKILL.includes("An empty return is different: it means the project has no accepted\n     decision, and the section is simply omitted, with no open item."), SKILL);
});

test("the Brief carries an optional Standing decisions section fed by an accepted-only recall", () => {
  assert.ok(SKILL.includes("## Standing decisions   [omit the whole section when the recall came back empty]"), SKILL);
  assert.ok(SKILL.includes("- #<number> <title> — <the `decision` field in 1 line>"), SKILL);
  assert.ok(
    SKILL.includes("The source is the `## Standing decisions`\n   section of the `# Nightshift context` block you already received"),
    "the Brief paragraph does not name the session block as the source",
  );
  assert.ok(SKILL.includes("`query` = the `**Affected area:**` plus the `**Objective:**` of the Brief."), SKILL);
  for (const status of ["proposed", "superseded", "rejected"]) {
    assert.ok(
      SKILL.includes(`a \`${status}\``),
      `the Brief paragraph does not say what happens to a \`${status}\` decision`,
    );
  }
  assert.ok(SKILL.includes('a row marked `via: "fallback"` did not match the query and is'), SKILL);
});

test("the architect prompt receives standing decisions as binding constraints, not as design", () => {
  assert.ok(SKILL.includes("[Include only if the Standing decisions section of the Brief exists:]\n## Standing decisions\n- #<number> <title> — <decision>"), SKILL);
  assert.ok(
    SKILL.includes(
      "These are the standing constraints of the project and of its org, decided before this task\n(a number written `<owner>#<number>` belongs to the org and binds every project of it).\nThey are binding context, never a proposed solution: a design that contradicts one either\nfollows the decision or takes the conflict to `## Requires user confirmation` naming its\nnumber.",
    ),
    SKILL,
  );
  assert.ok(SKILL.includes("The `## Standing decisions` section of the prompt below is NOT an exception to this\nprohibition"), SKILL);
});

test("a proposed decision is saved right after the Phase 3 gate, fail-open, and only when the block exists", () => {
  assert.ok(SKILL.includes("if\n`03-plan.md` contains a `## Proposed decision` block, call `decision_save` (MCP `nightshift`)"), SKILL);
  assert.ok(SKILL.includes('`status: "proposed"`'), SKILL);
  assert.ok(SKILL.includes("A failed `decision_save` NEVER blocks the run —"), SKILL);
  assert.ok(
    SKILL.includes("no block → nothing is saved, nothing is recorded, and the run proceeds"),
    "the Phase 3 post-gate does not say that a plan without the block is the normal case",
  );
  assert.ok(
    SKILL.includes("`` Proposed decision <number>: <title> — recorded as `proposed`; accept or reject it with `decision_update`. ``"),
    "the Phase 8 report does not carry the proposed-decision line",
  );
  assert.ok(
    SKILL.includes("**A decision proposed by this run is NOT part of the PR body.**"),
    "Phase 7 does not keep the proposed decision out of the pull request body",
  );
});

test("the architect may read decisions but never writes one", () => {
  const [, frontmatter] = ARCHITECT.split("---");
  assert.ok(frontmatter.includes("mcp__nightshift__decision_recall"), frontmatter);
  assert.equal(frontmatter.includes("decision_save"), false, "the architect must not be granted `decision_save`");
  assert.ok(ARCHITECT.includes("**Standing decisions are binding.**"), ARCHITECT);
  assert.ok(ARCHITECT.includes("naming the decision's number"), ARCHITECT);
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

test("the reflect worker stays out of the decisions and roadmap tables", () => {
  for (const file of REFLECT_FILES) {
    const source = read(file);
    assert.equal(source.includes("decisions.mjs"), false, `${file} imports the decisions module`);
    assert.equal(source.includes("roadmap.mjs"), false, `${file} imports the roadmap module`);
  }
});
