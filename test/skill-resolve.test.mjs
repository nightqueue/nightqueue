import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PHASE_TARGETS } from "../src/mcp/phase-context.mjs";
import { LESSON_TARGET_OF, PROMPT_TARGETS } from "../src/mcp/phase-prompt.mjs";
import { evaluateCheck } from "../src/queue/check-contract.mjs";
import { RESUME_PHASE_ORDER } from "../src/queue/resume.mjs";
import { AGENT_MODELS, PIPELINE_CONSTANTS } from "../src/queue/routing.mjs";
import { RUN_OUTCOME_STATUSES } from "../src/queue/run-state.mjs";
import { buildPrompt } from "../src/queue/spawn.mjs";

const SKILL = readFileSync(new URL("../plugin/skills/resolve/SKILL.md", import.meta.url), "utf8");
const RESUME = readFileSync(new URL("../plugin/skills/resolve/references/resume.md", import.meta.url), "utf8");
const INTERACTIVE = readFileSync(new URL("../plugin/skills/resolve/references/interactive-worktree.md", import.meta.url), "utf8");
const PHASE_8 = readFileSync(new URL("../plugin/skills/resolve/references/phase-8.md", import.meta.url), "utf8");
const PHASE_9 = readFileSync(new URL("../plugin/skills/resolve/references/phase-9.md", import.meta.url), "utf8");
const FLOW = [SKILL, PHASE_8, PHASE_9, RESUME, INTERACTIVE].join("\n");
const QA_PHASE = readFileSync(new URL("../plugin/skills/resolve/references/qa-phase.md", import.meta.url), "utf8");
const OPERATOR = readFileSync(new URL("../plugin/agents/operator.md", import.meta.url), "utf8");
const CLASSIFY = readFileSync(new URL("../src/queue/classify.mjs", import.meta.url), "utf8");
const TOOLS = readFileSync(new URL("../src/mcp/tools.mjs", import.meta.url), "utf8");
const CLI_RUN = ["cli/run.mjs", "cli/run-publish.mjs", "cli/run-start.mjs", "cli/run-report.mjs", "queue/phase-artifacts.mjs"].map((file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")).join("\n");
const REPORT_LAYOUT = readFileSync(new URL("../plugin/skills/resolve/references/report.md", import.meta.url), "utf8");
const QA_AGENT = readFileSync(new URL("../plugin/agents/qa-guardian.md", import.meta.url), "utf8");

// The arguments the skill tells the pipeline to send to each run tool, checked against the real schemas.
const RUN_TOOL_ARGS = {
  run_outcome: ["status", "notice", "question", "from_artifact"],
  run_set: ["type", "branch", "worktree", "qa_stage_a"],
};

// The places the skill tells the pipeline to record the outcome: the records of Phase 0 and its two call points.
const OUTCOME_ANCHORS = [
  "7. **Records.**",
  "`run publish` records the delivery itself.",
  "**A run terminated by `NO-CHANGE-NEEDED`.**",
];

// The target every per-phase placeholder of a plugin text names, in the order the prompts appear.
function contextTargets(text) {
  return [...text.matchAll(/`context_for_phase` \(target: "([a-z]+)"\)/g)].map((match) => match[1]);
}

// A prompt template of the resolve skill, as the runtime renders it from.
function promptTemplate(name) {
  return readFileSync(new URL(`../plugin/skills/resolve/references/prompts/${name}.md`, import.meta.url), "utf8");
}

test("every subagent prompt takes its context from one context block, in the old placeholder order", () => {
  const skillOrder = ["triager", "explore", "architect", "coder", "verifier"];
  assert.deepEqual(skillOrder.map((template) => LESSON_TARGET_OF[template]), ["triager", "explore", "architect", "coder", "verifier"]);
  assert.deepEqual(["qa-lite", "qa-analyst"].map((template) => LESSON_TARGET_OF[template]), ["qa", "qa"]);
  for (const target of Object.values(LESSON_TARGET_OF)) {
    assert.ok(PHASE_TARGETS.includes(target), `a prompt names \`${target}\`, which the context block does not accept`);
  }
  for (const text of [SKILL, QA_PHASE]) {
    assert.deepEqual(contextTargets(text), [], "a hand-filled context placeholder survived outside the templates");
    assert.equal(text.includes("[CONTEXT BLOCK]"), false, "a hand-filled context placeholder survived outside the templates");
  }
  assert.equal(SKILL.includes("[Include only if lesson_recall returned something:]"), false, "a lesson_recall placeholder survived");
  assert.equal(SKILL.includes("[Include only if memory_recall returned something:]"), false, "a memory_recall placeholder survived");
});

test("the per-phase section hands the prompt, the context block and the exclusion to the server", () => {
  assert.ok(SKILL.includes("### Context per phase (applies to every phase with a subagent)"), SKILL);
  assert.ok(SKILL.includes("Every subagent prompt comes from ONE `phase_prompt` call (MCP `nightqueue`) with `target` = the"), SKILL);
  for (const target of PROMPT_TARGETS) assert.ok(SKILL.includes(`\`${target}\``), `the skill never names the \`${target}\` prompt`);
  assert.ok(SKILL.includes("the server excludes by itself the lessons already injected in earlier phases of this session"), SKILL);
  for (const heading of ["## Applicable lessons", "## Project memory", "## Structural index", "## Related jobs", "## Job origin"]) {
    assert.ok(SKILL.includes(`\`${heading}\``), `the per-phase section no longer names \`${heading}\` of the context block`);
  }
  assert.ok(SKILL.includes("Pass `prompt` to the launch verbatim with the answered `subagent_type` and `model`"), "the orchestrator may edit the rendered prompt");
  assert.equal(/Also pass `exclude_ids`/.test(SKILL), false, "the agent is still told to rebuild exclude_ids by hand");
  assert.equal(/repeat the call without `exclude_ids`/.test(SKILL), false, "the agent is still told to retry the recall by hand");
  assert.equal(SKILL.includes("answers `unknown` for `phase_prompt`"), false, "the older-runtime fallback of phase_prompt survived");
  assert.ok(TOOLS.includes('name: "phase_prompt"'), "the skill names a tool src/mcp/tools.mjs does not register");
});

test("every run executes the one pipeline: the skill names no tier, no raise and no risk classification", () => {
  assert.equal(/[Mm]andatory escalation/.test(SKILL), false, "the mandatory escalation block survived");
  assert.equal(/tier/i.test(SKILL), false, "the skill still names a tier");
  assert.equal(SKILL.includes("Tier raised:"), false, "the skill still prints a tier raise");
  assert.equal(SKILL.includes("run start --tier"), false, "the skill still passes a tier to run start");
  assert.equal(/Classify the risk/.test(SKILL), false, "the risk classification step survived");
  assert.match(passageAt("3. **One pipeline:**"), /every run executes Phases 1–10; nothing in the request changes the phases/);
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
  assert.ok(SKILL.includes("- (d) the harness's subagent launch, with the `subagent_type` and `model` the runtime answers;"), "the launch no longer takes the model the runtime answers");
  assert.equal(SKILL.includes("**Agent models**"), false, "the skill still restates where the models come from");
  assert.deepEqual(
    [AGENT_MODELS.triager, AGENT_MODELS.explore, AGENT_MODELS.architect, AGENT_MODELS.coder, AGENT_MODELS.verifier],
    ["sonnet", "haiku", "opus", "opus", "haiku"],
  );
  assert.equal(PIPELINE_CONSTANTS.maxFixIterations, 2);
  for (const method of ["automated", "api", "emulator", "browser"]) assert.match(PIPELINE_CONSTANTS.qaMethods, new RegExp(`\\b${method}\\b`));
});

test("every run shares the full verifier scope, and the verifier prompt reads it from the constants", () => {
  assert.match(PIPELINE_CONSTANTS.verifierScope, /typecheck, lint, build, tests\) \+ the QA's PoCs/);
  assert.ok(promptTemplate("verifier").includes("Run: {{VERIFIER_SCOPE}}."), "the verifier prompt no longer reads the scope constant");
});

test("the fast tracks are gone: no fast block, no tier scoping note, and the fix loop has a fixed limit", () => {
  assert.equal(/fast track|fast-track|Fast Lite|coder-fast|verifier-fast/i.test(SKILL), false, "a fast track survived in the skill");
  assert.equal(/`routing` row/.test(SKILL), false, "a phase still reads a routing row");
  assert.equal(/Tier scoping/.test(SKILL), false, "a tier scoping note survived");
  assert.match(passageAt("- **Maximum of iterations**:"), /\*\*max 2 fix iterations\*\*/, "the fix loop no longer states its limit");
  assert.match(passageAt("| `VERDICT: PASSED` |"), /Phase 7 first unless the change is purely static/);
  assert.match(
    passageAt("### Phase 7 —").slice(0, 300).replace(/\n> /g, " "),
    /A purely static change \(typo, config, rename, types, pure logic already covered by a test\) → does not execute: the Phase 6 checks are enough\./,
    "Phase 7 lost its static-change rule",
  );
});

test("Phase 5 takes the QA mode from the `QA: lite|full` line of run check 03, and nothing else", () => {
  const mode = passageAt("**Mode:** read the `QA: lite|full` line of the last `nightqueue run check 03` answer");
  assert.match(mode, /`lite` → one qa-guardian with `qa-lite`/);
  assert.match(mode, /`full` → Stage A analyst then\s+N provers/);
  assert.match(mode, /Nothing else decides the mode\./);
  assert.ok(passageAt("### Phase 5 —").includes("**Mode:**"), "the mode rule is not in Phase 5");
  assert.match(SKILL, /`CONFIRM:`,\s+`QA:`,\s+`QA-STAGE:`,\s+`INVALIDATED:`/, "the check line list does not carry the QA line after CONFIRM");
});

// A text with its line breaks and indentation folded to single spaces.
function folded(text) {
  return text.replace(/\s+/g, " ");
}

test("Phase 5 pauses a usage-coverage-only gate and never terminates it, and its resume answers the gate once", () => {
  const phase5 = folded(SKILL.slice(SKILL.indexOf("### Phase 5 —"), SKILL.indexOf("### Phase 6 —")));
  const usageRow = phase5.slice(phase5.indexOf("| only `GATE: usage-coverage-*`"), phase5.indexOf("| `OPEN: …`"));
  assert.ok(phase5.includes("| only `GATE: usage-coverage-*`, after that relaunch |"), "Phase 5 has no row for a usage-coverage-only gate");
  assert.ok(usageRow.includes('`status: "gate"`') && usageRow.includes('{ file: "05-qa.md", section: "## Validated risks" }'), "the usage-coverage pause no longer composes its notice from 05-qa.md");
  assert.ok(usageRow.includes("never terminate"), "the usage-coverage pause no longer forbids the termination");
  assert.equal(usageRow.includes("→ terminate"), false, "a usage-coverage-only gate still leads to a termination");
  assert.ok(phase5.includes("| `GATE: …` | relaunch the QA once") && phase5.includes("still, with a non-usage GATE → terminate per step 6"), "the non-usage GATE row lost its relaunch-then-terminate path");
  assert.ok(phase5.includes("That pause's answer resumes Phase 5: `run check 05` first, a pure read."), "the resume no longer reads `run check 05` before any relaunch");
  assert.ok(phase5.includes("Approved → the same `usage-coverage-*` `GATE:` lines it prints are answered: act on the `VERDICT:` row"), "an approved resume no longer goes on with the verdict's own row");
  assert.ok(phase5.includes("never a second relaunch, pause or terminate"), "an approved resume may relaunch, pause or terminate again");
  assert.ok(phase5.includes("Adjustments → relaunch the QA once (🔁, `note` = the answer); only there a usage-only gate pauses again."), "the adjustments path no longer relaunches the QA with the answer");
  assert.ok(folded(RESUME).includes("**Exception, an OPERATOR ANSWER resuming at `qa`:** `run check 05` first, whatever `From stage:` says"), "resume.md lost the Phase 5 pause exception to `From stage: qa-stage-b`");
  assert.ok(folded(RESUME).includes("never a second relaunch, pause or terminate"), "resume.md lets an answered usage-coverage gate relaunch, pause or terminate");
  assert.ok(folded(QA_PHASE).includes("a persisting usage-coverage-only GATE pauses (SKILL.md Phase 5), never terminates"), "qa-phase.md no longer says a usage-coverage-only gate pauses");
  assert.ok(passageAt("7. **Records.**").includes("a gate pause of Phase 1, 3, 5 or 7"), "the records no longer list the Phase 5 pause");
  assert.ok(folded(SKILL).includes("the usage-coverage gate of Phase 3 or 5"), "Phase 10 no longer skips the reflection at the Phase 5 pause");
});

test("Phase 3 pauses a persisting coverage gate, never terminates it, and its answer never pauses twice", () => {
  const phase3 = folded(SKILL.slice(SKILL.indexOf("### Phase 3 —"), SKILL.indexOf("### Phase 4 —")));
  const missingRow = phase3.slice(phase3.indexOf("| `MISSING` |"), phase3.indexOf("| `GATE: coverage-*` |"));
  const coverageRow = phase3.slice(phase3.indexOf("| `GATE: coverage-*` |"), phase3.indexOf("| `GATE: usage-coverage-*`"));
  assert.ok(missingRow.includes("→ inform the user and terminate (⚠️ open item)"), "a persisting MISSING no longer terminates");
  assert.equal(missingRow.includes("coverage"), false, "the MISSING row still routes a coverage gate to the termination");
  for (const part of ["ONE `run_outcome` for every line", '`status: "gate"`', '{ file: "03-plan.md", section: "## Requires user confirmation" }', '`"## Symptom coverage"`', '"answer the open decision or say what to adjust"', "never terminate"]) {
    assert.ok(coverageRow.includes(part), `the coverage row lost ${part}`);
  }
  assert.equal(coverageRow.includes("→ terminate"), false, "a persisting coverage gate still leads to a termination");
  assert.ok(phase3.indexOf("| `GATE: coverage-*` |") < phase3.indexOf("| `CONFIRM: requires-user-confirmation`"), "the CONFIRM row matches before the coverage row, so one answer pauses twice");
  assert.ok(phase3.includes("A coverage pause's answer resumes here: `run check 03` first, then relaunch the architect once (🔁, `note` = answer + lines)"), "the coverage pause's answer no longer relaunches the architect with the answer");
  assert.ok(phase3.includes("the same `GATE:` lines → terminate (⚠️ open item), never pause twice on them"), "the coverage pause may pause twice on the same lines");
  assert.ok(phase3.includes("never pause twice on them (same gate code); else → its row, relaunch spent."), "the coverage pause's answer compares the lines by their evidence text, not by gate code");
  assert.ok(folded(SKILL).includes("the coverage gate of Phase 3,"), "Phase 10 no longer skips the reflection at the Phase 3 coverage pause");
  const architect = folded(promptTemplate("architect"));
  assert.ok(architect.includes("Each row carries ONE status, `covered` or `not-covered`: the one the plan ships by default."), "the architect prompt lost the single-status rule");
  assert.ok(architect.includes("An either/or decision goes to `## Requires user confirmation`, never into a row's Status or Reason."), "the architect prompt lets an either/or land in a coverage row");
  assert.ok(architect.includes("drops the answered `## Requires user confirmation`; keep that section only for a NEW question."), "an answered relaunch keeps the settled confirmation");
});

test("the architect prompt's symptom coverage table carries only statuses the check accepts", () => {
  const template = promptTemplate("architect");
  const section = template.slice(template.indexOf("## Symptom coverage"), template.indexOf("Rules: list ALL the paths"));
  const table = section.split("\n").filter((line) => line.startsWith("|")).join("\n");
  const plan = ["## Implementation plan", "- a fix.", "", "## Symptom coverage", '**How I enumerated:** `grep -rn "x" src`', "", table, "", "## Requires user confirmation", "- a trade-off.", "", "## Assumptions", "- [P1] a.", "", "## Pre-mortem", "- [PM1] a.", "", "## Identified risks", "- [R1] a."].join("\n");
  const triage = readFileSync(new URL("fixtures/check/coverage-vector-no-reason/01-triage.md", import.meta.url), "utf8");
  const { lines } = evaluateCheck({ check: "03", texts: { "01-triage.md": triage, "03-plan.md": plan } });
  assert.equal(lines[0], "OK", lines.join("\n"));
  assert.ok(table.includes("| covered |") && table.includes("| not-covered |"), "the template table lost a status example");
  assert.equal(lines.some((line) => line.startsWith("GATE: coverage-vector-no-reason")), false, lines.join("\n"));
});

test("a second INVALIDATED pauses at a gate, its answer has three paths, and no skill text terminates without a commit", () => {
  const phase5 = folded(SKILL.slice(SKILL.indexOf("### Phase 5 —"), SKILL.indexOf("### Phase 6 —")));
  const row = phase5.slice(phase5.indexOf("| `INVALIDATED: …` |"), phase5.indexOf("| `VERDICT: APPROVED` |"));
  assert.ok(row.startsWith("| `INVALIDATED: …` | relaunch the **architect** once"), "Phase 5 lost the one architect relaunch on INVALIDATED");
  for (const part of ["`run_outcome`", '`status: "gate"`', '{ file: "05-qa.md", section: "## Validated risks" }', "(a) one more architect round with your note, (b) ship as is, (c) terminate", "never terminate"]) {
    assert.ok(row.includes(part), `the INVALIDATED row lost ${part}`);
  }
  assert.ok(phase5.includes("never pause twice on the same lines"), "the INVALIDATED pause may pause twice on the same lines");
  const resume = folded(RESUME);
  assert.ok(resume.includes("(a) changes → relaunch the architect once (🔁, `note` = answer + lines), then Phases 4-5, a further `INVALIDATED:` terminating"), "resume.md lost answer (a)");
  assert.ok(resume.includes("(b) ship as is → the `VERDICT:` row, the lines ⚠️ open items"), "resume.md lost answer (b)");
  assert.ok(resume.includes("(c) terminate → `run_terminate` (`qa`, the reason)"), "resume.md lost answer (c)");
  assert.ok(resume.includes("Never pause twice on them."), "resume.md lets the INVALIDATED pause repeat");
  assert.ok(RESUME.includes("`RESTORED WIP:` → the previous attempt's work is back uncommitted: keep it."), "resume.md no longer keeps a restored wip");
  assert.ok(buildPrompt({ job: { prompt: "x" }, restoredWip: { short: "abc1234", subject: "wip(s): terminated at qa — why" } }).includes("RESTORED WIP: "), "the prompt no longer carries the RESTORED WIP line the skill reads");
  const pluginDir = new URL("../plugin/", import.meta.url);
  const files = readdirSync(pluginDir, { recursive: true }).map(String).filter((name) => name.endsWith(".md"));
  assert.deepEqual(files.filter((name) => folded(readFileSync(new URL(name, pluginDir), "utf8")).includes("without a commit")), [], "a plugin text still says to terminate without a commit");
});

test("the coder prompts never carry pasted file content, and no fast variant ships", () => {
  for (const text of [SKILL, promptTemplate("coder"), promptTemplate("coder-fix")]) {
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
  assert.ok(RESUME_PHASE_ORDER.includes("implementation"), "the resume order lost a canonical phase");
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

test("every artifact gate of the skill is one `nightqueue run check` call the CLI really answers", () => {
  const gate = passageAt("6. **Artifact gate.**");
  assert.ok(gate.includes("`nightqueue run check <NN>`"), "the gate is no longer a single command");
  assert.ok(gate.includes("never\n     with `ls` or Read"), "the gate no longer forbids checking an artifact by hand");
  for (const phase of ["01", "02", "03", "04", "05", "06", "07"]) {
    assert.ok(`${SKILL}${QA_PHASE}`.includes(`nightqueue run check ${phase}`), `the gate of phase ${phase} is not a \`run check\` call`);
    assert.ok(CLI_RUN.includes(`["${phase}", {`), `the skill calls \`run check ${phase}\`, a phase the CLI does not know`);
  }
  assert.ok(`${SKILL}${QA_PHASE}`.includes("nightqueue run check 05 --stage analyst"), "the QA stage A gate is not a `run check 05 --stage analyst` call");
  assert.equal(SKILL.includes("run check 00"), false, "the skill still writes the Brief by hand and gates it with `run check 00`");
  assert.ok(CLI_RUN.includes('["00", {'), "the CLI dropped `run check 00`, which an older plugin still calls");
  assert.equal(/existence gate \(step 9\)/.test(SKILL), false, "a phase still applies the gate by hand");
  assert.equal(/ls [`<]*ARTIFACT_PATH/.test(SKILL), false, "a gate still checks an artifact with `ls`");
  assert.equal(/git -C <CWD> diff --name-only/.test(SKILL), false, "the agent still derives the file list of Phase 4 itself");
  assert.ok(SKILL.includes("`MISSING: ## Modified files (no changed files)`"), "Phase 4 no longer reads the empty-worktree answer");
});

test("the QA echo is gone, and the pair that replaces it is really in the flow", () => {
  assert.equal(/ECHO per section/.test(SKILL), false, "a QA prompt still asks for the echo of the plan");
  assert.equal(/echo line per section/.test(QA_AGENT), false, "the qa-guardian agent still returns the echo of the plan");
  assert.equal(SKILL.includes("Validation of the QA echo"), false, "the orchestrator still audits an echo nobody returns");
  for (const template of ["qa-lite", "qa-analyst"]) {
    assert.ok(promptTemplate(template).includes("`{{RUN_DIR}}/03-plan.md` (open it only AFTER step 0"), `the ${template} prompt stopped reading the plan`);
  }
  assert.ok(
    CLI_RUN.includes('sections: ["## Proven breaks", "## Validated risks", "## Invalidated assumptions", "## Generated PoCs", "## Verdict"]'),
    "`run check 05` no longer requires the sections of the QA report's ## Deliver",
  );
});

test("the QA stage A gate reads the marker the check records, before stage B is launched", () => {
  const gate = passageAt("**Stage A gate:**", QA_PHASE);
  assert.ok(gate.includes("`recorded: qa_stage_a <verdict>`"), "the stage A gate no longer reads the marker the check records");
  assert.equal(gate.includes("`run_set` with `qa_stage_a`"), false, "the stage A gate still records the marker by hand");
  assert.ok(gate.includes("`QA-STAGE: provers|skip`"), "the stage A gate no longer reads whether stage B runs");
  assert.ok(gate.includes("BEFORE stage B"), "the marker is no longer recorded before the provers start");
  assert.ok(gate.includes("never by writing a file"), "the stage A gate no longer forbids hand-writing the marker");
});

test("the outcome record is documented at its three points and the NO-CHANGE-NEEDED report, with the enum the runtime really accepts", () => {
  for (const anchor of [OUTCOME_ANCHORS[0], OUTCOME_ANCHORS[2]]) {
    assert.ok(passageAt(anchor, FLOW).includes("run_outcome"), `${anchor} no longer calls \`run_outcome\``);
  }
  assert.ok(passageAt(OUTCOME_ANCHORS[0]).includes("`run_outcome` at its three points"), "the outcome record no longer names its three points");
  for (const status of ['`status: "gate"`', '`status: "no_change"`']) {
    assert.ok(passageAt(OUTCOME_ANCHORS[0]).includes(status), `the records no longer name ${status}`);
  }
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

// The run resume of references/resume.md, once Phase 0 sends a resumed run there.
function resumeStep() {
  assert.ok(SKILL.includes("read\n   `references/resume.md` now and follow it before step 2"), "Phase 0 no longer sends a resumed run to references/resume.md");
  assert.equal(SKILL.includes("Post-merge resume"), false, "the post-merge block survived in Phase 0");
  return RESUME;
}

test("step 2 trusts the resume block the runtime emits and re-validates nothing", () => {
  const handoff = {
    slug: "demo-slug",
    runDir: "/runs/demo/demo-slug",
    branch: "worktree-demo",
    worktree: "/worktrees/demo",
    lastPhase: "plan",
    fromPhase: "code",
    fromStage: "qa-stage-b",
  };
  const prompt = buildPrompt({ job: { id: 1, prompt: "p" }, handoff });
  const step = resumeStep();

  assert.ok(prompt.includes("RESUME CANDIDATE (slug `demo-slug`)"), prompt);
  assert.ok(step.includes("RESUME CANDIDATE (slug `<slug>`)"), "step 2 no longer names the block the runtime emits");
  for (const field of ["RUN_DIR:", "Branch:", "Worktree:", "Last completed phase:", "Resume from phase:", "From stage:"]) {
    assert.ok(prompt.includes(`\n${field} `), `the runtime stopped emitting \`${field}\` in the resume block`);
    assert.ok(step.includes(field), `step 2 no longer reads \`${field}\` from the block`);
  }
  assert.ok(step.includes("From stage: qa-stage-b"), "step 2 lost the QA stage B re-entry");
  assert.equal(SKILL.includes("schemaVersion == 1"), false, "the agent still re-validates the state the runtime already validated");
  assert.equal(SKILL.includes("increment `resumeCount`"), false, "the agent is still told to write `resumeCount`");
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
  assert.ok(SKILL.includes("never time a phase nor keep a table — `run report` derives them"), "step 8 no longer forbids timing a phase");
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
  assert.ok(INTERACTIVE.includes("Do not repeat the report table here"), "an interactive Phase 8 no longer leaves the table to `run report`");
});

// The text of Phase 8: the SKILL.md stub must send the run to references/phase-8.md, which carries the steps.
function commitPhase() {
  const start = SKILL.indexOf("### Phase 8 — Commit and PR");
  const end = SKILL.indexOf("### Phase 9 —", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents Phase 8");
  assert.ok(SKILL.slice(start, end).includes("Read\n`references/phase-8.md` now"), "the Phase 8 stub no longer sends the run to references/phase-8.md");
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
  assert.ok(SKILL.includes("- (b) `references/**` of this skill, each read when its phase says so;"), "channel (b) does not cover the references the orchestrator reads");
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
  assert.ok(phase.includes("An interactive `/resolve` (no `NIGHTQUEUE_JOB_ID`) also follows `references/interactive-worktree.md`"), "Phase 8 no longer sends an interactive run to its confirmation and worktree close");
  assert.ok(INTERACTIVE.includes("**Before any external action, show the user and wait for confirmation:**"), "an interactive run no longer confirms before pushing");
  assert.ok(INTERACTIVE.includes("`ExitWorktree`"), "an interactive run stopped closing the worktree, which only the session can do");
  assert.equal(phase.includes("ExitWorktree"), false, "Phase 8 still names the host worktree tool");
  assert.equal(phase.includes("--remove-worktree"), false, "the command is told to remove the worktree the session is inside");
});

test("step 4 splits the worktree: a queued job runs in the one the runtime created, an interactive /resolve still creates its own", () => {
  const start = SKILL.indexOf("4. **The worktree.**");
  const end = SKILL.indexOf("5. Every prompt carries the shell rule", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents the worktree in step 4");
  const step = SKILL.slice(start, end);
  assert.ok(step.includes("the runtime created it at `$PWD`"), "a queued job is no longer told the runtime placed its worktree");
  assert.ok(step.includes("never create another"), "a queued job may create a second worktree");
  assert.ok(step.includes("never record `branch`/`worktree`"), "a queued job may overwrite the worktree the runtime recorded");
  assert.ok(step.includes("`references/interactive-worktree.md` now"), "an interactive /resolve is no longer sent to its worktree reference");
  assert.equal(/EnterWorktree|ExitWorktree/.test(phaseZero()), false, "Phase 0 still names the host worktree tool");
  assert.ok(INTERACTIVE.includes("then `git worktree add <path> -b worktree-<slug> origin/main`"), "an interactive /resolve no longer creates its worktree with git");
  assert.ok(INTERACTIVE.indexOf("git worktree add") < INTERACTIVE.indexOf("EnterWorktree"), "the host tool is no longer only a shortcut after the git path");
});


// The text of Phase 0, from its heading to the fast tracks block.
function phaseZero() {
  const start = SKILL.indexOf("### Phase 0");
  const end = SKILL.indexOf("### Context per phase", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents Phase 0");
  return SKILL.slice(start, end);
}

test("the run comes named in the prompt, and Phase 0 writes no Brief, no critique and no rename line", () => {
  assert.ok(SKILL.includes("a `RUN_DIR:` line of the prompt is the same"), "Phase 0 derives the run directory by hand again");
  assert.equal(SKILL.includes("Right after the `mkdir -p`"), false, "the skill still prints the older slug protocol as the rule");
  assert.ok(INTERACTIVE.replace(/\s+/g, " ").includes("the `runDir` `run start` answers is the `RUN_DIR`"), "an interactive run lost where it takes its RUN_DIR");
  const phase = phaseZero();
  for (const template of ["## Brief", "## Request critique"]) {
    assert.equal(phase.includes(template), false, `Phase 0 still carries \`${template}\`, which the triager owns`);
  }
  assert.equal(phase.includes("SLUG:"), false, "Phase 0 still renames the run, which `run check 01` owns");
});

test("Phase 1 maps the triager's alternative, the Brief gates and the rename to an action", () => {
  const start = SKILL.indexOf("### Phase 1 — Triage-Gate");
  const end = SKILL.indexOf("### Phase 2 —", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents Phase 1");
  const table = SKILL.slice(start, end);
  assert.ok(table.includes("| `VERDICT: PROPOSE-ALTERNATIVE` |"), "Phase 1 no longer stops on the triager's alternative");
  assert.ok(table.includes("`GATE: brief-*`"), "Phase 1 no longer relaunches the triager on a Brief gate");
  assert.ok(table.includes("`recorded: slug … (renamed …; run dir <path>)`"), "Phase 1 no longer follows the run dir the check renamed");
  assert.equal(table.includes("raw_evidence"), false, "Phase 1 still passes the raw evidence the triager no longer receives");
});

test("the QA methodology lives in references/qa-phase.md and its prompts in references/prompts/, and both readers point there", () => {
  const phase5 = SKILL.slice(SKILL.indexOf("### Phase 5 —"), SKILL.indexOf("### Phase 6 —"));
  assert.match(phase5, /Read `references\/qa-phase\.md`/, "Phase 5 no longer points to the QA reference");
  assert.equal(phase5.includes("_qa-attack-brief.md"), false, "Phase 5 still reads the attack brief the QA prompts already render");
  assert.ok(promptTemplate("qa-lite").includes("{{>_qa-attack-brief}}"), "the LITE prompt no longer renders the attack brief");
  assert.ok(promptTemplate("qa-analyst").includes("{{>_qa-attack-brief}}"), "the ANALYST prompt no longer renders the attack brief");
  assert.ok(phase5.includes("| `run check 05` answers | Action |"), "Phase 5 no longer maps the answer of `run check 05`");
  assert.equal(phase5.includes("**Validation of the"), false, "Phase 5 still audits the QA coverage by hand");
  for (const [, name] of `${SKILL}${QA_PHASE}`.matchAll(/deliverables\/([a-z0-9-]+\.md)/g)) {
    assert.ok(existsSync(new URL(`../plugin/skills/resolve/references/deliverables/${name}`, import.meta.url)), `the skill names deliverables/${name}, which is not on disk`);
  }
  assert.equal(QA_PHASE.includes("operator hunt"), false, "references/qa-phase.md still describes the operator hunt the operator guard removed");
  for (const anchor of ["**Stage A gate:**", "**Consolidation — by the runtime:**"]) {
    const count = [SKILL, QA_PHASE, OPERATOR].reduce((sum, text) => sum + text.split(anchor).length - 1, 0);
    assert.equal(count, 1, `\`${anchor}\` is not written exactly once across the skill, the reference and the operator`);
    assert.ok(QA_PHASE.includes(anchor), `\`${anchor}\` left references/qa-phase.md`);
  }
  for (const [anchor, template] of [["Mode: LITE", "qa-lite"], ["Mode: ANALYST", "qa-analyst"], ["Mode: PROVER", "qa-prover"]]) {
    assert.equal([SKILL, QA_PHASE, OPERATOR].some((text) => text.includes(anchor)), false, `\`${anchor}\` is still written by hand outside its template`);
    assert.ok(promptTemplate(template).includes(anchor), `\`${anchor}\` left prompts/${template}.md`);
  }
  assert.equal(QA_PHASE.includes("#### QA attack brief"), false, "the QA attack brief is still copied in the reference");
  for (const [, name] of SKILL.matchAll(/references\/([a-z0-9-]+\.md)/g)) {
    assert.ok(existsSync(new URL(`../plugin/skills/resolve/references/${name}`, import.meta.url)), `the skill names references/${name}, which is not on disk`);
  }
  for (const [, name] of `${SKILL}${QA_PHASE}`.matchAll(/prompts\/([a-z0-9_-]+\.md)/g)) {
    assert.ok(existsSync(new URL(`../plugin/skills/resolve/references/prompts/${name}`, import.meta.url)), `the skill names prompts/${name}, which is not on disk`);
  }
});

test("the resolve skill directory holds only SKILL.md and references/", () => {
  const entries = readdirSync(new URL("../plugin/skills/resolve", import.meta.url)).sort();
  assert.deepEqual(entries, ["SKILL.md", "references"], "a new top-level entry appeared under plugin/skills/resolve/");
});

test("step 2 reads the re-run lines of a legacy job queued from an operator run, and no longer names the prior-run block", () => {
  const step = resumeStep();
  assert.ok(step.includes("Re-run:"), "step 2 no longer reads the phases the runtime refused to skip");
  assert.equal(step.includes("## PRIOR RUN (operator)"), false, "step 2 still names the prior-run block the operator guard removed");
  const prompt = buildPrompt({
    job: { id: 1, prompt: "p" },
    handoff: { slug: "demo-slug", runDir: "/runs/demo/demo-slug", lastPhase: null, fromPhase: "triage", reruns: [{ phase: "triage", reason: "evidence level 2 is below 3 on a bug (operator run)" }] },
  });
  assert.ok(prompt.includes("\nRe-run: triage — evidence level 2 is below 3 on a bug (operator run)\n"), prompt);
});

test("the round artifacts are append-only and read by their last round, and no template or agent still says `iteration N`", () => {
  assert.equal(SKILL.includes("**Round artifacts**"), false, "the skill still restates the round rule `_round.md` carries");
  assert.ok(QA_PHASE.includes("writes `## Round <n+1>` marked\n`source: runtime consolidation`"));
  assert.ok(promptTemplate("coder-fix").includes("{{>deliverables/implementation}}"));
  assert.ok(promptTemplate("../deliverables/implementation").includes("### Fix loop {{FIX_LOOP}} — what was wrong / what changed"));
  assert.ok(promptTemplate("_round").includes("Never edit an earlier round"));
  for (const name of ["verifier", "runtime", "qa-lite", "qa-analyst"]) {
    assert.ok(promptTemplate(name).includes("{{>_round}}"), `${name} misses the round rule`);
  }
  const prompts = readdirSync(new URL("../plugin/skills/resolve/references/prompts/", import.meta.url)).map((file) => promptTemplate(file.replace(/\.md$/, "")));
  const agents = ["verifier", "qa-guardian", "coder"].map((name) => readFileSync(new URL(`../plugin/agents/${name}.md`, import.meta.url), "utf8"));
  for (const text of [...prompts, ...agents, SKILL, QA_PHASE]) {
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
  const start = SKILL.indexOf("### Phase 10 — Reflect");
  assert.ok(start > SKILL.indexOf("### Phase 9 — Report"), "Phase 10 is missing or sits before Phase 9");
  const phase = SKILL.slice(start);
  assert.ok(phase.includes('`phase_prompt` with `target: "reflector"`'));
  assert.ok(phase.includes("BEFORE the final text"));
  assert.ok(phase.includes("a terminated run"));
  assert.ok(phase.includes("It does NOT run at a gate pause"));
  assert.ok(phase.includes("There is no artifact, no `nightqueue run check` and no `run_phase_done`"));
  assert.ok(phase.includes("`🪞 Reflection: not run — <reason>`"));
  assert.ok(phase.includes("ABOVE `## Notice`: `## Notice` stays\nthe LAST section of the final text"));
  assert.equal(SKILL.includes("gets its `reason` from the check itself"), false, "the skill still restates the relaunch reason `run check` records");
});

// The text of Phases 1 to 7, from the Phase 1 heading to the Phase 8 heading.
function gatedPhases() {
  const start = SKILL.indexOf("### Phase 1 —");
  const end = SKILL.indexOf("### Phase 8 —", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents Phases 1 to 7");
  return SKILL.slice(start, end);
}

test("Phases 1 to 7 act on the lines `run check` answers, and never re-read an artifact nor record a phase by hand", () => {
  const phases = gatedPhases();
  assert.equal(phases.includes("run_phase_done"), false, "a phase still records itself by hand");
  assert.equal(phases.includes("run index-save"), false, "Phase 2 still saves the index by hand");
  for (const line of phases.split("\n").filter((text) => text.includes("via Read"))) {
    assert.ok(line.includes("references/"), `a phase still reads a run artifact via Read: ${line}`);
  }
  for (const check of ["01", "03", "05", "06", "07"]) {
    assert.ok(phases.includes(`| \`run check ${check}\` answers | Action |`), `the answers of \`run check ${check}\` are not mapped to an action`);
  }
  for (const section of [
    '{ file: "01-triage.md", section: "## Open items" }',
    '{ file: "03-plan.md", section: "## Usage coverage" }',
    '{ file: "03-plan.md", section: "## Requires user confirmation" }',
    '{ file: "07-runtime.md", section: "## Runtime verdict" }',
  ]) {
    assert.ok(phases.includes(`\`from_artifact: ${section}\``), `a pause no longer composes its notice from ${section}`);
  }
  for (const gone of ["How to fill in `Type:`", "**Coverage gate (bug):**", "**Usage coverage gate (mechanical", "Read the `Diff applies plan:` line"]) {
    assert.equal(phases.includes(gone), false, `a gate the check evaluates is still written by hand: ${gone}`);
  }
});

test("the artifact gate documents the whole line contract of `run check`", () => {
  const start = SKILL.indexOf("6. **Artifact gate.**");
  const gate = SKILL.slice(start, SKILL.indexOf("- `MISSING` → relaunch", start));
  const prefixes = ["`REPAIRED:`", "`VERDICT:`", "`GATE:`", "`OPEN:`", "`TYPE-MISMATCH:`", "`CONFIRM:`", "`QA-STAGE:`", "`INVALIDATED:`", "`DIFF-APPLIES:`", "`NEEDS-DEVICE`", "`index:`", "`recorded:`", "`SCRIPT:`"];
  const positions = prefixes.map((prefix) => gate.indexOf(prefix));
  for (const [i, position] of positions.entries()) assert.ok(position > 0, `the gate no longer documents ${prefixes[i]}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "the gate documents the prefixed lines out of their order");
  assert.ok(gate.includes("`OK`, `MISSING: <sections>` or `GENERATED`"), "the gate no longer documents its first line");
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

test("the contract lists exactly the five channels (a)-(e), and names the reflector as the run's only writer", () => {
  const start = SKILL.indexOf("## The orchestrator's contract");
  const contract = SKILL.slice(start, SKILL.indexOf("\n## ", start + 1));
  const channels = contract.split("\n").filter((line) => /^- \([a-z]\) /.test(line)).map((line) => line.slice(3, 4));
  assert.deepEqual(channels, ["a", "b", "c", "d", "e"]);
  assert.ok(contract.includes("five channels only"), "the contract does not close the channel list");
  assert.ok(contract.includes("The orchestrator never calls `lesson_save`/`memory_save`; the reflector is the run's only writer."));
});

test("references/interactive-worktree.md is the only file of the skill that names the host's worktree tool", () => {
  const skillDir = new URL("../plugin/skills/resolve/", import.meta.url);
  const files = readdirSync(skillDir, { recursive: true }).map(String).filter((name) => name.endsWith(".md"));
  assert.ok(files.length > 10, "the skill files were not found");
  const naming = files.filter((name) => /EnterWorktree|ExitWorktree/.test(readFileSync(new URL(name, skillDir), "utf8")));
  assert.deepEqual(naming, ["references/interactive-worktree.md"]);
});
