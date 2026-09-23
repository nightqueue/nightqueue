import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PHASE_TARGETS } from "../src/mcp/phase-context.mjs";
import { PIPELINE_TASK_TYPES } from "../src/memory/runs.mjs";
import { RESUME_PHASE_ORDER } from "../src/queue/resume.mjs";
import { RUN_OUTCOME_STATUSES } from "../src/queue/run-state.mjs";
import { buildPrompt } from "../src/queue/spawn.mjs";
import { parseSlugTypeLine, parseTierRaiseLine } from "../src/queue/stream.mjs";

const SKILL = readFileSync(new URL("../plugin/skills/resolve/SKILL.md", import.meta.url), "utf8");
const QA_PHASE = readFileSync(new URL("../plugin/skills/resolve/references/qa-phase.md", import.meta.url), "utf8");
const OPERATOR = readFileSync(new URL("../plugin/agents/operator.md", import.meta.url), "utf8");
const CLASSIFY = readFileSync(new URL("../src/queue/classify.mjs", import.meta.url), "utf8");
const TOOLS = readFileSync(new URL("../src/mcp/tools.mjs", import.meta.url), "utf8");
const CLI_RUN = readFileSync(new URL("../src/cli/run.mjs", import.meta.url), "utf8");
const QA_AGENT = readFileSync(new URL("../plugin/agents/qa-guardian.md", import.meta.url), "utf8");
const OPERATOR_TIER_LITERAL = "(set by the operator - the pipeline may only raise it, with evidence, never lower it)";

// The arguments the skill tells the pipeline to send to each run tool, checked against the real schemas.
const RUN_TOOL_ARGS = {
  run_phase_done: ["phase", "artifact", "verdict", "note"],
  run_terminate: ["phase", "reason"],
  run_outcome: ["status", "notice"],
  run_set: ["type", "tier", "branch", "worktree", "qa_stage_a"],
};

// The three places the skill tells the pipeline to record the outcome: its contract and its two call points.
const OUTCOME_ANCHORS = [
  "**The outcome of the run.**",
  "**The delivery is recorded by the command itself**",
  "**Before printing the gate block, record the outcome**",
];

// The target every per-phase placeholder of a plugin text names, in the order the prompts appear.
function contextTargets(text) {
  return [...text.matchAll(/`context_for_phase` \(target: "([a-z]+)"\)/g)].map((match) => match[1]);
}

// The cells of a markdown table row, trimmed and without the outer pipes.
function cellsOf(line) {
  return line.split("|").slice(1, -1).map((cell) => cell.trim());
}

// The row of the Track routing table whose first cell ends with the given label.
function routingRow(label) {
  const row = SKILL.split("\n").find((line) => line.includes("|") && cellsOf(line)[0]?.endsWith(label));
  assert.ok(row, `the Track routing table has no row for ${label}`);
  return cellsOf(row);
}

test("every subagent prompt takes its context from one context_for_phase block", () => {
  assert.deepEqual(contextTargets(SKILL), ["coder", "triager", "explore", "architect", "coder", "verifier"]);
  assert.deepEqual(contextTargets(QA_PHASE), ["qa", "qa"]);
  for (const text of [SKILL, QA_PHASE]) {
    for (const target of contextTargets(text)) {
      assert.ok(PHASE_TARGETS.includes(target), `the skill names \`${target}\`, which context_for_phase does not accept`);
    }
    assert.equal(text.split("[CONTEXT BLOCK]").length - 1, contextTargets(text).length, "a placeholder lost its target line");
  }
  assert.equal(SKILL.includes("[Include only if lesson_recall returned something:]"), false, "a lesson_recall placeholder survived");
  assert.equal(SKILL.includes("[Include only if memory_recall returned something:]"), false, "a memory_recall placeholder survived");
});

test("the per-phase section hands the project, the exclusion and its retry to the server", () => {
  assert.ok(SKILL.includes("### Context per phase (applies to every phase with a subagent)"), SKILL);
  assert.ok(SKILL.includes("call `context_for_phase` (MCP `nightshift`)\nONCE with `target` = the target phase"), SKILL);
  assert.ok(SKILL.includes('For `target: "explore"`, also pass\n`repo_root` = the pipeline\'s CWD'), SKILL);
  assert.ok(SKILL.includes("excludes by itself the lessons already\ninjected in earlier phases of this session"), SKILL);
  assert.equal(/Also pass `exclude_ids`/.test(SKILL), false, "the agent is still told to rebuild exclude_ids by hand");
  assert.equal(/repeat the call without `exclude_ids`/.test(SKILL), false, "the agent is still told to retry the recall by hand");
  assert.ok(
    SKILL.includes("A host that answers `unknown` for `context_for_phase` is a runtime older than this plugin:"),
    "the older-runtime degradation line of context_for_phase is missing",
  );
  assert.ok(TOOLS.includes('name: "context_for_phase"'), "the skill names a tool src/mcp/tools.mjs does not register");
});

test("a tier is raised only on evidence, never lowered, and the mandatory escalation block is gone", () => {
  assert.equal(/[Mm]andatory escalation/.test(SKILL), false, "the mandatory escalation block survived");
  assert.ok(SKILL.includes("raise only on evidence found, never on the shape of the change"), SKILL);
  assert.ok(SKILL.includes("Tier raised: <from> -> <to>: <evidence>"), SKILL);
  assert.ok(SKILL.includes("never lowers an operator tier"), SKILL);
});

test("the operator-tier line of the prompt is the same literal in the skill and in the runtime", () => {
  assert.ok(SKILL.includes(OPERATOR_TIER_LITERAL), SKILL);
  const prompt = buildPrompt({ job: { id: 1, prompt: "p", tier: "simple" } });
  assert.ok(prompt.includes(`Tier: simple ${OPERATOR_TIER_LITERAL}`), prompt);
  assert.ok(!prompt.includes("Open pull requests"), "a caller that brings no pull request answer gets the prompt it has today");
});

test("the three tracks are one routing table, one value per tier", () => {
  assert.deepEqual(routingRow("Routing"), ["Routing", "trivial", "simple", "complex"], "the tier columns moved");
  assert.deepEqual(routingRow("Track"), ["Track", "Fast Lite", "Fast", "Standard"]);
  assert.deepEqual(routingRow("triager").slice(1), ["—", "haiku (bug only)", "sonnet"]);
  assert.deepEqual(routingRow("Explore").slice(1), ["—", "—", "sonnet"]);
  assert.deepEqual(routingRow("architect").slice(1), ["—", "—", "opus"]);
  assert.deepEqual(routingRow("coder").slice(1), ["sonnet", "sonnet", "opus"]);
  assert.deepEqual(routingRow("qa-guardian").slice(1), ["—", "—", "sonnet"]);
  assert.deepEqual(routingRow("verifier").slice(1), ["haiku", "haiku", "sonnet"]);
  assert.deepEqual(routingRow("Max fix iterations").slice(1), ["1", "2", "2"]);
  assert.deepEqual(routingRow("Request critique (step 2.5)").slice(1), ["skipped", "mandatory", "mandatory"]);
  assert.deepEqual(routingRow("`index_recall`").slice(1), ["no", "yes, to locate the affected files", "yes, in Phase 2 before the Explore"]);
  assert.deepEqual(routingRow("`context_for_phase` for the coder").slice(1), ["no", "yes", "yes"]);
  const [, ...qaMethods] = routingRow("QA methods of the PR");
  assert.equal(new Set(qaMethods).size, 1, "the tiers no longer share one QA method mapping");
  for (const method of ["automated", "api", "emulator", "browser"]) assert.match(qaMethods[0], new RegExp(`\\b${method}\\b`));
});

test("every tier keeps the verifier scope, the CLAUDE.md rule and the time target of its old block", () => {
  const [, trivial, simple, complex] = routingRow("Verifier scope");
  assert.match(trivial, /tsc \+ lint \+ the tests of the files that were touched \(no build, no full suite\)/);
  assert.match(simple, /tsc \+ lint \+ the project's FULL test suite \(no QA PoCs in this tier\)/);
  assert.match(complex, /typecheck, lint, build, tests\) \+ the QA's PoCs/);
  assert.deepEqual(routingRow("Time target").slice(1), ["under 5 minutes", "under 15 minutes", "none — the depth is the target"]);
  assert.equal(routingRow("`<CWD>/CLAUDE.md`")[1], "not named to the coder", "the trivial tier started reading CLAUDE.md");
  assert.match(routingRow("`<CWD>/CLAUDE.md`")[2], /when it exists/);
  const scopeLine = "Run: [the `Verifier scope` cell of this tier's column in the Track routing table].";
  assert.equal(SKILL.split(scopeLine).length - 1, 2, "the fast tracks and Phase 6 no longer read the same scope cell");
});

test("the two track headings are gone and every phase reads its tier from the table", () => {
  assert.equal(/### Fast Lite Track/.test(SKILL), false, "the Fast Lite block survived");
  assert.equal(/### Fast Track/.test(SKILL), false, "the Fast Track block survived");
  assert.ok(SKILL.includes('### Fast tracks — execute this block if the tier is "trivial" or "simple"'), SKILL);
  assert.equal(/\*\*trivial\*\* → does not execute/.test(SKILL), false, "a phase still restates the tier scoping the table carries");
  for (const phase of ["### Phase 1 —", "### Phase 2 —", "### Phase 3 —", "### Phase 4 —", "### Phase 5 —", "### Phase 6.5 —"]) {
    assert.match(passageAt(phase).slice(0, 400), /\*\*Track routing\*\* table \(step 6\)/, `${phase} does not read its tier from the table`);
  }
  const loop = passageAt("- **Maximum of iterations**:");
  assert.match(loop, /`Max fix iterations` cell of this tier's column/, "the fix loop still hard-codes the iterations per tier");
  assert.match(passageAt('### Phase 6 — Verification'), /the `model` of the ✅ verifier\nrow of the \*\*Track routing\*\* table/);
});

test("the fast tracks hand the coder the file list, never the pasted content", () => {
  assert.equal(SKILL.includes("[CONTENT READ INLINE]"), false, "a fast track still pastes file content into the coder prompt");
  assert.equal(SKILL.includes("Content of the affected files:"), false, "a fast track still pastes file content into the coder prompt");
  assert.ok(SKILL.includes("Affected files (read them yourself, via Read):"), SKILL);
  assert.match(passageAt("1. **Locate the affected files**"), /never their content pasted inline: it has Read/);
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
    SKILL.includes("means the runtime is older than this plugin: record it as an open item of Phase 8 and"),
    "the skill lost the older-runtime degradation line",
  );
});

test("every artifact gate of the skill is one `nightshift run check` call the CLI really answers", () => {
  const gate = passageAt("**Artifact gate (apply after every phase that expects a Write):**");
  assert.ok(gate.includes("`nightshift run check <NN>`"), "the gate is no longer a single command");
  assert.ok(gate.includes("Never check an artifact with `ls`"), "the gate no longer forbids checking an artifact by hand");
  for (const phase of ["01", "02", "03", "04", "05a", "05", "06", "06.5"]) {
    assert.ok(`${SKILL}${QA_PHASE}`.includes(`nightshift run check ${phase}`), `the gate of phase ${phase} is not a \`run check\` call`);
    assert.ok(CLI_RUN.includes(`["${phase}", {`), `the skill calls \`run check ${phase}\`, a phase the CLI does not know`);
  }
  assert.equal(/existence gate \(step 5\.2\)/.test(SKILL), false, "a phase still applies the gate by hand");
  assert.equal(/ls [`<]*ARTIFACT_PATH/.test(SKILL), false, "a gate still checks an artifact with `ls`");
  assert.equal(/git -C <CWD> diff --name-only/.test(SKILL), false, "the agent still derives the file list of Phase 4 itself");
  assert.ok(SKILL.includes("`MISSING: ## Modified files (no changed files)`"), "Phase 4 no longer reads the empty-worktree answer");
});

test("the QA echo is gone, and the pair that replaces it is really in the flow", () => {
  assert.equal(/ECHO per section/.test(SKILL), false, "a QA prompt still asks for the echo of the plan");
  assert.equal(/echo line per section/.test(QA_AGENT), false, "the qa-guardian agent still returns the echo of the plan");
  assert.equal(SKILL.includes("Validation of the QA echo"), false, "the orchestrator still audits an echo nobody returns");
  assert.equal(QA_PHASE.split("`<RUN_DIR>/03-plan.md` (open it only AFTER step 0").length - 1, 2, "a QA prompt stopped reading the plan");
  assert.ok(CLI_RUN.includes('sections: ["## Validated risks"]'), "`run check 05` no longer requires the section the plan feeds");
});

test("the QA stage A gate records its marker with the tool, before stage B is launched", () => {
  const gate = passageAt("**Stage A gate:**", QA_PHASE);
  assert.ok(gate.includes("`run_set` with `qa_stage_a`"), "the stage A gate no longer records the marker with the tool");
  assert.ok(gate.includes("05a-qa-analyst.md"), "the marker no longer names the artifact the resume decision reads");
  assert.ok(gate.includes("BEFORE launching stage B"), "the marker is no longer recorded before the provers start");
  assert.ok(gate.includes("never by writing the file"), "the stage A gate no longer forbids hand-writing the marker");
});

test("the outcome record is documented at its three points, with the enum the runtime really accepts", () => {
  for (const anchor of OUTCOME_ANCHORS) {
    assert.ok(passageAt(anchor).includes("run_outcome"), `${anchor} no longer calls \`run_outcome\``);
  }
  assert.ok(passageAt(OUTCOME_ANCHORS[0]).includes("`status` accepts ONLY `done`"), "the status enum of the record is no longer closed");
  assert.ok(passageAt(OUTCOME_ANCHORS[1]).includes('`status: "done"`'), "Phase 7 no longer records the delivery");
  assert.ok(passageAt(OUTCOME_ANCHORS[2]).includes('`status: "gate"`'), "the gate no longer records its outcome");
  assert.ok(passageAt(OUTCOME_ANCHORS[1]).includes("not a parameter"), "Phase 7 is told to send the pull request URL again");

  for (const field of ["state?.outcome", "record.status", "record.prUrl", "record.notice"]) {
    assert.ok(CLASSIFY.includes(field), `the outcome record loses \`${field}\`: \`classify.mjs\` no longer reads it`);
  }
  assert.deepEqual(RUN_OUTCOME_STATUSES, ["done", "gate"], "the runtime accepts a status the skill never documents");
  assert.ok(CLASSIFY.includes("RUN_OUTCOME_STATUSES.includes(record.status)"), "classify.mjs no longer reads the shared status enum");
});

// The text of step 0.5, from its heading to the start of step 0.6.
function resumeStep() {
  const start = SKILL.indexOf("0.5. **Run resume");
  const end = SKILL.indexOf("0.6. **", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents the run resume in step 0.5");
  return SKILL.slice(start, end);
}

test("step 0.5 trusts the resume block the runtime emits and re-validates nothing", () => {
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
  assert.ok(step.includes("RESUME CANDIDATE (slug `<slug>`)"), "step 0.5 no longer names the block the runtime emits");
  for (const field of ["RUN_DIR:", "Branch:", "Worktree:", "Last completed phase:", "Resume from phase:", "From stage:"]) {
    assert.ok(prompt.includes(`\n${field} `), `the runtime stopped emitting \`${field}\` in the resume block`);
    assert.ok(step.includes(field), `step 0.5 no longer reads \`${field}\` from the block`);
  }
  assert.ok(step.includes("From stage: qa-stage-b"), "step 0.5 lost the QA stage B re-entry");
  assert.equal(SKILL.includes("schemaVersion == 1"), false, "the agent still re-validates the state the runtime already validated");
  assert.equal(SKILL.includes("increment `resumeCount`"), false, "the agent is still told to write `resumeCount`");
});

// The text of the Phase 8 telemetry instruction, from its heading to the end of the section.
function telemetryStep() {
  const start = SKILL.indexOf("**Telemetry (mandatory");
  const end = SKILL.indexOf("\n---", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents the telemetry of Phase 8");
  return SKILL.slice(start, end);
}

// The `Tier raised:` line as the Brief tells the orchestrator to print it, read from the skill instead of copied.
function tierRaiseTemplate() {
  const line = SKILL.split("\n").find((text) => text.includes("`Tier raised:"));
  assert.ok(line, "the skill no longer tells the Brief to print the raise line");
  const quoted = /`([^`]+)`/.exec(line);
  assert.ok(quoted, `the raise line lost its literal delimiters: ${line}`);
  return quoted[1];
}

test("the telemetry call sends only judgment, under the names the real pipeline_log schema accepts", () => {
  const schema = toolSource("pipeline_log");
  const step = telemetryStep();
  for (const arg of ["task_type", "outcome", "gate_stop", "tier_operator", "phases"]) {
    assert.ok(step.includes(`\`${arg}\``), `the telemetry step no longer sends \`${arg}\``);
    assert.ok(schema.includes(`${arg}:`), `the telemetry step sends \`${arg}\`, whose schema has no such argument`);
  }
  assert.ok(step.includes("`tier` and `tier_raise_reason` are left out"), "the agent is told to assemble the tier again");
  assert.ok(schema.includes("tier_raise_reason:"), "the runtime lost the argument an older plugin still sends");
  assert.ok(step.includes("No duration and no model is sent"), "the telemetry step no longer says who measures the time");
  assert.equal(SKILL.includes("operator_tier"), false, "the old column name came back");
});

test("the agent measures no time: no clock, no arithmetic, no timestamp", () => {
  assert.equal(/date \+%s/.test(SKILL), false, "the skill still tells the agent to read the clock");
  assert.equal(/compute the\s+duration/.test(SKILL), false, "the agent still computes a duration");
  assert.equal(SKILL.includes("sum of the durations"), false, "the Total is still an arithmetic the agent does");
  assert.ok(SKILL.includes("Never time an agent"), "step 5.1 no longer forbids timing an agent");
  assert.ok(SKILL.includes("Never compute a duration and never write a timestamp"), "Phase 8 lost the rule about the times");
});

test("the Time column of Phase 8 is read from the command the CLI really ships", () => {
  const table = passageAt("**The Time column is read, never computed.**");
  assert.ok(table.includes("`nightshift run log`"), "the Phase 8 table no longer reads the runtime's measurement");
  assert.ok(table.includes("`nightshift run log --json`"), "the report lost the `at` stamps of the phases");
  assert.ok(SKILL.includes("**Total:** ⏱️ the `total` line of `nightshift run log`"), "the Total is assembled by the agent again");
  assert.ok(CLI_RUN.includes("nightshift run log [--json]"), "the CLI no longer offers the command the skill pastes from");
  assert.ok(CLI_RUN.includes("total\\t"), "the CLI no longer prints the `total` line the skill pastes into the Total");
});

// The text of Phase 7, from its heading to the start of Phase 8.
function commitPhase() {
  const start = SKILL.indexOf("### Phase 7 — Commit and PR");
  const end = SKILL.indexOf("### Phase 8 —", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents Phase 7");
  return SKILL.slice(start, end);
}

test("Phase 7 is the two `nightshift run` calls the CLI really ships, and no git or gh is run by hand", () => {
  const phase = commitPhase();
  assert.ok(phase.includes("`nightshift run commit --message-file <RUN_DIR>/commit-message.txt`"), "the commit is no longer the command's");
  assert.ok(phase.includes("`nightshift run pr --body-file <RUN_DIR>/pr-body.md`"), "the pull request is no longer the command's");
  assert.ok(CLI_RUN.includes("nightshift run commit --message-file <path>"), "the CLI no longer ships the command Phase 7 calls");
  assert.ok(CLI_RUN.includes("nightshift run pr --body-file <path>"), "the CLI no longer ships the command Phase 7 calls");
  for (const flag of ["--extra <pathspec>", "--message-file", "--body-file"]) {
    assert.ok(CLI_RUN.includes(flag), `Phase 7 passes \`${flag}\`, which the CLI does not accept`);
  }
  assert.ok(phase.includes("`nightshift run pr --template`"), "Phase 7 no longer asks the runtime which template the body follows");
  assert.ok(CLI_RUN.includes("| --template"), "the CLI no longer ships the template query Phase 7 calls");
  assert.ok(phase.includes("`MISSING: evidence for QA row <method>`"), "Phase 7 no longer reads the evidence refusal");
  for (const answer of ["CONVENTION:", "COMMITTED:", "REFUSED:", "REJECTED:", "MISSING:", "TEMPLATE:", "BRANCH:", "WORKTREE:"]) {
    assert.ok(phase.includes(answer), `Phase 7 never reads the \`${answer}\` line the command prints`);
    assert.ok(CLI_RUN.includes(answer), `Phase 7 reads \`${answer}\`, which the CLI never prints`);
  }
  for (const dead of [/git branch -m <current-name>/, /git push -u origin/, /Only after the user confirms/, /If Phase 0 did not create a worktree/]) {
    assert.equal(dead.test(SKILL), false, `Phase 7 still runs by hand what the runtime owns: ${dead}`);
  }
  assert.ok(phase.includes("`NIGHTSHIFT_JOB_ID` is unset"), "the push confirmation is asked for in an unattended run again");
  assert.ok(phase.includes("Inside a queued job"), "Phase 7 no longer says who goes straight to the pull request");
  assert.ok(phase.includes("`ExitWorktree`"), "Phase 7 stopped closing the worktree, which only the session can do");
  assert.equal(phase.includes("--remove-worktree"), false, "the command is told to remove the worktree the session is inside");
});

// The text of step 5.2, from its heading to the artifact map below it.
function handoffStep() {
  const start = SKILL.indexOf("5.2. **File handoff");
  const end = SKILL.indexOf("Artifact map", start);
  assert.ok(start >= 0 && end > start, "the skill no longer documents the file handoff in step 5.2");
  return SKILL.slice(start, end);
}

// The `SLUG:` declaration as step 5.2 tells the orchestrator to print it, read from the skill instead of copied.
function slugTemplate() {
  const line = SKILL.split("\n").find((text) => text.includes("`SLUG: <slug> TYPE: <type>`"));
  assert.ok(line, "the skill no longer tells the pipeline how to rename its run");
  return line.match(/`(SLUG: <slug> TYPE: <type>)`/)[1];
}

test("the run comes named in the prompt, and the rename line the skill prints is the line the runtime parses", () => {
  const handoff = handoffStep();
  assert.ok(handoff.includes("`Project:` and `RUN_DIR:` come in the prompt"), "step 5.2 derives the run directory by hand again");
  assert.equal(SKILL.includes("Right after the `mkdir -p`"), false, "the skill still prints the older slug protocol as the rule");
  assert.ok(
    handoff
      .replace(/\s+/g, " ")
      .includes("No `RUN_DIR:` line in the prompt → derive `RUN_DIR` from `<project>/<slug>` as before and print `QUEUE_SLUG: <slug>` once."),
    "step 5.2 lost the degradation line for a runtime older than this plugin",
  );
  for (const type of PIPELINE_TASK_TYPES) {
    assert.ok(handoff.includes(`\`${type}\``), `the rename line never names the task type \`${type}\` the runtime records`);
  }
  const printed = slugTemplate().replace("<slug>", "fix-the-worker").replace("<type>", "bug/error");
  assert.deepEqual(parseSlugTypeLine(printed), { slug: "fix-the-worker", type: "bug/error" });
  assert.equal(parseSlugTypeLine(slugTemplate()), null, "the template itself was read as a declaration");
});

test("the raise line the Brief prints is the line the runtime parses", () => {
  assert.equal(tierRaiseTemplate(), "Tier raised: <from> -> <to>: <evidence>");
  const printed = tierRaiseTemplate()
    .replace("<from>", "simple")
    .replace("<to>", "complex")
    .replace("<evidence>", "the brief did not name the money surface");
  assert.deepEqual(parseTierRaiseLine(printed), {
    from: "simple",
    to: "complex",
    reason: "the brief did not name the money surface",
  });
});

test("the QA methodology lives in references/qa-phase.md alone, and both of its readers point there", () => {
  const phase5 = SKILL.slice(SKILL.indexOf("### Phase 5 —"), SKILL.indexOf("### Phase 6 —"));
  assert.match(phase5, /Read `references\/qa-phase\.md`/, "Phase 5 no longer points to the QA reference");
  assert.ok(OPERATOR.includes("skills/resolve/references/qa-phase.md"), "the operator no longer points to the QA reference");
  for (const anchor of ["#### QA attack brief", "**Stage A gate:**", "Mode: ANALYST", "Mode: PROVER", "**Consolidation (inline"]) {
    const count = [SKILL, QA_PHASE, OPERATOR].reduce((sum, text) => sum + text.split(anchor).length - 1, 0);
    assert.equal(count, 1, `\`${anchor}\` is not written exactly once across the skill, the reference and the operator`);
    assert.ok(QA_PHASE.includes(anchor), `\`${anchor}\` left references/qa-phase.md`);
  }
  for (const [, name] of SKILL.matchAll(/references\/([a-z0-9-]+\.md)/g)) {
    assert.ok(existsSync(new URL(`../plugin/skills/resolve/references/${name}`, import.meta.url)), `the skill names references/${name}, which is not on disk`);
  }
});

test("step 0.5 reads the re-run lines and the prior-run block of a job queued from an operator run", () => {
  const step = resumeStep();
  assert.ok(step.includes("Re-run:"), "step 0.5 no longer reads the phases the runtime refused to skip");
  assert.ok(step.includes("## PRIOR RUN (operator)"), "step 0.5 no longer names the operator's block");
  const prompt = buildPrompt({
    job: { id: 1, prompt: "p" },
    handoff: { slug: "demo-slug", runDir: "/runs/demo/demo-slug", lastPhase: null, fromPhase: "triage", reruns: [{ phase: "triage", reason: "evidence level 2 is below 3 on a bug (operator run)" }] },
  });
  assert.ok(prompt.includes("\nRe-run: triage — evidence level 2 is below 3 on a bug (operator run)\n"), prompt);
});
