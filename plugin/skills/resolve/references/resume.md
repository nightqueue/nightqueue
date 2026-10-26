# Run resume

If the job context brought a block ``RESUME CANDIDATE (slug `<slug>`)``, this run continues a
previous one: the runtime already read `state.json` and decided it, so trust the block
and re-validate nothing BEFORE re-interpreting the task.

- Take every field from the block itself: `RUN_DIR:` is the run dir of this run (use it
  as it comes, do not derive another), `Branch:` and `Worktree:` are the ones to reuse
  (in a queued job the runtime already reused or recreated them and you are in it; an
  interactive `/resolve` reuses them per `references/interactive-worktree.md`), and execution
  STARTS at the phase in `Resume from phase:`. A field worth `none` means there is nothing to reuse there.
- Skip every phase up to `Last completed phase:` and read its artifact in `RUN_DIR` via
  Read — do NOT re-triage, do NOT re-explore, do NOT re-architect.
- **`From stage: qa-stage-b`** → Phase 5 re-enters straight at **Stage B (provers)**:
  read the analyst's round of `<RUN_DIR>/05-qa.md` (its last `## Round` carrying `## Break hypotheses`)
  via Read and launch Stage B, then `run check 05`, without relaunching the analyst. Any other value → run the whole of Phase 5, from Stage A.
- **Read-fail fallback (fail-safe):** an artifact of a phase the block declares completed
  that is missing or unreadable via Read → ignore the block and **start clean** from Phase 0.
- **`Re-run: <phase> — <reason>` lines** → the runtime refused to skip that phase of an
  operator run: run it, never skip it, and carry each line verbatim into Phase 9 as an
  open item and into the notice.
- Safety invariant: the resume only happens on a retry of a job in a TERMINAL status
  (gate/failed/budget), or the first claim of a job queued from an operator run (no
  worktree to reuse) — NEVER reuse the worktree of a job that is still running.
