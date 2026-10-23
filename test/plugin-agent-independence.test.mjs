import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROMPTS = join(ROOT, "plugin/skills/resolve/references/prompts");
const DELIVERABLES = join(ROOT, "plugin/skills/resolve/references/deliverables");
// The requests the pipeline renders for each agent whose file holds only who it is and how it thinks.
const REQUESTS = {
  triager: ["triager"],
  explore: ["explore"],
  architect: ["architect"],
  coder: ["coder", "coder-fast", "coder-fix"],
  "qa-guardian": ["qa-lite", "qa-analyst", "qa-prover"],
  verifier: ["verifier", "verifier-fast", "runtime"],
};
const INDEPENDENT = Object.keys(REQUESTS);
const PIPELINE_TERMS = [
  "01-triage",
  "02-explore",
  "03-plan",
  "04-implementation",
  "05-qa",
  "05a-qa-analyst",
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
const DELIVERABLE_PARTIAL = /\{\{>deliverables\/([\w-]+)\}\}/g;

// A pipeline-independent agent names no phase, artifact, orchestrator, other agent, shell rule or runtime block; it may name itself.
test("each pipeline-independent agent file names nothing of the pipeline", () => {
  for (const agent of INDEPENDENT) {
    const text = readFileSync(join(ROOT, `plugin/agents/${agent}.md`), "utf8");
    for (const term of PIPELINE_TERMS.filter((name) => name !== agent)) {
      assert.equal(text.includes(term), false, `${agent} names the pipeline: ${term}`);
    }
  }
});

const EVIDENCE_CAP = "When the request forbids writing or running, the evidence level is capped at 2 and the verdict says so.";

// A request that forbids writing or running (the operator's read-only delegation) caps every independent agent's evidence at 2.
test("each pipeline-independent agent caps its evidence at 2 under a request that forbids writing or running", () => {
  for (const agent of INDEPENDENT) {
    const text = readFileSync(join(ROOT, `plugin/agents/${agent}.md`), "utf8");
    const section = text.split("\n## How you operate\n")[1]?.split("\n## ")[0] ?? "";
    assert.ok(section.replace(/\s+/g, " ").includes(EVIDENCE_CAP), `${agent}'s ## How you operate does not cap the evidence at 2`);
  }
});

// The `## Deliver` block of a request is inline, or comes from every shared deliverable it includes.
function carriesDeliver(request, name) {
  if (request.includes("## Deliver")) return true;
  const shared = [...request.matchAll(DELIVERABLE_PARTIAL)].map((match) => match[1]);
  for (const deliverable of shared) {
    const file = join(DELIVERABLES, `${deliverable}.md`);
    assert.ok(existsSync(file), `the ${name} request includes a deliverable that does not exist: ${deliverable}`);
    assert.ok(readFileSync(file, "utf8").includes("## Deliver"), `the ${deliverable} deliverable carries no ## Deliver`);
  }
  return shared.length > 0;
}

// The triager frames the raw request itself, and its request asks for the Brief, the critique and the alternative verdict.
test("the triager frames the request, and its request delivers the Brief and the request critique", () => {
  const agent = readFileSync(join(ROOT, "plugin/agents/triager.md"), "utf8");
  assert.ok(agent.split("\n").includes("## Framing the request"), "the triager agent has no ## Framing the request section");
  const request = readFileSync(join(PROMPTS, "triager.md"), "utf8");
  for (const part of ["\n## Brief\n", "\n## Request critique\n", "PROPOSE-ALTERNATIVE"]) {
    assert.ok(request.includes(part), `the triager request does not carry ${part.trim()}`);
  }
});

// What the agent must deliver and how it returns lives in the request the pipeline renders.
test("each pipeline-independent agent's request owns the deliverable, the handoff and the shell rule", () => {
  assert.equal(Object.values(REQUESTS).flat().length, 12, "the six agents no longer map to their twelve requests");
  for (const name of Object.values(REQUESTS).flat()) {
    const request = readFileSync(join(PROMPTS, `${name}.md`), "utf8");
    assert.ok(carriesDeliver(request, name), `the ${name} request does not carry ## Deliver`);
    for (const part of ["{{>_handoff}}", "{{>_shell-rule}}"]) {
      assert.ok(request.includes(part), `the ${name} request does not carry ${part}`);
    }
  }
});
