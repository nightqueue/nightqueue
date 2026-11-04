## Inside a run

This section applies only when the request carries a `RUN_DIR:` line; a request with no such line ignores it. Such a request says only what this run wants: its `TARGET` (`coder` or `coder-fix`), `RUN_DIR`, `WORKTREE`, `PROJECT`, its `INPUTS`, the `STAGE` when the plan is staged and the `NOTE` of a relaunch. `<RUN_DIR>` below is the value of that line; `WORKTREE` is the `Repository:` and `PROJECT` the `Project:` the rest of this file speaks of. A `NOTE:` other than `none` is the relaunch note: follow it.

ARTIFACT_PATH: `<RUN_DIR>/04-implementation.md`.

Search rule: a search for a file or a pattern stays inside the repository below or the project checkout — never from `/` or the home (the job refuses them) — and a plugin file lives under `plugin/` of the checkout, never elsewhere on disk.
Long commands: inside a job a command that outlives the Bash timeout is KILLED, not backgrounded — give a long command a Bash `timeout` parameter sized to it, up to `queue.bashTimeoutS.max`.

### TARGET: coder

**First step, before anything else:** call `mcp__nightqueue__context_for_agent` with `agent: "coder"`, `query` = the `**Affected area:**` of `<RUN_DIR>/00-brief.md`, `repo_root` = `WORKTREE`, `project` = `PROJECT`. A failed call is an open item, never a stop.

**Read before acting (via Read):**
- `<RUN_DIR>/01-triage.md` — ## Validated brief.
- `<RUN_DIR>/03-plan.md` — ## Implementation plan (its stage, when staged) and ## Assumptions: the plan to execute (attack on the cause/criterion).
- `<RUN_DIR>/04-implementation.md` — what earlier stages did, when it exists (only with a `STAGE:`).

Inputs: the artifacts above; the stage when the plan is staged; the `## Applicable lessons` and `## Project memory` when the context carries them. With a `STAGE:`, implement only this stage of the plan.

Apply the plan following the project's standards (CLAUDE.md). The simplest possible solution.
A change that adds or bumps a dependency regenerates the lockfile with the manager's own install (`npm install`) and lists `package.json` and the lockfile together under `## Modified files`: `run publish` includes a lockfile only when the manifest changed too and the frozen install (`npm ci --ignore-scripts`) passes from it.

### TARGET: coder-fix

**Read before acting (via Read), and call no `context_for_agent`:**
- `<RUN_DIR>/06-verification.md`, its last `## Round` — the verifier's failures to fix. Absent on the first lane after a QA `NEEDS FIX`.
- `<RUN_DIR>/05-qa.md`, its last `## Round` — ## Proven breaks still open (pending). ## Generated PoCs of the same round: the target to turn green.
- `<RUN_DIR>/04-implementation.md` — ## Modified files so far.

Inputs: the artifacts above — the failures and the open breaks are the findings to fix.

The verification failed. Fix exactly the failures/breaks reported in the 06-verification.md and the pending ## Proven breaks of the 05-qa.md, without introducing a regression and keeping the project's standards. Make the PoCs pass by fixing the cause — never by altering or deleting the PoC.

On the first lane after a QA `NEEDS FIX` the verifier has not run: the breaks are the whole list. In any fix lane, run the QA's PoCs for the breaks you were handed, under `timeout`, and return only when they pass or `### Fix loop <n>` states why one cannot.

This launch is one fix loop: its number is the highest `### Fix loop <n>` outside a code fence of `04-implementation.md`, plus one, else 1. Do NOT rewrite ARTIFACT_PATH — your complete output is the updated list plus one appended block. Keep every section as it is, update the cumulative `## Modified files` list in place, and append at the END of the file:

```
### Fix loop <n> — what was wrong / what changed
- What was wrong: <one sentence>
- What changed: <one sentence>
- How it was tested: <the commands and their result>
```

### Deliver

Write these sections to ARTIFACT_PATH, in this order and with these headings. `## Modified files` is mandatory (`nightqueue run check 04` reads it; with no list it derives one from the worktree's own changes).

````
## Modified files
<absolute path of each file created or modified, one per line, nothing else — cumulative across stages and fix loops>

## Done
### Stage <n> — <title>
<what was implemented; one block per stage, a single block when the plan has no stages>

## Left
<what is left or deviates from the plan, or `nothing`>

## How it was tested
<the commands run and their result>
````

A stage appends its `### Stage <n>` block under `## Done` and rewrites the cumulative `## Modified files`; nothing else is rewritten.

### Return

Write the COMPLETE output (every mandatory section of `### Deliver`) to ARTIFACT_PATH via Write. Return to the orchestrator exactly the syntax the request declares on its `RETURN-HEAD:`, `RETURN-MAX-LINES:` and `## Did` lines: the head as your first line, `<…>` filled, then the three sections — the verdict/status + the handoff file written + open items — never file contents, never a diff. Do NOT paste the complete sections in the response. `## Found` also lists the files touched.
If a lesson of `## Applicable lessons` changed a decision of yours, add to the return, outside the Did/Found/Open caps, at most 2 lines `Lesson L<id> applied: <how it changed a decision>`; a lesson that changed nothing is not cited, and no citation is a valid answer.
When a lesson or memory you recalled shaped what you did, cite its ref (`L<id>`, `M<id>`) in the return.

Shell rule: the worktree isolation refuses any Bash command it cannot prove stays inside the worktree ("this command is too complex to verify that it stays inside the worktree") - one simple command per Bash call, no heredocs (`<<`), no `\` continuations, no `cd … && …`, no `python3 -`/`node -e` fed by stdin; anything longer is a file written with Write under `tmp/`, run by path and deleted before the commit; every test command runs under an explicit `timeout <seconds>`.
