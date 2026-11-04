import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deliverOf, phasePrompts } from "../test-support/skill-size.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// The agents a run launches: their whole text holds only who they are and how they think; the run contract lives in their blocks.
const INDEPENDENT = ["triager", "explore", "architect", "coder", "qa-guardian", "verifier", "reflector"];
// A `run` subcommand that needs no run, so any caller of the agent may use it.
const STANDALONE_COMMANDS = ["nightqueue run secrets-sweep"];
const PIPELINE_TERMS = [
  "RUN_DIR",
  "state.json",
  "00-brief",
  "00-prompt",
  "nightqueue run",
  "Mode: RUNTIME",
  "01-triage",
  "02-explore",
  "03-plan",
  "04-implementation",
  "05-qa",
  "07-runtime",
  "06-verification",
  "ARTIFACT_PATH",
  "orchestrator",
  "the architect",
  "the coder",
  "the verifier",
  "the triager",
  "qa-guardian",
  "Phase ",
  "run check",
  "## Shell inside",
  "Related jobs",
  "index-save",
  "index_recall",
  "Applicable lessons",
];

// One agent definition with its standalone commands taken out, so only a pipeline use of `nightqueue run` is left to find.
function agentText(agent) {
  const text = readFileSync(join(ROOT, `plugin/agents/${agent}.md`), "utf8");
  return STANDALONE_COMMANDS.reduce((rest, command) => rest.replaceAll(command, ""), text);
}

// A pipeline-independent agent names no phase, artifact, run file, orchestrator, other agent, shell rule or runtime block anywhere; it may name itself.
test("each pipeline-independent agent file names nothing of the pipeline", () => {
  for (const agent of INDEPENDENT) {
    const text = agentText(agent);
    for (const term of PIPELINE_TERMS.filter((name) => name !== agent)) {
      assert.equal(text.includes(term), false, `${agent} names the pipeline: ${term}`);
    }
  }
});

const LOCAL_PATH = /~\/(?!\.claude\/)|\/Users\/|\/home\/|nstest-demo/;

// No agent file names a path of one machine: a home-relative path (the host's own `~/.claude/` aside), a user directory or the old demo checkout.
test("no agent file names a local path", () => {
  const agents = readdirSync(join(ROOT, "plugin/agents")).filter((name) => name.endsWith(".md"));
  assert.ok(agents.length >= INDEPENDENT.length, "no agent files found");
  for (const name of agents) {
    const hits = readFileSync(join(ROOT, "plugin/agents", name), "utf8").split("\n").filter((line) => LOCAL_PATH.test(line));
    assert.deepEqual(hits, [], `${name} names a local path`);
  }
  assert.equal(LOCAL_PATH.test("run it in `~/Dev/nstest-demo`"), true, "the pattern misses a home path");
  assert.equal(LOCAL_PATH.test("secrets live in `~/.claude/`"), false, "the pattern refuses the host's config dir");
});

const EVIDENCE_CAP = "When the request forbids writing or running, the evidence level is capped at 2 and the verdict says so.";

// A request that forbids writing or running (the operator's read-only delegation) caps every independent agent's evidence at 2; the reflector grades no evidence.
test("each pipeline-independent agent caps its evidence at 2 under a request that forbids writing or running", () => {
  for (const agent of INDEPENDENT.filter((name) => name !== "reflector")) {
    const text = readFileSync(join(ROOT, `plugin/agents/${agent}.md`), "utf8");
    const section = text.split("\n## How you operate\n")[1]?.split("\n## ")[0] ?? "";
    assert.ok(section.replace(/\s+/g, " ").includes(EVIDENCE_CAP), `${agent}'s ## How you operate does not cap the evidence at 2`);
  }
});

// The triager frames the raw request itself, its block delivers the Brief and the critique, and no text offers a verdict that waits for an answer.
test("the triager frames the request, its block delivers the Brief and the request critique, and no verdict waits for an answer", () => {
  const agent = readFileSync(join(ROOT, "plugin/agents/triager.md"), "utf8");
  const block = phasePrompts().blocks.triager;
  assert.ok(agent.split("\n").includes("## Framing the request"), "the triager agent has no ## Framing the request section");
  assert.deepEqual(deliverOf(block).headings.slice(0, 3), ["## Brief", "## Request critique", "## Verdict"], "the triager block does not deliver the Brief, the critique and the verdict first");
  assert.ok(block.includes("## Verdict: PROCEED | NO-CHANGE-NEEDED | NOT-REPRODUCIBLE"), "the triager block does not carry the three verdicts");
  for (const word of ["NEEDS-CLARIFICATION", "PROPOSE-ALTERNATIVE"]) {
    assert.equal(agent.includes(word) || block.join("\n").includes(word), false, `the triager still offers ${word}`);
  }
});

// The run contract lives in the blocks of `## Phase prompts`, so no agent keeps a run section.
test("no agent file has an `## Inside a run` section", () => {
  const agents = readdirSync(join(ROOT, "plugin/agents")).filter((name) => name.endsWith(".md"));
  for (const name of agents) {
    assert.equal(readFileSync(join(ROOT, "plugin/agents", name), "utf8").includes("## Inside a run"), false, `${name} still has a run section`);
  }
});

// The run directory, the run state and the artifact path are the block's to name, never an agent's.
test("no agent file names the run directory, the run state or the artifact path", () => {
  const agents = readdirSync(join(ROOT, "plugin/agents")).filter((name) => name.endsWith(".md"));
  for (const name of agents) {
    const text = readFileSync(join(ROOT, "plugin/agents", name), "utf8");
    for (const term of ["RUN_DIR", "state.json", "ARTIFACT_PATH"]) assert.equal(text.includes(term), false, `${name} names ${term}`);
  }
});
