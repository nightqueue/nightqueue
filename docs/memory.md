# Memory

Everything the runtime remembers lives in one SQLite file,
`$NIGHTSHIFT_HOME/nightshift.db`, opened in WAL with a five second busy timeout.
Several processes write to it at the same time - the MCP server, the hooks and
the reflection worker - so every write is retried while the lock is held by
someone else, and every transaction starts as `BEGIN IMMEDIATE` instead of being
promoted from a read. A write that is still refused after the retries comes back
as a message asking to run the command again, never as a raw SQLite error.
Only the `nightshift` runtime opens it: the plugin talks to the MCP tools, never to
the file. The schema is created and migrated on first use, and reopening an
existing database is a no-op.

Nine tables plus three full text mirrors:

| table | what it holds |
|---|---|
| `lessons` | one lesson per mistake: title, root cause, solution, prevention rule, target phase, how many attempts it cost, how often it was injected and violated, and its embedding |
| `memory` | project facts and durable decisions, as key and value, per project or global |
| `project_index` | the file to responsibility map of a project, with the mtime the file had when it was indexed |
| `project_libs` | the libraries of a project with the version that was actually resolved |
| `pipeline_runs` | one row per `/resolve` run: tier, task type, outcome, gate stop, duration, model and session |
| `pipeline_phases` | one row per phase of a run: sequence, phase, model, status, retry and duration |
| `jobs` | one row per queue job: project, prompt, priority, status, attempts, lease, slug, session, branch, pull request, notice, usage and cost |
| `decisions` | one architecture decision per row: number inside its project, title, context, decision, consequences, status, the decision that superseded it, and its embedding |
| `roadmap_items` | one intent per row: horizon (`now`, `next`, `later`), title, detail, status, position inside its horizon, the decision that motivated it and the job it was queued as |
| `lessons_fts`, `memory_fts`, `decisions_fts` | FTS5 mirrors of the three text tables, kept in sync by triggers on insert, update and delete |

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

- `nightshift hook session-start` prints the block injected at the start of a
  session: the standing decisions of the project (the accepted ones, its own and
  its org's, one line each), then the top lessons and its memories, and it records
  what it injected in `state/<session>.json` and in the corpus.
- `nightshift hook prompt-context` prints the lessons and memories relevant to the
  prompt that was just submitted, skipping what this session already saw, and
  ignoring prompts too short to carry a request.
- `nightshift hook reflect` answers `{}` immediately and leaves a detached worker
  reading the transcript.

`nightshift setup` registers the three of them at user scope, and `nightshift setup
--remove` takes them out again (see [Install](install.md)). The two that inject context
answer with nothing when the working directory is outside a project registered
with `nightshift init`.

**Reflection.** The detached worker reads only the bytes appended to the
transcript since its last run, and only when 60 seconds have passed since the
previous run of that session and the readable digest of that slice is at least
800 characters. It then spends one call to the `claude` CLI to extract what the
session taught (retried once with a shorter digest if it times out) and, only
when a fresh lesson looks like a stored one, one more call to judge it. Both run
with no tools at all. That costs tokens from your own subscription, so:
`NIGHTSHIFT_REFLECT=1` in the environment disables the reflection (and every
other hook) for that process, and simply not registering the `SessionEnd` hook
disables it entirely. The read offset only advances after the lessons are
persisted, so a failed run reprocesses the same slice instead of losing it.

**Commands.**

```sh
nightshift mcp                     # start the stdio MCP server with the twenty-five tools
nightshift mcp --http --port 4747 --token <t>   # serve the same tools over Streamable HTTP on 127.0.0.1
nightshift hook session-start      # run a hook, reading the event JSON from stdin
nightshift reflect --transcript <path>   # reflect on a transcript now, in the foreground
nightshift embed download          # download the embedding weights (the only network path)
nightshift embed backfill          # embed the lessons and the decisions that still have no vector
nightshift memory stats [--json]   # counts per project
nightshift decision list [--project <name> | --org <name>] [--status <status>]   # the decisions log
nightshift decision show <number> [--project <name> | --org <name>]              # one decision, in full
nightshift decision export <number> [--dir <path>] [--force]                     # one decision as a markdown file
nightshift decision import <file.md> [--status <s>] [--superseded-by <n>] [--supersedes <n,...>] [--unrelated <n,...>]   # save a markdown decision file
nightshift roadmap [--project <name> | --org <name>]                             # the now/next/later roadmap
```

**Environment variables.**

| variable | effect |
|---|---|
| `NIGHTSHIFT_HOME` | home of the runtime, default `~/.nightshift` |
| `NIGHTSHIFT_EMBED_DISABLED` | `1` turns the semantic side off; the recall stays BM25 only |
| `NIGHTSHIFT_EMBED_DEADLINE_MS` | deadline of the embedding in the prompt hook, default `800` |
| `NIGHTSHIFT_REFLECT_MODEL` | model of the reflection, default `haiku` |
| `NIGHTSHIFT_CLAUDE_BIN` | path of the `claude` CLI used by the reflection, by the queue runner, by `nightshift setup` and by `nightshift doctor` |
| `NIGHTSHIFT_NPM_BIN` | path of the `npm` CLI that installs the runtime and the embedding prefix |
| `NIGHTSHIFT_JOB_ID` | set by the runner in the environment of the job it spawns, never read from outside |
| `CLAUDE_CONFIG_DIR` | configuration directory of the host that `nightshift setup` and `nightshift doctor` read and write, default `~/.claude` |
| `NIGHTSHIFT_REFLECT` | `1` marks a process as the reflection itself: no context block and no new reflection |
| `NIGHTSHIFT_MODEL`, `NIGHTSHIFT_SESSION_ID` | recorded in `pipeline_runs` by the server process |

**Honest numbers.** Measured in this repository, on macOS arm64 with Node
24.14.1:

| number | measured |
|---|---|
| `node_modules` of the package itself | 26 MB (94 packages) |
| the embedding prefix `$NIGHTSHIFT_HOME/embedding` | 380 MB |
| of which `onnxruntime-node` plus `onnxruntime-web` | 340 MB |
| embedding weights in `$NIGHTSHIFT_HOME/models` | 23 MB |
| one prompt hook, weights cached, semantic side on | 191 ms (median of 5 cold processes) |
| the same hook with `NIGHTSHIFT_EMBED_DISABLED=1` | 84 ms, so the semantic side costs about 107 ms |
| peak RSS of `nightshift embed backfill` with the model loaded | 227 MB, against 76 MB for `nightshift memory stats` |

That weight is exactly why the embedding library is not a dependency of the
package: `nightshift embed install` (or a yes during `nightshift init`) puts it in
`~/.nightshift/embedding` on demand, so the published package stays small and
audits clean. Without it every recall still answers through BM25 and the whole
test suite still passes.

### Decisions and roadmap

Two more things the runtime remembers, next to the lessons and the memories.

Both belong to exactly one **owner**, and an owner is a project or an org: a
decision several repos of the same product share is saved ONCE at org scope
instead of once per repo, and every project of that org reads it. A write names
`project` or `org`, never both; a read by `project` answers the project's rows
PLUS its org's, org rows first, each carrying its `scope` and its `owner`, while
a read by `org` answers that org's rows alone. A project never sees the rows of
another org.

A **decision** is one architecture decision of its owner, numbered inside that
owner (`#1`, `#2`, ... per project; `acme#1`, `acme#2` per org, and the numbering
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
`nightshift decision list` and `nightshift decision show`, and never reach a
prompt.

The **roadmap** is where "what next" lives: one line per intent, in one of the
three horizons `now`, `next` and `later`, ordered inside its horizon by a
contiguous position (`1..N`, renumbered on every move). An item carries a status
among `open`, `queued`, `done` and `dropped`, may link to the decision that
motivated it, and, once queued, to the job built from it.

**Private by design.** Both live only in `$NIGHTSHIFT_HOME/nightshift.db`, the
same file as the rest of the memory. The runtime writes nothing into the
repository, publishes nothing, and puts nothing in a pull request: no
`docs/adr/` tree, no `ROADMAP.md`; only an explicit `nightshift decision export`
writes a file. The only ways in are the MCP tools below and the one deliberate
terminal write, `nightshift decision import` (see below), and the only ways to
read them from a terminal are the three read-only commands
(`nightshift decision list`, `nightshift decision show <number>` and
`nightshift roadmap`), which resolve the project from the current directory when
`--project` is omitted, read one org alone with `--org <name>` instead, never
write, and never register a project. Read-only
means the database too: the three open it read-only, so they never create it and
never migrate it, and a home where nothing was ever saved reads as an empty one
(`no decisions for <project>`, every horizon empty) instead of a SQLite error.

**One source, moved on purpose.** `nightshift decision export <number>` writes
one decision as a markdown file, `<dir>/<nnnn>-<slug>.md` (default
`docs/decisions/` of the current directory; `--force` replaces an existing
file). It reads the database read-only like `show`, so it never creates nor
writes it; publishing that file stays a deliberate pull request of the operator.
`nightshift decision import <file.md>` is the one deliberate decision write from
a terminal: it reads an exported file or a hand-written ADR of the same shape
(`# <title>`, a `Status:` line with its date, `## Context`, `## Decision`,
`## Consequences`; any other `##` section stays inside the field it follows),
takes the status from the file unless `--status` overrides it
(`--superseded-by <n>` imports it `superseded`, pointing at `#n`), and saves it
through the same review as `decision_save`: an overlap refuses with the
candidates until each is named in `--supersedes` or `--unrelated`. On success it
prints `imported as #n` and stamps `Decision #n in the <owner> store.` into the
file's header; a file whose header already names an existing row of the owner is
refused, so a re-run imports nothing twice. The runtime itself never reads
`docs/decisions/`.

**The seven MCP tools** (parameters marked `?` are optional):

| tool | what it does |
|---|---|
| `decision_save` | records one decision: `project` or `org`, `title`, `context`, `decision`, `consequences?`, `status?` (default `accepted`), `supersedes?`, `unrelated?`; answers the `id`, the `number` and the owner it got. When the title overlaps an accepted or proposed title of the same owner, or the title plus decision is close in meaning to one, nothing is saved and it answers `status: "needs_review"` with the `candidates`; saving again names every candidate by `number`, in `supersedes` (they become `superseded` and point at the new row, in the same transaction) or in `unrelated`. Inside a queue job it stamps `job_id`, refuses `supersedes`, and refuses a second proposal while the first is still `proposed` |
| `decision_update` | changes a decision by `id`: any of `title`, `context`, `decision`, `consequences`, `status`, `superseded_by` — this is how a `proposed` one is accepted or rejected; `status: "superseded"` requires `superseded_by`, unless the row already names its successor; the row it answers is a compact one, truncated like `decision_list` |
| `decision_list` | the log in numbering order: `project` or `org`, `status?`; compact rows, org rows first |
| `decision_recall` | the standing constraints: `project` or `org`, `query?`, `limit?`; only `accepted` decisions, hybrid BM25 plus semantic, org rows first, and the text comes back untruncated because it feeds prompts |
| `roadmap_save` | adds an intent at the end of a horizon: `project` or `org`, `horizon`, `title`, `detail?`, `decision_id?` |
| `roadmap_update` | changes an item by `id`: `horizon`, `title`, `detail`, `status`, `position`, `decision_id`; `queued` is not a status that can be set by hand |
| `roadmap_get` | the whole roadmap of an owner: `project` or `org`; the three horizons in order, each item with its position, its linked decision and the live status of its job |

As everywhere else in the server, an explicit `null` is treated exactly like an
absent parameter, and `project` is the registered NAME, never a path.
`decision_update` and `roadmap_update` take an `id` and no owner, so inside an
unattended run they are restricted to the project of the job that is running:
an `id` belonging to another project is refused, naming both projects, the same
way `queue_retry` only retries its own job. An org row is refused there too,
naming its org — a job reads its org's decisions and never rewrites one. Outside
a job the restriction does not exist, and the operator updates any project from
anywhere.

Renaming an org carries its rows with it (`nightshift org rename` rewrites the
`org` of every decision and roadmap item), and an org that still owns rows
cannot be removed: the removal is refused naming how many. The rename records
its intent in `~/.nightshift/org-rename.pending.json` before it touches either
store; a rename interrupted halfway shows up as a failed `org rows` line of
`nightshift doctor`, and `nightshift org repair` settles it in the direction
the config already committed. Rows pointing to an org the config does not know
are the other thing that line reports; `nightshift org repair --to <org>` moves
them under an existing org.

**Queueing from the roadmap.** `queue_add` with `roadmap_item_id` and no
`prompt` (or `nightshift queue add --roadmap <id>`) builds the prompt from the
item instead of asking for it again: `## Task` with the title and the detail,
`## Linked decision` when the item links one, `## Standing decisions` with the
title of every accepted decision of the item's owner, `## Proposed (not binding)`
with the title of every proposed one, and `## Related decisions`
with at most eight accepted decisions the title recalled, in full - each heading
disappears when it has nothing under it. A **project** item decides where the job goes by itself,
so nothing is resolved from the current directory, and it is then marked `queued`
with the job id and flips to `done` when that job finishes `done`. An **org**
item cannot: a job is always one project's, so it takes the project from
`--project <name>` (`project` in `queue_add`), or from the current directory when
neither is given, and it must be a project of that org. That item is never linked
to a job — it stays `open` so it can be queued for every project of the org, and
only the operator marks it `done`. Passing both
`prompt` and `roadmap_item_id` is refused, because a silent precedence would let
the caller believe the item drove the job when it did not. Re-queueing a project
item whose job is still alive is refused too, naming that job; an org item, which
carries no job, is never refused for that reason. The text the operator
wrote - the title, the detail and the text of the decisions quoted under them -
is escaped on its way into that prompt: a line that would read as a heading
(`# ...` to `###### ...`) or as a `QUEUE_SLUG:` line is prefixed with a
backslash, so operator text stays readable but can never forge one of the three
headings above nor a literal of [Runtime contract](runtime-contract.md).

**How `/resolve` uses them.** The standing decisions are already in the block the
`SessionStart` hook injected, so the Phase 0 preflight pings `lesson_recall` alone:
the Brief copies EVERY accepted title from that section (or from one
`decision_list` with `status: "accepted"` when the section is absent), and adds
in full the 8 closest to the task, from one `decision_recall` with the affected
area and the objective as the query - the project's and its org's, in one call,
org rows first and written `acme#3` when they belong to the org. Both parts become
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
that job's id. `nightshift queue close <id>` and `nightshift queue close --merged`
list the open proposals of every job they closed and, on a terminal, ask
`accept / reject / keep` for each; `--decisions accept|reject|keep` answers for
all of them without asking, and without the flag and without a terminal (or
under `--json`) every proposal is kept, so scripts do not change. Each one
prints a `decision #n <title>: accepted|rejected|kept (proposed)` line, and
`--json` carries them in `decisions`. The MCP `queue_close` closes the job and
leaves its proposals alone. A proposal still open on a closed job is a warning
of the `decision proposals` line of `nightshift doctor`, which names each by
number and job.

