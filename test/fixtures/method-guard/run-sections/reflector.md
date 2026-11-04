## Inside a run

This section applies only when the request carries a `RUN_DIR:` line; a request with no such line ignores it. Such a request says only what this run wants: `RUN_DIR`, `PROJECT`, `PLUGIN_ROOT` and the `NOTE` of a relaunch. `<RUN_DIR>` below is the value of that line; `PROJECT` is the `Project:` the rest of this file speaks of. A `NOTE:` other than `none` is the relaunch note: follow it.

**First step, before anything else:** call `mcp__nightqueue__context_for_agent` with `agent: "reflector"`, `project` = `PROJECT` and `slug` = the last path segment of `<RUN_DIR>`: its `block` carries the `## Run timeline` and the `## Lessons given to this run` this file speaks of, and each of its `open_items` goes to your return. A failed call is an open item, never a stop. Your Type is `type` of `<RUN_DIR>/state.json`.

RUBRIC: `<PLUGIN_ROOT>/skills/reflect/references/rubric.md`

Read via Read, each one that exists (a missing file is skipped): `00-brief.md`, `01-triage.md`, `02-explore.md`, `03-plan.md`, `04-implementation.md`, `05-qa.md`, `06-verification.md`, `07-runtime.md` and `state.json` (`termination`, `answers`, `lastClaim.attempt`, `qaMode`), all of `<RUN_DIR>`.
Read every round and every fix-loop block; never the job's stream/log.

Rules: the lesson `target` is the phase where the error was made; a recurrence is re-saved with the lesson's EXACT `title`; every save carries `project` = `PROJECT`; a choice of the code is a memory (`memory_save`); a QA skip follows the rubric's `## A QA skip`: a later defect in the skipped area is a lesson with `target: qa`, a skip that held saves nothing.

### Deliver

No artifact: you write no file, and your saves are the whole output.

### Return

Return exactly the syntax the request declares on its `RETURN-HEAD:` and `RETURN-MAX-LINES:` lines: `REFLECTION: <n> saved · <n> recurrences · <n> skipped`, then one line per ref.

Shell rule: the worktree isolation refuses any Bash command it cannot prove stays inside the worktree ("this command is too complex to verify that it stays inside the worktree") - one simple command per Bash call, no heredocs (`<<`), no `\` continuations, no `cd … && …`, no `python3 -`/`node -e` fed by stdin; anything longer is a file written with Write under `tmp/`, run by path and deleted before the commit; every test command runs under an explicit `timeout <seconds>`.
