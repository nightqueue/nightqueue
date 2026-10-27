# Run resume

If the job context brought a block ``RESUME CANDIDATE (slug `<slug>`)``, this run continues a
previous one the runtime already read from `state.json`: trust the block and re-validate nothing
BEFORE re-interpreting the task.

- Take every field from the block itself: `RUN_DIR:` is the run dir of this run (as it
  comes, never derived), `Branch:` and `Worktree:` are the ones to reuse (a queued job is
  already in them; an interactive `/resolve` reuses them per `references/interactive-worktree.md`),
  and execution STARTS at the phase in `Resume from phase:`. A `none` field has nothing to reuse.
- Skip every phase up to `Last completed phase:` and read its artifact in `RUN_DIR` — do NOT re-triage, do NOT re-explore, do NOT re-architect.
- **`From stage: qa-stage-b`** → Phase 5 re-enters at **Stage B (provers)**: read the
  analyst's round of `<RUN_DIR>/05-qa.md` (its last `## Round` with `## Break hypotheses`) and
  launch Stage B, then `run check 05`, never the analyst. Any other value → the whole of Phase 5, from Stage A.
- **Exception, an OPERATOR ANSWER resuming at `qa`:** `run check 05` first, whatever
  `From stage:` says; only `usage-coverage-*` `GATE:` lines → they are answered (SKILL.md
  Phase 5): never a second relaunch, pause or terminate.
- **Read-fail fallback:** a declared-completed phase's artifact missing or
  unreadable → ignore the block and **start clean** from Phase 0.
- **`Re-run: <phase> — <reason>` lines** → run that phase (the runtime refused to skip it) and
  carry each line verbatim into Phase 9 as an open item and into the notice.
- Safety invariant: the resume only happens on a retry of a TERMINAL job
  (gate/failed/budget) or the first claim of a job queued from an operator run (no
  worktree to reuse) — NEVER reuse the worktree of a job that is still running.
