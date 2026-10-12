# Memory

Everything the runtime remembers lives in one SQLite file,
`$NIGHTQUEUE_HOME/nightqueue.db`, opened in WAL with a five second busy timeout.
Several processes write to it at the same time - the MCP server, the hooks and
the reflection worker - so every write is retried while the lock is held by
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

Schema v20 gives every column that holds another row's id a foreign key with its
own delete rule: a comment and a per-project row of an item go with the item
(`issue_comments.item_id`, `issue_projects.item_id`: cascade); the job
of an item, of a per-project row, of a decision and of a pipeline run is cleared
when that job is deleted (`job_id`: set null), and so is the decision an item
links (`issues.decision_id`); a decision that another one names in
`superseded_by` cannot be deleted (restrict). A v19 database migrates once, in
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
database at v20, this nightqueue expects v24: run \`nightqueue update\``, and `doctor` names
`nightqueue update`. It is never an outage: the runner does not back off on it, it stops with
the message, since waiting never brings an older schema up to date.

**Keys and refs.** A key is 2 to 5 uppercase letters or digits starting with a
letter, unique across projects and orgs together; the database refuses a
repeat with triggers over `projects`, `orgs` and their two alias tables. It is a
label like a name - identity stays the id - so `nightqueue project key` /
`org key` change one row and keep the old key in `project_key_aliases` /
`org_key_aliases`, where it still resolves to the same owner and no other owner
can take it. Everything is printed by a **ref** built from the current key, and
every tool and command that takes a job or a decision reads one:
`J-<id>` for a job (the plain id too), `D-<n>` for a decision of the project in context, `<KEY>/D-<n>` for a
decision named by its owner (`DLW/D-3`), and `G` for the rows that have no owner
(`G/D-2`). Decisions no longer take an internal id; an integer
where one of their refs belongs is refused. Every MCP answer that carries a job
or a decision carries its `ref` next to the existing `id`/`number`.

Twelve tables plus four full text mirrors:

| table | what it holds |
|---|---|
| `orgs` | one row per org: its id (a ULID), its name (unique, renamable), its key (unique across projects and orgs, renamable) and its creation date |
| `projects` | one row per project: its id (a ULID), its name (unique, renamable), its key (unique across projects and orgs, renamable), its checkout path (unique; none for a project known only from history) and the id of its org |
| `project_key_aliases`, `org_key_aliases` | the old keys of a project or an org, which keep resolving to it; never edited, removed with their owner |
| `lessons` | one lesson per mistake: title, root cause, solution, prevention rule, target phase, how many attempts it cost, how often it was injected and violated, and its embedding |
| `memory` | project facts and durable decisions, as key and value, per project or global |
| `project_index` | the file to responsibility map of a project, with the mtime the file had when it was indexed |
| `project_libs` | the libraries of a project with the version that was actually resolved |
| `pipeline_runs` | one row per `/resolve` run: tier, task type, outcome, gate stop, duration, model and session |
| `pipeline_phases` | one row per phase of a run: sequence, phase, model, status, retry and duration |
| `jobs` | one row per queue job: project, prompt, priority, status, attempts, lease, slug, session, branch, pull request, notice, usage and cost |
| `decisions` | one architecture decision per row: number inside its project, title, context, decision, consequences, status, the decision that superseded it, and its embedding |
| `lessons_fts`, `memory_fts`, `decisions_fts` | FTS5 mirrors of the three text tables, kept in sync by triggers on insert, update and delete |
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

**Hooks.** Three, all reading the event JSON from stdin:

- `nightqueue hook session-start` prints the block injected at the start of a
  session: the standing decisions of the project (the accepted ones, its own and
  its org's, one line each), then the top lessons and its memories, and it records
  what it injected in `state/<session>.json` and in the corpus.
- `nightqueue hook prompt-context` prints the lessons and memories relevant to the
  prompt that was just submitted, skipping what this session already saw, and
  ignoring prompts too short to carry a request.
- `nightqueue hook reflect` answers `{}` immediately and leaves a detached worker
  reading the transcript.

`nightqueue setup` registers the three of them at user scope, and `nightqueue setup
--remove` takes them out again (see [Install](install.md)). The two that inject context
answer with nothing when the working directory is outside a project registered
with `nightqueue init`.

**Reflection.** The detached worker reads only the bytes appended to the
transcript since its last run, and only when 60 seconds have passed since the
previous run of that session and the readable digest of that slice is at least
800 characters. It then spends one call to the `claude` CLI to extract what the
session taught (retried once with a shorter digest if it times out) and, only
when a fresh lesson looks like a stored one, one more call to judge it. Both run
with no tools at all. That costs tokens from your own subscription, so:
`NIGHTQUEUE_REFLECT=1` in the environment disables the reflection (and every
other hook) for that process, and simply not registering the `SessionEnd` hook
disables it entirely. The read offset only advances after the lessons are
persisted, so a failed run reprocesses the same slice instead of losing it.

**Commands.**

```sh
nightqueue mcp                     # start the stdio MCP server with the twenty-eight tools
nightqueue mcp --http --port 4747 --token <t>   # serve the same tools over Streamable HTTP on 127.0.0.1
nightqueue hook session-start      # run a hook, reading the event JSON from stdin
nightqueue reflect --transcript <path>   # reflect on a transcript now, in the foreground
nightqueue embed download          # download the embedding weights (the only network path)
nightqueue embed backfill          # embed the lessons and the decisions that still have no vector
nightqueue memory stats [--json]   # counts per project
nightqueue decision list [--project <name> | --org <name>] [--status <status>]   # the decisions log
nightqueue decision show <number> [--project <name> | --org <name>]              # one decision, in full
nightqueue decision export <number> [--dir <path>] [--force]                     # one decision as a markdown file
nightqueue decision import <file.md> [--status <s>] [--superseded-by <n>] [--supersedes <n,...>] [--unrelated <n,...>]   # save a markdown decision file
```

**Environment variables.**

| variable | effect |
|---|---|
| `NIGHTQUEUE_HOME` | home of the runtime, default `~/.nightqueue` |
| `NIGHTQUEUE_EMBED_DISABLED` | `1` turns the semantic side off; the recall stays BM25 only |
| `NIGHTQUEUE_EMBED_DEADLINE_MS` | deadline of the embedding in the prompt hook, default `800` |
| `NIGHTQUEUE_REFLECT_MODEL` | model of the reflection, default `haiku` |
| `NIGHTQUEUE_CLAUDE_BIN` | path of the `claude` CLI used by the reflection, by the queue runner, by `nightqueue setup` and by `nightqueue doctor` |
| `NIGHTQUEUE_NPM_BIN` | path of the `npm` CLI that installs the runtime and the embedding prefix |
| `NIGHTQUEUE_JOB_ID` | set by the runner in the environment of the job it spawns, never read from outside |
| `CLAUDE_CONFIG_DIR` | configuration directory of the host that `nightqueue setup` and `nightqueue doctor` read and write, default `~/.claude` |
| `NIGHTQUEUE_REFLECT` | `1` marks a process as the reflection itself: no context block and no new reflection |
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

### Decisions

One more thing the runtime remembers, next to the lessons and the memories.

A decision belongs to exactly one **owner**, and an owner is a project or an org: a
decision several repos of the same product share is saved ONCE at org scope
instead of once per repo, and every project of that org reads it. A write names
`project` or `org`, never both; a read by `project` answers the project's rows
PLUS its org's, org rows first, each carrying its `scope` and its `owner`, while
a read by `org` answers that org's rows alone. A project never sees the rows of
another org.

A **decision** is one architecture decision of its owner, numbered inside that
owner (`D-1`, `D-2`, ... per project; `DLW/D-1`, `DLW/D-2` per org, and the numbering
of one owner never touches another's): a title, the `context` that forced the
choice, the `decision` itself, the `consequences` it costs, and a status among
`proposed`, `accepted`, `superseded` and `rejected`. A decision that was replaced points at the one that replaced it
through `superseded_by`. Only `accepted` decisions are ever recalled as standing
constraints, and every one of them reaches a prompt: the block the `SessionStart`
hook injects lists the title of EVERY accepted decision of the project and of its
org under `## Standing decisions`, org rows first, followed by
`## Standing decisions in detail` with the text of the 8 most recently updated.
A `proposed` decision reaches a prompt by its title only, under a separate
`## Proposed (not binding)` section, because nobody accepted it yet and it binds
nothing. The other two statuses are read with `decision_list`,
`nightqueue decision list` and `nightqueue decision show`, and never reach a
prompt.

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

**Private by design.** Decisions live only in `$NIGHTQUEUE_HOME/nightqueue.db`, the
same file as the rest of the memory. The runtime writes nothing into the
repository and publishes nothing; the one thing it puts in a pull request is the
footer `nightqueue run pr` appends (`Opened by nightqueue · J-<n>` inside a job, plus ` · <kind> <ref>` when the job has an origin; `Opened by nightqueue` outside a job): no `docs/adr/` tree, no `ISSUES.md`; only an explicit `nightqueue decision export`
writes a file. The only ways in are the MCP tools below and the one deliberate
terminal write, `nightqueue decision import` (see below), and the only ways to
read them from a terminal are the two read-only commands
(`nightqueue decision list` and `nightqueue decision show <number>`), which resolve the project from the current directory when
`--project` is omitted, read one org alone with `--org <name>` instead, never
write, and never register a project. Read-only
means the database too: the two open it read-only, so they never create it and
never migrate it, and a home where nothing was ever saved reads as an empty one
(`no decisions for <project>`) instead of a SQLite error.

**One source, moved on purpose.** `nightqueue decision export <number>` writes
one decision as a markdown file, `<dir>/<nnnn>-<slug>.md` (default
`docs/decisions/` of the current directory; `--force` replaces an existing
file). It reads the database read-only like `show`, so it never creates nor
writes it; publishing that file stays a deliberate pull request of the operator.
`nightqueue decision import <file.md>` is the one deliberate decision write from
a terminal: it reads an exported file or a hand-written ADR of the same shape
(`# <title>`, a `Status:` line with its date, `## Context`, `## Decision`,
`## Consequences`; any other `##` section stays inside the field it follows),
takes the status from the file unless `--status` overrides it
(`--superseded-by <n>` imports it `superseded`, pointing at `D-n`), and saves it
through the same review as `decision_save`: an overlap refuses with the
candidates until each is named in `--supersedes` or `--unrelated`. On success it
prints `imported as D-n` and stamps `Decision D-n in the <owner> store.` into the
file's header (a header written before v19, `Decision #n ...`, is still read); a file whose header already names an existing row of the owner is
refused, so a re-run imports nothing twice. The runtime itself never reads
`docs/decisions/`.

**The four MCP tools** (parameters marked `?` are optional):

| tool | what it does |
|---|---|
| `decision_save` | records one decision: `project` or `org`, `title`, `context`, `decision`, `consequences?`, `status?` (default `accepted`), `supersedes?`, `unrelated?`; answers the `id`, the `number`, the `ref` and the owner it got. When the title overlaps an accepted or proposed title of the same owner, or the title plus decision is close in meaning to one, nothing is saved and it answers `status: "needs_review"` with the `candidates`; saving again names every candidate by `number` or `ref` (of the same owner), in `supersedes` (they become `superseded` and point at the new row, in the same transaction) or in `unrelated`. Inside a queue job it stamps `job_id`, refuses `supersedes`, and refuses a second proposal while the first is still `proposed` |
| `decision_update` | changes a decision by `id`, its ref (`D-7` in `project?` or the running job's project, `DLW/D-3` anywhere): any of `title`, `context`, `decision`, `consequences`, `status`, `superseded_by` — this is how a `proposed` one is accepted or rejected; `status: "superseded"` requires `superseded_by`, unless the row already names its successor; the row it answers is a compact one, truncated like `decision_list` |
| `decision_list` | the log in numbering order: `project` or `org`, `status?`; compact rows, org rows first |
| `decision_recall` | the standing constraints: `project` or `org`, `query?`, `limit?`; only `accepted` decisions, hybrid BM25 plus semantic, org rows first, and the text comes back untruncated because it feeds prompts. With `id` (a decision ref) alone, that one decision whole whatever its status (a `proposed`, `rejected` or `superseded` one too) with `job_ref` of the job that proposed it; a bare `D-<n>` is read in `project` (inside a job, the job's project), `query` or `limit` beside `id` is refused, and inside a job only a decision of the job's project or of its org is readable |

As everywhere else in the server, an explicit `null` is treated exactly like an
absent parameter, and `project` is the registered NAME, never a path. A name no
project carries is refused - by every MCP tool, `lesson_*` and `memory_*`
included - with `unknown project` and the list of the known ones, and nothing is
written; only the lesson, memory and index tools also accept a path, which
means the project whose checkout contains it, or the global scope when no
checkout does.
`decision_update` takes a ref and no owner, so inside an
unattended run it is restricted to the project of the job that is running:
a ref naming a row of another project is refused, naming both projects, the same
way `queue_retry` only retries its own job. An org row is refused there too,
naming its org — a job reads its org's decisions and never rewrites one.
Outside a job the restriction does not exist, and the operator updates
any project from anywhere.

Rows point at their owner by id: a decision carries
`project_id` or `org_id`, and every other table carries `project_id` alone (a
project's org is always the one of its `projects` row). Renaming an org or a
project (`nightqueue org rename`, `nightqueue project rename`) changes that one
row, and every view shows the new name at once. An org or a project that still
owns rows cannot be removed: the database refuses the removal, and the message
names how many rows of which table it still owns - nothing is removed.

**How `/resolve` uses them.** The standing decisions are already in the block the
`SessionStart` hook injected, so the Phase 0 preflight pings `lesson_recall` alone:
the Brief copies EVERY accepted title from that section (or from one
`decision_list` with `status: "accepted"` when the section is absent), and adds
in full the 8 closest to the task, from one `decision_recall` with the affected
area and the objective as the query - the project's and its org's, in one call,
org rows first and written `DLW/D-3` when they belong to the org. Both parts become
the `## Standing decisions` section of the Brief. That section
is passed to the architect as binding context - a design that contradicts a
standing decision either follows it or takes the conflict to
`## Requires user confirmation` naming its number. When a plan takes a
structural decision no standing decision covers, the architect emits a
`## Proposed decision` block, and the orchestrator saves it right after Phase 3 with
`status: "proposed"`, so it survives a run that later stops at a gate; the Phase 8
report lists it among the open items for the operator to accept or reject with
`decision_update` - it is not part of the pull request body. A `decision_recall` that fails is fail-open: the run
continues without the section and records it as an open item.

**A proposal ends when its job is closed.** The proposal a job saved carries
that job's id: proposed by a job, accepted when the job closes. The settle step of
`nightqueue queue close <id>`, `nightqueue queue close --merged` and the MCP `queue_close`
accepts every proposal of the job in the transaction that closes it, prints an
`accepted D-n: <title>` line for each, and `--json` carries them in `decisions`. A job that
ends cancelled or failed accepts nothing. A proposal still open on a closed job (from before
this rule) is a warning
of the `decision proposals` line of `nightqueue doctor`, which names each by
number and job.

