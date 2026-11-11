import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PHASE_ARTIFACTS } from "../plugin/skills/resolve/pipeline/artifacts.mjs";
import { agentRoles, phaseNamesOf } from "../src/queue/pipeline-package.mjs";
import { defaultAgentModels, pipelineConstants } from "../src/queue/routing.mjs";
import { RUN_OUTCOME_STATUSES } from "../src/queue/run-state.mjs";
import { buildPrompt } from "../src/queue/spawn.mjs";
import { phasePrompts } from "../test-support/skill-size.mjs";

const SKILL_FILE = readFileSync(new URL("../plugin/skills/resolve/SKILL.md", import.meta.url), "utf8");
const PHASES = readFileSync(new URL("../plugin/skills/resolve/references/phases.md", import.meta.url), "utf8");
const SKILL = `${SKILL_FILE}\n${PHASES}`;
const PHASE_8 = readFileSync(new URL("../plugin/skills/resolve/references/phase-8.md", import.meta.url), "utf8");
const PHASE_9 = readFileSync(new URL("../plugin/skills/resolve/references/phase-9.md", import.meta.url), "utf8");
const FLOW = [SKILL, PHASE_8, PHASE_9].join("\n");
const QA_PHASE = readFileSync(new URL("../plugin/skills/resolve/references/qa-phase.md", import.meta.url), "utf8");
const OPERATOR = readFileSync(new URL("../plugin/agents/operator.md", import.meta.url), "utf8");
const CLASSIFY = readFileSync(new URL("../src/queue/classify.mjs", import.meta.url), "utf8");
const TOOLS = readFileSync(new URL("../src/mcp/tools.mjs", import.meta.url), "utf8");
const CLI_RUN = ["cli/run.mjs", "cli/run-publish.mjs", "cli/run-start.mjs", "cli/run-report.mjs", "queue/rounds.mjs"].map((file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")).join("\n");
const REPORT_LAYOUT = readFileSync(new URL("../plugin/skills/resolve/references/report.md", import.meta.url), "utf8");
const QA_AGENT = readFileSync(new URL("../plugin/agents/qa-guardian.md", import.meta.url), "utf8");
const MANIFEST = JSON.parse(readFileSync(new URL("../plugin/skills/resolve/pipeline/manifest.json", import.meta.url), "utf8"));

// The arguments the skill tells the pipeline to send to each run tool, checked against the real schemas.
const RUN_TOOL_ARGS = {
  run_outcome: ["status", "notice", "question", "from_artifact"],
  run_set: ["type", "branch", "worktree"],
};

// The places the skill tells the pipeline to record the outcome: the records of Phase 0 and its two call points.
const OUTCOME_ANCHORS = [
  "7. **Records.**",
  "`run publish` records the delivery itself.",
  "**A run terminated by `NO-CHANGE-NEEDED`.**",
];

// One `## ` section of SKILL.md, from its heading to the next `## ` heading.
function skillSection(title) {
  const start = SKILL_FILE.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `SKILL.md has no \`## ${title}\` section`);
  const end = SKILL_FILE.indexOf("\n## ", start + 1);
  return SKILL_FILE.slice(start, end < 0 ? undefined : end);
}

// The Resume section of SKILL.md.
function resumeSection() {
  return skillSection("Resume");
}

// The Sequence section of SKILL.md.
function sequenceSection() {
  return skillSection("Sequence");
}

// The Routing section of SKILL.md.
function routingSection() {
  return skillSection("Routing");
}

// The target every per-phase placeholder of a plugin text names, in the order the prompts appear.
function contextTargets(text) {
  return [...text.matchAll(/`context_for_(?:phase|agent)` \(target: "([a-z]+)"\)/g)].map((match) => match[1]);
}

// The whole text of one agent definition.
function agentBody(agent) {
  return readFileSync(new URL(`../plugin/agents/${agent}.md`, import.meta.url), "utf8");
}

test("every agent of a run fetches its own context block, with a target the tool accepts", () => {
  const targets = { triager: "triager", explore: "explore", architect: "architect", coder: "coder", verifier: "verifier", "qa-guardian": "qa", reflector: "reflector" };
  for (const [agent, target] of Object.entries(targets)) {
    assert.ok(agentBody(agent).includes(`\`agent: "${target}"\``), `${agent} does not fetch its context with \`${target}\``);
    assert.ok(agentRoles().includes(target), `${agent} names \`${target}\`, which the context block does not accept`);
  }
  for (const text of [SKILL, QA_PHASE]) {
    assert.deepEqual(contextTargets(text), [], "a hand-filled context placeholder survived outside the templates");
    assert.equal(text.includes("[CONTEXT BLOCK]"), false, "a hand-filled context placeholder survived outside the templates");
  }
  assert.equal(SKILL.includes("[Include only if lesson_recall returned something:]"), false, "a lesson_recall placeholder survived");
  assert.equal(SKILL.includes("[Include only if memory_recall returned something:]"), false, "a memory_recall placeholder survived");
});

test("a launch is the LAUNCH fence filled from one step of the skill: the prompt lives in `## Phase prompts` and no tool renders it", () => {
  assert.ok(SKILL_FILE.includes("Its `prompt` is the LAUNCH fence filled from it, fence removed"), "the skill lets the fence reach the prompt, where the hook reads no declaration");
  for (const target of Object.keys(phasePrompts().blocks)) assert.ok(SKILL_FILE.includes(`\n### ${target} · `), `the skill has no step for the \`${target}\` target`);
  for (const text of [SKILL, QA_PHASE]) assert.equal(text.includes("phase_prompt"), false, "a plugin text still calls the removed tool");
  assert.equal(/Also pass `exclude_ids`/.test(SKILL), false, "the agent is still told to rebuild exclude_ids by hand");
  assert.equal(/repeat the call without `exclude_ids`/.test(SKILL), false, "the agent is still told to retry the recall by hand");
  assert.equal(TOOLS.includes('name: "phase_prompt"'), false, "the removed tool is still registered");
});

test("every run executes the one pipeline: the skill names no tier, no raise and no risk classification", () => {
  assert.equal(/[Mm]andatory escalation/.test(SKILL), false, "the mandatory escalation block survived");
  assert.equal(/tier/i.test(SKILL), false, "the skill still names a tier");
  assert.equal(SKILL.includes("Tier raised:"), false, "the skill still prints a tier raise");
  assert.equal(SKILL.includes("run start --tier"), false, "the skill still passes a tier to run start");
  assert.equal(/Classify the risk/.test(SKILL), false, "the risk classification step survived");
  assert.ok(sequenceSection().includes("each stage of the plan in order (none: one stage)"), "the sequence no longer runs every plan as stages");
  assert.equal(/routing/i.test(SKILL.slice(0, SKILL.indexOf("\n---\n"))), false, "the frontmatter description still names a routing step");
});

test("the runtime prompt carries no tier line, and a caller that brings no pull request answer gets no open pull requests block", () => {
  const prompt = buildPrompt({ job: { id: 1, prompt: "p", tier: "simple" } });
  assert.equal(/^Tier:/m.test(prompt), false, prompt);
  assert.ok(!prompt.includes("Open pull requests"), "a caller that brings no pull request answer gets the prompt it has today");
});

test("the agent models live in one module, never copied into the skill", () => {
  assert.equal(SKILL.includes("| Routing | trivial | simple | complex |"), false, "the skill still carries a copy of the routing table");
  assert.equal(SKILL.includes("| Agent | Model |"), false, "the skill carries a copy of the agent model table");
  assert.equal(SKILL.includes("## Appendix A"), false, "the skill still carries the routing rationale");
  assert.ok(SKILL.includes("- (d) the subagent launch, with the `subagent_type` and `model` of its step;"), "the launch no longer takes the model of its step");
  assert.equal(SKILL.includes("**Agent models**"), false, "the skill still restates where the models come from");
  assert.deepEqual(
    [defaultAgentModels().triager, defaultAgentModels().explore, defaultAgentModels().architect, defaultAgentModels().coder, defaultAgentModels().verifier],
    ["sonnet", "haiku", "opus", "opus", "haiku"],
  );
  assert.equal(pipelineConstants().maxFixIterations, 2);
  for (const method of ["automated", "api", "emulator", "browser"]) assert.match(pipelineConstants().qaMethods, new RegExp(`\\b${method}\\b`));
});

test("every run shares the full verifier scope, written in the verifier's block", () => {
  assert.match(phasePrompts().blocks.verifier.join("\n"), /typecheck, lint, build, tests\) \+ the QA's PoCs/);
});

test("the fast tracks are gone: no fast block, no tier scoping note, and the fix loop has a fixed limit", () => {
  assert.equal(/fast track|fast-track|Fast Lite|coder-fast|verifier-fast/i.test(SKILL), false, "a fast track survived in the skill");
  assert.equal(/`routing` row/.test(SKILL), false, "a phase still reads a routing row");
  assert.equal(/Tier scoping/.test(SKILL), false, "a tier scoping note survived");
  assert.ok(routingSection().includes("else coder-fix; after 2: next stage, or `publish --draft`"), "the fix loop no longer states its limit");
});

// A text with its line breaks and indentation folded to single spaces.
function folded(text) {
  return text.replace(/\s+/g, " ");
}

test("SKILL.md reads as a sequence, a routing table and three lines per step, with no Deliver in it or its references", () => {
  for (const title of ["The orchestrator's contract", "Resume", "Sequence", "Routing", "Phase prompts"]) skillSection(title);
  for (const text of [SKILL_FILE, PHASES, QA_PHASE]) {
    assert.equal(text.includes("## Deliver"), false, "a `## Deliver` heading list survived");
    assert.equal(text.includes("~~~"), false, "a `~~~` heading list survived");
  }
  for (const [target, step] of Object.entries(phasePrompts().steps)) {
    assert.deepEqual(step.lines.map((line) => line.split(":")[0]), ["- Receives", "- Wanted", "- Verdict"], `the ${target} step is not three lines`);
  }
});

test("the routing table names every verdict word of the checked phases, the `fix: design` route and the `QA: none` skip", () => {
  const routing = routingSection();
  for (const check of ["01", "05", "06", "07"]) {
    for (const verdict of MANIFEST.phases.find((phase) => phase.check === check).verdicts) assert.ok(routing.includes(verdict), `the routing never names ${verdict} of check ${check}`);
  }
  assert.ok(routing.includes("`fix: design` → architect, else coder-fix"), "the routing no longer sends a design fix to the architect");
  assert.ok(routing.includes("`NEXT:` is the route; the table explains it."), "the table may override `NEXT:`");
  assert.ok(routing.includes("A verification is never relaunched when nothing changed since its PASSED."), "the routing lost the no-relaunch rule");
  assert.ok(sequenceSection().includes("unless `QA: none`"), "the sequence no longer skips the QA of a `QA: none` stage");
});

test("each stage runs coder → verifier → QA, then the whole change is verified before the runtime", () => {
  const sequence = folded(sequenceSection());
  assert.ok(sequence.includes("`coder` → `verifier` → unless `QA: none`: `qa-triage` (`run check 05 --stage triage`)"), "a stage no longer runs coder, verifier, then its QA");
  assert.ok(sequence.includes("`qa-analyst` (`run check 05 --stage analyst`) → `qa-prover` ×N (read `references/qa-phase.md` first) → `run check 05`"), "a full QA lost its provers or its consolidation");
  assert.ok(sequence.indexOf("5. `verifier` on the whole change") > sequence.indexOf("4. each stage"), "the whole-change verification no longer follows the stages");
  assert.ok(sequence.indexOf("6. `runtime`") > sequence.indexOf("5. `verifier`"), "the runtime no longer follows the whole-change verification");
});

test("the architect, the verifier and every report carry the workflow marks the routing reads", () => {
  const { steps, snippets } = phasePrompts();
  assert.ok(steps.architect.Wanted.includes("each `### Stage N` has a line `QA: attack` or `QA: none`"), "the architect is not asked for the QA line of a stage");
  assert.ok(snippets.RETURN.join("\n").includes("a FAILED, NEEDS FIX or NOT-MET states `fix: code` or `fix: design`"), "a negative report is not asked whom it routes to");
  assert.ok(steps.verifier.Wanted.includes("with STAGE, never require QA or PoCs"), "a stage verifier may fail for a QA that has not run");
  assert.ok(steps["coder-fix"].Receives.includes("the last `## Round` NOTE names"), "the fix lane no longer names what it fixes");
  assert.ok(phasePrompts().blocks.coder.includes("STAGE: <stage> — this plan stage only"), "a stage lane is not scoped to its stage");
});

test("a skipped QA is told in the pull request: Phase 8 and the template place the `QA: skipped` line under the QA heading", () => {
  const template = readFileSync(new URL("../plugin/skills/resolve/references/pr-template.md", import.meta.url), "utf8");
  assert.ok(folded(PHASE_8).includes("A QA skip: `QA: skipped — <why>` (from `QA-MODE:` or the Facts' `QA mode:`) right under its section's heading."), "Phase 8 no longer writes the skip line");
  assert.ok(template.includes("A QA skip: one line `QA: skipped — <why>` right under the QA heading."), "the template no longer places the skip line");
});

test("no text of the QA phase reads a mode from the plan or from run check 03", () => {
  for (const text of [SKILL, QA_PHASE]) assert.equal(text.includes("QA: lite|full"), false, "the old check 03 line survived");
  assert.equal(`${SKILL}${QA_PHASE}`.includes("Always-gate class"), false, "the always-gate field still decides something in the QA texts");
  assert.equal(/two or more/.test(QA_PHASE), false, "qa-phase.md still counts 🔴 risks");
  assert.equal(/usage-coverage|pauses/.test(QA_PHASE), false, "qa-phase.md still routes a removed gate or a pause");
});

test("a resumed QA starts from its triage check", () => {
  assert.ok(resumeSection().includes("A QA resumes from `run check 05 --stage triage`."), "the Resume section does not name how a QA resumes");
});

test("the pre-existing-failure rule lives once in the verifier's definition", () => {
  const agents = readdirSync(new URL("../plugin/agents/", import.meta.url)).filter((file) => file.endsWith(".md"));
  const references = readdirSync(new URL("../plugin/skills/resolve/references/", import.meta.url), { recursive: true }).filter((file) => file.endsWith(".md"));
  const read = (base, file) => readFileSync(new URL(`${base}${file}`, import.meta.url), "utf8");
  const marker = "**Pre-existing failures.**";
  assert.equal(read("../plugin/agents/", "verifier.md").split(marker).length - 1, 1, `${marker} is not once in verifier.md`);
  const elsewhere = [SKILL_FILE, ...references.map((file) => read("../plugin/skills/resolve/references/", file)), ...agents.filter((file) => file !== "verifier.md").map((file) => read("../plugin/agents/", file))];
  assert.equal(elsewhere.filter((text) => text.includes(marker)).length, 0, `${marker} has a copy outside verifier.md`);
});

// The text of the Phase 3 section of references/phases.md, on one line.
function phase3Text() {
  return folded(PHASES.slice(PHASES.indexOf("### Phase 3 —"), PHASES.indexOf("### Phase 8 —")));
}

test("Phase 3 pauses once, on a filled question, and its answer runs the check before the coder", () => {
  const phase3 = phase3Text();
  assert.ok(phase3.includes('the one pause: `run_outcome` with `status: "gate"`'), "the gate action no longer pauses");
  assert.ok(phase3.includes("the last entry of `Answers:` in `RUN FACTS` (a job with no run directory yet: the `OPERATOR ANSWER TO THE GATE:` line)"), "the answer paragraph no longer names where the answer arrives");
  assert.equal(phase3.includes("`GATE:"), false, "Phase 3 still routes a gate check 03 no longer prints");
  assert.ok(phase3.includes("Run `run check 03` first, whatever the block says"), "the answer may skip the check, so it never reaches the coder");
  assert.ok(phase3.includes("Any other answer → relaunch the architect once (🔁, `note` = the answer), then `run check 03` again"), "an answer that changes the plan no longer reaches the architect");
  assert.ok(phase3.includes("an interactive run's chat answer counts as `CONFIRM: answered`"), "an interactive answer never prints the answered line, so it would pause forever");
  assert.ok(resumeSection().includes("An answer at the plan pause: `run check 03` first."), "a resumed run skips the Phase 3 answer rule");
  const architect = folded(agentBody("architect"));
  assert.ok(architect.includes("Each row carries ONE status, `covered` or `not-covered`: the one the plan ships."), "the architect prompt lost the single-status rule");
  assert.ok(architect.includes("An either/or decision is taken by you and recorded in `## Decisions taken`, never left in a row's Status or Reason."), "the architect prompt lets an either/or land in a coverage row");
  assert.ok(architect.includes("drops the answered `## Requires user confirmation`; keep that section only for a NEW question."), "an answered relaunch keeps the settled confirmation");
});

test("the only literal pause of the skill is the Phase 3 gate action, and nothing after it pauses or terminates", () => {
  const pauses = SKILL.split("\n").filter((line) => line.includes('status: "gate"'));
  assert.equal(pauses.length, 1, pauses.join("\n"));
  assert.ok(pauses[0].startsWith("- `NEXT: gate <question>` →"), pauses[0]);
  assert.ok(phase3Text().includes(folded(pauses[0])), "the pause left Phase 3");
  const tail = [PHASES.slice(PHASES.indexOf("### Phase 8 —")), QA_PHASE, PHASE_8, PHASE_9.replace(/a\s+terminated run carries `run_terminate`'s `notice` verbatim/, "")].join("\n");
  for (const gone of ["run_terminate", "→ terminate", "never pause twice", "Never pause twice", "same gate code", '"gate"', "ask the user"]) {
    assert.equal(tail.includes(gone), false, `Phases 8-10 or a reference still carry ${gone}`);
  }
  assert.ok(sequenceSection().includes("3. `architect`: the one pause"), "the sequence no longer names the one stop");
  assert.equal(buildPrompt({ job: { prompt: "x" } }).includes("Requires user confirmation"), false, "the runtime prompt still speaks of a stop");
});

test("a fix limit and a re-triage stop deliver a draft pull request, never a cancellation", () => {
  const routing = routingSection();
  assert.ok(routing.includes("| runtime | SYMPTOM-PERSISTS | triager once, then `publish --draft` |"), "a persisting symptom no longer opens a draft");
  assert.ok(routing.includes("| runtime | CONFIRMED, NEEDS-DEVICE, UNAVAILABLE | publish |"), "an unprovable runtime no longer publishes");
  assert.ok(folded(PHASES).includes("`publish [--draft] [remaining=<text>]` → Phase 8, `--draft` as given, each remaining failure on a `Remaining failure:` line"), "the draft action lost its remaining failures");
  assert.ok(folded(PHASE_8).includes("A limit of Phase 6 or 7 adds `--draft`"), "Phase 8 no longer names the draft flag");
  assert.ok(folded(PHASE_8).includes("→ commit it, ⚠️ open item."), "mixed hunks still stop the run");
});

test("a resumed run builds on the kept wip commit, and no plugin text terminates without a commit", () => {
  assert.equal(resumeSection().includes("RESTORED WIP"), false, "the Resume section still reads a RESTORED WIP line nothing prints");
  assert.equal(buildPrompt({ job: { prompt: "x" } }).includes("RESTORED WIP"), false, "the prompt still carries a RESTORED WIP line");
  assert.ok(resumeSection().includes("build on a `wip(<slug>)` commit, the previous attempt's work, never resetting or rewriting it"), "the Resume section no longer tells the run to build on the kept wip commit");
  const pluginDir = new URL("../plugin/", import.meta.url);
  const files = readdirSync(pluginDir, { recursive: true }).map(String).filter((name) => name.endsWith(".md"));
  assert.deepEqual(files.filter((name) => folded(readFileSync(new URL(name, pluginDir), "utf8")).includes("without a commit")), [], "a plugin text still says to terminate without a commit");
});

test("the coder prompts never carry pasted file content, and no fast variant ships", () => {
  for (const text of [SKILL, agentBody("coder")]) {
    assert.equal(text.includes("[CONTENT READ INLINE]"), false, "a coder prompt still pastes file content");
    assert.equal(text.includes("Content of the affected files:"), false, "a coder prompt still pastes file content");
  }
  for (const name of ["coder-fast", "verifier-fast"]) {
    assert.equal(existsSync(new URL(`../plugin/skills/resolve/references/prompts/${name}.md`, import.meta.url)), false, `${name}.md still ships`);
  }
});

// The passage of the skill (or of another plugin text) that starts at an anchor, long enough to carry the whole instruction under it.
function passageAt(anchor, text = SKILL) {
  const start = text.indexOf(anchor);
  assert.ok(start >= 0, `the skill no longer documents the instruction at: ${anchor}`);
  return text.slice(start, start + 900);
}

// The source of one MCP tool, from its name to its handler — the slice that carries its input schema.
function toolSource(name) {
  const start = TOOLS.indexOf(`name: "${name}"`);
  assert.ok(start >= 0, `the runtime no longer registers the tool \`${name}\``);
  const end = TOOLS.indexOf("handler:", start);
  assert.ok(end > start, `the tool \`${name}\` has no handler`);
  return TOOLS.slice(start, end);
}

test("the run is recorded with the run_* tools, under the argument names the handlers accept", () => {
  for (const [tool, args] of Object.entries(RUN_TOOL_ARGS)) {
    assert.ok(SKILL.includes(`\`${tool}\``), `the skill never tells the pipeline to call \`${tool}\``);
    const source = toolSource(tool);
    for (const arg of args) {
      assert.ok(source.includes(`${arg}:`), `the skill sends \`${arg}\` to \`${tool}\`, whose schema has no such argument`);
    }
  }
  assert.ok(phaseNamesOf(null).includes("implementation"), "the resume order lost a canonical phase");
  assert.ok(SKILL.includes("`run check` records each phase and `run publish` the delivery"), "the skill no longer leaves the phase records to the runtime");
});

test("the agent no longer writes state.json, anywhere and by any means", () => {
  assert.equal(SKILL.includes('"outcome": {'), false, "the skill still hand-writes the outcome record");
  assert.equal(SKILL.includes('"phases"'), false, "the skill still hand-writes the phases record");
  assert.equal(SKILL.includes("state.json.tmp"), false, "the skill still documents the atomic write of state.json");
  assert.equal(SKILL.includes("schemaVersion"), false, "the skill still talks about a field only its own writer had to keep");
  assert.equal(SKILL.includes("updatedAt"), false, "the agent is still told to write a timestamp");
  assert.equal(SKILL.includes("<iso>"), false, "a timestamp placeholder survived in the skill");
  assert.ok(SKILL.includes("`<RUN_DIR>/state.json` is the runtime's: never write it."), "the skill no longer forbids writing state.json");
  assert.equal(SKILL.includes("means the runtime is older than this plugin"), false, "the skill still carries the older-runtime fallback of Phase 0");
});

test("every check of the skill is one `nightqueue run check` call the CLI really answers", () => {
  const gate = PHASES.slice(PHASES.indexOf("6. **The check.**"), PHASES.indexOf("7. **Records.**"));
  assert.ok(gate.includes("`nightqueue run check <NN>`"), "the check is no longer a single command");
  assert.match(gate, /never\s+with `ls` or Read/, "the check no longer forbids checking an artifact by hand");
  assert.ok(sequenceSection().includes("After every lane run `nightqueue run check <NN>`"), "the sequence no longer checks every lane");
  for (const phase of ["01", "02", "03", "04", "05", "06", "07"]) assert.ok(PHASE_ARTIFACTS.has(phase), `the CLI does not know \`run check ${phase}\``);
  for (const stage of ["triage", "analyst"]) assert.ok(SKILL_FILE.includes(`run check 05 --stage ${stage}`), `the QA ${stage} check is not a \`run check 05 --stage ${stage}\` call`);
  assert.ok(QA_PHASE.includes("`nightqueue run check 05` merges"), "the QA consolidation is not a `run check 05` call");
  assert.equal(SKILL.includes("run check 00"), false, "the skill still writes the Brief by hand and gates it with `run check 00`");
  assert.ok(PHASE_ARTIFACTS.has("00"), "the CLI dropped `run check 00`, which an older plugin still calls");
  assert.equal(/ls [`<]*ARTIFACT_PATH/.test(SKILL), false, "a gate still checks an artifact with `ls`");
  assert.equal(/git -C <CWD> diff --name-only/.test(SKILL), false, "the agent still derives the file list of Phase 4 itself");
});

test("the QA echo is gone, and the QA lanes still read the plan after their own access map", () => {
  assert.equal(/ECHO per section/.test(SKILL), false, "a QA prompt still asks for the echo of the plan");
  assert.equal(/echo line per section/.test(QA_AGENT), false, "the qa-guardian agent still returns the echo of the plan");
  assert.equal(SKILL.includes("Validation of the QA echo"), false, "the orchestrator still audits an echo nobody returns");
  for (const target of ["qa-lite", "qa-analyst"]) {
    assert.ok(phasePrompts().blocks[target].join("\n").includes("03-plan.md (after step 0 of your Access map)"), `the ${target} lane stopped reading the plan`);
  }
});

test("the outcome record is documented at its three points and the NO-CHANGE-NEEDED report, with the enum the runtime really accepts", () => {
  for (const anchor of [OUTCOME_ANCHORS[0], OUTCOME_ANCHORS[2]]) {
    assert.ok(passageAt(anchor, FLOW).includes("run_outcome"), `${anchor} no longer calls \`run_outcome\``);
  }
  assert.ok(passageAt(OUTCOME_ANCHORS[0]).includes("`run_outcome` at its three points"), "the outcome record no longer names its three points");
  assert.ok(passageAt(OUTCOME_ANCHORS[0]).includes("the Phase 3 pause;"), "the records no longer send the pause to Phase 3");
  assert.ok(passageAt(OUTCOME_ANCHORS[0]).includes('`status: "no_change"`'), "the records no longer name the no_change status");
  assert.ok(passageAt(OUTCOME_ANCHORS[0]).includes("Phase 8's delivery, which `run publish`\n     records itself"), "the records no longer leave the delivery to `run publish`");
  assert.ok(PHASE_8.includes(OUTCOME_ANCHORS[1]), "Phase 8 no longer leaves the delivery record to `run publish`");
  assert.equal(PHASE_8.includes("run_outcome"), false, "Phase 8 tells the orchestrator to record the delivery by hand");
  assert.ok(passageAt(OUTCOME_ANCHORS[2], FLOW).includes('`status: "no_change"`'), "a NO-CHANGE-NEEDED run no longer records its conclusion");
  assert.ok(passageAt(OUTCOME_ANCHORS[2], FLOW).includes("does NOT write it (it would reach the origins)"), "the NO-CHANGE-NEEDED notice is no longer told to leave the next-step line to the runtime");
  assert.equal(FLOW.includes("ends with the line `Next step:"), false, "the skill asks the run to write the next-step line, which reaches the origins");

  for (const field of ["state?.outcome", "record.status", "record.prUrl", "record.notice"]) {
    assert.ok(CLASSIFY.includes(field), `the outcome record loses \`${field}\`: \`classify.mjs\` no longer reads it`);
  }
  assert.deepEqual(RUN_OUTCOME_STATUSES, ["done", "gate", "no_change"], "the runtime accepts a status the skill never documents");
  assert.ok(CLASSIFY.includes("RUN_OUTCOME_STATUSES.includes(record.status)"), "classify.mjs no longer reads the shared status enum");
});

test("the facts block the runtime prints carries every field the Resume section reads, and the runtime decides nothing", () => {
  const facts = { runDir: "/runs/demo/demo-slug", branch: "worktree-demo", worktree: "/worktrees/demo", phases: [{ phase: "triage", verdict: "PROCEED", artifact: "01-triage.md", at: "t" }], answers: [], wip: null };
  const prompt = buildPrompt({ job: { id: 1, prompt: "p", slug: "demo-slug" }, facts });

  assert.ok(prompt.includes("RUN FACTS (slug `demo-slug`)"), prompt);
  assert.ok(resumeSection().includes("With `RUN FACTS`, read `references/phases.md` and this section first"), "a resumed run is no longer sent to the Resume section");
  for (const field of ["RUN_DIR:", "Branch:", "Worktree:", "Recorded phases:", "Wip commit:", "Answers:"]) {
    assert.ok(prompt.includes(`\n${field} `) || prompt.includes(`  ${field} `), `the runtime stopped emitting \`${field}\` in the facts block`);
  }
  for (const gone of ["Last completed phase", "Resume from phase", "From stage", "Trust this block"]) assert.equal(prompt.includes(gone), false, gone);
  assert.equal(SKILL.includes("schemaVersion == 1"), false, "the agent still re-validates the state the runtime holds");
  assert.equal(SKILL.includes("Post-merge resume"), false, "the post-merge block survived");
});

test("SKILL.md has the Resume section with its generic marker and resolve's exceptions, within its size, and references/resume.md is gone", () => {
  const section = resumeSection();
  assert.ok(section.includes("<!-- generic: moves to the pipeline template in R6 -->"), "the generic part is no longer marked");
  assert.ok(section.includes("**Resolve's exceptions:**"), "the exceptions are no longer marked");
  assert.ok(Buffer.byteLength(section) <= 1331, `the Resume section is ${Buffer.byteLength(section)} bytes`);
  assert.equal(existsSync(new URL("../plugin/skills/resolve/references/resume.md", import.meta.url)), false, "references/resume.md is back");
  assert.ok(section.includes("Continue after the last recorded phase whose artifact exists"), "the general rule is gone");
  assert.ok(section.includes("a missing artifact → redo that phase"), "the missing artifact rule is gone");
  assert.ok(section.includes("A retried `NOT-REPRODUCIBLE`/`NO-CHANGE-NEEDED` triage → relaunch the triager"), "a retried terminal triage has no rule");
});

test("the telemetry of Phase 9 is one line naming `run report`, and the skill never calls pipeline_log", () => {
  const schema = toolSource("pipeline_log");
  assert.ok(PHASE_9.includes("**Telemetry:** `run report` records the run; a failure is an open item."), "phase-9.md no longer leaves the telemetry to `run report`");
  assert.equal(FLOW.includes("pipeline_log"), false, "the skill still tells the orchestrator to call pipeline_log");
  for (const old of ["phases:", "tier:", "tier_operator:", "tier_raise_reason:"]) assert.ok(schema.includes(old), `the runtime lost \`${old}\` an older plugin still sends`);
  assert.equal(SKILL.includes("operator_tier"), false, "the old column name came back");
});

test("the Notice of Phase 9 carries the six writing rules and claims no refusal it does not make", () => {
  const notice = PHASE_9.slice(PHASE_9.indexOf("The writing rules:"), PHASE_9.indexOf("## Visual identity"));
  for (const rule of ["1. **User language.**", "2. **No placeholder.**", "3. **The cap.**", "4. **\"Still open\" is mandatory", "5. **The header and the label are derived", "6. **A run terminated by `NO-CHANGE-NEEDED`.**"]) {
    assert.ok(notice.includes(rule), `the Notice lost the rule ${rule}`);
  }
  assert.equal(notice.includes("7. **"), false, "the Notice carries more than six writing rules");
  assert.ok(notice.includes("never above 1900"), "the cap is no longer a writing rule");
  assert.ok(notice.includes("The runtime validates a notice recorded through `run_outcome` and says why it refused one; fix and\nemit again."), "the Notice lost the scoped validation sentence");
  for (const claim of ["What the writing checks", "the writing refuses", "notice is REFUSED", "Count the characters", "the runtime refuses the whole notice"]) {
    assert.equal(PHASE_9.includes(claim), false, `phase-9.md still claims a refusal no code makes: ${claim}`);
  }
  assert.ok(PHASE_9.includes("Translate every `## Open items` entry of the report into the Notice's Still open"), "the report's open items no longer reach the Notice");
});

test("the agent measures no time: no clock, no arithmetic, no timestamp", () => {
  assert.equal(/date \+%s/.test(SKILL), false, "the skill still tells the agent to read the clock");
  assert.equal(/compute the\s+duration/.test(SKILL), false, "the agent still computes a duration");
  assert.equal(SKILL.includes("sum of the durations"), false, "the Total is still an arithmetic the agent does");
  assert.ok(FLOW.includes("Never compute a duration and never write a timestamp"), "Phase 9 lost the rule about the times");
});

test("the one table of Phase 9 and its Time column come from the command the CLI really offers", () => {
  const report = passageAt("**Open the report with `nightqueue run report`, pasted verbatim**", PHASE_9);
  assert.ok(/Time column the\s+runtime measured and\s+its `\*\*Total:\*\*`/.test(report), "the Phase 9 table no longer reads the runtime's measurement");
  assert.ok(report.includes("may only turn a `Happy: yes` into not\nhappy — never the reverse"), "the agent may override the fail-safe verdict of the report");
  assert.ok(CLI_RUN.includes("nightqueue run report [--json]"), "the CLI no longer offers the command the skill pastes from");
  assert.ok(CLI_RUN.includes('renderSkillTemplate(skillReferencesDir(), "report"'), "`run report` no longer renders its one layout, references/report.md");
  for (const header of ["| Step | Agent | Result |", "| Step | Agent | Status |"]) {
    assert.equal(CLI_RUN.includes(header), false, "the CLI carries a copy of the table layout of references/report.md");
    assert.equal(SKILL.includes(header), false, "the skill still carries the table model the report prints");
  }
  assert.equal(REPORT_LAYOUT.split("| Step | Agent | Result | Note | Time |").length, 2, "the report layout prints the one table header once");
  assert.ok(REPORT_LAYOUT.includes("{{ROWS}}"), "the report layout no longer takes the rows of the one table");
  assert.ok(REPORT_LAYOUT.indexOf("**Total:** ⏱️") >= 0 && REPORT_LAYOUT.indexOf("**Total:** ⏱️") < REPORT_LAYOUT.indexOf("{{HAPPY_LINE}}"), "the Total no longer precedes the Happy line");
  for (const gone of ["{{^HAPPY}}", "{{/HAPPY}}", "EXECUTION_ROWS", "STEP_ROWS", "Highlight", "Summary"]) {
    assert.equal(REPORT_LAYOUT.includes(gone), false, `the report layout still carries the two-table layout: ${gone}`);
  }
  assert.equal(CLI_RUN.includes("Lessons saved"), false, "the CLI still prints the lesson-capture audit line Phase 10 replaced");
  assert.equal(REPORT_LAYOUT.includes("LESSONS_LINE"), false, "the report layout still carries the lesson-capture audit line");
});

test("the skill describes the one report table, never the execution table it replaced", () => {
  assert.equal(/execution table/i.test(FLOW), false, "the skill still names the execution table `run report` no longer prints");
  assert.ok(PHASE_9.includes("one row per recorded execution"), "Phase 9 no longer says what the rows of the table are");
  assert.ok(PHASE_9.includes("`🔁N`"), "Phase 9 no longer names the re-run rows");
  assert.ok(PHASE_9.includes("Do NOT print the detail sections below"), "the happy path no longer keeps the detail sections out");
  assert.ok(PHASE_8.includes("Do not repeat the report table here"), "an interactive Phase 8 no longer leaves the table to `run report`");
});

// The text of Phase 8: the sequence and the phases send the run to references/phase-8.md, which carries the steps.
function commitPhase() {
  assert.ok(sequenceSection().includes("7. publish: read `references/phase-8.md` now"), "the sequence no longer sends the run to references/phase-8.md");
  assert.ok(PHASES.includes("Read `references/phase-8.md` now"), "the Phase 8 stub no longer sends the run to references/phase-8.md");
  return PHASE_8;
}

test("Phase 8 is the one `nightqueue run publish` call the CLI really offers, and no git or gh is run by hand", () => {
  const phase = commitPhase();
  assert.ok(
    phase.includes("`nightqueue run publish --message-file <RUN_DIR>/commit-message.txt --body-file <RUN_DIR>/pr-body.md`"),
    "the commit and the pull request are no longer the command's",
  );
  assert.ok(CLI_RUN.includes("nightqueue run publish --message-file <path> --body-file <path>"), "the CLI no longer offers the command Phase 7 calls");
  for (const flag of ["--extra <pathspec>", "--message-file", "--body-file", "--files-from"]) {
    assert.ok(CLI_RUN.includes(flag), `Phase 7 passes \`${flag}\`, which the CLI does not accept`);
  }
  assert.ok(phase.includes("the `prTemplate` `run start` answered"), "Phase 7 no longer reads the template the runtime found");
  assert.ok(phase.includes("never Read the repository's template file"), "Phase 7 may read the repository's template by hand");
  assert.ok(CLI_RUN.includes("prTemplate"), "`run start` no longer answers the template Phase 7 reads");
  assert.ok(phase.includes("Follow the `commitTemplate` `run start` answered"), "Phase 7 no longer follows the commit template the runtime found");
  assert.ok(phase.includes("read `references/commit-template.md`"), "Phase 7 no longer reaches the fallback commit template");
  assert.ok(CLI_RUN.includes("commitTemplate"), "`run start` no longer answers the commit template Phase 7 follows");
  assert.ok(SKILL.includes("- (b) `references/**` of this skill, each read when the sequence says so;"), "channel (b) does not cover the references the orchestrator reads");
  assert.ok(phase.includes("`MISSING: evidence for QA section <method>`"), "Phase 7 no longer reads the evidence refusal");
  assert.ok(phase.includes("`COMMITTED: <sha> (already committed)`"), "Phase 7 no longer reads the retry answer of the publication");
  for (const answer of ["CONVENTION:", "COMMITTED:", "REFUSED:", "REJECTED:", "MISSING:", "BRANCH:", "WORKTREE:"]) {
    assert.ok(phase.includes(answer), `Phase 7 never reads the \`${answer}\` line the command prints`);
    assert.ok(CLI_RUN.includes(answer), `Phase 7 reads \`${answer}\`, which the CLI never prints`);
  }
  for (const dead of [/git branch -m <current-name>/, /git push -u origin/, /Only after the user confirms/, /If Phase 0 did not create a worktree/]) {
    assert.equal(dead.test(FLOW), false, `Phase 7 still runs by hand what the runtime owns: ${dead}`);
  }
  assert.ok(SKILL.includes("inside a job, never ask before pushing"), "the push confirmation is asked for in an unattended run again");
  const outside = phase.replace(/\s+/g, " ");
  assert.ok(outside.includes("With no `NIGHTQUEUE_JOB_ID`, before step 2 show the user the branch, the commit message, `git diff --stat` and a status line"), "an interactive run no longer confirms before pushing");
  assert.ok(outside.includes("wait for the go; then add `--remove-worktree` to `run publish`"), "an interactive run no longer has the runtime close its worktree");
  assert.equal(phase.split("--remove-worktree").length, 2, "`--remove-worktree` is named outside the no-`NIGHTQUEUE_JOB_ID` sentence");
  assert.ok(CLI_RUN.includes("WORKTREE REMOVED:") && CLI_RUN.includes("WORKTREE KEPT:"), "Phase 8 reads a worktree close line the CLI never prints");
  assert.equal(phase.includes("ExitWorktree"), false, "Phase 8 still names the host worktree tool");
});

test("the start is one worktree rule: the one `run start` answered, placed by the runtime inside a job or not", () => {
  const start = folded(sequenceSection());
  assert.ok(start.includes("Work only in its `worktree`, never recording `branch`/`worktree`"), "a run may create a second worktree or overwrite the recorded one");
  assert.equal(start.includes("interactive-worktree"), false, "the start still sends a run to the removed recipe");
  assert.equal(/EnterWorktree|ExitWorktree/.test(SKILL_FILE), false, "SKILL.md still names the host worktree tool");
});

test("the run comes named in the prompt, and the start writes no Brief, no critique and no rename line", () => {
  const start = sequenceSection();
  assert.ok(start.includes("`runDir` is `RUN_DIR`"), "the start derives the run directory by hand again");
  assert.equal(SKILL.includes("Right after the `mkdir -p`"), false, "the skill still prints the older slug protocol as the rule");
  assert.ok(start.includes("then the answered `slug`"), "an interactive run may keep the slug it asked for after `run start` moved it");
  for (const template of ["## Brief", "## Request critique"]) {
    assert.equal(start.includes(template), false, `the start still carries \`${template}\`, which the triager owns`);
  }
  assert.equal(start.includes("SLUG:"), false, "the start still renames the run, which `run check 01` owns");
});

test("the run follows the rename and no retired verdict is routed", () => {
  for (const retired of ["PROPOSE-ALTERNATIVE", "NEEDS-CLARIFICATION"]) assert.equal(SKILL.includes(retired), false, `the skill still routes ${retired}`);
  assert.ok(PHASES.includes("`recorded: slug … (renamed …; run dir <path>)` → that path is `RUN_DIR` from here on"), "the run no longer follows the run dir the check renamed");
  assert.equal(SKILL.includes("raw_evidence"), false, "the skill still passes the raw evidence the triager no longer receives");
});

test("the QA provers live in references/qa-phase.md, the method in the qa-guardian and the modes in the qa steps, and the sequence points there", () => {
  assert.ok(sequenceSection().includes("`qa-prover` ×N (read `references/qa-phase.md` first)"), "the sequence no longer points to the QA reference");
  assert.equal(SKILL.includes("_qa-attack-brief.md"), false, "the skill still reads the attack brief the QA lanes already carry");
  assert.ok(agentBody("qa-guardian").includes("**QA attack brief.**"), "the qa-guardian no longer carries the attack brief");
  assert.equal(/deliverables\/|prompts\//.test(`${SKILL}${QA_PHASE}`), false, "the skill names a removed template directory");
  assert.equal(QA_PHASE.includes("operator hunt"), false, "references/qa-phase.md still describes the operator hunt the operator guard removed");
  for (const anchor of ["**Stage B — Provers:**", "**Consolidation — by the runtime:**"]) {
    const count = [SKILL, QA_PHASE, OPERATOR].reduce((sum, text) => sum + text.split(anchor).length - 1, 0);
    assert.equal(count, 1, `\`${anchor}\` is not written exactly once across the skill, the reference and the operator`);
    assert.ok(QA_PHASE.includes(anchor), `\`${anchor}\` left references/qa-phase.md`);
  }
  assert.ok(QA_PHASE.includes("MUST start with `H<N> (group: <group>): `"), "the prover launches lost the description prefix the cockpit reads");
  const { blocks } = phasePrompts();
  const modes = { "qa-triage": "Mode: TRIAGE", "qa-lite": "Mode: LITE", "qa-analyst": "Mode: ANALYST", "qa-prover": "Mode: PROVER" };
  for (const [target, anchor] of Object.entries(modes)) {
    assert.equal([QA_PHASE, OPERATOR].some((text) => text.includes(anchor)), false, `\`${anchor}\` is still written outside the qa steps`);
    assert.equal(SKILL.split(` · ${anchor}`).length - 1, 1, `\`${anchor}\` is not written once in the skill`);
    assert.ok(blocks[target].includes(anchor), `\`${anchor}\` left the ${target} launch`);
  }
  for (const [, skill = "resolve", name] of SKILL.matchAll(/(?:skills\/([a-z-]+)\/)?references\/([a-z0-9-]+\.md)/g)) {
    assert.ok(existsSync(new URL(`../plugin/skills/${skill}/references/${name}`, import.meta.url)), `the skill names ${skill}/references/${name}, which is not on disk`);
  }
});

test("the resolve skill directory holds only SKILL.md, references/ and its pipeline package", () => {
  const entries = readdirSync(new URL("../plugin/skills/resolve", import.meta.url)).sort();
  assert.deepEqual(entries, ["SKILL.md", "pipeline", "references"], "a new top-level entry appeared under plugin/skills/resolve/");
});

test("no plugin text names a block or a line the runtime no longer prints", () => {
  const pluginDir = new URL("../plugin/", import.meta.url);
  const files = readdirSync(pluginDir, { recursive: true }).map(String).filter((name) => name.endsWith(".md"));
  for (const gone of ["RESUME CANDIDATE", "From stage", "Re-run:", "resume.md", "## PRIOR RUN (operator)", "qa_stage_a"]) {
    assert.deepEqual(files.filter((name) => readFileSync(new URL(name, pluginDir), "utf8").includes(gone)), [], gone);
  }
});

test("the round artifacts are append-only and read by their last round, and no template or agent still says `iteration N`", () => {
  assert.equal(SKILL.includes("**Round artifacts**"), false, "the skill still restates the round rule `_round.md` carries");
  assert.ok(QA_PHASE.includes("writes `## Round <n+1>` marked\n`source: runtime consolidation`"));
  const { blocks } = phasePrompts();
  assert.ok(blocks["coder-fix"].join("\n").includes("append a `### Fix loop N` block"), "the fix lane no longer appends its fix loop");
  for (const target of ["verifier", "runtime", "qa-triage", "qa-lite", "qa-analyst"]) {
    assert.ok(blocks[target].join("\n").includes("Never edit an earlier round"), `the ${target} launch misses the round rule`);
  }
  for (const target of ["triager", "explore", "architect", "coder", "coder-fix", "qa-prover", "reflector"]) {
    assert.equal(blocks[target].join("\n").includes("Never edit an earlier round"), false, `the ${target} launch carries the round rule of a round artifact`);
  }
  const agents = ["verifier", "qa-guardian", "coder"].map((name) => readFileSync(new URL(`../plugin/agents/${name}.md`, import.meta.url), "utf8"));
  for (const text of [...agents, SKILL, QA_PHASE]) {
    assert.equal(/iteration N\b|Verification — iteration|append per iteration/.test(text), false);
  }
});

test("the orchestrator never saves a lesson: no capture rule is left, and Phase 10's reflector is the run's only writer", () => {
  for (const gone of ["Lesson payload", "Lesson-capture", "lesson-capture", "Lessons saved"]) {
    assert.equal(SKILL.includes(gone), false, `the skill still carries ${gone}`);
  }
  const saves = SKILL.split("\n").filter((line) => line.includes("lesson_save"));
  assert.deepEqual(saves, ["The orchestrator never calls `lesson_save`/`memory_save`; the reflector is the run's only writer."]);
  assert.ok(FLOW.includes("| 🪞 | **Reflector** | Memory |"), "the visual identity misses the reflector");
});

test("Phase 10 launches the reflector once at the end of every run and lists its refs above `## Notice`", () => {
  assert.ok(sequenceSection().includes("9. `reflector` once, also after a termination; never at the pause"), "the sequence no longer ends with the reflector");
  const start = PHASES.indexOf("### Phase 10 — Reflect");
  assert.ok(start > PHASES.indexOf("### Phase 9 — Report"), "Phase 10 is missing or sits before Phase 9");
  const phase = folded(PHASES.slice(start));
  assert.ok(phase.includes("after `run report` and BEFORE the final text, also on a terminated run"));
  assert.ok(phase.includes("never at the Phase 3 pause"));
  assert.ok(phase.includes("No artifact and no `run check`"));
  assert.ok(phase.includes("`🪞 Reflection: not run — <reason>`"));
  assert.ok(phase.includes("The line sits above `## Notice`, which stays the LAST section of the final text"));
  assert.equal(SKILL.includes("gets its `reason` from the check itself"), false, "the skill still restates the relaunch reason `run check` records");
});

test("the run follows the `NEXT:` of `run check`, and never re-reads an artifact nor records a phase by hand", () => {
  for (const table of SKILL.matchAll(/\| `run check \d\d[^|]*` answers \|/g)) assert.fail(`the skill still maps a check's answers by hand: ${table[0]}`);
  assert.ok(SKILL_FILE.includes("do what its last line says: `NEXT: <action>`"), "SKILL.md no longer tells the orchestrator to follow `NEXT:`");
  for (const action of ["`launch <target> [stage=<n>] [note=<text>]`", "`gate <question>`", "`terminate <reason>`", "`publish [--draft] [remaining=<text>]`", "`report`", "`check <NN>`"]) {
    assert.ok(PHASES.includes(action), `the phases do not say what ${action} asks`);
  }
  assert.equal(SKILL.includes("run_phase_done"), false, "a phase still records itself by hand");
  const orchestration = `${SKILL_FILE.slice(0, SKILL_FILE.indexOf("## Phase prompts"))}${PHASES}`;
  assert.equal(orchestration.includes("run index-save"), false, "the orchestrator saves the index by hand");
  assert.ok(SKILL.includes('`from_artifact: { file: "03-plan.md", section: "## Requires user confirmation" }`'), "the pause no longer composes its notice from the plan");
  assert.equal(SKILL.split("from_artifact").length, 2, "a step other than the Phase 3 pause still composes a gate notice");
  for (const gone of ["How to fill in `Type:`", "**Coverage gate (bug):**", "**Usage coverage gate (mechanical", "Read the `Diff applies plan:` line"]) {
    assert.equal(SKILL.includes(gone), false, `a gate the check evaluates is still written by hand: ${gone}`);
  }
});

test("the phases document the first and last lines of `run check`, and no text routes a format gate", () => {
  const check = folded(PHASES.slice(PHASES.indexOf("6. **The check.**"), PHASES.indexOf("7. **Records.**")));
  assert.ok(check.includes("Its first line is `OK`, `MISSING: <what>` or `GENERATED`"), "the check no longer documents its first line");
  assert.ok(check.includes("Its last line is `NEXT: <action>`. Do what it says, whatever the other lines seem to ask"), "the check no longer puts `NEXT:` above the other lines");
  for (const gone of ["`GATE:", "`TYPE-MISMATCH:", "`INVALIDATED:", "`DIFF-APPLIES:", "pre-existing-failure", "coverage-vector", "assumption-without-evidence", "stages-unjustified"]) {
    for (const [name, text] of [["SKILL.md", SKILL_FILE], ["phases.md", PHASES], ["qa-phase.md", QA_PHASE]]) {
      assert.equal(text.includes(gone), false, `${name} still routes the format gate ${gone}`);
    }
  }
});

// The body of one `### Phase <n>` section of SKILL.md, without its heading and its blank lines.
function phaseBody(number) {
  const lines = SKILL.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`### Phase ${number} `));
  assert.ok(start >= 0, `SKILL.md has no Phase ${number} section`);
  const end = lines.findIndex((line, i) => i > start && /^#{2,3} /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim() !== "");
}

test("the Phase 8 and Phase 9 sections of SKILL.md are stubs that send the orchestrator to their reference", () => {
  for (const [number, reference] of [[8, "`references/phase-8.md`"], [9, "`references/phase-9.md`"]]) {
    const body = phaseBody(number);
    assert.ok(body.length <= 5, `Phase ${number} is ${body.length} lines, not a stub`);
    assert.ok(body.join(" ").includes(`${reference} now`), `Phase ${number} does not send the orchestrator to ${reference}`);
  }
});

test("the skill carries no phase header rule and SKILL.md prints no agent header line", () => {
  assert.equal(FLOW.includes("Phase header"), false, "a phase header rule is still in the skill");
  assert.equal(FLOW.includes("Print the header"), false, "a phase still prints a header");
  const headerLines = SKILL.split("\n").filter((line) => /^\S+ [A-Z][A-Z-]+ · /.test(line.replace(/^[`\s>-]+/, "")));
  assert.deepEqual(headerLines, [], "SKILL.md still prints an agent header line");
});

test("the orchestrator reads no run artifact: Phases 8 and 9 and the pull request draw on the Facts, and the contract rules `<RUN_DIR>` out", () => {
  const template = readFileSync(new URL("../plugin/skills/resolve/references/pr-template.md", import.meta.url), "utf8");
  const artifacts = /`?(?:<RUN_DIR>\/)?0[0-7]-[a-z-]+\.md`?/;
  for (const [name, text] of [["phase-8.md", PHASE_8], ["phase-9.md", PHASE_9], ["pr-template.md", template]]) {
    assert.equal(artifacts.test(text), false, `${name} still names a run artifact: ${artifacts.exec(text)?.[0]}`);
  }
  assert.equal(/Re-read|re-read/.test(PHASE_9), false, "phase-9.md still re-reads something");
  assert.ok(PHASE_8.includes("`nightqueue run report --facts`"), "Phase 8 no longer takes its material from the Facts");
  assert.ok(folded(PHASE_9).includes("all that sits above its `## Facts for the report`"), "Phase 9 may paste the Facts into the final text");
  assert.ok(SKILL.includes("It works through five channels only; `<RUN_DIR>` files are not one:"), "`<RUN_DIR>` files are a channel again");
  assert.ok(SKILL.includes("(`run check <NN>` tells, never Read/Glob)"), "a resume may test an artifact's existence by reading it");
});

test("the contract lists exactly the five channels (a)-(e), and names the reflector as the run's only writer", () => {
  const start = SKILL.indexOf("## The orchestrator's contract");
  const contract = SKILL.slice(start, SKILL.indexOf("\n## ", start + 1));
  const channels = contract.split("\n").filter((line) => /^- \([a-z]\) /.test(line)).map((line) => line.slice(3, 4));
  assert.deepEqual(channels, ["a", "b", "c", "d", "e"]);
  assert.ok(contract.includes("five channels only"), "the contract does not close the channel list");
  assert.ok(contract.includes("The orchestrator never calls `lesson_save`/`memory_save`; the reflector is the run's only writer."));
});

test("no file of the skill names the host's worktree tool", () => {
  const skillDir = new URL("../plugin/skills/resolve/", import.meta.url);
  const files = readdirSync(skillDir, { recursive: true }).map(String).filter((name) => name.endsWith(".md"));
  assert.ok(files.length >= 8, "the skill files were not found");
  const naming = files.filter((name) => /EnterWorktree|ExitWorktree/.test(readFileSync(new URL(name, skillDir), "utf8")));
  assert.deepEqual(naming, []);
});
