# Run resume

A ``RESUME CANDIDATE (slug `<slug>`)`` block: this run continues one the runtime read from
`state.json`; follow it BEFORE re-interpreting the task.

- **Trust the block**, re-validate nothing. `RUN_DIR:` is this run's dir (never derived).
  `Branch:` and `Worktree:` are the ones to reuse (Phase 0 step 4); `none` → nothing to reuse.
  Execution starts at `Resume from phase:`; at `implementation` with an
  `OPERATOR ANSWER TO THE GATE:` line, run Phase 3's answer rule first. `From stage: qa-stage-b`
  → Phase 5 at **Stage B**: read the analyst's last `## Round` (with `## Break hypotheses`) of
  `<RUN_DIR>/05-qa.md`, launch the provers, then `run check 05`, never the analyst; any other
  value → the whole of Phase 5, whose first step on a resume is `run check 05 --stage triage`. `Re-run: <phase> — <reason>` → run that phase, each line verbatim
  an open item of Phase 9 and the notice.
- **Never redo a completed phase:** skip every phase up to `Last completed phase:`, reading its
  artifact in `RUN_DIR`. A declared artifact missing or unreadable → ignore the block, start clean
  from Phase 0.
- **Run `git status --short` first.** A `wip(<slug>)` commit on the branch is the previous attempt's
  work: start on it, never reset or rewrite it; `run publish` folds it into the delivery commit.
