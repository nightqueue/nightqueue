import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AGENTS = ["coder", "qa-guardian", "verifier", "triager", "explore", "architect"];
const SKILL = join(ROOT, "plugin/skills/resolve/SKILL.md");
const QA_PHASE = join(ROOT, "plugin/skills/resolve/references/qa-phase.md");
const REPOSITORY_LINE = "Repository: [CWD PATH]";
const PROJECT_LINE = "Project: [PROJECT — the same identifier used in RUN_DIR]";
const RUNTIME_WORK = {
  verifier: "nightshift verify",
  explore: "nightshift libs",
  architect: "nightshift libs",
  "qa-guardian": "nightshift run secrets-sweep",
  triager: "Open pull requests matching this job:",
};

// Lists every file under plugin/ as an absolute path
function pluginFiles() {
  const dir = join(ROOT, "plugin");
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

// Reads one plugin agent file with its line wrapping collapsed
function readAgent(agent) {
  return readFileSync(join(ROOT, `plugin/agents/${agent}.md`), "utf8").replace(/\s+/g, " ");
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
  assert.equal(
    readAgent("explore").includes("nightshift run index-save"),
    true,
    "explore does not say the runtime persists the index from its artifact",
  );
});

// The verifier reads the scale of the diff off the block instead of running its own git commands.
test("the verifier reads the diff-hygiene line instead of running git itself", () => {
  const agent = readAgent("verifier");
  assert.ok(agent.includes("The `diff-hygiene` line of the `nightshift verify` block"), "the verifier lost the diff-hygiene pointer");
  assert.ok(agent.includes("the summary of `git diff --stat`"), "the verifier does not report the scale of the change");
});

// Every orchestrator prompt template that carries the repository path also names the project.
test("each Repository template of the skill carries a Project line", () => {
  const lines = [SKILL, QA_PHASE].flatMap((file) => readFileSync(file, "utf8").split("\n"));
  const projectLines = lines.filter((line) => line.trim() === PROJECT_LINE);
  const repositoryLines = lines.filter((line) => line.trim() === REPOSITORY_LINE);
  assert.ok(repositoryLines.length >= 8, "the skill lost its Repository templates");
  assert.equal(projectLines.length, repositoryLines.length, "the skill does not carry one Project line per Repository template");
  for (const [index, line] of lines.entries()) {
    if (line.trim() !== REPOSITORY_LINE) continue;
    assert.equal(
      lines[index + 1]?.trim(),
      PROJECT_LINE,
      `the Repository template at line ${index + 1} is not followed by its Project line`,
    );
  }
});

// The secret-in-a-log sweep is a runtime command now, and its mandatory readings survive a host where the plugin root does not resolve.
test("the qa-guardian calls the sweep and still resolves its own plugin paths", () => {
  const agent = readAgent("qa-guardian");
  const skill = readFileSync(QA_PHASE, "utf8");
  assert.ok(agent.includes("nightshift run secrets-sweep --files"), "qa-guardian does not call the sweep command");
  assert.equal(agent.includes("grep -niE"), false, "qa-guardian still runs the greps the command replaced");
  assert.ok(
    agent.includes("fall back to `Glob` for `**/skills/qa-guardian/SKILL.md`"),
    "qa-guardian lost the Glob fallback for a prompt that brings no absolute path",
  );
  assert.equal(
    skill.split("\n").filter((line) => line.startsWith("QA_SKILL: ")).length,
    3,
    "the three qa-guardian prompts do not all carry the plugin paths",
  );
  assert.ok(
    skill.replace(/\s+/g, " ").includes("If it does not resolve, omit those three lines entirely"),
    "the skill does not tell the orchestrator to omit the paths it could not resolve",
  );
});

// The orchestrator only coordinates, so every lane returns pointers to its handoff file, never its contents.
test("each agent returns a short pointer, never file contents nor a diff", () => {
  for (const agent of AGENTS) {
    assert.ok(readAgent(agent).includes("never file contents, never a diff"), `${agent} may still return file contents or a diff`);
  }
});

// The coder writes the sections the stage lanes append to, and reads with the discipline that keeps a lane small.
test("the coder writes the staged handoff sections and reads with discipline", () => {
  const agent = readAgent("coder");
  for (const section of ["## Done", "## Left", "## How it was tested", "## Reading discipline (every lane)"]) {
    assert.ok(agent.includes(section), `coder.md does not name \`${section}\``);
  }
  assert.ok(agent.includes("under ~300 lines"), "coder.md lost the whole-file Read threshold");
  assert.ok(agent.includes("when the prompt names `Stage: <n>`"), "coder.md does not scope a lane to its stage");
});

// Phase 6.5 moved into the verifier, so the verifier must write the verdict and the plan line the skill branches on.
test("the verifier owns the runtime lane the skill reads", () => {
  const agent = readAgent("verifier");
  const skill = readFileSync(SKILL, "utf8");
  for (const phrase of ["## Mode: RUNTIME (Phase 6.5 lane)", "## Runtime verdict", "Diff applies plan: yes|no"]) {
    assert.ok(agent.includes(phrase), `verifier.md does not carry \`${phrase}\``);
  }
  for (const verdict of ["CONFIRMED", "NOT-MET", "SYMPTOM-PERSISTS", "NEEDS-DEVICE", "UNAVAILABLE"]) {
    assert.ok(agent.includes(`\`${verdict}\``), `verifier.md does not name the \`${verdict}\` verdict`);
    assert.ok(skill.includes(`\`${verdict}\``), `the skill does not route the \`${verdict}\` verdict`);
  }
  assert.ok(agent.includes("the one who must try is this step 6.5, not the coder."), "the unavailable rule did not move");
  assert.ok(agent.includes("evidence/automated-verification.md"), "the verifier does not write its evidence file");
  assert.equal(skill.includes("Decide the path by the change:"), false, "the skill still carries the runtime cases");
});

// One coder lane per stage keeps the binding rule of Phase 0: the verifier runs between stages.
test("the stage lanes keep the verifier between stages", () => {
  const skill = readFileSync(SKILL, "utf8").replace(/\s+/g, " ");
  assert.ok(skill.includes("Phase 4 implements stage by stage with the verifier between stages"), "Phase 0 lost the binding stage rule");
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
