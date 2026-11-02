# The phases of /resolve — gates and rules

Read by the orchestrator right after its first subagent returns (on a resume, before deciding):
what each `run check` answer means and what comes next. The launches are the blocks of
`## Phase prompts` of `SKILL.md`.

### Phase 0 — The gate and the records

6. **Artifact gate.** After every phase that writes, run `nightqueue run check <NN>`. Its first
   line is `OK`, `MISSING: <sections>` or `GENERATED` (only `04`: the file list was derived
   from the worktree's own changes).
   Then come stable-prefix lines that each phase's table maps to the next action: `REPAIRED:`,
   `VERDICT:`, `GATE:`, `OPEN:`, `TYPE-MISMATCH:`, `CONFIRM:`, `QA-MODE:`, `QA-STAGE:`,
   `INVALIDATED:`, `DIFF-APPLIES:`, `NEEDS-DEVICE`, `index:`, `recorded:`, `SCRIPT:`.
   - `MISSING` → relaunch the subagent once with the `MISSING:`/`REPAIRED:` lines as `note`; still
     `MISSING` → before Phase 4, its phase's row; from Phase 4 on, proceed with what the artifact
     has (⚠️ open item of Phase 9).
   - `recorded: not recorded (…)` and `index: not saved (…)` → ⚠️ open items, never blocking.
   - The subagent's return never replaces the artifact; confirm an artifact with the check, never
     with `ls` or Read: a `<RUN_DIR>` file is never read here. Each line of
     a return's `## Open` other than `none` becomes an open item of Phase 9.

7. **Records.** `<RUN_DIR>/state.json` is the runtime's: never write it.
   - `run check` records each phase and `run publish` the delivery.
   - `run_set` only when a field changes afterwards (the Phase 3 Type valve).
   - `run_outcome` at its three points: the Phase 3 pause (its table); the Phase 9 report of a
     `NO-CHANGE-NEEDED` run (`status: "no_change"`); and Phase 8's delivery, which `run publish`
     records itself.
   - Terminate (only the rows of Phases 1, 3 and 4 say so) = `run_terminate` (phase, reason): the runtime commits the changes as
     `wip(<slug>): terminated at <phase> — <reason>` and answers a `notice` for Phase 9; never commit by hand.
   - Tolerant: a failing `run_*` call is an open item of Phase 9, never an abort.

---

### Phase 1 — Triage-Gate

It always runs (bug/error and feature/refactor): it turns the request into the Brief and
critiques it before exploration, architecture and implementation are spent.

Launch **1 triager**: the `triager` block. It reads the request from `<RUN_DIR>/00-prompt.md`,
which `run start` writes inside a job (outside one, `references/interactive-worktree.md`). It writes
`01-triage.md`; run `nightqueue run check 01` (the artifact gate, step 6) and act on its answer.

**Gate:**

| `run check 01` answers | Action |
| --- | --- |
| `MISSING` / `GATE: symptom-proof-missing` / `GATE: brief-*` | relaunch the triager once with the line as `note`; still → terminate (⚠️ open item) |
| `VERDICT: PROCEED` | Phase 2 |
| `VERDICT: NO-CHANGE-NEEDED` | Phase 9 — its report records `run_outcome` with `status: "no_change"` (step 7); the job ends `done` with no pull request |
| `VERDICT: NOT-REPRODUCIBLE` | terminate; `## Open items` go to Phase 9 (the job ends `cancelled`) |
| `recorded: slug … (renamed …; run dir <path>)` | use that path as `RUN_DIR` from here on |

A re-triage from Phase 7 follows Phase 7's rule, never these terminations.

A PROCEED that concludes the system behaves correctly, or rests the cause on a guess about data
the environment could confirm, is invalid: relaunch the triager with that as `note` — a run
proven to need no change is `NO-CHANGE-NEEDED`.

An `## Intent note` or `## Depth note` never blocks the advance.

**A Brief with numbered stages** (its `**Stages:**` field, a `Stages:` line of the triager's return, `stages` of `run start` on a resume). Each stage is a unit of the run and
the order is binding: the Phase 3 plan is written per stage, Phase 4 implements stage by stage
with the verifier between stages, and the
report table and PR list the stages with their status. Stages never split the delivery:
still one branch and ONE pull request.

### Phase 2 — Exploration

Launch **1 explore agent**: the `explore` block.

Run `nightqueue run check 02`
before proceeding. Phase 3 reads the findings from `02-explore.md`. The check saves the
structural index itself: `index: not saved (…)` → ⚠️ open item of Phase 9; it never blocks.
A persisting `MISSING` → Phase 3, ⚠️ open item.

### Phase 3 — Architecture

Launch **1 architect agent**: the `architect` block (`DELIVERY:` when there is a limit, `NOTE:`
on a relaunch).

**Never inject the DESIGN into the architect's prompt** (fix level, where the solution goes, an
approach ruled out by diff size): the ONLY constraint is the delivery LIMIT, on the
`DELIVERY:` line.

**Gate:** run `nightqueue run check 03` (the artifact gate, step 6). Act on every line, `CONFIRM:` last.

| `run check 03` answers | Action |
| --- | --- |
| `MISSING` | relaunch the architect once (🔁, `note` = the lines); still → terminate (⚠️ open item); on a re-triage from Phase 7 → Phase 8 with `--draft` |
| `OPEN: …` | ⚠️ open item of Phase 9 |
| `TYPE-MISMATCH: … — triage: feature/refactor …` (the Type divergence valve) | `run_set` with `type: "feature/refactor"`, then Phase 4 |
| `TYPE-MISMATCH: … — triage: bug/error …` | stays bug/error, Phase 4 (the check already prints the `OPEN:`) |
| `CONFIRM: requires-user-confirmation` | the one pause: `run_outcome` with `status: "gate"` and `from_artifact: { file: "03-plan.md", section: "## Requires user confirmation" }`, then end the turn with one plain line |
| `CONFIRM: answered (<at>)` | the answer below, then Phase 4 |
| plain `OK` | Phase 4 |

**The answer** arrives as a retry, the last entry of `Answers:` in `RUN FACTS` (a job with no run
directory yet: the `OPERATOR ANSWER TO THE GATE:` line); an interactive run's chat answer counts
as `CONFIRM: answered`. The pause completed the phase, so the block may list it: run `run check 03`
first, before Phase 4, whatever the block says. Go-ahead or the recommended option → Phase 4. Any
other answer → relaunch the architect once (🔁, `note` = the answer), then `run check 03` again: a
NEW question is a new pause. Never write code before the answer.

### Phase 4 — Implementation

Launch 1 coder agent: the `coder` block (`STAGE:` in a staged plan).

Run `nightqueue run check 04` (the artifact gate, step 6); `GENERATED` → accept and move on.
`MISSING: ## Modified files (no changed files)` means the worktree changed nothing: inform the
user that the implementation did not complete successfully and terminate.

**One coder lane per stage:** a brief/plan with numbered stages launches one coder per stage,
in order, never in parallel, each with its `STAGE:` in the block.
Run `nightqueue run check 04` after each lane, then the verifier between stages (the Phase 6
block and its fix loop): a failing stage is fixed before the next lane starts; at the loop's limit
its failures are a ⚠️ open item and the next lane starts. After the last stage, Phase 5 (QA) and
the final Phase 6 verification run as usual, and that verification alone decides the draft.

**Parallel coders (batches):** concurrent batches run each in its own isolated worktree — never
two coders in one tree, and no `git stash`/`checkout`/`reset` while a batch is active.

### Phase 5 — Adversarial QA (attack)

**Triage first:** 1 qa-guardian with the `qa-triage` block, then `nightqueue run check 05 --stage triage`. On a resume at Phase 5 run the check first (a pure read); launch the lane only on its `MISSING`.

| `run check 05 --stage triage` answers | Action |
| --- | --- |
| `QA-MODE: skip — <why>` | recorded by the check; Phase 6, no attack lane |
| `QA-MODE: lite — <why>` | one qa-guardian with `qa-lite` |
| `QA-MODE: full — <why>` | Stage A analyst then N provers, then `run check 05` consolidates |
| `MISSING` | relaunch once (`note` = the lines); still → `lite`, ⚠️ open item |

The `QA-MODE:` line decides, and nothing else.

The QA is **adversarial and fixes nothing**; the fixes happen in the Phase 6 loop.

Read `references/qa-phase.md` before launching any qa-guardian: it carries the Stage A gate and
the consolidation. The blocks are `qa-triage`, `qa-lite`, `qa-analyst` and `qa-prover` with its
`GROUP:`.

**Gate of `lite` and `full`:** `nightqueue run check 05` reads the last round of `05-qa.md`.

| `run check 05` answers | Action |
| --- | --- |
| `MISSING` still (Stage A likewise) | Phase 6, ⚠️ open item |
| `OPEN: …` | ⚠️ mandatory open item of Phase 9; the verdict is unchanged |
| `INVALIDATED: …`, the first | relaunch the **architect** once (🔁, `note` = the lines), then Phase 4 with the revised plan |
| `INVALIDATED: …`, a second on the same assumption or any after two architect rounds | relaunch the architect to record it in `## Decisions taken`, then the `VERDICT:` row, ⚠️ open item |
| `VERDICT: APPROVED` | Phase 6, with the PoCs as a regression net |
| `VERDICT: NEEDS FIX` | Phase 6: `## Proven breaks` go to the coder, `## Generated PoCs` to the verifier to confirm the fix |
| `VERDICT: NEEDS DISCUSSION` | ⚠️ mandatory open item of Phase 9, then Phase 6 |

### Phase 6 — Verification (final gate + correction loop)

Launch 1 verifier agent: the `verifier` block (`STAGE:` between the stages of a staged plan).

The verifier runs **after** the QA, independently: it **reproduces** the QA's proven breaks. Neither the QA nor the coder validates its own work.

**Gate and fix loop:** run `nightqueue run check 06` (the artifact gate, step 6).

| `run check 06` answers | Action |
| --- | --- |
| `VERDICT: PASSED` | Phase 8 (Phase 7 first unless the change is purely static) |
| `VERDICT: PASSED-STATIC` | checks ok, but the bug's runtime path did not execute — never PASSED: run Phase 7 on the bug's exact flow before Phase 8; Phase 7 not viable (no environment) → Phase 8, `Not tested:` in the body, ⚠️ open item — never present it as verified |
| `VERDICT: FAILED` | a project check OR a QA PoC failing: relaunch the coder (`coder-fix`) passing the verifier's failures + the QA's `## Proven breaks` still open + the validated brief, then relaunch the verifier |
| `MISSING` still | Phase 8 with `--draft`, `Remaining failure: verification produced no verdict` |

- **Maximum of iterations**: **max 2 fix iterations**.
  If it still fails after the limit, **do not mask it**: Phase 8 with `--draft`, one
  `Remaining failure: <what>` line per failure or break still open.

Prompt of the coder in the fix: the `coder-fix` block with `NOTE:` = what the
relaunch is about (the iteration and its failures, in one line). After the coder returns, run
`nightqueue run check 04` before relaunching the verifier.

### Phase 7 — Runtime validation (real execution)

> A purely static change (typo, config, rename, types, pure logic already covered by a test) → does not execute: the
> Phase 6 checks are enough.

Runs when the change (fix OR feature) is **observable at runtime**
(UI/screen/flow/integration): passing tsc/lint proves neither the fix nor the feature — only
executing does.

Launch **1 verifier agent**: the `runtime` block.

Run `nightqueue run check 07` (the artifact gate, step 6). A field position/value or a control-flow
merely ASSUMED is never confirmed.

| `run check 07` answers | Action |
| --- | --- |
| `VERDICT: CONFIRMED` | Phase 8 |
| `VERDICT: NOT-MET` or `GATE: runtime-not-met` | the Phase 6 coder loop (same limit, `--draft` at it) |
| `VERDICT: SYMPTOM-PERSISTS` + `DIFF-APPLIES: no` | the Phase 6 coder loop |
| `VERDICT: SYMPTOM-PERSISTS` + `DIFF-APPLIES: yes` | re-triage (below) |
| `GATE: runtime-no-attempt` | relaunch the runtime lane once (🔁) — the attempt is the lane's, never the coder's; still → Phase 8, `Not tested:` in the body, ⚠️ open item |
| `OPEN: <scenario> — to confirm` | ⚠️ on the 7 Runtime line (it forces the non-happy path of Phase 9) + mandatory open item; never back to the coder, never blocks Phase 8 |
| `NEEDS-DEVICE` | Phase 8, the device script verbatim in the body, `Not tested:`, ⚠️ open item |
| `VERDICT: UNAVAILABLE` | Phase 8, `Not tested:` in the body, ⚠️ open item |

**Symptom persisting with the plan applied → the CAUSE is wrong (bug).** Relaunch the
**triager** (🔁) with the original diagnosis, the applied diff and the evidence of the live
symptom, instructing: "the diagnosis is incomplete; look for the underestimated path (order of gates,
preceding branch, race, data source)". Then Phase 3 → 4 → 6 → 7. **At most 1 re-triage per
pipeline** — if the symptom persists again, the re-triage answers anything but `VERDICT: PROCEED`
or stays `MISSING`: Phase 8 with `--draft`, the history on `Remaining failure:` lines.

Case (a) needs its 2 proofs, case (b) its screenshot, case (c) its device script, and cases
(d)/(d2) every line `MET` or `NOT MET / to confirm`.

### Phase 8 — Commit and PR

With `## Verification: PASSED` and Phase 7 (when applicable) confirmed or `Not tested:`; a limit
of Phase 6 or 7 comes with `--draft`. Read
`references/phase-8.md` now and follow it (inside a job, never ask before pushing).

### Phase 9 — Report

Read `references/phase-9.md` now and follow it; it opens with `nightqueue run report`.

### Phase 10 — Reflect (every run that reaches Phase 9)

It runs ONCE per attempt, after `nightqueue run report` (which records the run, so the run
timeline has this attempt's rows), and BEFORE the final text. It runs on a delivered run, a
`no_commit` run and a terminated run (a `gate_stop`, an artifact `MISSING`). It does not run at
the Phase 3 pause: the resumed run reflects at its end.

Launch: the `reflector` block.

There is no artifact, no `nightqueue run check` and no `run_phase_done` for this phase; the
reflector saves the run's lessons and memories itself.

**Report line:** from the reflector's return, ONE line: `🪞 Reflection: L<id>, M<id>, …` with
every ref it returned, or `🪞 Reflection: none` when it saved nothing. If the
launch failed: `🪞 Reflection: not run — <reason>` - it is never retried and never blocks. The line sits
after the `run report` output and the 🎯 Objective block, ABOVE `## Notice`: `## Notice` stays
the LAST section of the final text. The line does not count towards the ~30-line cap, never
enters the Notice, and never turns a run `Happy`.
