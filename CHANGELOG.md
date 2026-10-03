# Changelog

Every notable change of this project is recorded here, newest first. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Breaking

- **The database schema changes only in `nightqueue update` and `nightqueue setup`.** No other
  open migrates it any more - not a read command, a runner, the MCP server nor a hook, inside a
  job or outside one: a database older than the build is refused before a byte is written
  (sidecars included) with `database at v<file>, this nightqueue expects v<code>: run
  \`nightqueue update\``. The MCP tools answer `store-unavailable` with code `SCHEMA_OUTDATED`,
  hint `nightqueue update` and a new `message` field; hooks print their one warning line; a
  runner is never started nor registered; `doctor` warns and names `nightqueue update`. A read
  from a job worktree without `NIGHTQUEUE_HOME` used to migrate the operator's home under the
  installed build, which then refused it and stopped every runner.
- **`update`/`setup` migrate with the runtime they just installed, and only on an idle home.**
  After the runtime swap they run `nightqueue update --schema-only` from the new runtime under
  the home lock; it refuses, naming each one, while a runner or close is registered, a job holds
  a live lease or a close holds a live close lease (`--force` never bypasses it), then copies
  the database to `nightqueue.db.pre-v<N>` (never over an earlier copy) and migrates. A job left
  `running` with an expired lease only warns.
- **Upgrading from 0.5.x takes two updates, once.** The first `nightqueue update` runs the old
  build's update, which installs the new runtime without the schema step, and every command
  then refuses with the message above; a second `nightqueue update` (or `nightqueue setup`)
  migrates the database.

### Added

- **`nightqueue studio`, the local web cockpit.** It serves the built page (`studio/dist`,
  shipped in the package), the same stateless `/mcp` endpoint as `mcp --http`, a small `/api`
  (info, projects, watch/window runner start, queue pause/resume, raw job log) and `/events`
  (the diff of `queue_status` every second, and the narrated current attempt of one job) on
  127.0.0.1 only. Every request needs the per-start token: the printed `?t=` URL trades it
  once for an HttpOnly per-port cookie, `Authorization: Bearer` keeps working, and a write
  authorised by the cookie must also carry the studio's exact Origin. `--api-only` with
  `npm run studio:dev` serves the page through Vite instead; `npm run studio:build` builds
  and stamps the dist, and `release:check` refuses a missing or stale one.

### Removed

- The singular `runner` key of `nightqueue queue status --json` and of the MCP `queue_status`
  answer, deprecated in 0.2.0 as an alias of `runners[0]` and promised gone in the next minor.
  It carried the same object twice in every answer. Read `runners` (`runners[0]` for the
  first live runner, `runnersOnline` for the count). `runnerAnswer.runner` of `queue_run`,
  `queue_retry` and `queue_stop` is unrelated and stays.

## 0.6.0 - 2026-10-01

### Breaking

- **The roadmap is now called issues, everywhere, with no alias (NQ-64).** The tracker is typed
  items with a status workflow, priorities, comments and refs, so it carries the name readers
  know from GitHub Issues and Linear. Refs (`NQ-12`, `DLW-3`) are unchanged.
  - CLI: `nightqueue roadmap [show <ref>]` is `nightqueue issues [show <ref>]`, and
    `queue add --roadmap <ref>` is `queue add --issue <ref>`. The old command and option are
    unknown; update any script that calls them.
  - MCP: the tools `roadmap_get`, `roadmap_save`, `roadmap_update`, `roadmap_search` and
    `roadmap_comment` are `issue_get`, `issue_save`, `issue_update`, `issue_search` and
    `issue_comment`; the `queue_add` parameter `roadmap_item_id` is `issue_id`, and its answer
    keys `roadmapItemId` / `roadmap_ref` are `issueId` / `issue_ref`.
  - **Tool contract 3: restart the MCP clients** (start a new Claude Code session, reopen Claude
    Desktop and Cowork conversations, restart a running `nq open`). A client that cached the old
    definitions gets "tool not found" for a `roadmap_*` tool, and its `queue_add` with
    `roadmap_item_id` is refused with the stale-contract line instead of queuing a job without
    its issue.
  - A job queued from an issue gets an `## Issue` block with `Issue: <ref>` in its prompt, and the
    triager's phase context a `## Related issues` block. Prompts already stored keep their text.
  - **The database migrates once to schema v22** (from v20 or v21, the v21 columns `jobs.origin`
    and `projects.integrations` kept as they are), on the first command that opens it: a copy is
    left beside it as `nightqueue.db.pre-v22`, then one transaction copies `roadmap_items`,
    `roadmap_item_projects` and `roadmap_comments` into `issues`, `issue_projects` and
    `issue_comments` with every row, counter and delete rule kept, and rebuilds the search
    mirrors as `issues_fts` and `issue_comments_fts`. It refuses while a runner holds a live
    lease (stop the runners with `nightqueue queue run --stop` first) and on a row pointing at
    a row that does not exist, with nothing written.
  - `nightqueue doctor` names its check `issue workflow`, and a project purge blocked by comments
    on org items reports `issue_comments_on_org_items`.
  - The maintenance script `scripts/roadmap-backfill.mjs` is `scripts/issue-backfill.mjs`.

### Added

- **The close resolves a small textual conflict with a bounded merger agent (NQ-35).** When the
  conflict step's rebase stops on conflicts that code finds eligible - no `--force`, a
  `scripts.test`, no risk-list or generated file, markers in every file, at most 12 hunks in 6
  files summed over every stop - it spawns `nightqueue:merger` (sonnet, Read and Edit only,
  Edit fenced to the conflicted files by the new `merger-guard` hook) in the stopped worktree,
  for half of what the close has left after the suite's reserve, at most 20 min. A `RESOLVED`
  counts only once the runtime finds no marker left and no file touched outside the conflict,
  continues the rebase and runs the suite green; the note reads `resolved by merger: <n> hunks
  in <m> files (<names>); suite green; pushed <a> -> <b>`. Anything else stops with
  `real-conflict` as before, with `; merger: <reason>` when the agent ran.

### Changed

- **`queue.closeTimeoutS` defaults to 1800 instead of 600**, so a close has room for the merger
  and the suite. A `config.json` written by an earlier setup pins `600` explicitly - edit it to
  take the new default.

- **The close re-reads the head from GitHub and merges only a head it or CI verified (D-54).**
  Every step works on the head GitHub shows now instead of the one it recorded; preflight and
  conflict note a head that moved (an *Update branch*, a commit pushed to the branch, a rebase
  by hand), and the merge step alone accepts a head: one the close's own green suite ran on
  (`data.verifiedSha`, durable, never cleared), one CI reported all green on
  (`data.ciGreenSha`), or one whose checks are green now or once waited for - red stops with
  `checks-red`. With no check at all, a branch with GitHub workflows is waited on for about
  60 s; with no workflows, or none reporting, the close runs the suite on that head in a
  throwaway worktree and merges the head it verified, or stops with `suite-red` merging
  nothing - on a first close whose head never moved too. Without CI, the close runs the suite
  of the current head on your machine; a push by someone else to the job's branch runs that
  person's code locally. A head that keeps changing during the merge step stops it with
  `head-moved` after 2 loopbacks, nothing merged. Every merge is pinned with
  `--match-head-commit` (`gh pr merge` is never run without it), an open pull request GitHub
  answers without a head commit stops with `pr-unreadable` on every step, `--force` included,
  and a checks read now carries the head it was read with (a read of another head is
  `checks-unreadable`). `--force` still takes any other head. One run now closes a pull request
  updated from its base by the operator; before, it took a second run for nothing.
- **`queue status` reads `◐ closing` alone while a close holds the job.** The STATUS cell no
  longer says `done · closing`: a job under a live close is neither done nor closed yet, so it
  carries its own label, icon and color (cyan) until it reads `■ closed` - or, when the close
  stops, `done · close failed at <step>` / `done · close stalled` as before.
- **A sick home database degrades instead of killing the MCP server, the runner and the run.**
  A database SQLite cannot read (`SQLITE_NOTADB`, `CORRUPT`, `IOERR`, `READONLY`, `FULL`,
  `PROTOCOL`, and `CANTOPEN` of an existing file, classified by `errcode`) is one `StoreUnavailableError` with the hint `nightqueue doctor --fix`: the CLI
  prints one line, the MCP tools answer `store-unavailable` and the server keeps serving (it
  also starts on a sick home), `context_for_phase` and the SessionStart hook answer empty plus
  one line, and the failed connection is retired, never closed. The runner prints one outage
  line, backs off from 30 s to 5 min without exiting or stopping its child, and renews its
  running job's lease the moment the database answers; the steal rule is unchanged. A run knows
  itself from a runtime-only `job` block of `state.json`, written before the worktree, so
  `run commit`/`run pr` and the `run_*` tools keep working, and the writes it cannot make go to
  `pending-writes.jsonl`, replayed once (finalize, every claim sweep, maintenance, bare
  `queue repair`) without ever demoting a row. A session that cannot reach the MCP server is
  gated `store-unavailable` with no attempt spent and a noteless retry. Plain `doctor` warns
  instead of failing; `doctor --db` adds `db files`, `db integrity` and `lost jobs`;
  `doctor --fix` folds the WAL, moves a broken `-wal`/`-shm` aside when the main file is intact
  and no process holds the files (`lsof`), and refuses with the list of backups when it is not;
  `queue repair --from-disk` recreates the jobs the table lost from their runs on disk, as
  records that `queue retry` refuses since their prompt was not kept.
- **The rename leftovers are cleaned or named.** `setup` and `update` remove the shims `nightshift`,
  `nsft` and `nshift` from the shim directory when this package wrote them (a foreign file of the
  same name is kept). `doctor` warns about a leftover one, names `~/.nightshift/` and every
  `_broken-*` quarantine older than 30 days as removable (never deleting them), and
  `doctor --fix` now also removes the `.fuse_hidden*` / `.nfs*` shm orphans when no live runner is
  registered.
- **`queue close` waits for pending checks at preflight.** Required checks still running no
  longer stop the close with `checks-pending` at once: preflight polls them like the wait after
  a `BEHIND` update (same backoff, same `waiting for checks on <sha>` line), out of the one
  `queue.closeTimeoutS` budget the whole close shares. Green goes on to merge, red stops with
  `checks-red`, and past the budget it stops with `checks still running on <sha> - run queue
  close N again` and the next run continues.
- **Every reference to another row is enforced (schema v20).** The database migrates once to
  v20, on the first command that opens it and in the same open as the v18 and v19 steps when
  they are pending, leaving a copy `nightqueue.db.pre-v20` beside it. The rules: a comment and a
  per-project row go with their item (cascade); the job of an item, a per-project row, a
  decision or a pipeline run, and the decision an item links, are cleared when that row is
  deleted (set null); a decision named by another one's `superseded_by` cannot be deleted
  (restrict). A home with a row pointing at a row that does not exist refuses to migrate with
  one line naming each such row, its column and the missing id, and changes nothing - not even
  the copy, nor the v18/v19 steps of an older home - and `nightqueue doctor` reports those rows
  instead of promising the migration. A column v20 does not know refuses the migration naming
  it instead of being dropped. Deleting a roadmap item now removes its comments: they stay append-only and the
  guard still refuses to edit or delete one while its item exists. Inside a job that is not in
  the queue of the database being written, `decision_save` and `nightqueue decision save` are
  refused instead of saving a decision whose job of origin does not exist.

### Added

- **The resolve pipeline's mechanics moved into the runtime.** `nightqueue run start` records
  the run's tier and type and answers, as one JSON line, the run directory, the worktree the
  runtime created, the ONE routing row of the tier (now `src/queue/routing.mjs`), the phases,
  the tasks and the pull request template; `nightqueue run start --routing` prints the whole
  table. The MCP tool `phase_prompt` (twenty-nine tools now) renders the complete prompt of each
  subagent from `plugin/skills/resolve/references/prompts/`, with the Brief the orchestrator
  wrote to `<RUN_DIR>/00-brief.md` (`run check 00`), the context block and the architect's
  standing decisions; an unresolved placeholder is an error. `nightqueue run publish` checks the
  body, commits the list once and opens the pull request in one call (`run commit` and `run pr`
  are unchanged), and `nightqueue run report` renders the final report's tables and the
  happy/not-happy verdict from the layout in `plugin/skills/resolve/references/report.md`. The
  resolve skill no longer carries the subagent templates, the routing table or its rationale:
  its SKILL.md went from 110,517 to 94,796 bytes.
- **A tool contract version (contract 2).** The MCP server publishes it in its `serverInfo`
  title and instructions, every tool answer carries `contract`, and `nightqueue doctor` shows
  it. A client that cached the older tool definitions and sends an internal integer id where a
  ref is now expected (`roadmap_get`, `roadmap_comment`, `roadmap_update`, `roadmap_save`
  `decision_id`, `decision_update` `id`/`superseded_by`, `queue_add` `roadmap_item_id`) is
  answered `your client has the tool definitions of an older nightqueue (contract 1, this
  server is 2): start a new session or restart the MCP client`. For this release an id that
  names one row of the caller's project (or its org) is still accepted, and the answer carries
  `deprecated_input`; it will be refused after the grace release. `queue_status` advises
  `this client's tool contract is older than the server` once the server saw an old shape. The
  upgrading section of `docs/install.md` lists the clients to restart.
- A schema test fails on any `*_id` or `superseded_by` column without a foreign key and an
  explicit `ON DELETE` rule, unless an exception entry gives the reason (contributor-facing).

## 0.5.0 - 2026-09-29

### Breaking

- **Projects and orgs are identified by id, and their names can change.** Each org and project
  is a row of the database with an id (a ULID) and a unique name; every job, lesson, memory,
  index entry, run, decision and roadmap row points at the id, so `nightqueue org rename` and the
  new `nightqueue project rename <old> <new>` change one row and every view shows the new name
  at once. An org or a project that still owns rows cannot be removed: the database refuses and
  the message lists what it owns.
- **The database migrates once to schema v18**, on the first command that opens it, in one
  transaction: a copy of the file as it was is left beside it as `nightqueue.db.pre-v18`, and
  any failure leaves the database at its old version with nothing written. Names are kept
  exactly as they were, case included; a project name found only in history rows becomes a
  project without a path in the default org. While a runner holds a live lease on a job the
  migration refuses with one line naming the job and asking to stop the runners
  (`nightqueue queue run --stop`) first; a job left `running` by a crashed runner does not block
  it, and is reclaimed and resumed afterwards.
- **Projects and orgs moved out of `config.json`.** After the migration the file keeps the queue
  and embedding settings, `orgConnections` (the connection bound to each org, keyed by org id)
  and `defaultOrg` as an org id; its `projects` and `orgs` are removed once they are in the
  database. A top-level key the runtime does not know is now kept as it is instead of being
  dropped on the next write. `nightqueue org add --display-name` is removed, and `org list` has
  no display column (its `--json` carries the id).
- `nightqueue project move <name> [<org>] [--path <path>]` also gives a project a new checkout
  (or a first one, for a project known only from history), and `project list` shows a project
  without a path as `(no path)`. `nightqueue org repair` is removed, with the pending-rename
  record it settled: a rename is one row and can no longer be interrupted halfway.
- **Run directories are `runs/<project_id>/<slug>/`.** The existing `runs/<project>/` directories
  are moved under the id once, never overwriting a run already there (a `runs/.by-id` marker
  records the move), the prompt of a job carries `Project: <current name>` and
  `RUN_DIR: runs/<project_id>/<slug>`, and `state.json` records `projectId`. The new
  `nightqueue run dir [--project <name> --slug <slug>]` prints the directory of a run, so nothing
  has to build it from a project name.
- Every MCP tool, `lesson_*` and `memory_*` included, refuses a project name no project carries
  with `unknown project` and the list of the known projects, and writes nothing. A path outside every checkout
  still means the global scope for the lesson, memory and index tools.
- **Roadmap items and decisions no longer take internal ids.** Every tool and command that names
  one takes its ref instead: `roadmap_update`, `roadmap_get` and `roadmap_comment` `id`,
  `queue_add` `roadmap_item_id` and `queue add --roadmap` take an item ref (`NQ-12`);
  `decision_update` `id` and `superseded_by`, and `roadmap_save`/`roadmap_update` `decision_id`,
  take a decision ref (`D-7`, `DLW/D-3`). An integer there is refused. `decision_save`
  `supersedes`/`unrelated` and the `decision` commands keep their per-owner numbers. Jobs keep
  accepting the plain id next to `J-<id>`.
- **The database migrates once to schema v19**, the same way as v18 (and in the same open when a
  home is older): a copy `nightqueue.db.pre-v19` is left beside it, every project and org gets a
  key suggested from its name, and every roadmap item gets its number inside its owner, in the
  order the items were created. Decision numbers are unchanged, and comments, notices and prompts
  written before keep their old text (`job #N`). The live-lease refusal now names the job
  `J-<id>`.
- **Everything the runtime prints names jobs, items and decisions by ref**: `J-77 queued`,
  `J-77 done: <PR>`, `J-77 closed` in item threads; `J-5 started ...`, `cancelled J-5`,
  `J-5 closed: PR #12 merged as ...` on the terminal; `p5 NQ-12 <title>` in the roadmap;
  `D-7` / `DLW/D-3` for decisions everywhere, including the standing-decisions block of a
  session and exported decision files (`Decision D-7 in the <owner> store.`; files exported
  before still import). `project list` and `org list` gain a key column.
- **`nightqueue run pr` appends the pull request footer itself.** It publishes a copy of the body
  ending `Refs <KEY>-<n>` and `Opened by nightqueue · <KEY>-<n>` for a roadmap job, or
  `Opened by nightqueue` otherwise, and REJECTS a body that already carries an `Opened by
  nightqueue` line, a `Refs` line, a job ref or the run slug. The old last `Roadmap:` line and
  the `pr-body.roadmap.md` copy are gone. `nightqueue run commit` adds a `Refs: <KEY>-<n>`
  trailer to a roadmap job's commit and refuses a message that carries one.

### Added

- **Project and org keys.** Every project and org carries a key of 2 to 5 uppercase letters or
  digits, unique across both. `init`, `project add`, `org add` and the registration offer of
  `queue add`/`queue_add` suggest one (`nightqueue` → `NQ`) and ask for it on a terminal;
  `--key <KEY>` (and `key` on `queue_add`) chooses it. `nightqueue project key <name> <KEY>` and
  `nightqueue org key <name> <KEY>` change it in one row, and the old key keeps resolving to the
  same owner.
- **Refs.** `J-<id>` names a job, `<KEY>-<n>` a roadmap item numbered inside its owner, `D-<n>`
  a decision of the project in context and `<KEY>/D-<n>` a decision named by its owner; rows
  without an owner use `G`. MCP answers carry a `ref` next to every job, item and decision.
- `nightqueue queue status <PR URL>` and `queue_status` with `pr_url` find the job that opened a
  pull request; a URL opened by more than one job is refused with their refs.

- `queue_stop` (MCP) mirrors `nightqueue queue run --stop [pid]`: without `pid` it ends every
  registered runner, with `pid` that one, and answers one `{ outcome, pid, message }` per runner.
  `queue_cancel` with `stop: true` cancels a RUNNING job in one call: the job goes from `running`
  to `cancelled` in one write that only succeeds while its runner still owns it (no other runner
  can claim it in between), its attempt is given back, and then that runner alone is stopped;
  `release_worktree: true` also releases the job's worktree once the runner is gone. A worker of
  another host, or a pid that is not a live registered runner of this home, is refused with
  nothing signalled or written. An operator session can now stop and cancel a job without a
  terminal.

### Fixed

- Every job queued with a tier got the same run slug (`tier-complex-set-by-the-operator`, taken
  from the runtime's `Tier:` header) and so the same run directory: stopping one of them made its
  row copy another job's pull request and finish time. A run's slug now comes from its own brief,
  a slug another job already holds gets a numbered variant, a repair only reads its own job's
  `state.json`, and the rows that already shared a slug are separated on the next open.
- A nightqueue process older than the database it opens (a runner, an MCP server or a hook still
  running after an upgrade) used to read and even try to write a schema it did not know. Every
  open now reads the schema version first and refuses one newer than the runtime with one line
  (`update nightqueue / restart the client that runs the old version`), writing nothing; the
  check waits for a database another process is creating or migrating instead of failing the
  open with `database is locked`. `doctor` reports the same line.
- `queue close` of a pull request behind its base (the repository requires branches to be up to
  date) skipped the conflict step and then failed at the merge. The close now brings the branch
  up to date, waits in the same run for the required checks of the new head and merges it once
  they are green; a red check stops with `checks-red`, and a wait longer than
  `queue.closeTimeoutS` stops resumable with the head it updated.

### Changed

- `nightqueue open` greets: a fresh operator session opens with the operator introducing
  itself as the nightqueue operator of the project - what it does, what it never does, where
  to start - in the language the repository suggests; a resumed session is not greeted again.
- The operator session pre-approves the `nightqueue` MCP tools (`permissions.allow:
  ["mcp__nightqueue__*"]`), so reading the queue, the roadmap or the memory never asks first.
  Every other tool keeps Claude Code's own prompts.
- The package homepage is the website, https://nightqueue.github.io.

## 0.4.0 - 2026-09-24

### Breaking

- **nightshift is now nightqueue.** The package is `@nightqueue/nq` on npm (`@maykonv/nightshift`
  is deprecated and will not be updated; the unscoped name is refused by the registry as too close
  to an unrelated `night-queue`), the command is `nightqueue`, the Claude Code plugin is
  `nightqueue` (`/nightqueue:queue`, `/nightqueue:resolve`), the MCP server is `nightqueue`, the home is
  `~/.nightqueue` and every environment variable is `NIGHTQUEUE_*`. There is no alias for the old
  names: move the home yourself (`mv ~/.nightshift ~/.nightqueue`), run `npx @nightqueue/nq init` and
  remove the old plugin from Claude Code. The repository moved to `nightqueue/nightqueue`.
- The shortcut shims are gone with the name: `nshift` and `nsft` are replaced by one, `nq`.
  Because `nq` is also a Unix job queue (`brew install nq`), `nightqueue doctor` warns when another
  `nq` comes first on PATH and names it; `nightqueue` itself is never shadowed.

### Fixed

- `nightqueue doctor` no longer reports the `nq` shortcut as shadowed by a shim of another
  nightqueue home (a file of our own shape is never another tool); only a foreign `nq`
  earlier on PATH warns.
- The test suite no longer fails on a slow CI runner because one large test file crossed the
  60-second `--test-timeout`, which Node applies to a whole file as well as to each test:
  the limit is 4 minutes, and every CI job carries a 30-minute `timeout-minutes` so a hang
  can never hold a job for hours.

### Changed

- The repository is public. It gained `CONTRIBUTING.md`, `SECURITY.md`, issue and pull
  request templates and Dependabot; the README describes how a job runs and the status of
  the project. The test fixture that stood in for a repository's `CLAUDE.md` is a fictional
  one of the same shape, and the project names in the tests are fictional too.

### Breaking

- `closed` means the job's pull request was merged through the closing pipeline, and
  `nightqueue queue close <id>` is that pipeline. `nightqueue queue ship` and the MCP tool
  `queue_ship`, released in 0.3.0, are removed without an alias - nightqueue is a local
  product with no external user to migrate: `queue ship` now answers the unknown-subcommand
  error. `queue close <id> [--force] [--foreground] [--decisions accept|reject|keep] [--json]`
  runs the four steps (preflight, conflict, merge, settle) on one `done` job with a pull
  request, detached unless `--foreground`, and refuses every other status by name (``job `N`
  is already closed`` for a closed one); the old status flip of any number of ids from `done`,
  `failed`, `gate` or `cancelled` is gone. `queue close --merged` runs the same pipeline on
  every `done` job gh confirms merged, and on nothing else. The MCP `queue_close` takes
  `job_id, force?` and answers `{ ok, started, job_id, pid, logPath, follow }` like a detached
  start. A detached close settles the job's proposed decisions only with `--decisions`, and
  keeps them `proposed` otherwise.
- Vocabulary: the `ship_status`, `ship`, `ship_worker` and `ship_lease_until` columns become
  `close_status` (`closing` or `failed`, empty once closed), `close`, `close_worker` and
  `close_lease_until` (schema v16); `queue.shipTimeoutS` becomes `queue.closeTimeoutS` (same
  default and range, the old key is not read); the notice line is `Closed: PR #<n> merged as
  <sha7> on <date>`; the STATUS cell reads `done · closing`, `done · close failed at <step>`,
  `done · close stalled` or `closed`; `queue_status`, `queue status --json` and doctor carry
  `closes` in place of `ships`; the close runs as a runner of mode `close`, logs to
  `close-<id>-<stamp>.log` and reads `NIGHTQUEUE_CLOSE_WORKER`.
- `closed` requires a merge recorded by the pipeline: a `CHECK` of the `jobs` table refuses a
  `closed` row without a `pr_url`, with a `close_status`, or whose `close` checklist does not
  record `data.merged: true`, and `queue repair`, the witness reconciliation and every other
  writer refuse `closed` by name.
- The v16 migration runs once, in one transaction, on the first open after upgrading: a
  closed row whose merge was recorded stays `closed`; a closed row with a pull request but no
  recorded merge (closed by hand, or after a failed close - job 65) stays `closed` with a
  synthetic `merge: skipped "merged outside a close"`, `mergedBy: "operator"` and
  `migrated.from`, its existing checklist kept and extended, and no `mergeSha`; a closed row
  without a pull request becomes `cancelled`, its old status and note kept in `result`; a
  `done` row mid-close keeps its close state and lease; legacy `merged` rows follow the same
  rules; the old merge line of a notice is rewritten to `Closed:` only where it is the line
  the checklist recorded.
- `--force` is narrowed to "do not hold me back for tests": it ignores the pull request's
  red, pending or unreadable checks and skips the rebase suite, and nothing else. It no longer
  closes a `failed` or `gate` job and no longer overrides `pr-not-the-job-branch` (the override
  listed under Fixed below is withdrawn); a real conflict, leftover markers, uncommitted files
  the pull would touch and a missing checkout still stop it.
- A pull request closed without merge cancels the job (`pull request closed without merge`)
  and releases its worktree, instead of stopping the close; one merged by hand is recorded as
  `merged outside a close` with `mergedBy: "operator"`, and the pipeline's own merge as
  `mergedBy: "nightqueue"`.
- `queue cancel` and the MCP `queue_cancel` also accept a `done` or `failed` job, release its
  worktree, answer `{ job, worktree }` and refuse a job being closed under a live lease, or one
  whose close was interrupted (resume it with `queue close <id>`, so a merge is never lost).
- A run that exits cleanly with no pull request and no gate, whose attempt logged `no_commit`,
  ends `cancelled` with `nothing to close: the run produced no pull request`, instead of
  `failed`; `local_commit` and a run with no log stay `failed`.
- After upgrading, restart every MCP server process started before it (an open Claude Code
  session keeps its own): an old process still reads the removed columns and fails.

### Added

- Roadmap items have a `type` (`bug`, `feature`, `improvement`, `chore`, `incident`), required
  by `roadmap_save` (existing items get `improvement`). It sets the default tier of a job
  queued from the item (`bug`/`improvement`/`incident` → `simple`, `feature` → `complex`,
  `chore` → `trivial`; an explicit tier wins), and the job's prompt gains a `## Roadmap item`
  block with `Roadmap: <owner>#<id>`, the type and the commit type to use.
- Roadmap items have an append-only comment thread (`roadmap_comments`, guarded by triggers).
  Every job event leaves one comment signed `job:<id>`, in the same transaction as the status:
  `queued` (queued or retried), `gate`, `pr`, `failed` (failed or cancelled) and `closed`
  (the close, with the merge sha), with `refs` read from the job's row (pull request, branch, merge sha, the files the
  implementation listed, the decision the job proposed). A move back from `in_review`/`done`
  leaves `reopened`. The new `roadmap_comment` tool adds a `note`, `roadmap_get` with `id` alone
  reads one item untruncated with its thread, and `nightqueue roadmap show <id>` prints it;
  inside a job both reach only an item of the job's project or its org.
- `roadmap_search` finds at most five roadmap items an owner sees, by `query` (title, detail and
  comment thread, over two new FTS5 mirrors built once for the existing rows) and by `file` (a
  path a job recorded, exact or a directory above it, file matches first); inside a job it reads only the
  job's own project. The triager's phase context gains a `## Related roadmap items` block from
  the same search. 27 MCP tools.
- `nightqueue run pr` of a job queued from a roadmap item publishes the body with a last
  `Roadmap: <owner>#<id>` line (a copy in the run directory; the agent's file is untouched).
- `node scripts/roadmap-backfill.mjs [--dry-run]` synthesizes, once and idempotently, the
  `queued`/`pr`/`closed` comments of items linked to a job before comments existed.

### Changed

- The roadmap is a status workflow with priorities: schema v17 migrates `roadmap_items` in
  place, once and read-guarded, and drops the `now`/`next`/`later` horizons. An item's status
  is now `backlog`, `todo`, `in_progress`, `in_review`, `done` or `cancelled` (plus
  `closed_at` while `done`), and its `priority` is 1-9, default 5, 1 first like a job's; the
  position orders an item inside its priority group. The migration maps `open`+`now` to
  `todo`, `open`+`next`/`later` to `backlog`, `queued` to `in_progress`, `dropped` to
  `cancelled`, `done` to `done` (with `closed_at`), gives every item priority 5 and nightqueue
  items #9 and #36 priority 3. A linked item now follows its job through one table-driven
  reconciler at the store: queued or retried → `in_progress`, job `done` → `in_review`, job
  closed (its pull request merged through `nightqueue queue close`) → `done`, job failed or
  cancelled → `todo`; the store follows the close's own `settleClose` and `cancelOnClosedPr`
  writes, and a close that finds the pull request closed without merge cancels the job. Gate
  answer A of job 67 (a closed job maps to `done` only when it delivered) is now enforced by
  the `CLOSED_REQUIRES_MERGE` schema invariant instead of a per-source rule, and the v17
  roadmap rebuild runs after the v16 close migration. `run_outcome` no longer closes the item. `roadmap_save`/`roadmap_update` take
  `priority` and refuse `horizon` by name, `in_progress` is set only by a job, and moving an
  item back from `in_review`/`done` by hand is allowed. `roadmap_get` answers one `items`
  list in workflow order with optional `status`/`priority` filters, and `nightqueue roadmap`
  prints it grouped by status, p1 first, with `--status`/`--priority`. `nightqueue doctor`
  gains a `roadmap workflow` row that warns about an item left behind its job; the next claim
  cycle re-syncs it.
- An org roadmap item is executed per project: `queue_add` (and `nightqueue queue add --roadmap
  <id> --project <name|all>`) needs an explicit project of the org or `all`, never the current
  directory (`nightqueue project add` now refuses `all` as a project name), and queues one job per project, each linked to its own `roadmap_item_projects`
  row; a project whose row still holds a live job is skipped and reported, and the answer
  lists `jobs` and `skipped`. The org item carries no job itself, and its status is now
  derived from its rows in the same transaction as each row change (`in_progress` while any
  row is, `done` once every row is done or cancelled, otherwise the lowest open status),
  instead of staying as it was until the operator closed it. Row comments carry their
  `project`, a row's job publishes `Roadmap: <org>#<id>`, and closing the item by hand cancels
  every open row with one `closed` comment each. A project reads only its own row
  (`project_status`) and its own comments of an org item; `roadmap_get` by `org` and
  `nightqueue roadmap --org` show the item × project matrix. `nightqueue doctor` also flags an
  org item whose persisted status disagrees with what its rows derive.

### Fixed

- A job records its own pull request, and `queue ship` only ships that one. The run's pull
  request chain (decision #19, amended) now trusts the host's publication only when it is
  created, in the run's repository AND on the run's own branch (its recorded name or the
  `<type>/<slug>` name `run pr` publishes it under); a publication that names no branch
  loses to the pull request the runtime recorded, one on another branch never wins, and
  every publication dropped this way is named on one line of the job's notice. `nightqueue
  run pr` now records the branch it pushed as the run's branch, so resume and `jobs.branch`
  name the branch that exists. `queue ship <id>` stops at `✗ preflight
  pr-not-the-job-branch` when the pull request's head is not the job's branch - also for a
  pull request already merged - and `--force` now overrides this check too, recording the
  override in the step note. The pipeline and QA instructions carry two hard rules: a
  verification never unsets or works around a nightqueue guard or its variables
  (`NIGHTQUEUE_JOB_ID` ...), and a real pull request is only ever created, merged or closed
  in the operator's nstest-demo checkout. Two operator-run scripts, not published:
  `scripts/ship-qa-demo.mjs` (the real ship acceptance on nstest-demo, refused inside a
  job) and `scripts/repair-job-pr-attribution.mjs` (a dry-run-first, read-guarded fix of
  job 57's recorded pull request and `Shipped:` line). The `queue status` STATUS cell, in
  the table and under `--follow`, reads `shipping` alone while a ship is in progress and
  `closed` alone once shipped, in place of `done · shipping` and `closed · shipped`;
  `· ship stalled` and `· ship failed` are unchanged, and `--json`/MCP `ship_status` too.
- `nightqueue roadmap | head` no longer crashes with an uncaught `write EPIPE` once the output
  outgrows the pipe buffer: the CLI stops writing when its reader closes the pipe.

## 0.3.0 - 2026-09-21

### Added

- `nightqueue queue ship <id> [--force] [--foreground] [--json]` and the MCP tool `queue_ship`
  take a `done` job's pull request from open to merged and close the job, through a code
  pipeline of four steps run by the command's own process - preflight (fetch, pull request
  state, green checks, uncommitted files the pull would touch), conflict (a rebase in a
  throwaway worktree, `npm test`, a `--force-with-lease` push), merge (`gh pr merge --squash
  --match-head-commit`, confirmed by re-reading the merge commit) and settle (close the job
  and append `Shipped: PR #<n> merged as <sha7> on <date>` to its notice). Each step is
  recorded on the job (`ship_status`, the `ship` checklist, schema v15), a lease keeps two
  ships of one job apart, and running it again after a stop resumes at the failed step and
  never merges twice. Detached by default (log `ship-<id>-<stamp>.log`, a runner of mode
  `ship`); `--force` ships a `failed` or `gate` job's pull request. `queue status`, the MCP
  `queue_status` and doctor's new `ships` row show ships in flight, stopped or stalled;
  `queue.shipTimeoutS` (default 600 s) bounds a ship. It never stashes, deletes a branch,
  resolves a real conflict, retries the run or ships on its own.
- The resolve skill opens with the orchestrator's contract: it coordinates and nothing
  else - it never reads source code, explores the repository or reviews a diff; what it
  needs reaches it as a handoff file under the run directory or a subagent return of at
  most 10 lines (verdict, the file written, open items - never file contents, never a
  diff), in every tier. Its channels are the run's handoff files, the plugin's own files,
  the `nightqueue` MCP tools, the `Agent` tool and a closed Bash list.
- Phase 6.5 is a runtime lane: the verifier in `Mode: RUNTIME` runs the API / browser /
  emulator / acceptance cases, writes `06-runtime.md` (`## Runtime verdict`:
  `CONFIRMED | NOT-MET | SYMPTOM-PERSISTS | NEEDS-DEVICE | UNAVAILABLE`, plus
  `Diff applies plan:` on a bug) and its evidence files; `nightqueue run check 06.5`
  gates it. The same lane measures main for Phase 0.6 (`00-main-measure.md`). The runner
  creates the run directory before the session starts.
- The coder writes `04-implementation.md` in every tier (`## Modified files`, `## Done`,
  `## Left`, `## How it was tested`), one coder lane per numbered stage, and the verifier
  writes `evidence/automated-verification.md`.
- Inside a queued job, the `PreToolUse` hook scopes the orchestrator's own main thread
  (a call with no `agent_id`): `Read`/`Grep`/`Glob` only under the job's runs, the plugin
  and the host's tool-result spill of its own session only (`<dirname(transcript_path)>/<session_id>/tool-results/`),
  and `Bash` only for the closed list (`git rev-parse|worktree|status --short|add|commit|push|fetch|
  branch --show-current|diff --stat…` - never `commit --amend`, a forced, deleting or mirroring
  push, a global flag such as `-C`/`-c`/`--git-dir` nor a path to the binary -, `gh pr
  view|list|status|checks|create`, `nightqueue run check|log|index-save|commit|pr`). Anything else is denied with a reason that says to
  hand the work to the phase's subagent. Subagents and sessions outside a job are
  untouched, and the check fails open.
- Each job records what its orchestrator did (schema v14): `orch_turns`, `orch_reads`
  (reads outside the allowed roots), `orch_bash`, `orch_bash_explore` (Bash outside the
  closed list) and `orch_ctx_last` (the last turn's context), counted from the stream and
  summed over attempts. `queue status <id>` (human, `--json`, MCP) shows all five, zero
  included, and `nightqueue doctor` sums them over the last 20 finished jobs in an
  `orchestrator` row that warns when a read or an exploration Bash shows up.
- An unattended job now runs isolated from the operator's own environment by default:
  `--strict-mcp-config --setting-sources project,local` plus a `--settings` payload
  carrying only this package's own hooks and a `claudeMdExcludes` entry that keeps the
  operator's own `CLAUDE.md` out of the ancestor walk. A job sees only this package's
  MCP server, plugin and hooks, plus the project's own settings - never the operator's
  own MCP servers, plugins, skills, agents or user hooks (measured on the real spawn
  path: 39 MCP servers, 95 skills, 20 agents and a ~114k first turn before; 1, 21, 11
  and ~68k after). `queue.inheritUserEnvironment: true`
  restores the old, unfenced behaviour; `nightqueue doctor` reports which mode is in
  effect in a new `job environment` row.
- Each job records `baseline_ctx` (schema v13): the input, cache-read and
  cache-creation tokens the orchestrator's FIRST turn already carried before the run
  did anything of its own, from its first attempt that started fresh (a `--resume`
  attempt records none). Shown by
  `queue status <id>` (human, `--json`, MCP) the same way `bash_timeouts` is shown.
- The runtime configures the `claude` it spawns for a job:
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` plus `BASH_DEFAULT_TIMEOUT_MS` and
  `BASH_MAX_TIMEOUT_MS` from the new `queue.bashTimeoutS` (default
  `{ "default": 900, "max": 3600 }` seconds). A command that outlives its timeout now
  dies in the foreground with `Command timed out` instead of being moved to the
  background and killed later as an orphan task; an inherited value of these variables
  never leaks into the child. When a job's stream still shows a backgrounded task, its
  notice and the runner log get one warning line.
- Each job records `bash_timeouts`, `tasks_backgrounded` and `tasks_killed` (schema v12),
  shown by `queue status <id>` (human, `--json`, MCP) only when not zero, and
  `nightqueue doctor` sums them over the last 20 finished jobs in a `host commands` row.
- A long-lived MCP server that runs a superseded runtime says so in the hints of
  `queue_status`, `queue_run` and `queue_add`.
- A detached runner is launched from the installed current runtime, never from the tree
  of the process that started it, and its registration names that tree.
- `npm test` runs with `--test-timeout=60000`, so a hung test fails in 60 s by name.

- `nightqueue queue status <id>` (CLI, human and `--json`, and the MCP tool
  `queue_status` with `job_id`) now also answers `run_notice` whenever the
  run's own `## Notice` - read fresh from the log the row's `result.logPath`
  names - differs from the row's `notice_md`: both are shown, the row's under
  `notice` and the run's whole own, never truncated, under `run_notice`. A
  pure read: no write, no network, and a missing or unreadable log simply
  leaves the field absent.
- `nightqueue queue run --watch --from HH:MM --until HH:MM` works the queue inside
  one local wall-clock window and exits at its end. `--from` defaults to now;
  `--until` is always the next occurrence of that time after `from`, so a window
  that crosses midnight (`--from 22:00 --until 04:00`) needs no special syntax.
  Before `from` the runner is alive and registered but claims nothing; at `until`
  it stops claiming, the job it is running finishes - the window never kills or
  shortens a job's own timeout - and the process exits `0` with its registration
  gone, printing `window closed at 04:00 - 3 jobs still pending` when jobs are
  left. `queue status` shows the window on the runner line
  (`watch every 60 s · window 22:00-04:00 · opens in 3h12` / `· closes in 5h40`),
  and `queue status --json` and the MCP `queue_status` carry
  `window: { from, until }` as ISO instants. The window is one-shot: nightqueue
  starts no scheduler and no runner ever starts another runner, so a recurring
  overnight run is an OS-level job (`launchd`, `systemd`) the operator sets up.

- `queue.keepAwake` (`"auto"` default, `"always"`, `"off"`) keeps the machine from
  sleeping while a runner or one of its jobs is alive. On macOS every runner holds
  a `caffeinate` process bound to its own pid (`-s` on AC power under `auto`, `-i`
  under `always`), and an extra `-i` hold is bound to a job's child while it runs;
  each hold dies with what it was protecting. It is a no-op on every other
  platform, and a missing or failing `caffeinate` only warns once and never fails
  a runner or a job. The display can still sleep and nothing here wakes an
  already-sleeping machine, so a windowed night run needs the lid open (or an
  external display). `nightqueue doctor` reports the mode, whether `caffeinate`
  was found, and this same limitation.

- `nightqueue decision update <number> --status accepted|rejected|superseded
  [--superseded-by <n>]` settles a proposal a closed job left behind, or
  changes a decision's status by hand, from the terminal - the same write the
  MCP tool `decision_update` does. `superseded` requires `--superseded-by
  <n>`, the number of the decision that replaced it (of the same owner); any
  other status refuses that flag. It prints the updated decision the way
  `decision show` does.

- `nightqueue queue session <id>` and the MCP tool `queue_session` open the
  `claude` session of a job's LAST attempt - `last_session_id` when the job
  recorded one, else its first `session_id` - and resume it with `claude
  --resume <session>` in the cwd the run itself used: the run's worktree while
  it is still on disk, or the project's checkout once it was released, flagged
  `worktree_released: true` (`(worktree released, using the checkout)` on the
  CLI). A `pending` or a `running` job is refused by name, and so is a job that
  never reached the agent. `--print` prints the equivalent `cd <cwd> && claude
  --resume <session>` line instead of running it, and `--json` prints
  `{ jobId, attempt, session, cwd, worktreeReleased, command }`; the MCP tool
  only ever reads and never resumes or executes anything itself.

- `nightqueue decision export <number> [--dir <path>] [--force]` writes one
  decision as `<dir>/<nnnn>-<slug>.md` (default `docs/decisions/`), reading
  the database read-only like `show`. `nightqueue decision import <file.md>
  [--status <status>] [--superseded-by <n>] [--supersedes <n,...>] [--unrelated
  <n,...>]` reads that shape - or a hand-written ADR of the same one - back
  through the same review `decision_save` uses, prints `imported as <label>`
  and stamps the pointer line into the file's header so a re-run of the same
  file is refused as already imported. The runtime itself never reads
  `docs/decisions/`; publishing an exported file stays a deliberate pull
  request of the operator.

- `decision_save` (and `decision import`) is gated against the owner's own
  log: before saving, the title, and for the MCP tool the title plus the
  decision text, is checked against every accepted and proposed decision of
  the same owner, lexical and semantic. An overlap saves nothing and answers
  `needs_review` with the candidates it found; the caller names every one of
  them on a second call - `supersedes <n,...>` for the ones the new decision
  replaces WHOLE (they become `superseded`, pointing at the new row, in the
  same transaction), `unrelated <n,...>` for the ones it leaves untouched.
  Inside a queue job `supersedes` is refused outright, a second proposal while
  the first is still `proposed` is refused too, and the saved row is stamped
  with the job's `job_id`.

- `nightqueue queue close <id>...` and `nightqueue queue close --merged` now
  settle the decisions the jobs they close proposed and never settled: on a
  TTY, without `--decisions`, each open proposal is asked `accept / reject /
  keep` (default `keep`); `--decisions accept|reject|keep` answers every one
  without asking, and no terminal or `--json` keeps them all `proposed`. Each
  settled proposal prints a `decision <label> <title>: accepted|rejected|kept
  (proposed)` line, and `--json` carries them under `decisions`. The MCP
  `queue_close` still only closes the job and leaves its proposals alone.

- `nightqueue doctor` gains two more `warn` checks. `worktree <project>/<dir>
  left over` names, for every registered project with a `.claude/worktrees/`
  directory, each directory there that no open job still owns, with the exact
  command that cleans it (`git worktree remove`, `git worktree unlock && ...
  remove`, or `rm -rf` for one orphaned from git) - it never runs that command
  itself. `decision proposals` names every decision a queue job proposed and
  nobody settled before its job was closed, by number and job, with the hint
  to settle it with `decision_update` or, next time, with `nightqueue queue
  close <id> --decisions accept|reject`.

- The block the `SessionStart` hook injects now carries the title of EVERY
  accepted decision of the project and of its org under `## Standing
  decisions`, not only the closest few, followed by `## Standing decisions in
  detail` with the text of the 8 most recently updated, and a `## Proposed
  (not binding)` section listing the title of every decision still `proposed`
  - nobody accepted it yet, so it binds nothing. Each section keeps to its own
  budget so the lessons always keep a floor, giving way to an omission line
  first.

- `nightqueue run pr` checks the body against the target repository's own pull
  request template first. It resolves the run's checkout, then takes the first
  of `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`,
  `docs/PR_TEMPLATE.md`, or a pull request section of `CONTRIBUTING.md` or
  `CLAUDE.md` (the first fenced markdown block of that section carrying
  headings); it prints `TEMPLATE:` and `HEADINGS:` and records them as a
  top-level `prTemplate` in `state.json`. A body must carry every heading of that
  template in its order, and no nightqueue heading the template does not have.
  `nightqueue run pr --template` prints and records the template alone, reads no
  body and pushes nothing, so Phase 7 reads it instead of deciding.

- `nightqueue queue close <id>` and the MCP tool `queue_close` (twenty-four tools
  now): the operator's act that takes a delivered job from `done` to `closed`.
  Any other status is refused by name and nothing is written; `pr_url` is kept.
  A runner's witness can never close a job.

- A subagent of an unattended run is never killed for taking too long to answer.
  The runner starts the agent with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, so
  the CLI waits for every background task the run still has open instead of
  killing one after ten minutes and exiting `0`; the job timeout and the idle
  timeout already bound the attempt. A new `PreToolUse` hook,
  `nightqueue hook agent-foreground`, closes the other half: inside a job it
  rewrites every `Agent`/`Task` launch to `run_in_background: false`, whether the
  call asked for the background or simply left the field out. It normalises the
  call and never blocks it, and `setup` and `doctor` now register and check four
  hooks instead of three.

- A pending job a preflight block is holding back is now visible instead of
  looking like it is only waiting for a runner: `jobs.blocked_code` is an
  orthogonal column, the same shape `notice_md` already carries beside a
  `gate` - `status` answers where the job is, `blocked_code` answers why it
  is not moving right now. `queue status` breaks it out of the pending count
  (`pending=3 (1 blocked)`), shows `⛔ <code>: <message>` in the table and the
  detail view, and a new `--blocked` filter lists only those jobs; the field
  is exposed the same way on `queue_status` (MCP). `blocked` is not `gate`:
  a gate needs `queue_retry`, a block clears itself the moment the drain
  claims the job again, once the operator fixes the cause.

- `nightqueue run` is the family the pipeline calls from inside a job, each
  subcommand acting on the run of the job it was called from: `run check <NN>`
  is the artifact gate of a phase (`OK`, `MISSING: <sections>`, or `GENERATED`
  when it derives `## Modified files` from the changes of the worktree),
  `run log` prints the phases of the run with the model and the duration the
  runtime measured, `run commit` stages exactly what the implementation listed
  and refuses `.claude/`, `tmp/`, any lockfile and any path outside the
  worktree, and `run pr` checks the body, renames the branch the worktree
  mangled, pushes it, opens the pull request and records the outcome. Naming
  another run from inside a job is refused; outside one, `--project` and
  `--slug` are required.

- Five MCP tools, twenty-three in all. `run_phase_done`, `run_terminate`,
  `run_outcome` and `run_set` record the run in `state.json` - the phase
  completed, a deliberate stop, how the run ended and the fields of the run
  itself - and `run_outcome` with `status: "done"` also closes the roadmap item
  the job came from. `context_for_phase` returns the whole context block of one
  pipeline phase, already formatted, so a subagent prompt is one call instead of
  two plus the bookkeeping of what the run had already been given.

- The block the `SessionStart` hook injects opens with `## Standing decisions`:
  the accepted decisions of the project and of its org, one line each, before
  the lessons and the memories it already carried.

- The mechanical work the pipeline's subagents used to describe in prose is now
  three runtime commands. `nightqueue verify [--scope touched|full|+poc]
  [--files <list>]` detects the project's own checks from its lockfile and
  manifests and runs them in the fixed order typecheck, lint, build, test, poc,
  diff-hygiene, printing one `PASSED|FAILED|SKIPPED <check> <duration_s>s` line
  each and exiting `1` on any failure; a workspace root runs the checks its
  members declare, each in its own package, and a run that detected nothing says
  so instead of reading as a clean pass; it never installs anything, never writes
  the repository under test, and spawns every check against a throwaway
  `NIGHTQUEUE_HOME` and `CLAUDE_CONFIG_DIR`. `nightqueue libs <name>...` prints
  the version of each lib actually installed, read from the lockfile, never the
  range. `nightqueue run` also holds two steps the subagents call: `index-save <artifact>` persists the
  `## File map` and `## Third-party libraries` of an explore artifact into the
  project index, and `secrets-sweep --files <list>` reports the log calls whose
  arguments - or the lines those arguments are built from - may carry a secret.
  A job spawned by the queue now also carries an `Open pull requests matching
  this job:` block, looked up once before the spawn without blocking the dispatch
  of the other jobs, with a 5 s timeout and skipped entirely under
  `NIGHTQUEUE_NO_PR_CHECK=1`; the titles and branches it carries are framed as
  untrusted data and capped, since whoever opened the pull request wrote them. The six agent files stopped
  doing all of that by hand, so what they do is now testable from `test/`
  instead of only observable in a run. Documented in `docs/cli.md`.

- `nightqueue sandbox <command> [args...]` runs one command, its arguments
  forwarded verbatim, against a throwaway `NIGHTQUEUE_HOME` and
  `CLAUDE_CONFIG_DIR` created before the spawn and removed once it exits,
  whatever the exit code - the same isolation `verify` gives its own checks,
  now available for a `nightqueue` command typed by hand. Stdin, stdout,
  stderr, the rest of the environment and the current directory are inherited
  unchanged, and the exit code is the child's own.

- `nightqueue queue repair <id>` re-derives the outcome of a job left in `gate`
  or `failed` from its own log and its own `state.json`, and writes the
  corrected row and witness. It is the way to settle a job that really opened a
  pull request but was recorded without it, with no hand-edited database. It
  never runs by itself: the automatic witness sweep is unchanged.

### Fixed

- A kill now fails the run only when it ended it. Before this fix, ANY
  `task_updated {status: "killed"}` in the last attempt made the job `failed`
  with a fixed notice ("...after its wait ceiling; the run did not finish;
  ...the hook did not run"), even when the run went on for hundreds more
  lines, opened its pull request and wrote its own `## Notice` - the real
  notice was then lost (job #49). A kill is now TERMINAL only when the CLI's
  own wait-ceiling line is in the log (it literally says "terminating"), or no
  `result` event carrying a `## Notice` ever followed it AND `state.json`
  recorded no outcome of its own; a terminal kill still fails exactly as
  before, with a notice that now says only what the stream proves: the
  ceiling clause only with the raw line, "; the run did not finish" only with
  no settling notice, and a hint naming what happened to the killed Bash call
  - launched with `run_in_background: true` (the hook should have caught it)
  or moved to the background by the Bash tool's own timeout, never both. A
  non-terminal kill classifies exactly as if it had never happened
  (`done`/`gate`/`failed` from the run's own record), with one line appended
  to whatever notice results, never replacing it: `⚠️ a command was
  abandoned mid-run: <command, truncated to 120 code points>`. `queue repair`
  and the runner's own retry decision follow the same terminal/non-terminal
  read.

- `queue status <id>` no longer shows `run_notice` as a second, near-identical
  copy of `notice` when the two differ only by a line the runtime itself
  appended to the row's notice (the kept-worktree line, the abandoned-command
  warning, the disabled-background escape) or by trailing whitespace - the
  comparison now sets those aside first (job #52, whose `## Requires user
  confirmation` gate printed the same block twice).

- `nightqueue queue status --follow` redraws the table over itself on a
  terminal instead of clearing the screen every tick, which piled one copy of
  the table per tick in the scrollback of iTerm2 and Terminal.app. The frame
  is cut to the width and the height of the terminal (`… +N more lines` when
  the queue is taller), the cursor is hidden while it runs and given back on
  the way out, and a resize redraws from the top. A pipe still only prints
  what changed.

- A run the CLI killed at its background-wait ceiling is no longer recorded as a
  job waiting for a decision. A stream carrying the ceiling line, or a task the
  CLI marked `killed`, is a failure whatever the final text says, whatever
  `state.json` recorded and even with a pull request in it, and the reason names
  the background task that was killed. The same pass tightened the gate itself: a
  clean exit with no pull request only waits for a human when the run actually
  asked for one - by recording the gate in `state.json` or by printing
  `## Requires user confirmation` - and is `failed` otherwise, keeping its final
  text as the reason. A last line like "Verifier running. Waiting for its
  verdict" used to be enough to buy a gate; it now reads as what it is, a run
  that stopped without delivering. Neither is a transient failure, so no attempt
  is spent re-running one, and `queue retry` takes both without `--note`.

- A retried job no longer degrades into a clean run. The job keeps the slug and
  the run directory of the attempt it is resuming, the resume is counted in
  `state.json` by the runtime, and the pipeline reads the phase to resume from
  out of the prompt instead of re-deriving a decision it could get wrong.

- The roadmap item of a job is closed by every path that lands its row on
  `done`, not only by the live finalize: `nightqueue queue repair`, the
  reconciliation from the witness and `run_outcome` all go through the same
  closure in the store, so a job that really delivered never leaves its item
  queued.

- The pull request of a run is read from the `code_change_published` event the
  host emits when it publishes the change, ahead of the record in `state.json`
  and of the text of the session: a run whose final message contradicts what it
  really published is no longer recorded without its link. Only an event with
  `action: "created"` for the run's own repository counts, so a pull request the
  session opened for another repository - or an event about a pull request it
  closed - is never delivered as the run's own, whichever arrives last.

- `state.json` is written under a lock of its own run. The pipeline's record is
  now written from two processes - the MCP tools of the agent and the queue
  runner - and each read and its write are one critical section, so a phase the
  agent recorded is no longer erased by a fact the runner recorded at the same
  moment.

- `nightqueue run commit` refuses `.claude/`, `tmp/` and the lockfiles whatever
  the case of the path: on a filesystem that resolves `.Claude/hook.js` to
  `.claude/hook.js`, the refusal used to be walked past by spelling the
  directory differently, in the list of the implementation and in `--extra`.

- The reason a gated job carries is the `## Notice` the run itself wrote, not
  the summary the pipeline had recorded in `<RUN_DIR>/state.json`: a gate was
  stored with a one-paragraph digest where the run had written the whole
  explanation, and the operator answered it without ever reading what it said.
  `state.json` keeps ruling the status (the pull request URL now comes first from the
  `code_change_published` event, see below), and its summary
  stays the fallback for a run that printed no `## Notice`, with the whole final
  text of the orchestrator as the last resort. `nightqueue queue repair <id>`
  now also writes a correction that is only a notice - it compared the status
  and the pull request URL alone, answered that there was nothing to correct and
  dropped the text it had just re-derived - and it leaves the witness of the run
  untouched when nothing but the notice moved. `queue log` and the refusal of
  `queue retry` say where the whole notice is read (`nightqueue queue status
  <id>`) when they had to cut it, which `queue status <id>` never does: a gate
  is answerable again from the detail of the job.

- `lesson_save` no longer loses a lesson because the payload arrived
  incomplete: `root_cause`, `solution` and `prevention` are now optional at the
  MCP boundary, and `attempts` below 2 is stored as `null` instead of refusing
  the call. A missing `title` still refuses, but with a one-line message
  naming it instead of the full contract dump. The answer now carries
  `incomplete`, the fields still empty, so a follow-up call with the same
  title fills in only what was missing. A lesson stored with an empty
  `prevention` has nothing to inject and is excluded from `lesson_recall`,
  though it stays visible in the CLI. `decision_save` mirrors the same
  tolerance: a missing or invalid `status` is stored as `proposed` instead of
  refusing the call, and the answer flags it with `status_defaulted: true`.

- A run that opened its pull request and then said one more sentence was
  recorded as `gate` with no pull request URL. Of the three signals the runtime
  read from the session, two already looked back over the whole run and the
  third read only the last message, so a delivery announced one message earlier
  was lost. All three now look back the same way. The pipeline also records the
  outcome of a run in `<RUN_DIR>/state.json`, and the runtime prefers that
  record over the text it reads from the session for the status and the pull
  request URL: a run that describes its own result in different words is no
  longer misread. The text stays the fallback.

- `nightqueue queue status --follow` and the MCP `queue_status` tool read the
  queue on a read-only connection opened for that poll alone, instead of the one
  connection cached for the whole life of the process. A job another process
  finished, merged or repaired is rendered on the next poll, where a session
  could keep showing it as `running` for hours; and a follow with nothing to
  merge and nothing to repair no longer opens a write connection at all.
- `roadmap_update` now answers with the linked decision number and the status of
  the job the item was queued as, the way `roadmap_get` already did. Its answer
  read the item without joining those two tables, so both fields always came back
  empty - the link itself was never lost.

- The MCP server reports the installed package version to its client. It declared
  `0.1.0` in a constant that no release touched, so Claude and `claude mcp list`
  showed an MCP two versions behind the CLI running it.

### Changed

- The `PreToolUse` hook matcher is now `Agent|Task|Bash|Read|Grep|Glob`. An existing
  install picks it up only after `nightqueue update` or `nightqueue setup`;
  `nightqueue doctor` warns (`registered with an older tool matcher`) meanwhile. Known
  limits: the hook enforces `Read`/`Grep`/`Glob`/`Bash` only - an orchestrator
  `Write`/`Edit` into the repository is forbidden by the skill but not denied at runtime;
  and every `Read`/`Grep`/`Glob` of every session on a machine with the hook installed
  now starts the hook process (about 120 ms), which answers nothing outside a job.
- `queue status <id>` separates a field name from its value by at least one space, so a
  name longer than 15 characters (`orch_bash_explore`, `tasks_backgrounded`) no longer
  glues to its value.

- Inside a queued job, the `PreToolUse` hook now also sees `Bash`: a call with
  `run_in_background: true` is rewritten to the foreground with the same
  reason a subagent launch already got, and a command that scans from the
  filesystem root or the home (`find`, `grep -r`, `rg`, `ls -R` against `/`,
  `~` or `$HOME`) is denied, naming the worktree or the project checkout
  instead. The hook matcher is now `Agent|Task|Bash`, and a runtime kill of a
  Bash task quotes the command's first 120 characters and says the hook
  should have kept it in the foreground.

- Schema v11: `decisions.job_id` stamps the job that proposed a decision, read
  by the new `decision proposals` check of `nightqueue doctor` and by the
  settlement `nightqueue queue close` runs on every job it closes.

- A gate's notice is now the `## Requires user confirmation` block of the
  plan, verbatim, plus the answer line - no length cap, no summary. A notice
  missing that heading, or shorter than the plan's own confirmation section by
  more than 200 code points, is recorded `failed` with a fixed notice pointing
  at the plan instead of `gate`.

- `git worktree list --porcelain` is now read without `-z`, which git older
  than 2.36 refuses (`unknown switch 'z'`): the doctor's leftover-worktree
  check and the worktree lock lookup used to see every worktree as unreadable
  on a host like Ubuntu 22.04 (git 2.34), and now both parse the plain
  porcelain output they already supported.

- A job's worktree now lives as long as the job. `finalize` removes it once a
  `done` run is clean and its branch is pushed (or a pull request is
  recorded); `nightqueue queue close`, `queue close --merged` and the MCP
  `queue_close` apply the same rule to every job they close. A dirty,
  unpushed or locked worktree is kept instead, and a `Worktree kept: <path> -
  <reason>` line is appended to the job's existing notice rather than
  replacing it.

- The nightqueue pull request template is now only the fallback, and its shape
  changed: `## Report`, `## Cause`, `## Changes`, `## QA`, where `## QA` is a
  `| Method | Executed | Result |` table with one row per method that really ran
  (Automated, API, Browser, Android / iOS emulator or device, never `N/A`)
  followed by a `Not tested:` line, and every row needs a non-empty
  `<RUN_DIR>/evidence/<method>-*` file. Each violation prints its own
  `MISSING: <what>` or `REJECTED: <reason>` line, the evidence one reading
  `MISSING: evidence for QA row <method>`, and nothing is pushed. It replaces the
  `## Summary`/`## Changes`/`## QA` + `Verdict:`/`Proven:` shape: a body written
  by a plugin older than this runtime is now `MISSING`. The Track routing table
  gains a `QA methods of the PR` row mapping an API change to automated + api and
  a UI change to automated + emulator (Expo) or browser (web).

- Every read of the queue is a pure read. `queue status`, `queue status --follow`
  and the MCP `queue_status` render one view built from SELECTs and file reads
  alone: no network, no database write, no file write. The pull request of a job
  is shown as a derived `pr_state` (`merged` > `closed` > `conflicted` > `draft`
  > `unknown` > `open`) from a process-local cache that gh refreshes outside the
  frame, never stored; a merged pull request on a `done` job adds the suggestion
  `#<id> PR merged - close it with nightqueue queue close <id>` instead of
  rewriting the row. Repair and prune are maintenance, owned by the runner cycle,
  the one-shot `queue status` and a 60 s timer of the MCP server; `--follow`
  never writes. The follow sleeps what is left of its interval and its footer
  states the cadence it achieved and what each part of the read cost; `--json`
  and `queue_status` carry `pr_state`, `suggestions` and `sections`. A follow
  behind a gh that takes 2 s to fail now redraws as often as one with the checks
  off (11 against 11 frames in 22 s, from 3 against 11).

- A runner now works one job at a time, in queue order; parallel jobs come only
  from starting more runners, and no start is refused because another runner is
  live.

- `queue.maxConcurrent` defaults to no ceiling. A positive integer still sets a
  hard ceiling across every runner of the home, and anything else means none.
  **Upgrade note:** a home whose `config.json` was written by an earlier version
  already carries `"maxConcurrent": 2` from the old default and keeps that
  ceiling; delete the key, or set it to `null`, to run without one.

- `queue run --max <n>` is now a budget for the run instead of a concurrency
  limit: the runner exits after n jobs that reached the agent, printing
  `queue: stopped - the --max budget of this run is spent`, for a drain, a
  `--watch` and a single foreground cycle alike. A job the preflight releases
  does not count. `--dry` reports it as `max`, next to `cap`, both `none` when
  unset.

- Advisory lines warn, without ever blocking a start, when the five-hour window
  of the provider is at 80% or more while runners are live
  (`5h window at NN% · K runners active — ...`) and when two or more runners
  work one repository (``N runners on `<project>` — ...``). They follow the
  runner lines of `queue status`, are echoed once by every start (on stderr
  by a foreground run under `--json`), and are answered as `advisories` by `queue status --json`,
  `queue_status` (also appended to its `hint`), `queue_run` and `queue_retry`.

- `state.json` is written by the runtime alone. Every key of the run - the
  phases, the termination, the outcome, the type, the tier and its raise, the
  branch, the worktree, the QA stage A marker and the resume count - goes
  through one writer, called by the `run_*` tools, by `nightqueue run pr` and by
  the runner itself; the pipeline no longer writes the file, no longer stamps a
  time and no longer counts its own resumes. An `updatedAt` an older plugin
  hand-writes is overwritten by the runtime's clock instead of being trusted.

- The run comes named in the prompt. The runner opens the run directory before
  spawning anything and hands `Project:` and `RUN_DIR:` over, plus a
  `RESUME CANDIDATE` block carrying the branch, the worktree, the last completed
  phase and the phase to resume from, so the decision is taken once, by the
  runtime. A run renames itself with one `SLUG: <slug> TYPE: <type>` line, which
  moves the directory with its artifacts inside it; `QUEUE_SLUG:` is deprecated
  in favour of it and still read, for a plugin older than this runtime.

- `pipeline_log` records what the runtime measured. The total duration, the
  per-phase durations and the model of each phase are read from the stream of
  the job and overwrite what the call sent; `project`, `slug`, `tier`,
  `task_type` and `tier_raise_reason` are resolved from the job's own row and
  from `state.json` when the call leaves them out. The pipeline sends judgment
  only, and never times a phase itself.

- Every SQLite access now goes through an async store obtained from
  `openStore(env)` / `openStoreReadOnly(env)`: `src/store/` is the only path from
  the rest of the code to the database, and `src/memory/` became its private,
  synchronous implementation. Internal only - no command, output, hook or MCP
  tool changed.

- `decision_save` defaults a missing or invalid `status` to `proposed` instead
  of `accepted`: a decision recorded without a clear status now injects
  nothing into a future recall until someone accepts it.

### Removed

- The `merged` job status and the `done -> merged` sweep that `queue status`, the
  runner and `queue_status` ran on every read. The v9 migration turns every
  `merged` row into `closed` (keeping `pr_url`, `merged_at` and `merge_sha`) and
  drops `jobs.pr_checked_at`; it runs on every open, read-guarded, so a row an
  older build writes back is healed on the next one. `counts.merged` and
  `jobs[].pr_checked_at` are gone from `--json` and `queue_status`.
- `jobs.merged_at` and `jobs.merge_sha`. Nothing has written them since the
  sweep left, so they held values frozen from the old sweep on migrated rows
  and stayed empty on every job closed afterwards. The v10 migration drops both
  the same read-guarded, idempotent way, and `merged_at`/`merge_sha` are gone
  from `queue status --json` and `queue_status`.

## 0.2.0 - 2026-09-14

### Fixed

- `nightqueue org rename` records its intent before touching either store, so a
  rename interrupted between the database and the config no longer hides the
  org's decisions and roadmap items with nothing pointing at them. `nightqueue
  org repair` settles the interrupted rename in the direction the config already
  committed (forward or back, idempotent), and moves rows that point to an org
  the config does not know under the org named with `--to`. `nightqueue doctor`
  gains an `org rows` line that fails on either state, and `org rename` and `org
  remove` refuse to run while a rename is still in flight.
- The output of `npm pack --json` is read in both shapes npm prints: the array
  of npm 10 and 11 and the object keyed by package name of npm 12. Every reader
  goes through one `parsePackOutput` - the runtime install of `setup`, `init`
  and `update`, `release:check` and the package tests - so a host on npm 12 no
  longer fails to install its own tarball with "printed no tarball name".
- `npm run release:check` refuses a changelog that still carries content under
  `## Unreleased` while the manifest declares the version of the top released
  entry, because a publish from that state ships changes the released entry does
  not describe - and npm rejects the duplicate version only after the pack.

### Added

- Org-scoped decisions and roadmap: a decision or a roadmap item now belongs to
  exactly one owner - a project or an org - and is numbered inside it (`#7` per
  project, `acme#3` per org, enforced by the database). A write names `project` or
  `org`, never both; a read by `project` answers the project's rows PLUS its
  org's, org rows first and each carrying its `scope` and its `owner`, while a
  read by `org` answers that org's rows alone and no other org's. Phase 0 of
  `/resolve` injects both levels in the same single `decision_recall`,
  `nightqueue decision list --org <name>`, `nightqueue decision show <number>
  --org <name>` and `nightqueue roadmap --org <name>` read an org from the
  terminal, and `nightqueue org rename` carries the rows of the org with it while
  `org remove` refuses an org that still owns any. An org roadmap item becomes a
  job with an explicit `--project <name>` (`project` in `queue_add`) of that org,
  or the project of the current directory: it stays `open` and unlinked, so the
  same item is queued for every project of the org and only the operator closes
  it. The schema migrates by itself to v6 - every existing row reads as
  `scope='project'` and keeps its number, with no manual step.
- Versioned runtime: an install writes a new
  `~/.nightqueue/runtime/versions/<version>-<stamp>/` and publishes it by
  renaming a symlink onto `~/.nightqueue/runtime/current`, in one step, so no
  instant leaves the host without a runtime and a failed install never touches
  the link. The shims, the MCP server, the hooks, the Claude Desktop entry and
  the plugin marketplace all resolve through `current`, a process that is
  already running keeps executing the directory it loaded from, and the last two
  version directories are kept - never the one `current` names, never the one a
  live runner recorded. `doctor` reports the installed version and the directory
  it resolves to, and an installation still at the old
  `runtime/node_modules/` layout keeps working and is never deleted by an
  install. The decision is recorded in
  `docs/decisions/0003-versioned-runtime-single-runner.md`.
- A terminal write is now durable, verified and witnessed: the transaction of a
  finish commits with `PRAGMA synchronous = FULL`, a fresh read-only connection
  reads the three terminal columns back, a mismatch is reported as `finish
  verification failed` in the log of the job and on stderr and retried once, and
  the write-ahead log is checkpointed afterwards. The same shape guards the
  `pipeline_log` insert. The runner then writes `terminal { status, prUrl,
  finishedAt, writtenBy, pid }` into the `state.json` of the run, and
  `nightqueue queue status`, every runner cycle and the MCP `queue_status`
  restore any job whose row still says `running` or `pending` while that witness
  says how it ended, marking the result `repairedFrom: "state.json"`. A job
  under a live lease is never touched, and a retry clears the witness so the
  previous attempt can never close the next one.
- A runner records the version directory it loaded from, and watches it: when
  that tree disappears it warns once, finishes the job it is running and exits
  without claiming another. `queue status` and `doctor` name the runtime of the
  live runner.
- A terminal `merged` status for the queue: a job that delivered a pull request
  is checked with `gh pr view` and becomes `⇡ merged` once that pull request is
  merged, carrying the instant of the merge in `merged_at` and the commit in
  `merge_sha`, both in `queue status <id>` and in `--json`; a closed or open
  pull request only updates `pr_checked_at` and the job stays `done`. The check
  runs at the start of `queue status` (every `--follow` tick included), of every
  runner cycle and of the MCP `queue_status`, over at most ten jobs and at most
  once per job every five minutes, never inside an unattended job session and
  never in a hook. It fails open and in silence - with `gh` missing, logged out
  or offline nothing is written, nothing is printed and the command still exits
  `0` - and `NIGHTQUEUE_NO_PR_CHECK=1` switches it off. `queue cancel` and
  `queue retry` refuse a `merged` job, and `queue retry` still accepts only
  `failed`, `cancelled` and `gate`.

- The operator sets the risk tier of a job, and the pipeline runs the track of
  that tier: `nightqueue queue add --tier trivial|simple|complex` and the `tier`
  parameter of `queue_add` store it in a new nullable column of `jobs` (one
  migration, schema v5), `nightqueue queue status <id>` and the `--json` of the
  list and the detail show it, and the unattended prompt carries the line
  `Tier: <tier> (set by the operator - the pipeline may only raise it, with
  evidence, never lower it)` into the run. The `/nightqueue:queue` skill proposes
  a tier, names it in the single confirmation it already asks and lets the user
  override it in that same answer. `/resolve` gained three tracks: `trivial`
  (coder plus a verifier on tsc, lint and the tests of the touched files, under 5
  minutes), `simple` (a triager only when the request is a bug, then a coder and
  a verifier on the FULL test suite, under 15 minutes, with no architect and no
  qa-guardian) and `complex` (the whole pipeline, unchanged). The mandatory
  escalation to `complex` whenever a fix changed a condition is gone: a tier is
  raised only on evidence found, never on the shape of the change, and the raise
  is written into the Brief as `Tier raised: <from> -> <to>: <evidence>`. An
  operator tier is never lowered. `pipeline_log` records `tier_operator` and
  `tier_raise_reason` next to the final `tier`, so a raised run is the runs whose
  two tiers differ, with the evidence beside them.

- Decisions and roadmap, per project and private to the home: a numbered
  decisions log (context, decision, consequences and a status among `proposed`,
  `accepted`, `superseded` and `rejected`) and a `now`/`next`/`later` roadmap,
  both reachable through seven new MCP tools and never written into the
  repository. `queue_add` with `roadmap_item_id`, and its CLI twin
  `nightqueue queue add --roadmap <id>`, build the job prompt from a roadmap
  item, its linked decision and the accepted decisions around it instead of
  asking for it again, mark the item `queued` and close it as `done` when the
  job finishes. `/resolve` recalls the accepted decisions as the
  `## Standing decisions` of its Brief, passes them to the architect as binding
  constraints, and records the decision a plan takes as `proposed` for the
  operator to accept on the pull request. Three read-only commands print all of
  it in a terminal: `nightqueue decision list`,
  `nightqueue decision show <number>` and `nightqueue roadmap`, each resolving
  the project from the current directory when `--project` is omitted, opening
  the database read-only - they never create it, and a home where nothing was
  saved reads as an empty one. Inside an unattended run, `decision_update` and
  `roadmap_update` only accept ids of the project of the job that is running,
  and the operator text a roadmap prompt carries is escaped, so it can never
  forge one of the prompt's headings nor a literal of the runtime contract.
- Release by tag: pushing a `v*` tag publishes the package to npm with
  provenance, through OIDC trusted publishing and without any npm token in the
  repository, and opens the GitHub Release of that tag with the CHANGELOG
  section of the version. A second workflow runs the suite on Node 22 and Node
  24 for every pull request and every push to `main`, and `docs/RELEASING.md`
  documents the flow plus the one-time trusted publisher setup on npmjs.com.
- Passive update notice: `nightqueue queue status` and the session-start context
  block close with one line when a newer version is published. The registry is
  asked at most once every 24 hours and the answer is cached in
  `$NIGHTQUEUE_HOME/update-check.json`; the check is fail-open, so a registry
  that does not answer costs nothing and prints nothing. `--json` output and
  unattended jobs never carry the line, and `NIGHTQUEUE_NO_UPDATE_CHECK=1` turns
  the check off entirely.
- `nightqueue update` refuses while a job holds a live lease or a watcher is
  registered, pointing at `nightqueue queue run --stop`; a job left behind by a
  crash never blocks it, and `--force` overrides both refusals.

### Changed

- `nightqueue doctor` and `nightqueue memory stats` size their name column by the
  longest name of the report, so a long project name no longer runs into the text
  next to it.
- Any number of runners now work the queue together. A runner registers as
  `~/.nightqueue/runners/<pid>.json`, one file per live process, carrying `pid`,
  `startedAt`, `mode`, `jobId`, `intervalS`, `detached`, `logPath`, `runtimeDir`
  and `uptimeS`; no start is ever refused because another runner is live.
  `queue status` prints one `runner:` line per live runner and prunes the
  registrations no process answers for, `doctor` reports one row per runner with
  its own runtime, `queue run --stop` ends every registered runner (one report
  line each, one shared ten-second timeout) and `queue run --stop <pid>` ends
  exactly one, and `setup`, `setup --from`, `update` and `init` refuse while ANY
  registration is alive, naming every live pid. A single-job start that could not
  claim its job now answers `job #N waiting: concurrency cap reached` and spawns
  nothing, instead of reporting a runner that would claim nothing; a drain start
  on a paused queue says so; a watcher always starts. A `runner.pid` left by a
  previous version is adopted read-only until it is stopped or pruned. A
  registry directory that cannot be LISTED - a permission, a mount failure - is
  never read as a home without runners: it is its own `unreadable` entry, so the
  install refuses (`--force` still goes through), the prune of the old runtime
  versions deletes nothing, `doctor` warns naming the directory, `queue status`
  opens with `runner: unknown`, and `queue status --json` and the MCP
  `queue_status` refuse instead of answering that nothing runs. The
  decision is recorded in
  `docs/decisions/0004-parallel-runners-registry.md`.
- Two jobs of the same project may now run at the same time: the claim no longer
  filters by project, so the only limits are the atomic claim of one job and
  `queue.maxConcurrent` - which also means the whole ceiling may be spent on one
  repository, and that merge conflicts between the pull requests of two jobs of
  one project are the operator's to resolve. The clean-canonical-checkout
  preflight stays: in a project that does not ignore the directory the pipeline
  creates its worktree in, the second same-project job is blocked with
  `dirty-checkout`, keeps its attempt and is retried by the drain until the first
  one finishes. The `project-busy` claim reason is gone.
- A drain that meets the concurrency ceiling now waits 15 s and passes again
  instead of exiting: the set of reasons it waits on named `concurrency-cap`, a
  string the claim never produces, and now names `cap-reached`.
- The refusal `nightqueue update` already had is now shared by `nightqueue
  setup`, `setup --from` and `nightqueue init`: while a runner is registered
  alive or a job holds a live lease, all four exit 1 with `a runner is active
  (pid P / job #N) - the runtime cannot be replaced while it runs; stop it with
  nightqueue queue run --stop or wait for the queue to drain` and install
  nothing. `--force` installs anyway and warns on stderr, naming the tree it is
  replacing.
- `npm run release:check` also refuses a working tree with uncommitted changes,
  before the version and the pack checks, because a publish ships what is on
  disk and not what is committed.

### Deprecated

- The singular `runner` key of `nightqueue queue status --json` and of the MCP
  `queue_status` answer. It is now the first entry of `runners` (and the same
  all-null object as before when no runner is live), kept for one release and
  removed in the next minor - read `runners`. `runnerAnswer.runner`, which
  describes the runner a `queue_run` or `queue_retry` call itself started, is not
  part of this deprecation and stays.

## 0.1.0 - 2026-09-09

First public release.

### Added

- Unattended queue (`nightqueue queue`): enqueue a request, run it through
  `/nightqueue:resolve` and get a pull request back. The runner starts detached
  by default, `--foreground` keeps it in the terminal, `queue run --watch`
  registers a pidfile and `queue run --stop` ends it. `queue retry` sends a
  gated, failed or cancelled job back to the queue, and `queue log --follow`
  narrates a run while it happens.
- Hybrid memory on `node:sqlite`: BM25 keyword recall always, semantic recall
  once the opt-in embedding library is installed into its own prefix, plus the
  lessons, the memories, the repository index and the pipeline log.
- MCP server (`nightqueue mcp`): the eleven stdio tools of the memory and of the
  queue, over the official SDK.
- Claude Code plugin: the `/nightqueue:resolve` pipeline, `/nightqueue:qa-guardian`
  and the six subagents, distributed through the marketplace of this package.
- Configuration CLI: `nightqueue init` and `nightqueue setup` install the runtime
  into `~/.nightqueue` and register the MCP server, the three hooks and the
  plugin in the host, idempotently and reversibly; `nightqueue update` reinstalls
  the runtime from the registry; `nightqueue doctor` diagnoses the host and the
  home without ever writing to them, and asks the registry for the newest
  published version only behind `--check-updates`.
- Orgs, projects and connections: named scopes for the memory and for the queue,
  with the secrets kept in a file only the owner can read.
- Published to npm as `@maykonv/nightshift`; the command it installed was `nightshift`.

[0.2.0]: https://github.com/nightqueue/nightqueue/releases/tag/v0.2.0
[0.1.0]: https://github.com/nightqueue/nightqueue/releases/tag/v0.1.0
