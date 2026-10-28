# Run resume

A ``RESUME CANDIDATE (slug `<slug>`)`` block: this run continues one the runtime read from
`state.json`; trust it, re-validate nothing BEFORE re-interpreting the task.

- Take every field from the block: `RUN_DIR:` is this run's dir (never derived), `Branch:` and
  `Worktree:` the ones to reuse (Phase 0 step 4); execution STARTS at `Resume from phase:`.
  `none` → nothing to reuse.
- Skip every phase up to `Last completed phase:`, reading its artifact in `RUN_DIR` — never redo one.
- **`From stage: qa-stage-b`** → Phase 5 re-enters at **Stage B**: read the analyst's last
  `## Round` (with `## Break hypotheses`) of `<RUN_DIR>/05-qa.md`, launch the provers, then
  `run check 05`, never the analyst. Any other value → the whole of Phase 5.
- **Exception, an OPERATOR ANSWER resuming at `qa`:** `run check 05` first, whatever
  `From stage:` says; only `usage-coverage-*` `GATE:` lines → they are answered (SKILL.md
  Phase 5): never a second relaunch, pause or terminate. `INVALIDATED:` lines → by the answer:
  (a) changes → relaunch the architect once (🔁, `note` = answer + lines), then Phases 4-5, a
  further `INVALIDATED:` terminating; (b) ship as is → the `VERDICT:` row, the lines ⚠️ open
  items; (c) terminate → `run_terminate` (`qa`, the reason). Else (a). Never pause twice on them.
- **Read-fail fallback:** a declared-completed artifact missing or unreadable → ignore the
  block, **start clean** from Phase 0.
- **`Re-run: <phase> — <reason>`** → run that phase (the runtime refused to skip it); each line
  verbatim → open item of Phase 9 and the notice.
- `RESTORED WIP:` → the previous attempt's work is back uncommitted: keep it.
- Safety: a resume follows only a retry of a TERMINAL job or the first claim of an
  operator-queued job — NEVER reuse a running job's worktree.
