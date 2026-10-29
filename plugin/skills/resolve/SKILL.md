---
name: resolve
description: >-
  Orchestrates an autonomous team of agents to solve any coding task.
  Pipeline: interpretation → triage-gate → exploration → architecture →
  implementation → QA → functional verification → report. Use when the user asks to
  "resolve", "implement", "fix" or describes a coding task that requires autonomous
  execution with integrated QA and verification.
---

# Resolve — Agent orchestrator

## The orchestrator's contract (read first)

The orchestrator coordinates and nothing else: it never reads source code, never explores the
repository, never reviews a diff itself — everything it needs reaches it as a handoff file or a
≤10-line subagent return.

It works through five channels only:

- (a) the run's handoff files under `<RUN_DIR>`;
- (b) `references/**` of this skill, each read when its phase says so;
- (c) the `nightqueue` MCP tools;
- (d) the harness's subagent launch, with the `subagent_type` and `model` the runtime answers;
- (e) git/gh/`nightqueue run` in the subcommands the runtime allows; a denial says what to do instead.

Inside a queued job the runtime enforces them; never work around a denial — hand the need to the phase's subagent.
The orchestrator never calls `lesson_save`/`memory_save`; the reflector is the run's only writer.
Independent launches go in parallel; the runtime waits for every subagent and background task of an unattended run — never end a turn to wait for one.

## Pipeline (execute in this exact order)

### Phase 0 — Start

1. **Run resume.** When the context carries a ``RESUME CANDIDATE`` block, read
   `references/resume.md` now and follow it before step 2.

2. **Start the run**: run `nightqueue run start` (outside a job add
   `--project <project> --slug <a short kebab-case slug of the request>`). It answers one JSON
   line: `runDir` (the `RUN_DIR` from here on; a `RUN_DIR:` line of the prompt is the same),
   `worktree`, `branch`, `phases`, `prTemplate`, `commitConvention` and `commitTemplate`. The type
   and the commit type come from the triager, recorded by `run check 01`.

3. **One pipeline:** every run executes Phases 1–10; nothing in the request changes the phases.

4. **The worktree.** Inside a queued job the runtime created it at `$PWD` on branch
   `worktree-<slug>` and recorded it: never create another and never record `branch`/`worktree`.
   Run `git status --short` once: anything listed is a previous attempt's work — keep it. Pass
   `$PWD` to every phase. No `NIGHTQUEUE_JOB_ID` (an interactive `/resolve`) → read
   `references/interactive-worktree.md` now.

5. Every prompt carries the shell rule (`references/prompts/_shell-rule.md`); every test command a phase runs goes under an explicit `timeout`.

6. **Artifact gate.** After every phase that writes, run `nightqueue run check <NN>`. Its first
   line is `OK`, `MISSING: <sections>` or `GENERATED` (only `04`: the file list was derived
   from the worktree's own changes).
   Then come stable-prefix lines that each phase's table maps to the next action: `REPAIRED:`,
   `VERDICT:`, `GATE:`, `OPEN:`, `TYPE-MISMATCH:`, `CONFIRM:`, `QA:`, `QA-STAGE:`,
   `INVALIDATED:`, `DIFF-APPLIES:`, `NEEDS-DEVICE`, `index:`, `recorded:`, `SCRIPT:`.
   - `MISSING` → relaunch the subagent once with the `MISSING:`/`REPAIRED:` lines as `note`; still
     `MISSING` → terminate the pipeline (⚠️ open item of Phase 9).
   - `recorded: not recorded (…)` and `index: not saved (…)` → ⚠️ open items, never blocking.
   - The ≤10-line return never replaces the artifact; confirm an artifact with the check, never
     with `ls` or Read; never re-read what is already in context (Phase 9 excepted).

7. **Records.** `<RUN_DIR>/state.json` is the runtime's: never write it.
   - `run check` records each phase and `run publish` the delivery.
   - `run_set` only when a field changes afterwards (the Phase 3 Type valve).
   - `run_outcome` at its three points: a gate pause of Phase 1, 3, 5 or 7 (`status: "gate"` with
     `question`/`from_artifact`, then end the turn with one plain line); the Phase 9 report of a
     `NO-CHANGE-NEEDED` run (`status: "no_change"`); and Phase 8's delivery, which `run publish`
     records itself.
   - Terminate = `run_terminate` (phase, reason): the runtime commits the changes as
     `wip(<slug>): terminated at <phase> — <reason>` and answers a `notice` for Phase 9; never commit by hand.
   - Tolerant: a failing `run_*` call is an open item of Phase 9, never an abort.

8. No execution log by hand: never time a phase nor keep a table — `run report` derives them.

9. **Autonomy.** The run executes without asking to confirm commands; the isolation is the
   worktree. It stops for the user only at the gates the phase tables name.

---

### Context per phase (applies to every phase with a subagent)

Every subagent prompt comes from ONE `phase_prompt` call (MCP `nightqueue`) with `target` = the
prompt of the phase (`triager` | `explore` | `architect` | `coder` | `coder-fix` | `verifier` |
`runtime` | `qa-lite` | `qa-analyst` | `qa-prover` | `reflector`) and, optionally, `query` = 2–4 keywords from
the brief. The context block is already inside the prompt: `## Applicable lessons`, `## Project memory`,
`## Structural index` (explore only), `## Related jobs` and `## Job origin` (triager only); inside a
job the server excludes by itself the lessons already injected in earlier phases of this session.

Pass `prompt` to the launch verbatim with the answered `subagent_type` and `model` — never rewrite a line of it, never add one; relaunch context goes
in `note` only. Then gate the answered `artifact` with `nightqueue run check <check>`. Each
`open_items` line of the answer becomes an open item of Phase 9. `phase_prompt` refuses every target
but the triager until `run check 01` wrote `<RUN_DIR>/00-brief.md`.

### Phase 1 — Triage-Gate

It always runs (bug/error and feature/refactor): it turns the request into the Brief and
critiques it before exploration, architecture and implementation are spent.

Prompt: `phase_prompt` with `target: "triager"`; outside a job pass `request` = the user's
request verbatim (`references/interactive-worktree.md`). Inside a job the runtime reads the job's
own prompt.

Launch **1 triager**. It writes `01-triage.md`; run `nightqueue run check 01` (the artifact gate, step 6) and act on its answer.

**Gate:**

| `run check 01` answers | Action |
| --- | --- |
| `MISSING` / `GATE: symptom-proof-missing` / `GATE: brief-*` | relaunch the triager once with the line as `note`; still → terminate (⚠️ open item) |
| `VERDICT: PROCEED` | Phase 2 |
| `VERDICT: NO-CHANGE-NEEDED` | Phase 9 — its report records `run_outcome` with `status: "no_change"` (step 7); the job ends `done` with no pull request |
| `VERDICT: NOT-REPRODUCIBLE` | terminate; `## Open items` go to Phase 9 (the job ends `cancelled`) |
| `VERDICT: NEEDS-CLARIFICATION` | `run_outcome` with `status: "gate"` and `from_artifact: { file: "01-triage.md", section: "## Open items" }`, then end the turn |
| `VERDICT: PROPOSE-ALTERNATIVE` | the same action as `NEEDS-CLARIFICATION` |
| `recorded: slug … (renamed …; run dir <path>)` | use that path as `RUN_DIR` from here on |

A PROCEED that concludes the system behaves correctly, or rests the cause on a guess about data
the environment could confirm, is invalid: relaunch the triager with that as `note` — a run
proven to need no change is `NO-CHANGE-NEEDED`.

An `## Intent note` or `## Depth note` never blocks the advance.

**A Brief with numbered stages** (its `**Stages:**` field). Each stage is a unit of the run and
the order is binding: the Phase 3 plan is written per stage, Phase 4 implements stage by stage
with the verifier between stages, and the
report table and PR list the stages with their status. Stages never split the delivery:
still one branch and ONE pull request.

### Phase 2 — Exploration

Launch **1 explore agent**: `phase_prompt` with `target: "explore"`. The prompt already carries
the structural index earlier runs saved (`stale`/`missing` files marked REVALIDATE).

Run `nightqueue run check 02`
before proceeding. Phase 3 reads the findings from `02-explore.md`. The check saves the
structural index itself: `index: not saved (…)` → ⚠️ open item of Phase 9; it never blocks.

### Phase 3 — Architecture

Launch **1 architect agent**: `phase_prompt` with `target: "architect"` (plus
`delivery_constraints` when there is one, and `note` on a relaunch).

**Never inject the DESIGN into the architect's prompt** (fix level, where the solution goes, an
approach ruled out by diff size): the ONLY constraint is the delivery LIMIT, on the
`Delivery constraints:` line.

**Gate:** run `nightqueue run check 03` (the artifact gate, step 6).

| `run check 03` answers | Action |
| --- | --- |
| `MISSING` | relaunch the architect once (🔁, `note` = the lines); still → inform the user and terminate (⚠️ open item) |
| `GATE: coverage-*` | the same relaunch; still → ONE `run_outcome` for every line: `status: "gate"`, `from_artifact: { file: "03-plan.md", section: "## Requires user confirmation" }` (no `CONFIRM:` → `"## Symptom coverage"`), `question` = the `GATE:` lines verbatim + "answer the open decision or say what to adjust", then end the turn; never terminate |
| `GATE: usage-coverage-*` | the same relaunch, asking `## Requires user confirmation` or a quoted source per `changed=yes` line; still → `run_outcome` with `status: "gate"`, `from_artifact: { file: "03-plan.md", section: "## Usage coverage" }` and `question` = the `GATE:` lines verbatim, then end the turn |
| `TYPE-MISMATCH: … — triage: bug/error …` together with `CONFIRM:` | ONE `run_outcome` with `status: "gate"`, `from_artifact: { file: "03-plan.md", section: "## Requires user confirmation" }` and `question` = "Is this a bug or a feature/refactor? <the TYPE-MISMATCH evidence>", then end the turn |
| `TYPE-MISMATCH: … — triage: feature/refactor …` (the Type divergence valve) | `run_set` with `type: "feature/refactor"`, then Phase 4 |
| `TYPE-MISMATCH: … — triage: bug/error …` | the pause of the row with `CONFIRM:`, without `from_artifact` |
| `CONFIRM: requires-user-confirmation` (the Confirmation pause) | `run_outcome` with `status: "gate"` and `from_artifact: { file: "03-plan.md", section: "## Requires user confirmation" }`, then end the turn |
| plain `OK` | Phase 4 |

Never terminate over a Type divergence. An insufficient brief → inform the user and terminate.
The user's answer to a pause arrives as a retry and applies on the resumed run before Phase 4:
approved → Phase 4 with the architect's plan; adjustments → relaunch the architect (🔁) with the
decision as `note`; the literal reading → relaunch it (🔁) instructing the literal plan; a Type
answer → `run_set` with that `type`, then Phase 4 (`feature/refactor`) or relaunch the architect
(🔁, `bug/error`). Never write code before that confirmation. A coverage pause's answer resumes
here: `run check 03` first, then relaunch the architect once (🔁, `note` = answer + lines) and
`run check 03`; the same `GATE:` lines → terminate (⚠️ open item), never pause twice on them
(same gate code); else → its row, relaunch spent.

### Phase 4 — Implementation

Launch 1 coder agent: `phase_prompt` with `target: "coder"` (plus `stage` in a staged plan).

Run `nightqueue run check 04` (the artifact gate, step 6); `GENERATED` → accept and move on.
`MISSING: ## Modified files (no changed files)` means the worktree changed nothing: inform the
user that the implementation did not complete successfully and terminate.

**One coder lane per stage:** a brief/plan with numbered stages launches one coder per stage,
in order, never in parallel, each with its `stage` in `phase_prompt`.
Run `nightqueue run check 04` after each lane, then the verifier between stages (the Phase 6
prompt and its fix loop): a failing stage is fixed before the next lane starts. After the last
stage, Phase 5 (QA) and the final Phase 6 verification run as usual.

**Parallel coders (batches):** concurrent batches run each in its own isolated worktree — never
two coders in one tree, and no `git stash`/`checkout`/`reset` while a batch is active.

### Phase 5 — Adversarial QA (attack)

**Mode:** read the `QA: lite|full` line of the last `nightqueue run check 03` answer (run the
check again on a resume): `lite` → one qa-guardian with `qa-lite`; `full` → Stage A analyst then
N provers, then `run check 05` consolidates. Nothing else decides the mode.

The QA is **adversarial and fixes nothing**; the fixes happen in the Phase 6 loop.

A `03-plan.md` without `## Identified risks` → terminate and inform the user.

Read `references/qa-phase.md` before launching any qa-guardian: it carries the Stage A gate and
the consolidation. The prompts come from `phase_prompt` (`qa-lite`, `qa-analyst`, `qa-prover`
with its `group`).

**Gate:** `nightqueue run check 05` audits the symptom and usage coverage of the last round
against `03-plan.md` itself.

| `run check 05` answers | Action |
| --- | --- |
| `GATE: …` | relaunch the QA once (🔁, `note` = the `GATE:` lines; in `full` from the analyst); still, with a non-usage GATE → terminate per step 6 (⚠️ open item) |
| only `GATE: usage-coverage-*`, after that relaunch | `run_outcome` with `status: "gate"`, `from_artifact: { file: "05-qa.md", section: "## Validated risks" }` and `question` = the `VERDICT:`/`GATE:`/`OPEN:` lines verbatim + "approve the QA or say what to adjust", then end the turn; never terminate |
| `OPEN: …` | ⚠️ mandatory open item of Phase 9; the verdict is unchanged |
| `INVALIDATED: …` | relaunch the **architect** once (🔁, `note` = the lines), then Phase 4 with the revised plan; a second one → `run_outcome` with `status: "gate"`, `from_artifact: { file: "05-qa.md", section: "## Validated risks" }` and `question` = the `INVALIDATED:` lines verbatim + `## Modified files` of `04-implementation.md` + the last `VERDICT:` + "(a) one more architect round with your note, (b) ship as is, (c) terminate", then end the turn; never terminate |
| `VERDICT: APPROVED` | Phase 6, with the PoCs as a regression net |
| `VERDICT: NEEDS FIX` | Phase 6: `## Proven breaks` go to the coder, `## Generated PoCs` to the verifier to confirm the fix |
| `VERDICT: NEEDS DISCUSSION` | ⚠️ mandatory open item of Phase 9, then Phase 6 |

That pause's answer resumes Phase 5: `run check 05` first, a pure read. Approved → the same
`usage-coverage-*` `GATE:` lines it prints are answered: act on the `VERDICT:` row, those lines a
⚠️ open item — never a second relaunch, pause or terminate. Adjustments → relaunch the QA once
(🔁, `note` = the answer); only there a usage-only gate pauses again. The INVALIDATED pause's
answer follows `references/resume.md`; never pause twice on the same lines.

### Phase 6 — Verification (final gate + correction loop)

Launch 1 verifier agent: `phase_prompt` with `target: "verifier"` (plus `stage` between the
stages of a staged plan).

The verifier runs **after** the QA, independently: it **reproduces** the QA's proven breaks. Neither the QA nor the coder validates its own work.

**Gate and fix loop:** run `nightqueue run check 06` (the artifact gate, step 6).

| `run check 06` answers | Action |
| --- | --- |
| `VERDICT: PASSED` | Phase 8 (Phase 7 first unless the change is purely static) |
| `VERDICT: PASSED-STATIC` | checks ok, but the bug's runtime path did not execute — never PASSED: run Phase 7 on the bug's exact flow before Phase 8; Phase 7 not viable (no environment) → the user decides on committing without real execution — never decide alone nor present it as verified |
| `VERDICT: FAILED` | a project check OR a QA PoC failing: relaunch the coder (`coder-fix`) passing the verifier's failures + the QA's `## Proven breaks` still open + the validated brief, then relaunch the verifier |

- **Maximum of iterations**: **max 2 fix iterations**.
  If it still fails after the limit, **do not mask it**: skip Phase 8 (no PR),
  go to Phase 9 and report the remaining failures/breaks to the user.

Prompt of the coder in the fix: `phase_prompt` with `target: "coder-fix"` and `note` = what the
relaunch is about (the iteration and its failures, in one line). After the coder returns, run
`nightqueue run check 04` before relaunching the verifier.

### Phase 7 — Runtime validation (real execution)

> A purely static change (typo, config, rename, types, pure logic already covered by a test) → does not execute: the
> Phase 6 checks are enough.

Runs when the change (fix OR feature) is **observable at runtime**
(UI/screen/flow/integration): passing tsc/lint proves neither the fix nor the feature — only
executing does.

Launch **1 verifier agent**: `phase_prompt` with `target: "runtime"`.

Run `nightqueue run check 07` (the artifact gate, step 6). Only move on to Phase 8 with the
change confirmed at runtime; a field position/value or a control-flow merely ASSUMED does not pass.

| `run check 07` answers | Action |
| --- | --- |
| `VERDICT: CONFIRMED` | Phase 8 |
| `VERDICT: NOT-MET` or `GATE: runtime-not-met` | the Phase 6 coder loop (same limit) |
| `VERDICT: SYMPTOM-PERSISTS` + `DIFF-APPLIES: no` | the Phase 6 coder loop |
| `VERDICT: SYMPTOM-PERSISTS` + `DIFF-APPLIES: yes` | re-triage (below) |
| `GATE: runtime-no-attempt` | relaunch the runtime lane once (🔁) — the attempt is the lane's, never the coder's |
| `OPEN: <scenario> — to confirm` | ⚠️ on the 7 Runtime line (it forces the non-happy path of Phase 9) + mandatory open item; never back to the coder, never blocks Phase 8 |
| `NEEDS-DEVICE` | `run_outcome` with `status: "gate"` and `from_artifact: { file: "07-runtime.md", section: "## Runtime verdict" }` (the device script verbatim), then end the turn; the retry answer: a positive device verdict → Phase 8, a negative one → the Phase 6 coder loop |
| `VERDICT: UNAVAILABLE` | ⚠️ open item |

**Symptom persisting with the plan applied → the CAUSE is wrong (bug).** Relaunch the
**triager** (🔁) with the original diagnosis, the applied diff and the evidence of the live
symptom, instructing: "the diagnosis is incomplete; look for the underestimated path (order of gates,
preceding branch, race, data source)". Then Phase 3 → 4 → 6 → 7. **At most 1 re-triage per
pipeline** — if it persists again, terminate (no PR) and take the history to the user (Phase 9).

Case (a) needs its 2 proofs, case (b) its screenshot, case (c) the user's verdict, and cases
(d)/(d2) every line `MET` or `NOT MET / to confirm`.

### Phase 8 — Commit and PR

Only when Phase 6 returned `## Verification: PASSED` **and** Phase 7 (when applicable) confirmed
the change at runtime; otherwise no PR — go straight to Phase 9. Read
`references/phase-8.md` now and follow it (inside a job, never ask before pushing).

### Phase 9 — Report

Read `references/phase-9.md` now and follow it; it opens with `nightqueue run report`.

### Phase 10 — Reflect (every run that reaches Phase 9)

It runs ONCE per attempt, after `nightqueue run report` (which records the run, so the run
timeline has this attempt's rows), and BEFORE the final text. It runs on a delivered run, a
`no_commit` run and a terminated run (`run_terminate`, a `gate_stop`, an artifact `MISSING`, the
loop limits). It does NOT run at a gate pause (Phase 1, the Confirmation pause, the coverage gate
of Phase 3, the usage-coverage gate of Phase 3 or 5, NEEDS-DEVICE): the resumed run reflects at
its end.

Launch: `phase_prompt` with `target: "reflector"`.

There is no artifact, no `nightqueue run check` and no `run_phase_done` for this phase; the
reflector saves the run's lessons and memories itself.

**Report line:** from the reflector's return, ONE line: `🪞 Reflection: L<id>, M<id>, …` with
every ref it returned, or `🪞 Reflection: none` when it saved nothing. If `phase_prompt` or the
launch failed: `🪞 Reflection: not run — <reason>` - it is never retried and never blocks. The line sits
after the `run report` output and the 🎯 Objective block, ABOVE `## Notice`: `## Notice` stays
the LAST section of the final text. The line does not count towards the ~30-line cap, never
enters the Notice, and never turns a run `Happy`.
