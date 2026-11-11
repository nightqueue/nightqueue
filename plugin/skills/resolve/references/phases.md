# The phases of /resolve — `NEXT:` and the records

Read by the orchestrator right after its first subagent returns (on a resume, before deciding):
what the `NEXT:` line of `run check` asks. The launches are the steps of `## Phase prompts` of
`SKILL.md`; the phases are numbered as the report rows: 1 triage, 2 explore, 3 plan, 4 coder,
5 QA, 6 verification, 7 runtime, 8 commit and PR, 9 report, 10 reflect.

### Phase 0 — The check and the records

6. **The check.** After every lane that writes, run `nightqueue run check <NN>`. Its first line is
   `OK`, `MISSING: <what>` or `GENERATED` (only `04`: the file list was derived from the
   worktree's own changes). Its last line is `NEXT: <action>`. Do what it says, whatever the
   other lines seem to ask:
   - `launch <target> [stage=<n>] [note=<text>]` → that step, with `STAGE:` and `NOTE:` from them
     (add what the note needs; `note` is your judgment, the route is not);
   - `gate <question>` → the Phase 3 pause;
   - `terminate <reason>` → terminate (step 7) with that reason, ⚠️ open item, then Phase 9;
   - `publish [--draft] [remaining=<text>]` → Phase 8, `--draft` as given, each remaining failure on
     a `Remaining failure:` line;
   - `report` → Phase 9, which records `run_outcome` with `status: "no_change"` (step 7); the job
     ends `done` with no pull request;
   - `check <NN>` → run that check and read its `NEXT:`.
   - `recorded: not recorded (…)` and `index: not saved (…)` → ⚠️ open items, never blocking.
   - `recorded: slug … (renamed …; run dir <path>)` → that path is `RUN_DIR` from here on.
   - The subagent's return never replaces the artifact; confirm an artifact with the check, never
     with `ls` or Read: a `<RUN_DIR>` file is never read here. Each line of a return's `## Open`
     other than `none` becomes an open item of Phase 9.

7. **Records.** `<RUN_DIR>/state.json` is the runtime's: never write it.
   - `run check` records each phase and `run publish` the delivery.
   - `run_set` only when a field changes afterwards.
   - `run_outcome` at its three points: the Phase 3 pause; the Phase 9 report of a
     `NO-CHANGE-NEEDED` run (`status: "no_change"`); and Phase 8's delivery, which `run publish`
     records itself.
   - Terminate (only when `NEXT:` says so) = `run_terminate` (phase, reason): the runtime commits the changes as
     `wip(<slug>): terminated at <phase> — <reason>` and answers a `notice` for Phase 9; never commit by hand.
   - Tolerant: a failing `run_*` call is an open item of Phase 9, never an abort.

### Phase 3 — The pause

Never put the design in the architect's launch: its only constraint is the `DELIVERY:` limit.

- `NEXT: gate <question>` → the one pause: `run_outcome` with `status: "gate"` and `from_artifact: { file: "03-plan.md", section: "## Requires user confirmation" }`, then end the turn with one plain line.

**The answer** arrives as a retry, the last entry of `Answers:` in `RUN FACTS` (a job with no run
directory yet: the `OPERATOR ANSWER TO THE GATE:` line); an interactive run's chat answer counts
as `CONFIRM: answered`. Run `run check 03` first, whatever the block says. Go-ahead or the
recommended option → its `NEXT:`. Any other answer → relaunch the architect once (🔁, `note` =
the answer), then `run check 03` again: a NEW question is a new pause. Never write code before
the answer.

### Phase 8 — Commit and PR

Read `references/phase-8.md` now and follow it (inside a job, never ask before pushing).

### Phase 9 — Report

Read `references/phase-9.md` now and follow it; it opens with `nightqueue run report`.

### Phase 10 — Reflect

Once per attempt, after `run report` and BEFORE the final text, also on a terminated run; never
at the Phase 3 pause. No artifact and no `run check`. **Report line:** from the reflector's return,
ONE line `🪞 Reflection: L<id>, M<id>, …` with every ref, or `🪞 Reflection: none`; a failed
launch → `🪞 Reflection: not run — <reason>`, never retried. The line sits above `## Notice`,
which stays the LAST section of the final text, and never turns a run `Happy`.
