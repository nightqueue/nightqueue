import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { phasePrompts } from "../test-support/skill-size.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AGENTS = ["coder", "qa-guardian", "verifier", "triager", "explore", "architect"];
const SKILL = join(ROOT, "plugin/skills/resolve/SKILL.md");
const REFERENCES = join(ROOT, "plugin/skills/resolve/references");
const QA_PHASE = join(REFERENCES, "qa-phase.md");
const PHASES = join(REFERENCES, "phases.md");
const RUNTIME_WORK = {
  verifier: "nightqueue verify",
  explore: "nightqueue libs",
  architect: "nightqueue libs",
  "qa-guardian": "nightqueue run secrets-sweep",
};
const REQUESTS = {
  triager: ["triager"],
  explore: ["explore"],
  architect: ["architect"],
  coder: ["coder", "coder-fix"],
  "qa-guardian": ["qa-triage", "qa-lite", "qa-analyst", "qa-prover"],
  verifier: ["verifier", "runtime"],
};
const INDEPENDENT = Object.keys(REQUESTS);

// Lists every file under plugin/ as an absolute path
function pluginFiles() {
  const dir = join(ROOT, "plugin");
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

// The fields a target's block of `## Phase prompts` declares, one per line.
function blockFields(target) {
  return phasePrompts().blocks[target].map((line) => line.split(":")[0]);
}

// Reads one plugin agent file with its line wrapping collapsed
function readAgent(agent) {
  return readFileSync(join(ROOT, `plugin/agents/${agent}.md`), "utf8").replace(/\s+/g, " ");
}

// One plugin agent's text above its `## Inside a run` section, line wrapping collapsed
function independentPart(agent) {
  return readAgent(agent).split(" ## Inside a run ")[0];
}

// The runtime resolves a path to its registered project, so no agent derives the project by hand.
test("no plugin file derives the project with git rev-parse", () => {
  const files = pluginFiles();
  assert.ok(files.length >= AGENTS.length + 1, "the plugin directory was not walked");
  const offenders = files.filter((file) => readFileSync(file, "utf8").includes("git-common-dir"));
  assert.deepEqual(offenders, [], `${offenders.length} plugin file(s) still derive the project by hand`);
});

// Each agent whose mechanical work moved into the runtime points at what replaced it.
test("each agent names the runtime work that replaced its prose", () => {
  for (const [agent, mention] of Object.entries(RUNTIME_WORK)) {
    assert.ok(readAgent(agent).includes(mention), `${agent} does not name \`${mention}\``);
  }
  assert.equal(independentPart("explore").includes("index-save"), false, "explore.md names the index persistence outside a run");
  assert.ok(readAgent("explore").includes("nightqueue run index-save"), "explore.md does not say the runtime persists the index inside a run");
});

// A pipeline-independent agent learns about the runtime blocks only inside a run, never from the text any request reads.
test("the triager's run section names the blocks the runtime hands it", () => {
  for (const block of ["`open-prs` entry of the job origin", "## Related jobs"]) {
    assert.ok(readAgent("triager").includes(block), `the triager's run section does not name \`${block}\``);
    assert.equal(independentPart("triager").includes(block), false, `triager.md names \`${block}\` outside a run`);
  }
});

// The verifier reads the scale of the diff off the block instead of running its own git commands.
test("the verifier reads the diff-hygiene line instead of running git itself", () => {
  const agent = readAgent("verifier");
  assert.ok(agent.includes("The `diff-hygiene` line of the `nightqueue verify` block"), "the verifier lost the diff-hygiene pointer");
  assert.ok(agent.includes("the summary of `git diff --stat`"), "the verifier does not report the scale of the change");
});

// Every block that carries the worktree also names the project, and each run agent reads the two as its Repository and Project.
test("each block of the skill carries a PROJECT line next to its WORKTREE line", () => {
  const { blocks } = phasePrompts();
  assert.ok(Object.keys(blocks).length >= 12, "the skill lost its blocks");
  for (const [target, lines] of Object.entries(blocks)) {
    const fields = lines.map((line) => line.split(":")[0]);
    assert.ok(fields.includes("RUN_DIR") && fields.includes("PROJECT"), `the ${target} block names neither the run nor the project`);
    if (target !== "reflector") assert.equal(fields[fields.indexOf("WORKTREE") + 1], "PROJECT", `the WORKTREE line of the ${target} block is not followed by its PROJECT line`);
  }
  for (const agent of AGENTS) {
    assert.ok(readAgent(agent).includes("`WORKTREE` is the `Repository:` and `PROJECT` the `Project:`"), `${agent} does not read its block's worktree and project`);
  }
  const references = readdirSync(REFERENCES).filter((name) => name.endsWith(".md")).map((name) => join(REFERENCES, name));
  assert.ok(references.includes(QA_PHASE), "the skill's top-level references were not found");
  for (const file of [SKILL, ...references]) {
    assert.equal(readFileSync(file, "utf8").includes("Repository: [CWD PATH]"), false, `${file} still carries a hand-filled prompt template`);
  }
});

// The secret-in-a-log sweep is a runtime command now, and its mandatory readings survive a host where the plugin root does not resolve.
test("the qa-guardian calls the sweep and still resolves its own plugin paths", () => {
  const agent = readAgent("qa-guardian");
  assert.ok(agent.includes("nightqueue run secrets-sweep --files"), "qa-guardian does not call the sweep command");
  assert.equal(agent.includes("grep -niE"), false, "qa-guardian still runs the greps the command replaced");
  assert.ok(
    agent.includes("fall back to `Glob` for `**/skills/qa-guardian/SKILL.md`"),
    "qa-guardian lost the Glob fallback for a prompt that brings no absolute path",
  );
  assert.ok(agent.includes("QA_SKILL: `<PLUGIN_ROOT>/skills/qa-guardian/SKILL.md`"), "the qa-guardian lost its QA_SKILL line");
  assert.deepEqual(
    REQUESTS["qa-guardian"].filter((target) => blockFields(target).includes("PLUGIN_ROOT")),
    ["qa-lite", "qa-analyst", "qa-prover"],
    "the three qa-guardian blocks do not all carry the plugin root",
  );
});

// The orchestrator only coordinates, so every lane returns pointers to its handoff file, never its contents.
test("each agent returns a short pointer, never file contents nor a diff", () => {
  for (const agent of AGENTS.filter((name) => !INDEPENDENT.includes(name))) {
    assert.ok(readAgent(agent).includes("never file contents, never a diff"), `${agent} may still return file contents or a diff`);
  }
  for (const agent of Object.keys(REQUESTS)) {
    assert.equal(independentPart(agent).includes("never file contents, never a diff"), false, `${agent}.md carries the return format outside a run`);
    assert.ok(readAgent(agent).includes("never file contents, never a diff"), `${agent}.md lost the short-pointer return of a run`);
  }
});

// The coder's deliverable holds the sections the stage lanes append to, its request scopes a lane to its stage, and the agent reads with the discipline that keeps a lane small.
test("the coder writes the staged handoff sections and reads with discipline", () => {
  const agent = readAgent("coder");
  for (const section of ["## Modified files", "## Done", "## Left", "## How it was tested"]) {
    assert.ok(agent.includes(section), `the coder's run section does not name \`${section}\``);
  }
  assert.ok(agent.includes("## Reading discipline"), "coder.md lost its reading discipline");
  assert.ok(agent.includes("under ~300 lines"), "coder.md lost the whole-file Read threshold");
  assert.ok(agent.includes("When the request names a stage, implement only that stage"), "coder.md does not scope a task to its stage");
  assert.ok(phasePrompts().blocks.coder.includes("STAGE: <stage>"), "the coder block does not name its stage");
});

// The verifier owns the method of proving by execution and the verdicts; its block owns the line that tells a runtime lane apart.
test("the verifier owns the runtime method and the verdict the phases read", () => {
  const agent = readAgent("verifier");
  const phases = readFileSync(PHASES, "utf8");
  assert.ok(agent.includes("## Proving by execution"), "verifier.md does not carry `## Proving by execution`");
  assert.ok(agent.includes("a scenario with no recorded attempt is not `to confirm`"), "the unavailable rule left the verifier");
  for (const phrase of ["## Runtime verdict", "Diff applies plan: yes|no"]) {
    assert.ok(agent.includes(phrase), `the runtime section does not carry \`${phrase}\``);
  }
  assert.ok(phasePrompts().blocks.runtime.includes("Mode: RUNTIME"), "the runtime block lost its `Mode: RUNTIME` line");
  for (const verdict of ["CONFIRMED", "NOT-MET", "SYMPTOM-PERSISTS", "NEEDS-DEVICE", "UNAVAILABLE"]) {
    assert.ok(agent.includes(`\`${verdict}\``), `the runtime section does not name the \`${verdict}\` verdict`);
    assert.ok(phases.includes(`\`${verdict}\``) || phases.includes(`\`VERDICT: ${verdict}`), `the phases do not route the \`${verdict}\` verdict`);
  }
  assert.ok(agent.includes("evidence/automated-verification.md"), "the verifier's run section does not write its evidence file");
  assert.equal(phases.includes("Decide the path by the change:"), false, "the phases still carry the runtime cases");
});

// One coder lane per stage keeps the binding rule of a staged Brief: the verifier runs between stages.
test("the stage lanes keep the verifier between stages", () => {
  const skill = readFileSync(PHASES, "utf8").replace(/\s+/g, " ");
  assert.ok(skill.includes("Phase 4 implements stage by stage with the verifier between stages"), "the skill lost the binding stage rule of a staged Brief");
  assert.ok(skill.includes("then the verifier between stages"), "the one-lane-per-stage text skips the verifier between stages");
  assert.equal(skill.includes("Phase 5 and Phase 6 run once"), false, "the stage lanes still defer every verification to the end");
});

// The agents have a standalone caller too, so the contract must stay safe for a prompt with no Project.
test("each agent states the fallback for a prompt that carries no Project", () => {
  for (const agent of AGENTS) {
    const text = readAgent(agent);
    assert.ok(
      text.includes("pass that path verbatim"),
      `${agent} does not say a bare Repository: path is a valid project value`,
    );
    assert.ok(
      text.includes("With neither, call it without `project`"),
      `${agent} does not say what to pass when the prompt carries neither`,
    );
    assert.ok(
      text.includes("cross-project lessons, not an error"),
      `${agent} does not state the degraded outcome of a project-less recall`,
    );
  }
});
