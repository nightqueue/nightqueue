import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RUN_HEADING = "\n## Inside a run\n";
// The agents whose text above `## Inside a run` holds only who they are and how they think.
const INDEPENDENT = ["triager", "explore", "architect", "coder", "qa-guardian", "verifier"];
const RUN_AGENTS = [...INDEPENDENT, "reflector"];
const PIPELINE_TERMS = [
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

// One agent definition split at `## Inside a run`: what holds for any request, then what holds inside a run.
function agentParts(agent) {
  const text = readFileSync(join(ROOT, `plugin/agents/${agent}.md`), "utf8");
  const [independent, ...run] = text.split(RUN_HEADING);
  return { independent, run: run.join(RUN_HEADING) };
}

// Above `## Inside a run` a pipeline-independent agent names no phase, artifact, orchestrator, other agent, shell rule or runtime block; it may name itself.
test("each pipeline-independent agent file names nothing of the pipeline above its run section", () => {
  for (const agent of INDEPENDENT) {
    const text = agentParts(agent).independent;
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

// A request that forbids writing or running (the operator's read-only delegation) caps every independent agent's evidence at 2.
test("each pipeline-independent agent caps its evidence at 2 under a request that forbids writing or running", () => {
  for (const agent of INDEPENDENT) {
    const text = readFileSync(join(ROOT, `plugin/agents/${agent}.md`), "utf8");
    const section = text.split("\n## How you operate\n")[1]?.split("\n## ")[0] ?? "";
    assert.ok(section.replace(/\s+/g, " ").includes(EVIDENCE_CAP), `${agent}'s ## How you operate does not cap the evidence at 2`);
  }
});

// The triager frames the raw request itself, its run section delivers the Brief and the critique, and no text offers a verdict that waits for an answer.
test("the triager frames the request, its run section delivers the Brief and the request critique, and no verdict waits for an answer", () => {
  const { independent, run } = agentParts("triager");
  assert.ok(independent.split("\n").includes("## Framing the request"), "the triager agent has no ## Framing the request section");
  for (const part of ["\n## Brief\n", "\n## Request critique\n", "\n## Verdict: PROCEED | NO-CHANGE-NEEDED | NOT-REPRODUCIBLE\n"]) {
    assert.ok(run.includes(part), `the triager run section does not carry ${part.trim()}`);
  }
  for (const word of ["NEEDS-CLARIFICATION", "PROPOSE-ALTERNATIVE"]) {
    assert.equal(independent.includes(word) || run.includes(word), false, `the triager agent still offers ${word}`);
  }
});

// What an agent delivers inside a run and how it returns is its own, and only a request naming a run reaches that section.
test("each run agent's last section is conditioned on `RUN_DIR:` and carries the deliverable, the return rule and the shell rule", () => {
  for (const agent of RUN_AGENTS) {
    const { run } = agentParts(agent);
    assert.ok(run.trim().startsWith("This section applies only when the request carries a `RUN_DIR:` line"), `${agent}: the run section is not conditioned`);
    for (const part of ["Deliver", "RETURN-HEAD:", "Shell rule: "]) {
      assert.ok(run.includes(part), `${agent}: the run section does not carry ${part}`);
    }
  }
});

// A request of the operator names no run, so an agent it delegates to must hold its whole independent method before the run section.
test("the run section comes last in each run agent's file", () => {
  for (const agent of RUN_AGENTS) {
    const { independent, run } = agentParts(agent);
    assert.ok(independent.length > 0 && run.length > 0, `${agent} has no run section`);
    const headings = run.replace(/^(`{3,})[\s\S]*?^\1$/gm, "").match(/^## .+$/gm) ?? [];
    assert.deepEqual(headings, [], `${agent}: a section follows the run section`);
  }
});
