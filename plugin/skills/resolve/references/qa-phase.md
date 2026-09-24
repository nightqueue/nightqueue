# QA phase — the adversarial QA of /resolve

Read via Read by the /resolve orchestrator in Phase 5, before launching any qa-guardian, and by
the operator in its step 6b (a bug hunt). It is the single home of the plugin root, the QA attack
brief, the LITE/ANALYST/PROVER prompts, the Stage A gate and the consolidation.

**Without a diff (operator hunt):** the hunt's scope replaces the file list of
`04-implementation.md`, and the fronts that depend on a plan — the pre-mortem, the symptom and
usage coverage, every read of `03-plan.md` — are omitted from the prompts. A caller without
`Glob` takes `[PLUGIN_ROOT]` from this file's own path, three levels above its directory.
Everything else below is unchanged.

**Before launching any qa-guardian, resolve the plugin root once:** `Glob` for
`skills/qa-guardian/SKILL.md` with `path` = the plugin root — the directory three levels above
the directory of this file (never a Glob of the repository) — and take the directory that
CONTAINS `skills/` as `[PLUGIN_ROOT]`, then substitute it into the `QA_SKILL:` / `RISK_MATRIX:` / `FUZZ_TEMPLATE:`
lines of the three prompts below. If it does not resolve, omit those three lines
entirely — the agent keeps its own `Glob` fallback for that case.

**complex → two stages (analyst → parallel provers):** the analysis stays in a single
head — it groups breaks by root (4 symptoms with the same cause = 1 fix, not 4) and crosses
callers and interactions between files. The proof — the write→run→iterate loop of each PoC,
the serial bottleneck of the phase — is distributed across parallel provers. Stages A and B
below replace the single launch.

#### QA attack brief (shared by LITE and ANALYST)

The orchestrator pastes this brief into each prompt below, at the line that points here.

[Include only if 03-plan.md has ## Usage coverage:] Step 0 — BEFORE reading 03-plan.md: read
`<RUN_DIR>/04-implementation.md` (## Modified files) and the target code and write YOUR
## Access map (QA), in the format and vocabulary of agents/explore.md — a Map written after the
plan is a rubber stamp, not an enumeration.

What `03-plan.md` (once open) demands: ## Identified risks (MANDATORY to attack each one),
## Assumptions (attack each one with real evidence), ## Pre-mortem (validate each declared
mitigation AND attack each "accepted because" justification).

Pre-mortem mitigations — two attacks, both mandatory, on every item. (1) "mitigation:
adjustment already made in the plan": confirm it ACTUALLY exists in the diff — a mitigation
declared and not implemented is a break in ## Proven breaks. (2) "mitigation: accepted because <reason>":
attack the JUSTIFICATION with real evidence — it is the most fragile hypothesis of the plan
and today nobody checks it; "Accepted" never waives the attack. A false justification is a
live and unmitigated risk: what you prove goes to ## Proven breaks (or ## Break hypotheses in
ANALYST mode, when it depends on runtime); if you knock the justification down without proving
the failure, report it in ## Invalidated assumptions (back to the architect, not the coder).

[Include only if Type = bug/error:] ## Symptom coverage — TWO attacks, both
mandatory. (1) Is each vector marked `covered` ACTUALLY covered in the diff? Covered in the
plan and absent from the diff = a break. (2) Is the list COMPLETE? Do NOT trust it: re-run
the command declared in `**How I enumerated:**` and widen it on your own (writers of the
state, entry points, handlers/listeners, jobs, error paths). A path that
produces the ticket's symptom and is NOT in the table is an **omitted vector** = a break in
## Proven breaks, with the command used and `file:line`. Record it as the FIRST line of
## Validated risks:
`Symptom coverage: <N vectors of the plan's table> · <command/criterion of your
re-enumeration> · omitted: <file:line | none>` — the orchestrator audits that line.
`N vectors of the plan's table` = the total of lines of the ## Symptom coverage table of the
plan (`covered` + `not-covered`), NOT the number of vectors you confirmed in the diff:
a `not-covered` vector counts towards N even without being in the diff (by definition it is
not), and an omitted vector that YOU discovered does NOT enter N — it goes only in the
`omitted:` field.

[Include only if 03-plan.md has ## Usage coverage:] ## Usage coverage — with YOUR
## Access map (QA) of step 0 already written, only then read 02-explore.md and that section
of the plan and diff the two against it. Every prohibition of ## What to avoid and every
`source=pipeline` line is a hypothesis to attack: a named consumer (file:line + entry point) →
a proven break; without one → the label `the decision remains unconfirmed by the operator`,
and `HELD` is FORBIDDEN on those items. ## Access map (QA) is mandatory whenever this front
applies. Record it in ## Validated risks, right after the `Symptom coverage: ...` line when it
exists (otherwise as the first line):
`Usage coverage: <N lines of the plan> · <M own scenarios> · divergences: <file:line, ...|none> · unconfirmed decisions: <item, ...|none>`
`N lines of the plan` = the total of scenario lines (the ones starting with `- `) inside the
cut of the `## Usage coverage` section of `03-plan.md` — from the heading to the next `## `,
outside a code block; the `**Diff axis:**`, `**Always-gate class:**` and `**Scenarios
consulted:**` lines do NOT count. `M own scenarios` = the total of entry-point lines of the
`## Access map (QA)` of the QA report; the `partial:` line and the `unimplemented intent:`
lines do NOT count. The orchestrator audits that line with these same definitions.

Prompt of the LITE mode (the single-flow mode of `qa-guardian.md`; no tier routes here
today — `complex` always runs the two stages below):

```
ARTIFACT_PATH: <RUN_DIR>/05-qa.md
Read before acting (via Read):
- `<RUN_DIR>/04-implementation.md` — ## Modified files (the files to attack).
- `<RUN_DIR>/03-plan.md` (open it only AFTER step 0 of the Access map (QA), when it
  applies) — see the QA attack brief above, pasted here by the orchestrator.

Mode: LITE

Attack every pre-mortem mitigation per the QA attack brief above; prove the consequence with an
executable PoC and report it in ## Proven breaks.

Try to break each risk (execute the architect's steps or derive equivalents;
HELD/BROKE) and apply your adversarial methodology. Attack each
assumption too: if you find evidence that invalidates it, report it in ## Invalidated
assumptions — the plan was designed on top of it. On a bug, use the criterion of the
break from the user's point of view (fallback-zero in the bug's scenario = BROKE). Do NOT
fix anything — prove each break with an executable PoC and hand it back to the coder.

[Include only if Type = bug/error:]
MANDATORY (the bug's regression net): besides the break PoCs, create
<module>.regression.test.* encoding the EXACT SCENARIO of the bug (state of the bug
account + input of the symptom) asserting the correct behavior. It must PASS
against the fixed code; when feasible, prove that it would fail without the fix
(git stash → run → git stash pop). Without a scenario exercisable at runtime,
justify it explicitly in ## Generated PoCs.

Finish with ## Proven breaks, ## Validated risks, ## Generated PoCs and
## Invalidated assumptions (or "None").

[Paste the `block` of `context_for_phase` (target: "qa") — omit when it came back empty:]
[CONTEXT BLOCK]

Repository: [CWD PATH]
Project: [PROJECT — the same identifier used in RUN_DIR]
[Include the three lines only if [PLUGIN_ROOT] resolved:]
QA_SKILL: [PLUGIN_ROOT]/skills/qa-guardian/SKILL.md
RISK_MATRIX: [PLUGIN_ROOT]/skills/qa-guardian/references/risk-matrix.md
FUZZ_TEMPLATE: [PLUGIN_ROOT]/skills/qa-guardian/references/fuzz-template.md
```

**Stage A — Analyst (complex):** launch 1 qa-guardian
(subagent_type="nightqueue:qa-guardian", `model: "sonnet"`), header
`🛡️ QA-GUARDIAN · complex · ANALYST · ...`:

```
ARTIFACT_PATH: <RUN_DIR>/05a-qa-analyst.md
Read before acting (via Read):
- `<RUN_DIR>/04-implementation.md` — ## Modified files (the files to attack).
- `<RUN_DIR>/03-plan.md` (open it only AFTER step 0 of the Access map (QA), when it
  applies) — see the QA attack brief above, pasted here by the orchestrator.

Mode: ANALYST

Attack every pre-mortem mitigation per the QA attack brief above: static proof (by reading)
goes to ## Proven breaks, runtime-dependent proof becomes a ## Break hypotheses item.

Apply the COMPLETE analytical attack (fronts, risks, assumptions, callers,
robustness), but follow the rules of the ANALYST Mode: do NOT write or run a runtime
PoC — each runtime break becomes a hypothesis in ## Break hypotheses
(grouped by probable root, with type, minimum context and an assigned PoC name).
A static break (proof by reading) is yours: report it in ## Proven breaks.
Discover and record the project's ## Test recipe — the provers are going to use it
without rediscovering the setup. On a bug, use the criterion of the break from the user's point of view
(fallback-zero in the bug's scenario = BROKE).

[Include only if Type = bug/error:]
MANDATORY: include in ## Break hypotheses an item with type=regression with the
EXACT SCENARIO of the bug (state of the bug account + input of the symptom) and the name
<module>.regression.test.* — the prover is going to build it to PASS against the
fixed code.

Finish with ## Proven breaks (static), ## Break hypotheses,
## Test recipe, ## Validated risks (analytical HELD or "→ hypothesis
H<n>") and ## Invalidated assumptions (or "None").

[Paste the `block` of `context_for_phase` (target: "qa") — omit when it came back empty:]
[CONTEXT BLOCK]

Repository: [CWD PATH]
Project: [PROJECT — the same identifier used in RUN_DIR]
[Include the three lines only if [PLUGIN_ROOT] resolved:]
QA_SKILL: [PLUGIN_ROOT]/skills/qa-guardian/SKILL.md
RISK_MATRIX: [PLUGIN_ROOT]/skills/qa-guardian/references/risk-matrix.md
FUZZ_TEMPLATE: [PLUGIN_ROOT]/skills/qa-guardian/references/fuzz-template.md
```

**Stage A gate:** run `nightqueue run check 05a` (the artifact gate, step 5.2) over
`05a-qa-analyst.md`, which must carry `## Break hypotheses` and `## Test recipe` — on
`MISSING`, relaunch the analyst (🔁) once; if it persists, terminate and inform the user. Zero
runtime hypotheses → skip stage B and go straight to the consolidation.

As soon as that gate closes, call `run_set` with `qa_stage_a` = `{ "artifact":
"05a-qa-analyst.md", "verdict": "<the analyst's verdict>" }` — BEFORE launching stage B,
never by writing the file: this is what makes a resume skip the analyst if the provers die
halfway.

**Stage B — Provers (complex):** launch **N qa-guardian in parallel, all in a single message**
(subagent_type="nightqueue:qa-guardian", `model: "sonnet"`, `mode: "bypassPermissions"`) — one
per root group of the hypotheses (never one per symptom). The `description` of each prover's Agent call MUST start with
`H<N> (group: <group>): ` — the cockpit identifies each prover lane and its verdict by that
prefix. Single header of the phase: `🛡️ QA-GUARDIAN · complex · PROVERS ×N · ...`. On a resume
whose block says `From stage: qa-stage-b`, `05a-qa-analyst.md` is already on disk: read it and
start from here, without rebuilding stage A. Prompt of each one:

```
Read before acting (via Read): `<RUN_DIR>/05a-qa-analyst.md` — stick to YOUR group
of hypotheses (## Break hypotheses: <IDs/label of the assigned group>) and to the ## Test
recipe. Write ONLY the assigned PoC files — with no .md artifact of your own.
Return summary (≤10 lines): verdict per hypothesis + open items.

Mode: PROVER

Group of hypotheses under your responsibility (read the detail in 05a-qa-analyst.md):
[IDs/LABEL OF THE SAME-ROOT GROUP ASSIGNED TO THIS PROVER]

Follow the rules of the PROVER Mode: write ONLY the PoC files with the assigned
names; never touch the git state (other provers run in this same
working tree). type=break → iterate until the PoC FAILS against the current code by the real
break; type=regression → iterate until it PASSES. NEVER report PROVEN without the output
of a real failure.

Finish with the verdict per hypothesis: PROVEN (PoC + output of the failure) |
REFUTED (evidence) | INCONCLUSIVE (what was missing).

Repository: [CWD PATH]
Project: [PROJECT — the same identifier used in RUN_DIR]
[Include the three lines only if [PLUGIN_ROOT] resolved:]
QA_SKILL: [PLUGIN_ROOT]/skills/qa-guardian/SKILL.md
RISK_MATRIX: [PLUGIN_ROOT]/skills/qa-guardian/references/risk-matrix.md
FUZZ_TEMPLATE: [PLUGIN_ROOT]/skills/qa-guardian/references/fuzz-template.md
```

**Consolidation (inline, by yourself — no subagent):** assemble the single report in the
contract that Phase 6 consumes:
- `## Proven breaks` = the analyst's static ones + the `PROVEN` hypotheses of the provers,
  keeping the analyst's grouping by root (same root = 1 item with its PoCs).
- `## Validated risks` = the analyst's, resolving each "→ hypothesis H<n>" to HELD (REFUTED)
  or BROKE (PROVEN).
- `## Generated PoCs` = the provers' files + a note that the without-fix proof via stash was
  delegated to the verifier.
- `## Invalidated assumptions` = the analyst's.
- `INCONCLUSIVE` **never becomes HELD**: relaunch ONE prover (🔁) for that hypothesis with
  what was missing; if it remains inconclusive, record an ⚠️ open item.
- Aggregate verdict: any proven break → `NEEDS FIX`; nothing proven and no open item →
  `APPROVED`.
- Record 5.1: one line per agent — `🛡️ QA-Guardian (analyst)`, `🛡️ QA-Guardian (prover
  <group>)`.

Write the consolidated report to `05-qa.md` via Write and run `nightqueue run check 05`
(the artifact gate, step 5.2) — the artifact Phase 6 and Phase 8 re-read via Read.
