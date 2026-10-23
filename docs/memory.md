# Memory

Everything the runtime remembers lives in one SQLite file,
`$NIGHTQUEUE_HOME/nightqueue.db`, opened in WAL with a five second busy timeout.
Several processes write to it at the same time - the MCP server, the hooks and
the queue runner - so every write is retried while the lock is held by
someone else, and every transaction starts as `BEGIN IMMEDIATE` instead of being
promoted from a read. A write that is still refused after the retries comes back
as a message asking to run the command again, never as a raw SQLite error.
Only the `nightqueue` runtime opens it: the plugin talks to the MCP tools, never to
the file. The schema is created on first use, and reopening a current database writes
nothing. **Only `nightqueue update` and `nightqueue setup` migrate an existing database** (see
[Install](install.md)): every other open - CLI, runner, MCP server, hooks - refuses a database
older than its build before writing a byte, with `database at v<file>, this nightqueue expects
v<code>: run \`nightqueue update\``. The version is read from the file's header (`user_version`,
offset 60), so the refusal opens no connection and creates no `-wal`/`-shm`; only a home whose
write-ahead log holds frames not yet folded in is read through one short read-only connection.
The migration copies the database to `nightqueue.db.pre-v<N>` (`VACUUM INTO`, never over an
earlier copy) before its first step. The idempotent per-open steps below (indexes, full-text
mirrors, the default org, the v21 columns, the v23 columns and backfill) still run on every open of a CURRENT database, and
write nothing there; they bring a database to the current schema only inside the migration.

Schema v18 identifies orgs and projects by id instead of by name. A database
from an older build migrates once, in `nightqueue update`
(`nightqueue doctor` only reports that it is pending), in a single transaction: before touching it the runtime copies the file to
`nightqueue.db.pre-v18` beside it, moves the orgs and projects of `config.json`
into the `orgs` and `projects` tables (a project name found only in history rows
gets a path-less project in the default org, and names are kept exactly as they
were, case included), then rebuilds every table on `project_id`/`org_id`. Any
failure rolls the whole migration back and leaves the database at its old
version. While a runner holds a live lease on a job the migration refuses with
one line naming the job and asking to stop the runners
(`nightqueue queue run --stop`) and run the command again, and writes nothing;
a job left `running` by a runner that crashed does
not block it. The step that gives each job of a project its own run slug still
runs on every open, now keyed by `project_id`.

Schema v19 gives every project and every org a **key** and every issue a
**number** inside its owner. A v18 database migrates the same way, once, in the
same open as the v18 step when both are pending: a copy `nightqueue.db.pre-v19`
first, then one transaction that suggests a key for every project (in
registration order) and every org, numbers the items of each owner `1..n` in the
order they were created, and rebuilds `orgs`, `projects` and the issues table to
the current shape. Decision numbers, comments, notices and prompts are not
touched - text written before keeps its old spelling. The same live-lease refusal
applies, naming the job `J-<id>`.

Schema v20 gave every column that held another row's id a foreign key with its
own delete rule: a comment and a per-project row of an item went with the item
(`issue_comments.item_id`, `issue_projects.item_id`: cascade); the job
of an item, of a per-project row, of a decision and of a pipeline run was cleared
when that job was deleted (`job_id`: set null), and so was the decision an item
linked (`issues.decision_id`); a decision that another one named in
`superseded_by` could not be deleted (restrict). A v19 database migrates once, in
the same open as the v18 and v19 steps when they are pending: a copy
`nightqueue.db.pre-v20` first, then one transaction that rebuilds `decisions`,
the three issue tables and `pipeline_runs`
with every row as it was. A row that points at a row that does not exist refuses
the migration with one line naming each such row, its column and the missing id,
and writes nothing, not even the copy: fix or clear those rows with `sqlite3` and
run the command again. That check runs before the first pending step, so a v17 or
v18 home with such a row stays at its version with no copy of any step, and
`nightqueue doctor` reports the rows instead of the migration. A column of those
five tables that v20 does not know refuses the migration naming it, so no data
is dropped. The same live-lease refusal applies. Comments stay
append-only - an UPDATE or a DELETE of a comment is still refused while its item
exists - but they go away with their item.

Schema v21 adds two nullable JSON text columns: `jobs.origin` (`{ "kind", "ref" }`, the
service a job came from, set by `queue add`/`queue_add` - see [Queue](queue.md)) and
`projects.integrations` (the project's integration settings, one object per provider
kind; NULL is a project without integrations). Both are added by an idempotent step
(`src/memory/migration/v21.mjs`), never in the DDL the v18 and v19 rebuilds copy into, so an
older home of any version upgrades in one migration with no rebuild. The diagnosis read of
`nightqueue doctor` on a v20 home reads both as absent instead of failing.

**A job never migrates the runner's own home.** The installed nightqueue owns the schema of
the home the runner uses. No open migrates at all, inside a job or outside one, whatever its
environment; on top of that, the migration itself (`nightqueue update --schema-only`) run from
inside a job (`NIGHTQUEUE_JOB_ID` set) refuses before any statement changes the schema when
that home is the runner's: the `NIGHTQUEUE_JOB_HOME` the runner pinned, or the default
`~/.nightqueue` when the runner pinned none and no `NIGHTQUEUE_HOME` was given. That refusal
names the database and the fix: run the build against a temporary home with
`nightqueue sandbox <command>` or `NIGHTQUEUE_HOME=$(mktemp -d)`.

Schema v22 gives the tracker its name: its tables are `issues`, `issue_projects`
and `issue_comments`, with the mirrors `issues_fts` and `issue_comments_fts`. A v20
or v21 database migrates once, in `nightqueue update` (or `setup`) and in the same migration
as the earlier steps when they are pending: a copy `nightqueue.db.pre-v22` first (the one
`update` takes, kept as it is when it is already there), then one transaction that copies
every row into the new tables, keeps their counters, foreign keys and delete
rules, rebuilds the search mirrors and drops the old tables. Refs (`NQ-12`), the
`item_id` columns, the v21 columns and text written before are untouched. The same
orphan check and live-lease refusal apply.

Schema v23 gives a job its attempt history: the table `job_attempts`, one row per claim
keyed by `(job_id, attempt)` - an ordinal that is never reused, independent of
`jobs.attempts` - with the claim's `worker`, `session_id`, `started_at`, `finished_at`,
`outcome`, `exit_reason`, `spawns`, tokens, `cost_usd` and the flags `measured`, `fresh` and
`backfilled`; `job_id` references `jobs(id)` with cascade (a project purge deletes the
project's jobs, so their rows go with them, and the purge's footprint counts them as
`job_attempts`), and a partial unique index allows
at most one open row (`finished_at IS NULL`) per job. It adds `jobs.attempt_started_at` (the
start of the current claim, the anchor of the orphan ceiling) and `jobs.next_attempt_fresh`
(set by `queue retry --fresh`, read by the next claim). The step
(`src/memory/migration/v23.mjs`) is additive and idempotent like v21's, with no rebuild: it
adds the two columns, records the last attempt of every job that already ran as one
`backfilled` row from the job's own columns (a running job's row stays open and unmeasured,
so its finish lands on it), and anchors `attempt_started_at` of a job running at that moment
on its `started_at`; each write sits behind a read that finds nothing once it ran, so a
second open writes nothing. `update` takes the usual `nightqueue.db.pre-v23` copy first.

Schema v24 removes the tracker and indexes the job history: the tables `issues`,
`issue_projects` and `issue_comments` go, with the mirrors `issues_fts` and
`issue_comments_fts` and every trigger and index of theirs, and the full-text table `jobs_fts`
(slug, the first 1500 characters of the prompt, the notice) is created with its triggers on
`jobs`. A v22 or v23 database migrates once, in `nightqueue update` (or `setup`) and in the
same migration as the earlier steps when they are pending (`src/memory/migration/v24.mjs`): a
copy `nightqueue.db.pre-v24` first (kept as it is when it is already there), then one
transaction that rebuilds `jobs_fts` from every job, drops the tracker and checks that every job
is kept and indexed, that no tracker object is left and that no foreign key breaks. Job ids,
refs and titles are untouched; the tracker rows stay only in the copy. The same live-lease
refusal applies.

Schema v25 lets a job resolved without change be `closed`: the closed invariant of `jobs`
accepts, besides a pull request whose checklist records the merge, a row with no pull request
whose checklist records `data.resolvedWithoutChange: true` (see [Queue](queue.md)). A v24
database migrates once, in `nightqueue update` (or `setup`) and after the earlier steps when
they are pending (`src/memory/migration/v25.mjs`): a copy `nightqueue.db.pre-v25` first, then
one transaction that rebuilds `jobs` under the new invariant - every column kept, the
per-open ones included, every row in id order, the id sequence kept - recreates its indexes and
the `jobs_fts` triggers, and checks that every job is kept and indexed, that the new invariant
is in the schema and that no foreign key breaks. The same live-lease refusal applies.

Schema v26 removes decisions, with their data: the table `decisions` goes, with its full-text
mirror `decisions_fts`, its three triggers and its four indexes. A v25 database migrates once, in
`nightqueue update` (or `setup`) and after the earlier steps when they are pending
(`src/memory/migration/v26.mjs`): a copy `nightqueue.db.pre-v26` first (kept as it is when it is
already there), then one transaction that refuses when any other table still has a foreign key
to `decisions`, drops the triggers, the mirror and the table, and checks that no decisions object
is left, that every lesson, memory and job is kept and that no foreign key breaks. The decision
rows stay only in the copy. A home that never had the table migrates the same way, and so does a
v22 to v25 home whose decision rows name a missing job or decision: the check for rows that point
at a missing row skips the decisions there, since v26 drops them. The same live-lease refusal
applies.

**A sick database degrades, it does not kill.** The file can break under a live process - a
home on a network or FUSE mount, a copy taken by hand, a second sqlite opened on the live
file. Every open and every store call classifies what SQLite throws by its numeric `errcode`
(`errcode & 0xff`: 26 `SQLITE_NOTADB`, 11 `SQLITE_CORRUPT`, 10 `SQLITE_IOERR`, 8
`SQLITE_READONLY`, 13 `SQLITE_FULL`, 15 `SQLITE_PROTOCOL`, and 14 `SQLITE_CANTOPEN` only when
the file exists - a home with no database yet is not a sick one - extended codes included), and
by the message only for a node:sqlite error (`ERR_SQLITE_ERROR`) that carries no `errcode`, so
an error that merely echoes one of those phrases is never classified; busy, locked and a plain
SQL error are never classified either. A classified error is one
`StoreUnavailableError` with `code`, `home`, `path` and the hint `nightqueue doctor --fix`: it is
never retried as busy, the CLI prints it as one line, the MCP tools answer
`{ ok: false, error: "store-unavailable", code, home, hint, message }`, `context_for_phase` and the
SessionStart hook answer an empty block and one warning line, the MCP server still starts, and
the runner backs off (see [Runtime contract](runtime-contract.md)). The connection that failed is
retired - dropped from the cache so the next call opens a fresh one, and never closed, because
closing a handle whose WAL index is broken can fold the log and unlink `-wal`/`-shm` under a
repair in progress. Two broken states are SILENT, since SQLite survives them: a random `-shm`
(it rebuilds the index) and a `-wal` truncated mid-frame (it reads the valid frames and the rest
of the rows are gone). Neither throws; `nightqueue doctor --db` is what finds them - the file
sizes, `quick_check`, and the `lost jobs` whose run is on disk and whose row is not - and
`nightqueue queue repair --from-disk` rebuilds those rows. To inspect the database, `cp` it
first: never open a second sqlite on the live file.

A database older than the build is the same class with the code `SCHEMA_OUTDATED`, the hint
`nightqueue update` and the message `database at v<file>, this nightqueue expects v<code>: run
\`nightqueue update\``: the MCP tools answer it as `store-unavailable`, the SessionStart hook
and the MCP server's startup print `nightqueue memory unavailable (SCHEMA_OUTDATED at <home>):
database at v20, this nightqueue expects v26: run \`nightqueue update\``, and `doctor` names
`nightqueue update`. It is never an outage: the runner does not back off on it, it stops with
the message, since waiting never brings an older schema up to date.

**Keys and refs.** A key is 2 to 5 uppercase letters or digits starting with a
letter, unique across projects and orgs together; the database refuses a
repeat with triggers over `projects`, `orgs` and their two alias tables. It is a
label like a name - identity stays the id - so `nightqueue project key` /
`org key` change one row and keep the old key in `project_key_aliases` /
`org_key_aliases`, where it still resolves to the same owner and no other owner
can take it. Everything is printed by a **ref** built from the current key, and
every tool and command that takes a job reads one: `J-<id>` (the plain id too). Every MCP
answer that carries a job carries its `ref` next to the existing `id`.

Eleven tables plus three full text mirrors:

| table | what it holds |
|---|---|
| `orgs` | one row per org: its id (a ULID), its name (unique, renamable), its key (unique across projects and orgs, renamable) and its creation date |
| `projects` | one row per project: its id (a ULID), its name (unique, renamable), its key (unique across projects and orgs, renamable), its checkout path (unique; none for a project known only from history) and the id of its org |
| `project_key_aliases`, `org_key_aliases` | the old keys of a project or an org, which keep resolving to it; never edited, removed with their owner |
| `lessons` | one lesson per mistake: title, root cause, solution, prevention rule, target phase, how many attempts it cost, how often it was injected and violated, and its embedding |
| `memory` | project facts and durable choices of the code, as key and value, per project or global |
| `project_index` | the file to responsibility map of a project, with the mtime the file had when it was indexed |
| `project_libs` | the libraries of a project with the version that was actually resolved |
| `pipeline_runs` | one row per `/resolve` run: tier, task type, outcome, gate stop, duration, model and session |
| `pipeline_phases` | one row per phase of a run: sequence, phase, model, status, retry, duration and the `reason` the phase ran again (added on open to an older database, null on a first run) |
| `jobs` | one row per queue job: project, prompt, priority, status, attempts, lease, slug, session, branch, pull request, notice, usage and cost |
| `lessons_fts`, `memory_fts` | FTS5 mirrors of the two text tables, kept in sync by triggers on insert, update and delete |
| `jobs_fts` | FTS5 index of each job's slug, brief (the first 1500 characters of its prompt) and notice, kept by triggers on insert, update and delete, read by the triager's `## Related jobs` |

**Hybrid recall.** A recall with a query always runs BM25 over the FTS mirror,
with a coverage floor: a row only counts as a hit when it matches enough of the
informative tokens of the query, so a single generic word never drags an
unrelated lesson in. The same query is then embedded and compared to the stored
vectors by brute force cosine, above a fixed cut. The two lists are
interleaved, and the lexical list is never truncated by the fusion: a semantic
hit can only take a slot the BM25 list did not need. Every step of the semantic
side is fail-open - no library, no weights, a slow embedder or a thrown error
all end in the same place, the lexical result, within a deadline of 1.5s (800ms
in the prompt hook). A recall with no query returns the recent lessons of the
project plus the globals, current project first, the violated ones ahead of the
rest. When a query matched nothing, the same recent list comes back marked
`via: "fallback"`, which means "this did not match your query".

**Hooks.** Two, both reading the event JSON from stdin:

- `nightqueue hook session-start` prints the block injected at the start of a
  session: the top lessons of the project and its memories, and it records
  what it injected in `state/<session>.json` and in the corpus.
- `nightqueue hook prompt-context` prints the lessons and memories relevant to the
  prompt that was just submitted, skipping what this session already saw, and
  ignoring prompts too short to carry a request.

`nightqueue setup` registers the two of them at user scope (next to the `PreToolUse`
agent-foreground guard), and `nightqueue setup --remove` takes them out again (see
[Install](install.md)). Both answer with nothing when the working directory is outside a
project registered with `nightqueue init`. No hook writes a lesson or a memory: there is no
`SessionEnd` hook any more, and `setup`, `setup --remove` and `update` drop a leftover
nightqueue `SessionEnd` entry (a third-party one stays).

**Reflection.** What a session or a run learned is saved by one rubric,
`plugin/skills/reflect/references/rubric.md`, with two consumers:

- `/nightqueue:reflect` - the skill, also offered once by the operator and by the server
  instructions at the end of a session that changed or learned something. It finds the
  project (the one the conversation names, else the longest registered `path` prefix of the
  cwd; with none it offers `project_register` and calls it only on a yes), drafts the
  candidates, lists them numbered and asks once; it saves ONLY the ones the person confirms
  and reports their refs.
- the reflector of `/resolve` - Phase 9, the last phase of every run that reaches Phase 8,
  delivered or terminated, never at a gate pause. It saves on its own, with no confirmation,
  and returns at most ten lines whose refs the orchestrator prints as one `🪞 Reflection:`
  line above `## Notice`. The orchestrator itself never calls `lesson_save` or `memory_save`.

The rubric has three kinds: an `error` or a `correction` becomes a **lesson** (`title`,
`root_cause`, `solution`, `prevention`, `target`) saved with `lesson_save`; a `decision` of the
code becomes a **memory** (`key`, `value`) saved with `memory_save`. Each field is one short sentence; a typo, a one-ticket detail, what the code already
says, a secret and a restatement are skipped. Before proposing, the candidate is looked up
with `lesson_recall`/`memory_recall`.

`memory_save` records one `key`/`value` for a project (or global) and never overwrites: a key
the owner already has answers `deduped: true` with the stored value. Like `lesson_save`, it is
allowed inside a queue job.

`lesson_delete` and `memory_delete` remove one row by `id` (`L344`, `M446` or the plain number) of
`project`, both required, with its search entry, so it never comes back in recall or
`context_for_phase`. An unknown id and an id of another project are refused and nothing is
deleted; unlike the saves, both are refused inside a queue job. The answer names the id and the
title (or key) that went.

**Recurrence.** A lesson that recalls an existing one is re-saved with that lesson's exact
`title`: the server finds it and bumps its `attempts` instead of adding a row. Inside a queued
job, when the lesson is one the run was given (injected into its session), the same re-save
also bumps `violated` and answers `violated: true`. An interactive `/nightqueue:reflect` bumps
`attempts` only, since outside a job the server cannot tell which lessons the session was
given.

**What the reflector reads.** The run's handoffs as they are, never the job's raw stream. The
loop artifacts keep their history: `05a-qa-analyst.md`, `05-qa.md`, `06-verification.md` and
`06-runtime.md` are append-only, one `## Round n` per launch, and a fix-loop coder appends a
`### Fix loop n — what was wrong / what changed` block to `04-implementation.md` instead of
rewriting it (gates read only the last round). Its prompt carries the run timeline - phase,
model, status and reason in order - from this attempt's `pipeline_phases`: the orchestrator
passes `reason` to `run_phase_done` on every relaunch, and `pipeline_log` copies the recorded
reasons into the rows when its table lists exactly as many launches of that phase as the run
recorded (otherwise it copies none of them and answers `reasons_unpaired`). When `pipeline_log` recorded no run for the attempt, the timeline
comes from `state.json` and says so.

An old `~/.nightqueue/state/reflect.json` and `reflect.log` from the former `SessionEnd`
worker are no longer read or written and can be deleted.

**Commands.**

```sh
nightqueue mcp                     # start the stdio MCP server with the thirty-three tools
nightqueue mcp --http --port 4747 --token <t>   # serve the same tools over Streamable HTTP on 127.0.0.1
nightqueue hook session-start      # run a hook, reading the event JSON from stdin
nightqueue embed download          # download the embedding weights (the only network path)
nightqueue embed backfill          # embed the lessons that still have no vector
nightqueue memory stats [--json]   # counts per project
nightqueue lesson delete <id> [--project <name>]   # delete one lesson (L344 or 344) and its search entry
nightqueue memory delete <id> [--project <name>]   # delete one memory (M446 or 446) and its search entry
```

**Environment variables.**

| variable | effect |
|---|---|
| `NIGHTQUEUE_HOME` | home of the runtime, default `~/.nightqueue` |
| `NIGHTQUEUE_EMBED_DISABLED` | `1` turns the semantic side off; the recall stays BM25 only |
| `NIGHTQUEUE_EMBED_DEADLINE_MS` | deadline of the embedding in the prompt hook, default `800` |
| `NIGHTQUEUE_CLAUDE_BIN` | path of the `claude` CLI used by the queue runner, by `nightqueue setup` and by `nightqueue doctor` |
| `NIGHTQUEUE_NPM_BIN` | path of the `npm` CLI that installs the runtime and the embedding prefix |
| `NIGHTQUEUE_JOB_ID` | set by the runner in the environment of the job it spawns, never read from outside |
| `CLAUDE_CONFIG_DIR` | configuration directory of the host that `nightqueue setup` and `nightqueue doctor` read and write, default `~/.claude` |
| `NIGHTQUEUE_MODEL`, `NIGHTQUEUE_SESSION_ID` | recorded in `pipeline_runs` by the server process |

**Honest numbers.** Measured in this repository, on macOS arm64 with Node
24.14.1:

| number | measured |
|---|---|
| `node_modules` of the package itself | 26 MB (94 packages) |
| the embedding prefix `$NIGHTQUEUE_HOME/embedding` | 380 MB |
| of which `onnxruntime-node` plus `onnxruntime-web` | 340 MB |
| embedding weights in `$NIGHTQUEUE_HOME/models` | 23 MB |
| one prompt hook, weights cached, semantic side on | 191 ms (median of 5 cold processes) |
| the same hook with `NIGHTQUEUE_EMBED_DISABLED=1` | 84 ms, so the semantic side costs about 107 ms |
| peak RSS of `nightqueue embed backfill` with the model loaded | 227 MB, against 76 MB for `nightqueue memory stats` |

That weight is exactly why the embedding library is not a dependency of the
package: `nightqueue embed install` (or a yes during `nightqueue init`) puts it in
`~/.nightqueue/embedding` on demand, so the published package stays small and
audits clean. Without it every recall still answers through BM25 and the whole
test suite still passes.

**Related jobs.** The triager phase of `/resolve` gets a lexical search over the job
history of the job's project - each job's slug, brief and notice - as a `## Related jobs`
block of its phase context: at most five jobs, best first, one
`- [J-<n>] <title> [<status> · PR #<n> · <YYYY-MM-DD>]` line each, never the caller's own job.
Jobs cited in the job prompt or the query, by `J-<n>` or by a GitHub pull request URL, of the
same project and never the caller's own, come first: up to five on top of the five matches,
each marked `cited` with its status, PR URL, branch, finish day and the first line of its
notice, and a match already cited is not repeated. A citation that resolves to no job of the
project (an unknown ref, another project's job, a pull request no job of the project opened, or
one several of them opened) gets one line saying so.

**Private by design.** The memory lives only in `$NIGHTQUEUE_HOME/nightqueue.db`. The
runtime writes nothing into the repository and publishes nothing; the one thing it puts in a
pull request is the footer `nightqueue run pr` appends (`Opened by nightqueue · J-<n>` inside a
job, plus ` · <kind> <ref>` for every origin of the job; `Opened by nightqueue` outside a job):
no `docs/adr/` tree, no `ISSUES.md`.

As everywhere else in the server, an explicit `null` is treated exactly like an
absent parameter, and `project` is the registered NAME, never a path. A name no
project carries is refused - by every MCP tool, `lesson_*` and `memory_*`
included - with `unknown project` and the list of the known ones, and nothing is
written; only the lesson, memory and index tools also accept a path, which
means the project whose checkout contains it, or the global scope when no
checkout does.

Rows point at their owner by id: every table carries `project_id` alone (a
project's org is always the one of its `projects` row). Renaming an org or a
project (`nightqueue org rename`, `nightqueue project rename`) changes that one
row, and every view shows the new name at once. An org or a project that still
owns rows cannot be removed: the database refuses the removal, and the message
names how many rows of which table it still owns - nothing is removed.

