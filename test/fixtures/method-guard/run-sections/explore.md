## Inside a run

This section applies only when the request carries a `RUN_DIR:` line; a request with no such line ignores it. Such a request says only what this run wants: `RUN_DIR`, `WORKTREE`, `PROJECT` and the `NOTE` of a relaunch. `<RUN_DIR>` below is the value of that line; `WORKTREE` is the `Repository:` and `PROJECT` the `Project:` the rest of this file speaks of. A `NOTE:` other than `none` is the relaunch note: follow it.

ARTIFACT_PATH: `<RUN_DIR>/02-explore.md`. Read before acting: only the first step below.

**First step, before anything else:**
1. Read the Brief from `<RUN_DIR>/00-brief.md`, never the user's raw input. Find the files related to its `**Affected area:**`; the task objective is its `**Objective:**`. With no `00-brief.md`, write no artifact and name it in the `## Open` of your return.
2. Call `mcp__nightqueue__context_for_agent` with `agent: "explore"`, `query` = the `**Affected area:**`, `repo_root` = `WORKTREE`, `project` = `PROJECT`. A failed call is an open item, never a stop.

Inputs: the affected area and the objective (from the validated brief, never the user's raw input); the known map of the project and its known libs when earlier runs indexed one; the `## Applicable lessons` and `## Project memory` when the context carries them.

`## Structural index` of the answer is the already known map of the project (index from earlier runs), its `libs:` line the already known libs. Do NOT rediscover the fresh files of the map — trust them and complement only what is missing for this area. Revalidate ONLY the ones marked REVALIDATE (they changed or disappeared since the indexing). Fix the responsibilities that are wrong.

Search rule: a search for a file or a pattern stays inside the repository below or the project checkout — never from `/` or the home (the job refuses them) — and a plugin file lives under `plugin/` of the checkout, never elsewhere on disk.

Limit: at most 30 relevant files.

### Deliver

Write these sections to ARTIFACT_PATH, in this order and with these headings. All three are mandatory (`nightqueue run check 02` fails without any of them). After this phase the runtime persists the project's structural index from `## File map` and `## Third-party libraries` (`nightqueue run index-save`), so keep those two headings and their line formats exactly.

````
## File map
- <absolute path> — <responsibility in 1 line>
One line per mapped file, at most 30, the files the Access map cites included.

## Access map
Only for the target code of this task. One line per entry point, each consumer walked up at most 3 hops to a terminal:
- <consumer> · <file:line> · <hop1 → hop2 → hop3> · terminal: <one of the below>

Valid terminals (do not invent another label):
- `click: <label/element> (<file:line>)`
- `route: <URL + query params that change the behavior>`
- `job/cron/webhook: <trigger> (<file:line>)`
- `command: <entrypoint operated by a human — CLI, skill, agent> (<file:line>)`
- `external consumer: not verifiable`

A parameter, field or flag the target code READS and uses in no decision gets a line of its own, verbatim:
`- unimplemented intent: <param> · governs <scope | filter | auth | other>`
(`scope` = which records/entities the operation reaches; `filter` = a cut inside an already defined scope; `auth` = who can; `other` = the rest, with 3 words of explanation.)

A target with no UI consumer, route, job or command (instruction text, a purely textual refactor, a library with no call site) → do not leave the section mute nor write `n/a`: write `**No entry point:** <reason> · <exact command that confirmed it>`.

Cut off by the cap of 30 files → the last line of this section, after the entry points, is `partial: <N> consumers not walked up`. Without a cut the line does not exist.

## Third-party libraries
- <lib>@<resolved version>
A lib `nightqueue libs` answered `not-found` → `- <lib> (version not found)`. No lib on the path → `- None`.
````

### Return

Write the COMPLETE output (every mandatory section of `### Deliver`) to ARTIFACT_PATH via Write. Return to the orchestrator exactly the syntax the request declares on its `RETURN-HEAD:`, `RETURN-MAX-LINES:` and `## Did` lines: the head as your first line, `<…>` filled, then the three sections — the verdict/status + the handoff file written + open items — never file contents, never a diff. Do NOT paste the complete sections in the response. `## Found` also says "N files, M libs mapped" — the File map count and the Third-party libraries count.
If a lesson of `## Applicable lessons` changed a decision of yours, add to the return, outside the Did/Found/Open caps, at most 2 lines `Lesson L<id> applied: <how it changed a decision>`; a lesson that changed nothing is not cited, and no citation is a valid answer.
When a lesson or memory you recalled shaped what you did, cite its ref (`L<id>`, `M<id>`) in the return.

Shell rule: the worktree isolation refuses any Bash command it cannot prove stays inside the worktree ("this command is too complex to verify that it stays inside the worktree") - one simple command per Bash call, no heredocs (`<<`), no `\` continuations, no `cd … && …`, no `python3 -`/`node -e` fed by stdin; anything longer is a file written with Write under `tmp/`, run by path and deleted before the commit; every test command runs under an explicit `timeout <seconds>`.
