# nightshift

Autonomous queue of coding agents with its own memory.

## What it is

nightshift turns a coding request into a full pipeline run instead of a chat
session: the request is triaged against real evidence, explored, planned,
implemented, attacked by an adversarial QA and only then verified against the
checks the project itself defines. Every phase hands off through a file
artifact, so a run can be inspected, resumed and audited after the fact.

The long-term product is a queue that runs those pipelines unattended, on top
of a memory of its own - lessons, project decisions and structural indexes that
survive between runs and make each run cheaper than the last.

## Status - v0

The memory half of the runtime ships in this repository: a SQLite database, the
MCP server with the six tools the plugin requires, the three session hooks and
the CLI commands that drive them (see `## Memory`). The plugin in `plugin/` is
the pipeline half.

What is still missing: the queue and the scheduler that would run pipelines
unattended, and any automatic registration in `~/.claude` - the MCP server and
the hooks have to be wired into the host by hand.

## What ships today

- `/nightshift:resolve` - the 8-phase pipeline (triage, exploration,
  architecture, implementation, adversarial QA, verification, runtime
  validation, commit and report).
- `/nightshift:qa-guardian` - self-contained adversarial QA: risk matrix,
  proven breaks, fuzz templates.
- Six subagents, invoked as `nightshift:<agent>`: `architect`, `coder`,
  `explore`, `qa-guardian`, `triager`, `verifier`.
- `shift mcp` - the stdio MCP server that answers those six tools.

## Requirements

- Claude Code.
- Node >= 22: the memory runtime uses `node:sqlite`, which older versions do not
  ship. `npm install` on Node 20 only warns (`EBADENGINE`), but every memory
  command fails there.
- An MCP server named `nightshift`, exposing `lesson_recall`, `lesson_save`, `memory_recall`,
  `index_save`, `index_recall` and `pipeline_log`. All six are hard requirements: there is no
  memoryless mode - Phase 0 opens with a preflight call to `lesson_recall` and the run stops
  right there when the host does not expose it. `shift mcp` is that server.
- Two dependencies (`@modelcontextprotocol/sdk`, `zod`) and one optional
  dependency (`@huggingface/transformers`) that costs most of the install (see
  `## Memory`, honest numbers). Without it the recall is BM25 only.

An **empty** memory is not a problem: on a fresh install every recall comes back empty, and an
empty recall only makes the phase drop the corresponding section and move on with what it
already has. A memory **write** that fails is recorded as an open item in the artifact or in
the report, and the run continues - that covers `index_save` and `pipeline_log`, and also
`lesson_save`, which the Phase 0 critique gate calls when it avoided a wrong execution. What
stops a run is the server being **absent**, never it being empty.

## Try it

```
claude --plugin-dir ./plugin
```

The plugin loads that way, but `/nightshift:resolve` stops at the Phase 0 preflight until an
MCP server named `nightshift` is connected. `shift mcp` is that server: it speaks the protocol
over stdio and exposes exactly the six tools. Registering it in the host is still manual, and
so is registering the hooks.

## The `shift` CLI

`bin/shift.mjs` is the CLI: it manages orgs, projects and the connections (and
their secrets), and it drives the memory runtime.

- `shift --help` lists every command: `setup`, `init`, `org`, `project`,
  `connection`, `mcp`, `hook`, `reflect`, `embed` and `memory`.
- Exit codes: `0` ok, `1` user error (a single line on stderr), `2` unexpected
  error (a stack on stderr).
- Every `list` accepts `--json`; on `--json`, stdout is either valid JSON or
  empty, because warnings and errors always go to stderr.

The queue and the scheduler do not exist yet and land in a future version,
published as the npm package `nightshift`, of which this plugin is the pipeline
half.

## Configuration

`NIGHTSHIFT_HOME` (default `~/.nightshift`) is a single directory that holds
both the configuration at its root and the run artifacts under `runs/` (see
`## Runtime contract`) - one home, two kinds of content, not two environment
variables:

```
$NIGHTSHIFT_HOME/          # 0700
  config.json              # orgs, projects, queue settings
  secrets.json             # 0600, connection secrets
  nightshift.db            # the memory database (see `## Memory`)
  models/                  # embedding weights, downloaded on demand
  state/                   # per-session hook state
  runs/<project>/<slug>/   # run artifacts, written by the runtime
```

Secrets are kept in a `0600` file rather than in the operating system
credential store, because the runtime is meant to run unattended, with nobody
there to unlock anything.

A command that writes holds the directory `$NIGHTSHIFT_HOME.lock` while it
runs, so two `shift` processes never overwrite each other's changes; read-only
commands such as `list` never take it. The memory commands (`mcp`, `hook`,
`reflect`, `embed`, `memory`) never take it either: they rely on SQLite for
concurrency, so a running server never blocks a `shift init`.

```sh
shift setup                                   # create the home, config.json and secrets.json
shift init                                    # register the current git repository as a project
shift init ~/code/api --org acme --name api   # ...or an explicit path, org and name

shift org add acme --display-name "Acme"      # create an org
shift org list --json                         # orgs, connection slots, project counts
shift org rename acme acme-inc                # rewrites every project pointing at it
shift org remove acme-inc                     # refused while projects still point at it

shift project list                            # name, path, org, whether the path still exists
shift project move api acme                   # move a project to another org
shift project remove api

echo "$GITHUB_TOKEN" | shift connection add gh --type github
shift connection bind gh --org acme           # bind (or rebind) an org slot
shift connection test gh                      # prints login and scopes, never the token
shift connection list --json
shift connection remove gh                    # unbinds from every org, then deletes the secret
```

The secret is read from stdin when stdin is not a terminal, and asked for in a
hidden prompt otherwise. It is never accepted as a command-line argument, and
never printed back - not by `list`, not by `--json`, not by an error message.

A path that starts with `-` has to come after `--` (`shift init -- -weird-dir`),
otherwise it is parsed as an unknown option and rejected.

## Memory

Everything the runtime remembers lives in one SQLite file,
`$NIGHTSHIFT_HOME/nightshift.db`, opened in WAL with a five second busy timeout.
Several processes write to it at the same time - the MCP server, the hooks and
the reflection worker - so every write is retried while the lock is held by
someone else, and every transaction starts as `BEGIN IMMEDIATE` instead of being
promoted from a read. A write that is still refused after the retries comes back
as a message asking to run the command again, never as a raw SQLite error.
Only the `shift` runtime opens it: the plugin talks to the MCP tools, never to
the file. The schema is created and migrated on first use, and reopening an
existing database is a no-op.

Six tables plus two full text mirrors:

| table | what it holds |
|---|---|
| `lessons` | one lesson per mistake: title, root cause, solution, prevention rule, target phase, how many attempts it cost, how often it was injected and violated, and its embedding |
| `memory` | project facts and durable decisions, as key and value, per project or global |
| `project_index` | the file to responsibility map of a project, with the mtime the file had when it was indexed |
| `project_libs` | the libraries of a project with the version that was actually resolved |
| `pipeline_runs` | one row per `/resolve` run: tier, task type, outcome, gate stop, duration, model and session |
| `pipeline_phases` | one row per phase of a run: sequence, phase, model, status, retry and duration |
| `lessons_fts`, `memory_fts` | FTS5 mirrors of the two text tables, kept in sync by triggers on insert, update and delete |

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

- `shift hook session-start` prints the block injected at the start of a
  session: the top lessons of the project plus its memories, and it records
  what it injected in `state/<session>.json` and in the corpus.
- `shift hook prompt-context` prints the lessons and memories relevant to the
  prompt that was just submitted, skipping what this session already saw, and
  ignoring prompts too short to carry a request.
- `shift hook reflect` answers `{}` immediately and leaves a detached worker
  reading the transcript.

None of them is registered anywhere by this repository: wiring them into the
host is a manual step.

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
shift mcp                     # start the stdio MCP server with the six tools
shift hook session-start      # run a hook, reading the event JSON from stdin
shift reflect --transcript <path>   # reflect on a transcript now, in the foreground
shift embed download          # download the embedding weights (the only network path)
shift embed backfill          # embed the lessons that still have no vector
shift memory stats [--json]   # counts per project
```

**Environment variables.**

| variable | effect |
|---|---|
| `NIGHTSHIFT_HOME` | home of the runtime, default `~/.nightshift` |
| `NIGHTSHIFT_EMBED_DISABLED` | `1` turns the semantic side off; the recall stays BM25 only |
| `NIGHTSHIFT_EMBED_DEADLINE_MS` | deadline of the embedding in the prompt hook, default `800` |
| `NIGHTSHIFT_REFLECT_MODEL` | model of the reflection, default `haiku` |
| `NIGHTSHIFT_CLAUDE_BIN` | path of the `claude` CLI used by the reflection |
| `NIGHTSHIFT_REFLECT` | `1` marks a process as the reflection itself: no context block and no new reflection |
| `NIGHTSHIFT_MODEL`, `NIGHTSHIFT_SESSION_ID` | recorded in `pipeline_runs` by the server process |

**Honest numbers.** Measured in this repository, on macOS arm64 with Node
24.14.1:

| number | measured |
|---|---|
| `node_modules` without the optional dependency | 26 MB (94 packages) |
| `node_modules` with it | 406 MB |
| of which `onnxruntime-node` plus `onnxruntime-web` | 340 MB |
| embedding weights in `$NIGHTSHIFT_HOME/models` | 23 MB |
| one prompt hook, weights cached, semantic side on | 191 ms (median of 5 cold processes) |
| the same hook with `NIGHTSHIFT_EMBED_DISABLED=1` | 84 ms, so the semantic side costs about 107 ms |
| peak RSS of `shift embed backfill` with the model loaded | 227 MB, against 76 MB for `shift memory stats` |

The optional dependency is what makes the install heavy, and it degrades
cleanly: if it fails to build or is skipped with `npm install --omit=optional`,
every recall still answers through BM25 and the whole test suite still passes.

## Runtime contract

What a runtime has to provide, and what it can rely on:

- `NIGHTSHIFT_HOME` - home directory of the runtime, default `~/.nightshift`.
- Run artifacts live in `${NIGHTSHIFT_HOME}/runs/<project>/<slug>/`, always
  outside the worktree, because the worktree is removed before the last phase
  reads them.
- Artifact names, in order: `01-triage.md`, `02-explore.md`, `03-plan.md`,
  `04-implementation.md`, `05a-qa-analyst.md`, `05-qa.md`,
  `06-verification.md`.
- `state.json` in the same directory carries the resumable state:
  `schemaVersion`, `slug`, `project`, `type`, `tier`, `branch`, `worktree`,
  `resumeCount`, `updatedAt`, `termination`, `qaStageA` and
  `phases[{phase, artifact, verdict}]`.
- Literals a runtime parses from the pipeline's stdout: `QUEUE_SLUG:`,
  `## Requires user confirmation` (the run is waiting on a human gate) and
  `## Notice` (the executive summary to deliver).

These names are a machine contract, not prose: the pipeline files are the
source of truth for them, and any runtime that reads them must match them
exactly.

The six MCP tools, with the parameters `shift mcp` actually accepts:

| tool | parameters |
|---|---|
| `lesson_recall` | `query?`, `project?`, `target?`, `exclude_ids?` |
| `lesson_save` | `title`, `root_cause`, `solution`, `prevention`, `attempts?`, `project?`, `target?` |
| `memory_recall` | `query?`, `project?` |
| `index_save` | `project`, `repo_root`, `files[{path, responsibility}]`, `libs?[{lib, version}]` |
| `index_recall` | `project`, `repo_root?`, `query?` |
| `pipeline_log` | `slug`, `tier`, `outcome`, `project?`, `task_type?`, `gate_stop?`, `duration_s?`, `phases?[{phase, model?, status?, retry?, duration_s?, note?}]` |

Every optional parameter accepts an explicit `null` and treats it exactly like
an absent one, so a caller that fills its whole argument object never gets an
error for a field it had nothing to put in. The closed
vocabularies are `target` (`triager`, `architect`, `coder`, `qa`, `verifier`),
`tier` (`trivial`, `simple`, `complex`), `task_type` (`bug/error`,
`feature/refactor`), `outcome` (`pr_opened`, `local_commit`, `no_commit`),
`gate_stop` (`critique`, `triage`, `architect`, `qa`, `verification`, `runtime`,
`user`) and the phase `status` (`ok`, `failed`, `skipped`). A value outside them
comes back as an error message, never as a stack.

`pipeline_runs.model` and `pipeline_runs.session_id` are not parameters: the
server reads them from `NIGHTSHIFT_MODEL` and `NIGHTSHIFT_SESSION_ID` in its own
environment, and stores `NULL` when they are not set.

## License

Business Source License 1.1. Change Date 2029-09-04, Change License
Apache License, Version 2.0. See `LICENSE`.

**Project note, not part of the license text:** this BSL 1.1 text and its
parameters have not been through legal review yet. That review is pending and
has to happen before the first `npm publish` of this package.
