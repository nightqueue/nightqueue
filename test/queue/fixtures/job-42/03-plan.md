# 03 — Plan: decisions as an ADR log

## Requires user confirmation

**Answered by the operator (2026-09-18). No question is open.**

- **C1–C4, C6, C8:** approved as proposed. Their content is built into the plan below:
  - C1: `supersedes`/`unrelated` carry decision numbers.
  - C2: the hook's 8 detail entries stay clipped at 200.
  - C3: the acceptance uses the full title.
  - C4: a queue job never passes `supersedes`.
  - C6: the MCP `queue_close` does not settle proposals.
  - C8: a second proposal is refused only while the first is still `proposed`.
- **C5:** the import default stays as proposed: status comes from the file. The Stage 4 operator runbook runs 0006 with `--status accepted` unconditionally. Reason: 0006 is in execution (roadmap S1–S3) and must bind jobs.
- **C7:** the lexical side stays title against title. The semantic side embeds the new decision's title + decision text, using the same composition that builds the stored vectors, and compares it against the stored title+decision vectors at `RECALL_COS_CUT` 0.55. A duplicate with a different title but the same rule must be caught.

Intent note: none in the brief. Depth note: none (feature).

Measured on the real rows (evidence level 3). Method: a `sqlite3 -readonly … ".backup"` copy of `~/.nightqueue/nightqueue.db` plus `config.json`, placed in a throw-away `tmp/scratch-home` inside the worktree and deleted afterwards. Nothing was written to the operator's home (decision #7). The measurement scripts are the source of the lexical numbers in Stage 2. The semantic measurement used title-only embedding and was NOT redone for title+decision: this revision may not touch `~/.nightqueue`. There are 24 `nightqueue` rows that are `accepted` or `proposed`. Number → id: #8 → 8, #9 → 19, #10 → 20, #12 → 22, #23 → 35.

---

## Implementation plan

Paths are absolute under `R = ~/nightqueue/.claude/worktrees/feat+decisions-adr-log`. Each stage ends green on its own.
