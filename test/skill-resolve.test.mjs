import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PHASE_TARGETS } from "../src/mcp/phase-context.mjs";
import { LESSON_TARGET_OF, PROMPT_TARGETS } from "../src/mcp/phase-prompt.mjs";
import { RESUME_PHASE_ORDER } from "../src/queue/resume.mjs";
import { AGENT_MODELS, PIPELINE_CONSTANTS } from "../src/queue/routing.mjs";
import { RUN_OUTCOME_STATUSES } from "../src/queue/run-state.mjs";
import { buildPrompt } from "../src/queue/spawn.mjs";

const SKILL = readFileSync(new URL("../plugin/skills/resolve/SKILL.md", import.meta.url), "utf8");
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

// The three places the skill tells the pipeline to record the outcome: its contract and its two call points.
const OUTCOME_ANCHORS = [
  "**The outcome of the run.**",
  "**The delivery is recorded by the command itself**",
  "**A gate pause records the outcome before the turn ends**",
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
  assert.ok(SKILL.includes("excludes by itself the lessons already\ninjected in earlier phases of this session"), SKILL);
  assert.ok(SKILL.includes("Pass `prompt` to `Agent` exactly as it came"), "the orchestrator may edit the rendered prompt");
  assert.equal(/Also pass `exclude_ids`/.test(SKILL), false, "the agent is still told to rebuild exclude_ids by hand");
  assert.equal(/repeat the call without `exclude_ids`/.test(SKILL), false, "the agent is still told to retry the recall by hand");
  assert.ok(
    SKILL.includes("A host that answers `unknown` for `phase_prompt` is a runtime older than this plugin:"),
    "the older-runtime degradation line of phase_prompt is missing",
  );
  assert.ok(TOOLS.includes('name: "phase_prompt"'), "the skill names a tool src/mcp/tools.mjs does not register");
  assert.ok(TOOLS.includes('name: "context_for_phase"'), "the degraded path names a tool src/mcp/tools.mjs does not register");
});

test("every run executes the one pipeline: the skill names no tier, no raise and no risk classification", () => {
  assert.equal(/[Mm]andatory escalation/.test(SKILL), false, "the mandatory escalation block survived");
  assert.equal(/tier/i.test(SKILL), false, "the skill still names a tier");
  assert.equal(SKILL.includes("Tier raised:"), false, "the skill still prints a tier raise");
  assert.equal(SKILL.includes("run start --tier"), false, "the skill still passes a tier to run start");
  assert.equal(/Classify the risk/.test(SKILL), false, "the risk classification step survived");
  assert.match(passageAt("4. **One pipeline**"), /every run executes every phase \(Phases 1–9\)/);
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
  const models = passageAt("11. **Agent models**");
  assert.match(models, /the `model` `phase_prompt` answered/, "step 11 no longer passes the answered model");
  assert.match(models, /`src\/queue\/routing\.mjs`, `nightqueue run start --routing` prints the table/, "step 11 no longer names the source of the models");
  assert.match(models, /`nightqueue project models <name>`/, "step 11 no longer names the project's override");
  assert.match(models, /the relaunched coder of a fix loop\s+keeps the Phase 4 model/);
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
  assert.match(SKILL, /`CONFIRM:`,\s+`QA: lite\|full` \(`03` only\), `QA-STAGE:` \(`05 --stage analyst` only\), `INVALIDATED:`/, "the check line list does not carry the QA line after CONFIRM");
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
  for (const phase of RESUME_PHASE_ORDER) {
    assert.ok(SKILL.includes(`\`${phase}\``), `the skill no longer names the canonical phase \`${phase}\` the tool accepts`);
  }
});

test("the agent no longer writes state.json, anywhere and by any means", () => {
  assert.equal(SKILL.includes('"outcome": {'), false, "the skill still hand-writes the outcome record");
  assert.equal(SKILL.includes('"phases"'), false, "the skill still hand-writes the phases record");
  assert.equal(SKILL.includes("state.json.tmp"), false, "the skill still documents the atomic write of state.json");
  assert.equal(SKILL.includes("schemaVersion"), false, "the skill still talks about a field only its own writer had to keep");
  assert.equal(SKILL.includes("updatedAt"), false, "the agent is still told to write a timestamp");
  assert.equal(SKILL.includes("<iso>"), false, "a timestamp placeholder survived in the skill");
  assert.ok(SKILL.includes("Never write that file"), "the skill no longer forbids writing state.json");
  assert.ok(
    SKILL.includes("means the runtime is older than this plugin: record it as an open item of Phase 9 and"),
    "the skill lost the older-runtime degradation line",
  );
});

test("every artifact gate of the skill is one `nightqueue run check` call the CLI really answers", () => {
  const gate = passageAt("**Artifact gate (apply after every phase that expects a Write):**");
  assert.ok(gate.includes("`nightqueue run check <NN>`"), "the gate is no longer a single command");
  assert.ok(gate.includes("Never check an artifact with `ls`"), "the gate no longer forbids checking an artifact by hand");
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
  for (const anchor of OUTCOME_ANCHORS) {
    assert.ok(passageAt(anchor).includes("run_outcome"), `${anchor} no longer calls \`run_outcome\``);
  }
  assert.ok(passageAt(OUTCOME_ANCHORS[0]).includes("`status` accepts ONLY `done`, `gate` and `no_change`"), "the status enum of the record is no longer closed");
  assert.ok(passageAt(OUTCOME_ANCHORS[0]).includes("exactly THREE points"), "the outcome record no longer names its three points");
  assert.ok(passageAt(OUTCOME_ANCHORS[1]).includes('`status: "done"`'), "Phase 8 no longer records the delivery");
  assert.ok(passageAt(OUTCOME_ANCHORS[2]).includes('`status: "gate"`'), "the gate no longer records its outcome");
  assert.ok(passageAt(OUTCOME_ANCHORS[3]).includes('`status: "no_change"`'), "a NO-CHANGE-NEEDED run no longer records its conclusion");
  assert.ok(passageAt(OUTCOME_ANCHORS[3]).includes("does NOT write it (it would reach the origins)"), "the NO-CHANGE-NEEDED notice is no longer told to leave the next-step line to the runtime");
  assert.equal(SKILL.includes("ends with the line `Next step:"), false, "the skill asks the run to write the next-step line, which reaches the origins");
  assert.ok(passageAt(OUTCOME_ANCHORS[1]).includes("not a parameter"), "Phase 8 is told to send the pull request URL again");

  for (const field of ["state?.outcome", "record.status", "record.prUrl", "record.notice"]) {
    assert.ok(CLASSIFY.includes(field), `the outcome record loses \`${field}\`: \`classify.mjs\` no longer reads it`);
  }
  assert.deepEqual(RUN_OUTCOME_STATUSES, ["done", "gate", "no_change"], "the runtime accepts a status the skill never documents");
  assert.ok(CLASSIFY.includes("RUN_OUTCOME_STATUSES.includes(record.status)"), "classify.mjs no longer reads the shared status enum");
});

// The text of step 2, from its heading to the start of step 3.
function resumeStep() {
  const start = SKILL.indexOf("2. **Run resume");
  const end = SKILL.indexOf("3. **Post-merge resume", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents the run resume in step 2");
  return SKILL.slice(start, end);
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

// The text of the Phase 9 telemetry instruction, from its heading to the end of the section.
function telemetryStep() {
  const start = SKILL.indexOf("**Telemetry (mandatory");
  assert.ok(start >= 0, "the skill no longer documents the telemetry of Phase 9");
  const end = SKILL.indexOf("\n---", start);
  return SKILL.slice(start, end > start ? end : SKILL.length);
}

test("the telemetry call sends only judgment, under the names the real pipeline_log schema accepts", () => {
  const schema = toolSource("pipeline_log");
  const step = telemetryStep();
  for (const arg of ["task_type", "outcome", "gate_stop", "phases"]) {
    assert.ok(step.includes(`\`${arg}\``), `the telemetry step no longer sends \`${arg}\``);
    assert.ok(schema.includes(`${arg}:`), `the telemetry step sends \`${arg}\`, whose schema has no such argument`);
  }
  assert.equal(/tier/i.test(step), false, "the telemetry step still names a tier");
  for (const old of ["tier:", "tier_operator:", "tier_raise_reason:"]) assert.ok(schema.includes(old), `the runtime lost \`${old}\` an older plugin still sends`);
  assert.ok(step.includes("No duration and no model is sent"), "the telemetry step no longer says who measures the time");
  assert.equal(SKILL.includes("operator_tier"), false, "the old column name came back");
});

test("the agent measures no time: no clock, no arithmetic, no timestamp", () => {
  assert.equal(/date \+%s/.test(SKILL), false, "the skill still tells the agent to read the clock");
  assert.equal(/compute the\s+duration/.test(SKILL), false, "the agent still computes a duration");
  assert.equal(SKILL.includes("sum of the durations"), false, "the Total is still an arithmetic the agent does");
  assert.ok(SKILL.includes("Never time an agent"), "step 8 no longer forbids timing an agent");
  assert.ok(SKILL.includes("Never compute a duration and never write a timestamp"), "Phase 9 lost the rule about the times");
});

test("the tables of Phase 9 and their Time column come from the command the CLI really offers", () => {
  const report = passageAt("**Open the report with `nightqueue run report`, pasted verbatim**");
  assert.ok(report.includes("Time column the\nruntime measured and its `**Total:**`"), "the Phase 9 table no longer reads the runtime's measurement");
  assert.ok(report.includes("may only turn a `Happy: yes` into not\nhappy — never the reverse"), "the agent may override the fail-safe verdict of the report");
  assert.ok(CLI_RUN.includes("nightqueue run report [--json]"), "the CLI no longer offers the command the skill pastes from");
  assert.ok(REPORT_LAYOUT.includes("**Total:** ⏱️"), "the report layout no longer prints the Total the report carries");
  assert.ok(CLI_RUN.includes('renderSkillTemplate(skillReferencesDir(), "report"'), "`run report` no longer renders its one layout, references/report.md");
  assert.equal(CLI_RUN.includes("| Step | Agent | Status |"), false, "the CLI carries a copy of the table layout of references/report.md");
  assert.equal(CLI_RUN.includes("Lessons saved"), false, "the CLI still prints the lesson-capture audit line Phase 10 replaced");
  assert.equal(REPORT_LAYOUT.includes("LESSONS_LINE"), false, "the report layout still carries the lesson-capture audit line");
  assert.equal(SKILL.includes("| Step | Agent | Status | Highlight |"), false, "the skill still carries the table model the report prints");
});

// The text of Phase 8, from its heading to the start of Phase 9.
function commitPhase() {
  const start = SKILL.indexOf("### Phase 8 — Commit and PR");
  const end = SKILL.indexOf("### Phase 9 —", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents Phase 8");
  return SKILL.slice(start, end);
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
  assert.ok(SKILL.includes("`references/commit-template.md` of Phase 8"), "channel (b) does not list the commit template the orchestrator reads");
  assert.ok(phase.includes("`MISSING: evidence for QA section <method>`"), "Phase 7 no longer reads the evidence refusal");
  assert.ok(phase.includes("`COMMITTED: <sha> (already committed)`"), "Phase 7 no longer reads the retry answer of the publication");
  for (const answer of ["CONVENTION:", "COMMITTED:", "REFUSED:", "REJECTED:", "MISSING:", "BRANCH:", "WORKTREE:"]) {
    assert.ok(phase.includes(answer), `Phase 7 never reads the \`${answer}\` line the command prints`);
    assert.ok(CLI_RUN.includes(answer), `Phase 7 reads \`${answer}\`, which the CLI never prints`);
  }
  for (const dead of [/git branch -m <current-name>/, /git push -u origin/, /Only after the user confirms/, /If Phase 0 did not create a worktree/]) {
    assert.equal(dead.test(SKILL), false, `Phase 7 still runs by hand what the runtime owns: ${dead}`);
  }
  assert.ok(phase.includes("`NIGHTQUEUE_JOB_ID` is unset"), "the push confirmation is asked for in an unattended run again");
  assert.ok(phase.includes("Inside a queued job"), "Phase 7 no longer says who goes straight to the pull request");
  assert.ok(phase.includes("`ExitWorktree`"), "Phase 7 stopped closing the worktree, which only the session can do");
  assert.equal(phase.includes("--remove-worktree"), false, "the command is told to remove the worktree the session is inside");
});

test("step 6 splits the worktree: a queued job runs in the one the runtime created, an interactive /resolve still enters its own", () => {
  const start = SKILL.indexOf("6. **The exclusive worktree**");
  const end = SKILL.indexOf("7. **Create the tasks**", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents the worktree in step 6");
  const step = SKILL.slice(start, end);
  assert.ok(step.includes("the runtime created your worktree"), "a queued job is no longer told the runtime placed its worktree");
  assert.ok(step.includes("never create another"), "a queued job may create a second worktree");
  assert.ok(step.includes("never `run_set` those two fields"), "a queued job may overwrite the worktree the runtime recorded");
  const job = step.slice(step.indexOf("Inside a queued job"), step.indexOf("Interactive `/resolve`"));
  assert.ok(job.includes("never call\n     `EnterWorktree`/`ExitWorktree`") || job.includes("never call `EnterWorktree`/`ExitWorktree`"), job);
  const interactive = step.slice(step.indexOf("Interactive `/resolve`"));
  assert.ok(interactive.includes("call `EnterWorktree` with `name: \"<slug>\"`"), "an interactive /resolve no longer enters its own worktree");
  assert.ok(interactive.includes("git worktree add <path> -b worktree-<slug> origin/main"), "the worktree fallback still names the commit type the triager has not chosen yet");
});

// The text of step 9, from its heading to the artifact map below it.
function handoffStep() {
  const start = SKILL.indexOf("9. **File handoff");
  const end = SKILL.indexOf("Artifact map", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents the file handoff in step 9");
  return SKILL.slice(start, end);
}

// The text of Phase 0, from its heading to the fast tracks block.
function phaseZero() {
  const start = SKILL.indexOf("### Phase 0");
  const end = SKILL.indexOf("### Context per phase", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents Phase 0");
  return SKILL.slice(start, end);
}

test("the run comes named in the prompt, and Phase 0 writes no Brief, no critique and no rename line", () => {
  const handoff = handoffStep();
  assert.ok(handoff.includes("`Project:` and `RUN_DIR:` come in the prompt"), "step 9 derives the run directory by hand again");
  assert.equal(SKILL.includes("Right after the `mkdir -p`"), false, "the skill still prints the older slug protocol as the rule");
  assert.ok(handoff.replace(/\s+/g, " ").includes("the `runDir` `run start` answers (step 5) is the `RUN_DIR`"), "step 9 lost where an interactive run takes its RUN_DIR");
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
  assert.match(phase5, /Read `references\/prompts\/_qa-attack-brief\.md`/, "Phase 5 no longer reads the attack brief");
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
  assert.ok(SKILL.includes("**Round artifacts** (`05-qa.md`, `06-verification.md`, `07-runtime.md`)"));
  assert.ok(SKILL.includes("Every gate and every reader reads the LAST round"));
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
  assert.deepEqual(saves, ["   - **The orchestrator never calls `lesson_save` or `memory_save`** - not after a loop, not at"]);
  assert.ok(SKILL.includes("| 🪞 | **Reflector** | Memory |"), "the visual identity misses the reflector");
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
  assert.ok(SKILL.includes("A phase that runs again (🔁) gets its `reason` from the check itself"), "step 10 lost the relaunch reason rule");
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
  const start = SKILL.indexOf("**Artifact gate (apply after every phase that expects a Write):**");
  const gate = SKILL.slice(start, SKILL.indexOf("**Gate prohibitions", start));
  const prefixes = ["`VERDICT:`", "`GATE: <code> — <evidence>`", "`OPEN:`", "`TYPE-MISMATCH:`", "`CONFIRM:`", "`QA-STAGE:`", "`INVALIDATED:`", "`DIFF-APPLIES:`", "`NEEDS-DEVICE`", "`index:`", "`recorded:`", "`SCRIPT:`"];
  const positions = prefixes.map((prefix) => gate.indexOf(prefix));
  for (const [i, position] of positions.entries()) assert.ok(position > 0, `the gate no longer documents ${prefixes[i]}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "the gate documents the prefixed lines out of their order");
  assert.ok(gate.includes("`recorded: phase_done <phase> <verdict>`"), "the gate no longer says the check records the phase");
});
