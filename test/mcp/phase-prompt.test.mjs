import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { LESSON_TARGET_OF, PROMPT_TARGETS, phasePrompt, promptsDir, renderTemplate, templateOf } from "../../src/mcp/phase-prompt.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, claimJobById, persistRunFacts } from "../../src/memory/jobs.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { ensureProject, makeHome, makeProject, projectIdOf, projectPathOf } from "../../test-support/memory.mjs";

const FIXTURES = new URL("../fixtures/skill-templates/", import.meta.url);
const RUN = "/runs/p/add-slugify";
const REPO = "/work/wt";
const SLUG = "add-slugify";
const WORKER = "host:4242";

// Every value a template may read, with every flag on, so every conditional line of the old templates is rendered.
const FULL = {
  RUN_DIR: RUN,
  REPOSITORY: REPO,
  PROJECT: "alpha",
  TIER: "simple",
  TYPE: "bug/error",
  BRIEF: "## Brief\n**Affected area:** src/text.mjs",
  AFFECTED_AREA: "src/text.mjs",
  OBJECTIVE: "add slugify",
  EXPECTED_OUTCOME: "slugify turns a title into a slug",
  BUG_ACCOUNT: "user 42",
  VERIFIER_SCOPE: "tsc + lint + the project's FULL test suite (no QA PoCs in this tier)",
  CLAUDE_MD: `${REPO}/CLAUDE.md`,
  CONTEXT_BLOCK: "## Applicable lessons\n- [L1] close the descriptor",
  INDEX_PATHS: "- src/text.mjs",
  INDEX_MAP: "- src/text.mjs — the text helpers",
  INDEX_LIBS: "zod@4.6.5",
  STANDING_TITLES: "- D-1 the worker keeps a lease",
  STANDING_DETAIL: "- D-1 the worker keeps a lease — renew it every tick",
  PROPOSED_TITLES: "- D-2 the queue gets priorities",
  IS_BUG: true,
  SIMPLE: true,
  TRIAGED: true,
  HAS_USAGE_COVERAGE: true,
  PLUGIN_ROOT: "/opt/nightqueue/plugin",
  RAW_EVIDENCE: "TypeError: text.split is not a function",
  DELIVERY_CONSTRAINTS: "it must not touch native code",
  STAGE: "2 — the report",
  GROUP: "H1, H2 (group: parsing)",
  NOTE: "the verifier failed on the empty title",
  ARTIFACT: "06-runtime.md",
};

// The template each golden fixture was moved into; the attack brief lives inside both QA prompts that paste it.
const GOLDEN = [
  ["coder-fast", ["coder-fast"]],
  ["verifier-fast", ["verifier-fast"]],
  ["triager", ["triager"]],
  ["explore", ["explore"]],
  ["architect", ["architect"]],
  ["coder", ["coder"]],
  ["verifier", ["verifier"]],
  ["coder-fix", ["coder-fix"]],
  ["runtime", ["runtime"]],
  ["qa-lite", ["qa-lite"]],
  ["qa-analyst", ["qa-analyst"]],
  ["qa-prover", ["qa-prover"]],
  ["qa-attack-brief", ["qa-lite", "qa-analyst"]],
];

const TEMPLATES = ["coder-fast", "verifier-fast", "triager", "explore", "architect", "coder", "verifier", "coder-fix", "runtime", "qa-lite", "qa-analyst", "qa-prover"];

// A fixture of the templates as the skill carried them before the move.
function fixture(name) {
  return readFileSync(new URL(`${name}.txt`, FIXTURES), "utf8");
}

// Whitespace collapsed, so a rewrap-free comparison ignores only spacing.
function collapse(text) {
  return text.replace(/\s+/g, " ").trim();
}

// Escapes a literal for a regular expression.
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The lines of a fixture as matchers: a `[...]` placeholder (nested, and across lines) becomes a wildcard; a line that is only placeholders is skipped.
function lineMatchers(text) {
  const lines = [];
  let depth = 0;
  let segments = [];
  let literal = "";
  let touched = false;
  const closeLiteral = () => {
    if (literal.trim()) segments.push({ literal: collapse(literal) });
    literal = "";
  };
  const closeLine = () => {
    closeLiteral();
    const literals = segments.filter((segment) => segment.literal);
    if (literals.length > 0 && !/^- D-<n> /.test(literals[0].literal)) lines.push({ segments, touched });
    segments = [];
    touched = depth > 0;
  };
  for (const char of text.replaceAll("<RUN_DIR>", RUN).replaceAll("<CWD>", REPO)) {
    if (char === "\n") closeLine();
    else if (char === "[") {
      if (depth === 0) closeLiteral();
      depth += 1;
      touched = true;
    } else if (char === "]" && depth > 0) {
      depth -= 1;
      if (depth === 0) segments.push({ wild: true });
    } else if (depth === 0) literal += char;
  }
  closeLine();
  return lines.map(({ segments: parts, touched: wild }) => {
    const exact = parts.filter((part) => part.literal).map((part) => part.literal).join(" ");
    if (!wild) return { text: exact, test: (line) => collapse(line) === exact };
    const pattern = parts.map((part) => (part.wild ? ".*" : escapeRegExp(part.literal))).join("\\s*");
    const regex = new RegExp(`^${pattern}$`);
    return { text: exact, test: (line) => regex.test(collapse(line)) };
  });
}

// Asserts every non-placeholder line of the fixture appears in the render, in order.
function assertLinesPreserved(fixtureName, render, template) {
  const lines = render.split("\n");
  let from = 0;
  for (const matcher of lineMatchers(fixture(fixtureName))) {
    const at = lines.findIndex((line, index) => index >= from && matcher.test(line));
    assert.ok(at >= 0, `${fixtureName} → ${template}: the line is missing or out of order: ${matcher.text}`);
    from = at + 1;
  }
}

test("golden: every line of each old template survives, in order, in the render of its new home", () => {
  for (const [name, templates] of GOLDEN) {
    for (const template of templates) assertLinesPreserved(name, renderTemplate(template, FULL), template);
  }
});

test("the handoff contract heads every prompt, and the fast prompts carry its generic lines verbatim", () => {
  const contract = fixture("handoff").trim().split("\n");
  for (const template of TEMPLATES) {
    assert.equal(renderTemplate(template, FULL).split("\n")[0], contract[0], `${template} does not open with the handoff contract`);
  }
  for (const template of ["coder-fast", "verifier-fast"]) {
    const render = renderTemplate(template, FULL);
    for (const line of contract.slice(3)) assert.ok(render.includes(`${line}\n`), `${template} misses: ${line}`);
  }
});

test("the lesson target of each context block is the one the old placeholder order named", () => {
  const skillOrder = ["coder-fast", "triager", "explore", "architect", "coder", "verifier"];
  const qaOrder = ["qa-lite", "qa-analyst"];
  const oldTargets = (names) => names.map((name) => fixture(name).match(/\(target: "(\w+)"\)/)[1]);
  assert.deepEqual(oldTargets(skillOrder), ["coder", "triager", "explore", "architect", "coder", "verifier"]);
  assert.deepEqual(oldTargets(qaOrder), ["qa", "qa"]);
  assert.deepEqual(skillOrder.map((name) => LESSON_TARGET_OF[name]), oldTargets(skillOrder));
  assert.deepEqual(qaOrder.map((name) => LESSON_TARGET_OF[name]), oldTargets(qaOrder));
  for (const template of TEMPLATES) {
    const carries = readFileSync(join(promptsDir(), `${template}.md`), "utf8").includes("{{>_context}}");
    assert.equal(carries, template in LESSON_TARGET_OF, `${template}: the context block and the lesson target disagree`);
  }
});

test("no render leaves a placeholder behind, whatever the type, the coverage and the optional values", () => {
  const empty = Object.fromEntries(Object.entries(FULL).map(([key, value]) => [key, typeof value === "boolean" ? false : value]));
  for (const optional of ["CLAUDE_MD", "CONTEXT_BLOCK", "INDEX_PATHS", "INDEX_MAP", "STANDING_TITLES", "STANDING_DETAIL", "PROPOSED_TITLES", "RAW_EVIDENCE", "DELIVERY_CONSTRAINTS", "STAGE", "NOTE"]) empty[optional] = "";
  for (const template of TEMPLATES) {
    for (const base of [FULL, empty]) {
      for (const IS_BUG of [true, false]) {
        for (const HAS_USAGE_COVERAGE of [true, false]) {
          const render = renderTemplate(template, { ...base, IS_BUG, HAS_USAGE_COVERAGE });
          assert.equal(/\{\{|\}\}/.test(render), false, `${template} left a tag: ${render}`);
          assert.equal(/\n{3,}/.test(render), false, `${template} left a run of blank lines`);
        }
      }
    }
  }
});

test("the conditional sections follow the type, the usage coverage and the triage", () => {
  const lite = (values) => renderTemplate("qa-lite", { ...FULL, ...values });
  assert.ok(lite({ IS_BUG: true }).includes("MANDATORY (the bug's regression net)"));
  assert.equal(lite({ IS_BUG: false }).includes("MANDATORY (the bug's regression net)"), false);
  assert.equal(lite({ IS_BUG: false }).includes("## Symptom coverage — TWO attacks"), false);
  assert.ok(lite({ HAS_USAGE_COVERAGE: true }).includes("Step 0 — BEFORE reading 03-plan.md"));
  assert.equal(lite({ HAS_USAGE_COVERAGE: false }).includes("Step 0 — BEFORE reading 03-plan.md"), false);
  assert.equal(lite({ HAS_USAGE_COVERAGE: false }).includes("## Usage coverage — with YOUR"), false);
  assert.ok(renderTemplate("coder-fast", { ...FULL, TRIAGED: false }).includes("Read before acting (via Read): none\n"));
  assert.equal(renderTemplate("coder-fast", { ...FULL, SIMPLE: false }).includes("Follow the test patterns"), false);
  assert.equal(renderTemplate("triager", { ...FULL, RAW_EVIDENCE: "" }).includes("Raw evidence from the user"), false);
  assert.ok(renderTemplate("coder", FULL).includes("Relaunch note:\nthe verifier failed on the empty title\n\nRepository: /work/wt"));
});

test("a placeholder with no value is an error, never a half prompt", () => {
  const { NOTE: _note, ...missing } = FULL;
  assert.throws(() => renderTemplate("coder", missing), /the prompt placeholder `NOTE` has no value/);
});

test("the fast tiers render the fast coder and verifier; every other target is its own template", () => {
  assert.equal(templateOf("coder", "simple"), "coder-fast");
  assert.equal(templateOf("verifier", "trivial"), "verifier-fast");
  assert.equal(templateOf("coder", "complex"), "coder");
  assert.equal(templateOf("coder-fix", "simple"), "coder-fix");
  const shipped = readdirSync(promptsDir()).filter((file) => !file.startsWith("_")).map((file) => file.replace(/\.md$/, ""));
  for (const target of PROMPT_TARGETS) assert.ok(shipped.includes(templateOf(target, "complex")), target);
});

// A home with one claimed job bound to its run, the run's tier and type recorded, and its Brief written.
function makeRun(t, name, { tier = "simple", type = "feature/refactor", brief = true, worktree = true } = {}) {
  const home = makeHome(t, name);
  const repo = makeProject(t, home, "alpha");
  const job = addJob({ projectId: ensureProject(home, "alpha"), prompt: "add slugify" }, home);
  claimJobById(job.id, { worker: WORKER, cap: 4 }, home);
  persistRunFacts(job.id, { worker: WORKER, slug: SLUG, sessionId: `${name}-session` }, home);
  const env = { ...home, NIGHTQUEUE_JOB_ID: String(job.id) };
  const run = { project: "alpha", projectId: projectIdOf(home, "alpha"), slug: SLUG };
  recordRunFields({ projectId: run.projectId, slug: SLUG, fields: worktree ? { tier, type, worktree: repo } : { tier, type }, env: home });
  const dir = runDir(run.projectId, SLUG, home);
  mkdirSync(dir, { recursive: true });
  const text = "## Brief\n**Affected area:** the worker lease\n**Objective:** renew the lease\n**Expected outcome:** no lost job\n**Type:** feature/refactor\n";
  if (brief) writeFileSync(join(dir, "00-brief.md"), text);
  return { env, home, run, repo, dir };
}

// The lesson ids a prompt carries, in order.
function lessonIds(prompt) {
  return [...prompt.matchAll(/\[L(\d+)\]/g)].map((match) => Number(match[1]));
}

test("`phase_prompt` answers the prompt, the agent, the model, the artifact and its gate for the run's tier", async (t) => {
  const { env, run, dir, repo } = makeRun(t, "phase-prompt-coder");
  const answer = await phasePrompt({ target: "coder" }, { run, env });
  assert.equal(answer.subagent_type, "nightqueue:coder");
  assert.equal(answer.model, "sonnet");
  assert.equal(answer.artifact, join(dir, "04-implementation.md"));
  assert.equal(answer.check, "04");
  assert.deepEqual(answer.open_items, []);
  assert.ok(answer.prompt.startsWith("## File handoff (contract — read first)\n"));
  assert.ok(answer.prompt.includes("Affected area: the worker lease\n"));
  assert.ok(answer.prompt.includes(`Repository: ${repo}\nProject: alpha\n`));
  assert.ok(answer.prompt.includes("Read before acting (via Read): none\n"));
});

test("`phase_prompt` refuses a run whose Brief was never written, naming the path", async (t) => {
  const { env, run, dir } = makeRun(t, "phase-prompt-no-brief", { brief: false });
  await assert.rejects(phasePrompt({ target: "coder" }, { run, env }), (error) => {
    assert.equal(error.message, `write the Brief to ${join(dir, "00-brief.md")} first (then \`nightqueue run check 00\`)`);
    return true;
  });
});

test("two phases of one run never get the same lesson, as with `context_for_phase`", async (t) => {
  const { env, home, run } = makeRun(t, "phase-prompt-dedupe", { tier: "complex" });
  for (let i = 0; i < 8; i += 1) {
    saveLesson({ projectId: run.projectId, title: `the worker lease drops ${i}`, root_cause: "late", solution: "renew", prevention: `renew the worker lease ${i}` }, home);
  }
  const coder = await phasePrompt({ target: "coder" }, { run, env });
  const verifier = await phasePrompt({ target: "verifier" }, { run, env });
  assert.ok(lessonIds(coder.prompt).length > 0, "the coder got no lesson");
  assert.deepEqual(lessonIds(verifier.prompt).filter((id) => lessonIds(coder.prompt).includes(id)), []);
});

test("the architect gets the standing decisions of the project, titled by their ref", async (t) => {
  const { env, home, run } = makeRun(t, "phase-prompt-architect", { tier: "complex" });
  saveDecision({ projectId: run.projectId, title: "the worker keeps a lease", context: "c", decision: "renew the lease every tick", status: "accepted" }, home);
  saveDecision({ projectId: run.projectId, title: "the queue gets priorities", context: "c", decision: "p1 first", status: "proposed" }, home);
  const { prompt, model } = await phasePrompt({ target: "architect", delivery_constraints: "it must not touch native code" }, { run, env });
  assert.equal(model, "opus");
  assert.ok(prompt.includes("## Standing decisions\n- D-1 the worker keeps a lease\n"), prompt);
  assert.ok(prompt.includes("- D-1 the worker keeps a lease — renew the lease every tick"), prompt);
  assert.ok(prompt.includes("## Proposed (not binding)\n- D-2 the queue gets priorities\n"), prompt);
  assert.ok(prompt.includes("Delivery constraints (the limit of what may be delivered — NEVER design; omit the line if there is none):\nit must not touch native code\n"));
});

test("a run with no worktree recorded gets the registered checkout as its Repository, named in an open item", async (t) => {
  const { env, home, run } = makeRun(t, "phase-prompt-no-worktree", { worktree: false });
  const checkout = projectPathOf(home, "alpha");
  const answer = await phasePrompt({ target: "coder" }, { run, env });
  assert.ok(answer.prompt.includes(`Repository: ${checkout}\n`), answer.prompt);
  assert.deepEqual(answer.open_items, [`the run has no worktree recorded; Repository is the registered checkout of \`alpha\` (${checkout})`]);
});

test("a target outside the tier's row is rendered anyway, with an open item", async (t) => {
  const { env, run } = makeRun(t, "phase-prompt-outside");
  const answer = await phasePrompt({ target: "architect" }, { run, env });
  assert.equal(answer.model, "opus");
  assert.match(answer.open_items[0], /the architecture phase does not run in the simple tier/);
});

test("the runtime lane may write another artifact of the run, which then has no phase gate", async (t) => {
  const { env, run, dir } = makeRun(t, "phase-prompt-runtime", { tier: "complex" });
  const measure = await phasePrompt({ target: "runtime", artifact: "00-main-measure.md" }, { run, env });
  assert.equal(measure.artifact, join(dir, "00-main-measure.md"));
  assert.equal(measure.check, null);
  assert.ok(measure.prompt.includes(`ARTIFACT_PATH: ${join(dir, "00-main-measure.md")}\n`));
  await assert.rejects(phasePrompt({ target: "runtime", artifact: "../x.md" }, { run, env }), /invalid `artifact`/);
  await assert.rejects(phasePrompt({ target: "coder", artifact: "x.md" }, { run, env }), /only accepted with `target: "runtime"`/);
  await assert.rejects(phasePrompt({ target: "qa-prover" }, { run, env }), /`group` is required/);
});
