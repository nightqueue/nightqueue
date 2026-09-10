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
the CLI commands that drive them (see `## Memory`). The queue that runs those
pipelines unattended ships too, with its own five tools (see `## Queue`). The
plugin in `plugin/` is the pipeline half.

What is still missing: the scheduler that would start the queue by itself at
night, and any cockpit over it. Registering the MCP server, the hooks and the
plugin in the host is no longer a manual step - `nightshift setup` does it (see
`## Install`), and `nightshift doctor` says whether it took (see `## Doctor`).

## What ships today

- `/nightshift:resolve` - the 8-phase pipeline (triage, exploration,
  architecture, implementation, adversarial QA, verification, runtime
  validation, commit and report). The pull request it opens follows the fixed
  template in `plugin/skills/resolve/references/pr-template.md`.
- `/nightshift:qa-guardian` - self-contained adversarial QA: risk matrix,
  proven breaks, fuzz templates.
- `/nightshift:queue` - queues the current plan or request as one unattended
  job, without running it: it cuts the job, resolves the project of the current
  directory, writes the prompt and answers with the job id and the pending
  count.
- Six subagents, invoked as `nightshift:<agent>`: `architect`, `coder`,
  `explore`, `qa-guardian`, `triager`, `verifier`.
- `nightshift mcp` - the stdio MCP server that answers those six tools plus the five
  of the queue.
- `nightshift queue` - the unattended queue: enqueue a request, run it through
  `/nightshift:resolve` and get a pull request back (see `## Queue`).
- `nightshift setup` - installs the runtime in `~/.nightshift` and registers the MCP
  server, the three hooks and the plugin in the host, idempotently and
  reversibly (see `## Install`).
- `nightshift doctor` - the read-only diagnosis of the host and the home (see
  `## Doctor`).

## Requirements

- Claude Code.
- Node >= 22: the memory runtime uses `node:sqlite`, which older versions do not
  ship. `npm install` on Node 20 only warns (`EBADENGINE`), but every memory
  command fails there.
- An MCP server named `nightshift`, exposing `lesson_recall`, `lesson_save`, `memory_recall`,
  `index_save`, `index_recall` and `pipeline_log`. All six are hard requirements: there is no
  memoryless mode - Phase 0 opens with a preflight call to `lesson_recall` and the run stops
  right there when the host does not expose it. `nightshift mcp` is that server.
- Two dependencies (`@modelcontextprotocol/sdk`, `zod`). The embedding library
  (`@huggingface/transformers`) is not one of them: it is opt-in and lands in
  its own prefix, `~/.nightshift/embedding` (see `## Memory`, honest numbers).
  Without it the recall is BM25 only.

An **empty** memory is not a problem: on a fresh install every recall comes back empty, and an
empty recall only makes the phase drop the corresponding section and move on with what it
already has. A memory **write** that fails is recorded as an open item in the artifact or in
the report, and the run continues - that covers `index_save` and `pipeline_log`, and also
`lesson_save`, which the Phase 0 critique gate calls when it avoided a wrong execution. What
stops a run is the server being **absent**, never it being empty.

## How nightshift is meant to be used

nightshift is a backlog, not a chat: `queue add` only records the work, and
nothing runs until you start the batch.

- **During the day, queue.** Every task or plan becomes a `nightshift queue add`
  the moment it comes up. One job is one deliverable that can be reviewed and
  merged on its own; large work goes in as ONE job with numbered stages written
  in the prompt, never as several jobs that depend on each other (see
  `## Writing a job`).
- **When you step away, start the batch.** `nightshift queue run` takes the whole
  backlog, in priority order, detached - and `--watch` keeps a runner picking up
  whatever you queue afterwards (see `### Running the queue`).
- **When you come back, review.** `nightshift queue status` says what each job
  became: an open pull request, or a stop at a gate with the reason in its
  notice. A gate is answered with
  `nightshift queue retry <id> --note "<your answer>"`.
- **`--run` is the exception.** It starts that one job right away, for the work
  you need now instead of tonight.

## Install

One command installs everything; the rest is the daily flow, from anywhere, on a
machine that has nothing installed yet:

```sh
npx @maykonv/nightshift init                           # install the runtime and set the host up
# then open a new terminal, or source your rc file, so `nightshift` resolves
nightshift doctor                                      # check the host and the home
nightshift queue add "fix the flaky worker"            # queue one deliverable
nightshift queue add "add the retry to the uploader"   # and the next one
nightshift queue add api "rotate the webhook secrets"  # a job of another registered project
nightshift queue run                                   # start the whole batch, detached, when you step away
```

The next morning, `nightshift queue status` says what each job became and the
pull requests are waiting for review; `nightshift queue run --watch` keeps a
runner picking up whatever you queue afterwards (see `### Running the queue`).

**Run one job now.** `nightshift queue add "fix the flaky worker" --run` queues
the request and starts the runner on that job right away, instead of leaving it
in the backlog, and `nightshift queue log <id> --follow` watches that run as it
happens.

**A repository nobody registered yet.** Inside a git repository that is not a
registered project, `nightshift queue add` asks one question — register it under
the basename of its root and queue the job — and does both in the same run.
`--yes` answers it for a script; with no terminal and no `--yes` the command
keeps failing as before, without registering anything.

`npx @maykonv/nightshift init` is the whole installation. It puts the package
in `~/.nightshift/runtime`, writes the shims `~/.nightshift/bin/nightshift`,
`nshift` and `nsft` (`--no-shortcuts` writes only `nightshift`), offers to
put that directory on your PATH, registers the MCP server, the hooks and the
plugin **against the runtime**, and offers the semantic recall. Nothing depends
on where the command ran from: the npx cache and a development checkout both
converge on the same `~/.nightshift/runtime`. The npm package is scoped,
`@maykonv/nightshift`; the command it installs is still `nightshift`.

Outside a repository it stops right there and says so. Inside one, it also
registers that repository as a project and offers to import the token of the
GitHub CLI. Either way it closes with the same `Next steps` block: how to queue
work from Claude Code, how to start the batch and how to review it.

Flags: `--path` / `--no-path` answers the PATH question
without a terminal,
`--embedding` / `--no-embedding` answers the semantic recall question,
`--gh` / `--no-gh` answers the GitHub CLI one, `--shortcuts` / `--no-shortcuts`
decides whether the short command names are written, `--desktop` /
`--no-desktop` decides whether the MCP server is registered in the Claude
Desktop app, and `--org` / `--name` name
the project. Without a terminal and without the flag, nothing is written and nothing
is downloaded: both questions print what to run by hand instead.
`--from <dir|tgz>` installs another checkout or tarball instead of the package
that is running (see `## Developing nightshift`).

Every step of `init` the runtime cannot work without is fatal: a failed home,
runtime or shim exits 1, and the PATH block is only written once
`~/.nightshift/bin/nightshift --version` has answered. A step that only degrades
the experience - MCP server, hooks, plugin, semantic recall - is reported and the
command still exits 0, pointing at `nightshift doctor`. The PATH block itself is
guarded, so sourcing your rc file again never prepends the directory twice:

```sh
# nightshift
case ":$PATH:" in
  *":$HOME/.nightshift/bin:"*) ;;
  *) export PATH="$HOME/.nightshift/bin:$PATH" ;;
esac
# nightshift end
```

The two marker lines delimit the block, and nothing between them is ours unless BOTH
are there: a `# nightshift` you wrote for your own reason, followed by lines that happen
to look like ours, is never rewritten and never removed.

`nightshift update` reinstalls the runtime from the registry at the newest
version and re-points the host at it; config, secrets and the database stay
untouched. `nightshift update 0.2.0` asks the registry for that exact version
instead (a tag such as `next` works too), and `--from <dir|tgz>` installs a local
source instead of asking the registry at all (see `## Developing nightshift`); a
version and `--from` together are a usage error, because they are two different
sources. The runtime line names both versions, as in
`runtime: updated (v0.1.0 -> v0.2.0 at ~/.nightshift/runtime)`. `update` is the
only command that reaches the registry to install, and a runtime it could not
reinstall is an exit code, never a quiet degraded line.

`nightshift init` is `nightshift setup` plus the project registration, always in that
order: every step below first, then the repository of the current directory (or
of `[path]`), then the token of the GitHub CLI. Running it again changes
nothing: every step reports `already present` and the project reports
`already registered`.

**The token of the GitHub CLI.** When `gh` is installed and authenticated and
the `github` slot of the org is still free, `nightshift init` on a terminal asks
`GitHub CLI is authenticated as <login> — import its token as connection "gh"?
[Y/n]`. A yes reads `gh auth token`, stores it in `secrets.json` (`0600`), binds
it to the org and checks it against the API; the value never goes through argv,
stdout or stderr. `--gh` imports without asking, `--no-gh` never even calls the
binary, and without a terminal nothing is asked - only a line pointing at
`nightshift init --gh`. A slot already taken, a connection already named `gh`, a
missing `gh` or one that is logged out all cost a single line and never an
error; the manual path stays open:

```sh
echo "$GITHUB_TOKEN" | nightshift connection add gh --type github
```

`NIGHTSHIFT_GH_BIN` chooses which `gh` binary the import calls.

Restart Claude Code and the pipeline answers as `/nightshift:resolve`. To check
the result of all of it at any point, run `nightshift doctor`.

**The manual flow**, still supported one step at a time, on top of a global
install (`npm install -g @maykonv/nightshift`) or a clone (`npm install` plus
`npm link`):

```sh
nightshift setup                                   # install the runtime and register everything in the host
nightshift init                                    # register this repository as a project
echo "$GITHUB_TOKEN" | nightshift connection add gh --type github
```

`nightshift setup` is idempotent and prints the state of every step (`created`,
`already present` or `updated`), in this order:

1. the configuration home (`0700`), `config.json` and `secrets.json` (`0600`).
2. the runtime in `$NIGHTSHIFT_HOME/runtime`, at the version of the package that
   ran the command; already at that version means no reinstall.
3. the shims `$NIGHTSHIFT_HOME/bin/nightshift`, `nshift` and `nsft` (`0755`
   each), plus the offer to add that directory to the PATH through a guarded
   block marked `# nightshift` in `~/.zshrc`, `~/.bashrc` or
   `~/.config/fish/config.fish`.
4. the MCP server `nightshift` at **user** scope, started as
   `node $NIGHTSHIFT_HOME/runtime/node_modules/@maykonv/nightshift/bin/nightshift.mjs mcp`.
5. the same server in the configuration of the Claude Desktop app
   (`claude_desktop_config.json`), when that app is installed - an app that is
   not installed is a `skipped` step and never a directory this CLI creates.
   `--no-desktop` skips it.
6. the three hooks in `<claude config>/settings.json`: `SessionStart`,
   `UserPromptSubmit` and `SessionEnd`, pointing at that same entry.
7. the runtime as a local marketplace, plus the plugin installed from it.
8. the semantic recall: the embedding library in `$NIGHTSHIFT_HOME/embedding`
   and its weights - the only step that opens the network, and the only one
   that is opt-in.

Steps 4 to 7 never run when step 2 could not finish: a hook pointing at a
runtime that is not there would break every session of the host.

`--remove` undoes steps 3 to 7 - the shims, the marked PATH block, the MCP server,
its entry in the Claude Desktop configuration,
the three hook entries, the plugin and the marketplace - and asks before
deleting `runtime/` and `embedding/`. It never touches `config.json`,
`secrets.json` or the database; only `--remove --purge` deletes
`$NIGHTSHIFT_HOME` whole.

**Coexistence with hooks of other tools.** The merge into `settings.json` is not
destructive: every entry that is not this package's is left as it is, matcher
included, and events nightshift does not use are never even read. The file is
backed up as `settings.json.bak-<timestamp>` before the first change of a run,
and a run that has nothing to change does not rewrite the file at all - so a
second `nightshift setup` leaves it byte for byte identical. A `settings.json` that
is not valid JSON stops the step with an error instead of being overwritten.

The hooks are registered at user scope, so they run in **every** Claude Code
session of the machine - but the two that inject context produce no output at
all outside a directory registered with `nightshift init`. The exception is
`SessionEnd`, the reflection, which spends tokens on any session it sees: not
registering it, or `NIGHTSHIFT_REFLECT=1`, turns it off (see `## Memory`).

If the `claude` CLI is missing or one of its subcommands fails, the setup does
not stop: it prints the step as `failed`, prints the exact command to run by
hand, finishes the remaining steps and points at `nightshift doctor`. The hooks are
plain file writes, so they land even with no `claude` at all.

`CLAUDE_CONFIG_DIR` is honored everywhere, so a throwaway host is one variable
away. `NIGHTSHIFT_CLAUDE_BIN` chooses which `claude` binary the setup and the
diagnosis call.

**Upgrading from the `shift` command.** The CLI used to be called `shift`. Run
`nightshift setup` again: it re-points the hooks and the MCP server at
`bin/nightshift.mjs` without duplicating any entry, writes the three new shims
and removes the old `~/.nightshift/bin/shift`. A file of another tool sitting
under that name is kept, and `nightshift doctor` says so instead of deleting it.

### Using nightshift from Claude

With the MCP server registered, Claude drives the same backlog from inside a
session: ask it to queue the tasks as they come up, and to start the batch later
with `queue_run`. Claude does not start a job the moment it queues it - it waits
for the batch - unless you ask for that one job now. What each job became comes
back through `queue_status`, and a job stopped at a gate is answered with
`queue_retry`. In Claude Code, `/nightshift:queue` is the shortcut for that
first step: it turns the plan under discussion into one job and records it.

`nightshift setup` registers the same server in `claude_desktop_config.json`,
so the Claude Desktop chat, Cowork, and every other client that reads that file
see the same server and the same queue as Claude Code; restart the Claude
Desktop app once after the setup for it to pick the server up. The merge is not destructive: every other
server and every other key of that file is left exactly as it was, the file is
backed up as `claude_desktop_config.json.bak-<timestamp>` before the first
change of a run, and a run with nothing to change does not rewrite it at all. A
file that is not valid JSON, or that carries a `__proto__`, `constructor` or
`prototype` key, is never rewritten: the step is reported as `failed` and the
rest of the setup goes on.

## Updating

You find out that a new version exists without asking for it. `nightshift queue
status` and the context block the session hook injects at the start of a Claude
Code session inside a registered project close with a single line whenever the
registry has something newer than the runtime you have installed:

```
nightshift 0.2.0 is available (installed 0.1.0) - run `nightshift update`
```

That line is passive and cheap. The registry is asked at most once every 24
hours; the answer is cached in `$NIGHTSHIFT_HOME/update-check.json` as
`{ "checkedAt", "latest" }` and every invocation in between reads that file
instead of the network. The request has a three second timeout and the whole
check is fail-open: a registry that does not answer, a reply that is not a
version or a cache that cannot be read never breaks the command and never prints
anything - the line simply does not appear. `--json` output never carries it,
and neither does a job the runner spawned, because an unattended session has
nobody to read a notice. `nightshift doctor --check-updates` asks the same
question on demand (see `## Doctor`).

`nightshift update` is how you take the new version (see `## Install` for what it
reinstalls). It refuses while the queue is working:

```
nightshift: a job is running - update after it finishes, or stop the runner first (nightshift queue run --stop)
```

The refusal exits `1` and has two causes: a job holding a live lease, or a
watcher registered in `$NIGHTSHIFT_HOME/runner.pid`. A job left behind by a crash
does not count - its lease is dead, so it never blocks the command that repairs
the installation. `nightshift update --force` overrides both, for when you know
the state of the machine better than the pidfile does.

`NIGHTSHIFT_NO_UPDATE_CHECK=1` turns the check off entirely: no cache read, no
request, no line, on every surface.

**There is no auto-update, and that is a decision.** This runtime executes
unattended jobs: a batch started at night runs for hours with nobody watching it.
Code that replaced itself under a job already in flight would change the
pipeline, the hooks and the MCP server mid-run, and the failure would land on a
pull request nobody could explain the next morning. So the upgrade is always a
command you run, at a moment you chose - and it refuses on its own when that
moment is the wrong one.

## Try it without installing

```
claude --plugin-dir ./plugin
```

The plugin loads that way, but `/nightshift:resolve` stops at the Phase 0 preflight until an
MCP server named `nightshift` is connected. `nightshift mcp` is that server: it speaks the protocol
over stdio and exposes those six tools plus the five of the queue, and `nightshift setup` is what
registers it.

## The `nightshift` CLI

`bin/nightshift.mjs` is the CLI: it manages orgs, projects and the connections (and
their secrets), and it drives the memory runtime.

- `nightshift --help` lists every command: `setup`, `doctor`, `init`, `org`,
  `project`, `update`, `connection`, `mcp`, `hook`, `reflect`, `embed`,
  `memory`, `queue` and `version`.
- `nightshift --version` (same as `nightshift version`) prints the installed version
  and exits `0`.
- Exit codes: `0` ok, `1` user error (a single line on stderr), `2` unexpected
  error (a stack on stderr). `nightshift doctor` also exits `1` when a check fails.
- Every `list` accepts `--json`; on `--json`, stdout is either valid JSON or
  empty, because warnings and errors always go to stderr.

The queue lives in `nightshift queue` (see `## Queue`); the scheduler that would
start it by itself lands in a future version, published as the npm package
`nightshift`, of which this plugin is the pipeline half.

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
  runtime/                 # the installed package the host is registered against
  bin/                     # the shims: nightshift, nshift and nsft
  embedding/               # npm prefix of the embedding library, opt-in
  models/                  # embedding weights, downloaded on demand
  state/                   # per-session hook state
  runs/<project>/<slug>/   # run artifacts, written by the runtime
  logs/                    # one log per queue job plus one per runner
  queue.paused             # sentinel file, present only while the queue is paused
  runner.pid               # registration of the watch runner, present only while one is up
```

Secrets are kept in a `0600` file rather than in the operating system
credential store, because the runtime is meant to run unattended, with nobody
there to unlock anything.

A command that writes holds the directory `$NIGHTSHIFT_HOME.lock` while it
runs, so two `nightshift` processes never overwrite each other's changes; read-only
commands such as `list` never take it. The memory and queue commands (`mcp`,
`hook`, `reflect`, `embed`, `memory`, `queue`) never take it either: they rely
on SQLite for concurrency, so a running server - or a runner that works all
night - never blocks a `nightshift init`. The one exception is the registration
`nightshift queue add` (and `queue_add`) offers inside an unregistered
repository: that single write of `config.json` takes the lock by itself, so it
never races a `nightshift project add`.

```sh
nightshift setup                                   # install the runtime and register everything in the host
nightshift setup --remove --purge                  # undo the registrations, or delete the home as well
nightshift update                                  # reinstall the runtime and re-point the host at it
nightshift update 0.2.0                            # ...at one exact version from the registry
nightshift doctor --json                           # check the host and the home, exit 1 on any failure
nightshift doctor --check-updates                  # ...and ask the registry for the newest version
nightshift init                                    # set the host up and register the current repository
nightshift init ~/code/api --org acme --name api   # ...or an explicit path, org and name
nightshift init --no-embedding --no-path --no-gh   # ...answering every question up front

nightshift org add acme --display-name "Acme"      # create an org
nightshift org list --json                         # orgs, connection slots, project counts
nightshift org rename acme acme-inc                # rewrites every project pointing at it
nightshift org remove acme-inc                     # refused while projects still point at it

nightshift project list                            # name, path, org, whether the path still exists
nightshift project move api acme                   # move a project to another org
nightshift project remove api

echo "$GITHUB_TOKEN" | nightshift connection add gh --type github
nightshift connection bind gh --org acme           # bind (or rebind) an org slot
nightshift connection test gh                      # prints login and scopes, never the token
nightshift connection list --json
nightshift connection remove gh                    # unbinds from every org, then deletes the secret
```

The secret is read from stdin when stdin is not a terminal, and asked for in a
hidden prompt otherwise. It is never accepted as a command-line argument, and
never printed back - not by `list`, not by `--json`, not by an error message.

A path that starts with `-` has to come after `--` (`nightshift init -- -weird-dir`),
otherwise it is parsed as an unknown option and rejected.

## Memory

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

Seven tables plus two full text mirrors:

| table | what it holds |
|---|---|
| `lessons` | one lesson per mistake: title, root cause, solution, prevention rule, target phase, how many attempts it cost, how often it was injected and violated, and its embedding |
| `memory` | project facts and durable decisions, as key and value, per project or global |
| `project_index` | the file to responsibility map of a project, with the mtime the file had when it was indexed |
| `project_libs` | the libraries of a project with the version that was actually resolved |
| `pipeline_runs` | one row per `/resolve` run: tier, task type, outcome, gate stop, duration, model and session |
| `pipeline_phases` | one row per phase of a run: sequence, phase, model, status, retry and duration |
| `jobs` | one row per queue job: project, prompt, priority, status, attempts, lease, slug, session, branch, pull request, notice, usage and cost |
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

- `nightshift hook session-start` prints the block injected at the start of a
  session: the top lessons of the project plus its memories, and it records
  what it injected in `state/<session>.json` and in the corpus.
- `nightshift hook prompt-context` prints the lessons and memories relevant to the
  prompt that was just submitted, skipping what this session already saw, and
  ignoring prompts too short to carry a request.
- `nightshift hook reflect` answers `{}` immediately and leaves a detached worker
  reading the transcript.

`nightshift setup` registers the three of them at user scope, and `nightshift setup
--remove` takes them out again (see `## Install`). The two that inject context
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
nightshift mcp                     # start the stdio MCP server with the eleven tools
nightshift hook session-start      # run a hook, reading the event JSON from stdin
nightshift reflect --transcript <path>   # reflect on a transcript now, in the foreground
nightshift embed download          # download the embedding weights (the only network path)
nightshift embed backfill          # embed the lessons that still have no vector
nightshift memory stats [--json]   # counts per project
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

## Queue

The queue is what makes the runtime unattended: `nightshift queue add` records a
request against a registered project, `nightshift queue run` claims it and spawns
`claude -p /nightshift:resolve <request>` with the plugin of this package and
this same MCP server attached, and the pipeline itself opens the pull request at
the end. The runner reads the stream of the run and stores what
`## Runtime contract` defines: the slug, the session id, the pull request URL,
the `## Notice` and the token usage.

```sh
nightshift queue add api "fix the flaky worker" --priority 2   # enqueue a job
nightshift queue add "fix the flaky worker"                    # same, for the project of the current directory
nightshift queue add fix the flaky worker --run                # enqueue and start the runner on it, detached
nightshift queue add "fix the flaky worker" --yes              # register the repository of the current directory without asking
nightshift queue status [--limit 10] [--json]                  # the state of the runner, the table of the queue and the counts
nightshift queue status --follow [2] [--until-idle]            # the same table, redrawn in place until Ctrl-C (or until the queue is idle)
nightshift queue status 7 [--json]                             # one job, never with its prompt
nightshift queue run [--job 7] [--max 2] [--dry]               # start the runner detached; --dry only reports
nightshift queue run --watch [30]                              # start a watcher, one pass every N seconds
nightshift queue run --stop                                    # end the watcher registered in the home
nightshift queue run --foreground [--job 7]                    # run it in this process instead, for a script or CI
nightshift queue log 7 [--follow] [--raw] [--all]              # the narrated stream of the job
nightshift queue cancel 7 --reason "not needed"                # cancel a pending, gated or orphaned job
nightshift queue retry 7 --note "rename the column" [--fresh]  # answer the gate and send the job back to the queue
nightshift queue pause | nightshift queue resume                    # stop claiming new jobs, or claim again
```

**The project is optional, the prompt is variadic.** Omitted, the project is the
one whose registered path contains the current directory (`nightshift init` is what
registers it), and the command says which one it picked. Given, the first word
is the project only when it is a registered NAME; anything else is already part
of the prompt, so the words of the request need no quotes.

**No project registered for the current directory.** Inside a git repository, on
a terminal, the command asks `Register it as <name> in org <org> and queue the
job?`, with `<name>` derived from the basename of the repository root (`-2`,
`-3` ... when that name is taken). A yes registers the root and queues the job in
the same run; a no changes nothing. `--yes` answers the question for a script.
Without a terminal and without `--yes`, or outside any repository, the command
fails exactly as it did before and registers nothing.

**Options are read only at the two edges of the command line**, before the first
word of the request and after the last one. Everything between them is the
prompt, kept exactly as it was typed: `nightshift queue add explain the --run flag to
the team` queues those seven words and starts nothing. A prompt that begins or
ends with a flag is the ambiguous case, and goes after `--`:
`nightshift queue add -- explain --run to me`. An option that does not exist is still
a usage error at either edge, never a silent word of the prompt.

**`--run` starts the runner on the job right away**, detached, instead of leaving
it for the next `nightshift queue run`. It prints the job id first, then the line
`job #<id> started (pid <pid>) - follow with: nightshift queue log <id> --follow`,
and exits `0` as soon as the child is up: the exit code answers for the start, not
for the outcome of the job, which is read with `queue status` or `queue log`. Add
`--foreground` to get the old behaviour back - the job runs in this very process,
the stream goes to the log of the job, and the exit code answers only about this
run: `0` when the job ended as `done`, `1` for any other outcome (`gate`,
`failed`, `cancelled`, an interrupted run) and `1` when the job never started,
with the reason on the line `job #<id> did not start (<reason>)` - the job stays
in the queue. `--foreground` on a command that was not given `--run` is a usage
error, never a silent no-op. An explicit job id ignores the pause sentinel, so
`--run` runs even on a paused queue.

### Running the queue

**The runner is detached by default.** `nightshift queue add --run`,
`nightshift queue retry --run` and `nightshift queue run` all spawn a child that runs
the queue on its own and return as soon as that child is up, with exit code `0`.
The child is this same CLI started as `nightshift queue run --foreground ...`, so
`--foreground` is both the flag you type for a blocking run and the flag that tells
the child it is the worker. A start that cannot spawn exits `1` with the reason and
never falls back to running the job in the foreground behind your back.

Its output goes to `$NIGHTSHIFT_HOME/logs/runner-<stamp>.log`, which
`queue run` prints on the line `runner started (pid <pid>) - log: <path>`. When the
start is aimed at a single job the line points at that job's own narrated stream
instead: `job #<id> started (pid <pid>) - follow with: nightshift queue log <id> --follow`.

**`--foreground` is the mode for a script or for CI**: it runs the cycle in the very
process you started, prints one line per processed job and answers with an exit code
that depends on the outcome (`0` only for `done` on `--run`). `--dry` never detaches
either: it is a read-only report of what a cycle would do.

**`--watch [seconds]` is the daemon**, one pass every `N` seconds (30 by default).
It registers itself in `$NIGHTSHIFT_HOME/runner.pid` with `pid`, `startedAt`, `mode`,
`intervalS` and `logPath`, and prints
`runner started (pid <pid>, every <n> s) - stop with: nightshift queue run --stop`.
Only one watcher at a time: a second one is refused with the pid of the first, while a
registration whose process is gone is cleared and the start goes on. A single-shot
runner (`--run`, `--job`, a bare `queue run`) writes no pidfile - two of them never
collide because a job is claimed under a lease, not under a file. `--job` and `--watch`
are refused together: running one job and watching the whole queue are opposite intents.

**`nightshift queue run --stop` ends the watcher**: it sends a `SIGTERM` and waits up
to ten seconds for the process to go. It answers `runner stopped (pid <pid>)`,
`runner was not running (stale pidfile removed)` or `runner is not running`, and exits
`0` in the three cases; it exits `1` only when the process is still there after those
ten seconds, saying that the runner finishes the job it is running and exits by
itself. `--stop` takes no other option. Known limitation: if the watcher died and the
system handed its pid number to another process inside the same boot session, `--stop`
trusts the registration and signals that pid; confirming the real identity of a process
would need `ps`//proc/ and is out of the scope of this command.

**A watcher stopped in the middle of a job never corrupts it.** The signal makes the
runner stop claiming and end the child of the job it was running; that job is released
back to `pending`, with its lease dropped and its attempt given back, so the next
runner picks it up as if it had never started. The watcher then removes its own
registration - and only its own, matched by pid, so it never clears the pidfile of
another runner.

**`queue status` is a table, and `--follow` keeps it live.** One row per job with
the columns of the cockpit: `ID STATUS DURATION TOKENS PROJECT SLUG/LAST PR`.
`STATUS` carries an icon (`● running`, `✓ done`, `⚑ gate`, `✗ failed`,
`⊘ cancelled`, `○ pending`) and a color on a terminal. `DURATION` is how long a
running job has been up (from its own `started_at`) or how long a finished one
took; `TOKENS` is what it spent so far (`374k`, `1.2M`). `SLUG/LAST` is the last
thing the orchestrator said in its log while the job runs (`» ...`), the first
line of the notice of a `gate` or `failed` job, and the slug otherwise; `PR` is
the URL of the pull request, bare, so the terminal makes it clickable on its own. Only running jobs are read from disk, and only the tail of their log, so
listing a job whose stream is already hundreds of kilobytes costs nothing; a job
with no log yet and a log that cannot be read both show `-`, the table is always
printed in full and the exit code stays `0`. The columns adapt to the width of
the terminal and `SLUG/LAST` is cut with an ellipsis, never wrapped; on a pipe there
is no color and no cursor movement. `nightshift queue status --follow [seconds]`
(default 2) redraws the table in place until Ctrl-C - the terminal equivalent of
a queue panel - and `--until-idle` makes it exit by itself once nothing is
running or pending. `--follow` refuses `--json` and a single job id. `--json`
answers with the same fields as before. The listing opens with the state of the
runner - `runner: running (pid <pid>, watch every <n> s, since <iso>)` or
`runner: stopped` - and `--json` carries the same thing under `runner`. Reading the
state never changes it: a registration whose process is gone reads as stopped, and
only `--stop` or the start of a new watcher removes the file.

**The log is narrated by default.** `nightshift queue log <id>` prints one line per
relevant event of the stream, timed relative to the `=== attempt N ===` marker
that opens each attempt: `»` what the orchestrator said, `·` each tool with its
file or command, `▶`/`◀` each subagent lane with its phase and what it reported
back, the actions of that lane indented under it, and `⚑` the slug, `⚠` the gate,
`✓` the pull request, `ℹ` the notice and `✗` a tool that failed. Nothing else of
an event is printed: no prompt, no task summary, no output of a tool that
worked; an MCP tool shows only a field that names its target (a project, a path,
a pattern, a query), never the rest of its input. A line the narration cannot read is counted and reported at the end
instead of vanishing. `--raw` prints the stream exactly as it was written,
`--all` adds the text of the subagents, and the two together are a usage error.

**`--follow` ends by itself.** It keeps reading the file by offset (no `watch`,
no missed append), and stops as soon as the job leaves `running`, closing with
`═ job #<id> <status>`; a job whose row is gone or a status that cannot be read
stops it too, with the reason on stderr and the exit code still `0`. While the
job runs and the stream has nothing to narrate, it ticks `· still running` every
30 seconds, so silence never means the follow died. A log file that cannot be
read is treated as a glitch first: the failure is reported on stderr, the follow
keeps polling and only gives up after five failures in a row, and the closing
reason always says that the log became unreadable instead of claiming a complete
narration - the exit code stays `0` and a stack trace is never printed. `NIGHTSHIFT_FOLLOW_DEBUG=1`
traces every poll on stderr (`follow: t=<iso> size=<n> offset=<n> lines=<n>`),
which is what to turn on if the output ever stalls again.

**The six states.** A job is `pending` while it waits, `running` while a runner
owns it under a lease, and then one of four final states: `done` (the run
delivered a pull request URL), `gate` (the pipeline stopped asking for a human
decision, or ended with nothing to deliver), `failed` (a non-zero exit, a
timeout, or an orphan that had already spent its attempts) and `cancelled`
(cancelled by the operator, or stopped while running). A job in `gate` ALWAYS
carries the reason it stopped in `notice_md`: without a `## Notice` the reason is
the whole final text of the orchestrator, and a run that ended saying nothing at
all is `failed` with a fixed warning instead of a gate nobody can read.

`queue cancel` moves a job out of a final state into `cancelled` (from `pending`,
`gate` or an orphan), and `queue retry` moves it back to `pending` (from `gate`,
`failed` or `cancelled`). A gated job only moves with `--note`, and that note is
the only thing that ever reaches the prompt of the run, in a block labelled
`OPERATOR ANSWER TO THE GATE:` - a retry without `--note` clears whatever was in
`operator_note`, so the label never lies about where the text came from. Each
retry widens the allowance of attempts by one, capped at 10, and never rewrites
the attempts already spent.

Without `--fresh` the retry keeps slug, branch, session and run directory, and
the pipeline resumes from the last completed phase. The ceiling of those resumes
lives in the `state.json` of the run (`resumeCount` against `maxResumes`, default
`1`), not in the database: a SECOND retry without `--fresh` starts the run from
scratch because the runtime decided so, which is the intended behaviour and not a
bug of the retry. `--fresh` asks for that from the start: it clears slug, branch
and session and drops the run directory - and only a plain directory of this home,
never a symlink, never a path outside `<home>/runs/`; anything else is kept, with
the reason printed, and the retry goes on.

**One job per project at a time.** Two jobs of the same project never run
together: the pipeline of each job creates its own git worktree from the
canonical checkout, and two of them in the same checkout collide (a shared
branch, a worktree left inside the working tree). A project with an active job
is skipped by the claim, so the jobs behind it never block the rest of the
queue: the next job of ANOTHER project is claimed instead, and the queue of one
repository drains strictly in series, in priority order. `queue run` of a busy
project refuses with `queue: nothing to run (project-busy)`.

**Ownership and orphans.** A claim is one atomic `UPDATE` inside SQLite, so two
runners never share a job and `queue.maxConcurrent` (default `2`) is a ceiling
over the whole home, not over one process - a ceiling across DISTINCT projects,
since one project runs one job at a time. The claim arms a lease of
`timeout_s + 600` seconds; while the job runs, the runner re-arms it every
`queue.leaseHeartbeatS` seconds (default `5`, accepted range `1..20`), which is
the same write that answers whether it still owns the job. A `running` row
becomes an orphan only 60 seconds after its lease expired, and even then it is
left alone while the process named in `worker` is alive on this host - unless
`started_at + timeout_s + 600` has already passed, in which case it is recycled
anyway, because reclaiming never depends on a healthy process. The next claim
returns an orphan to `pending` (keeping its attempts) or fails it once it spent
the `max_attempts` of its own row. A runner that loses ownership kills its child
in the same heartbeat and writes nothing but one line in the job log: the row
belongs to somebody else. `queue cancel` refuses a job that is running under a
live lease: stop that runner first.

**Timeouts.** Each job has its own total timeout (`--timeout`, default 4 hours)
and every attempt also dies after 20 minutes without a single line on the
stream. Neither is a transient failure: a timed out attempt is `failed` and is
never retried. Only a provider failure (429, overload, connection reset) is
retried, up to `--max-attempts`, backing off 5s, 15s and 45s.

**Resuming by slug.** The pipeline writes `state.json` in the run directory of
its slug, and the runner reads it: it stores the `branch`, and on a new run of
the same job it asks the pipeline to resume from the phase after the last
completed one instead of starting over. With `queue.resumeSession: true` in
`config.json` it also passes `--resume <session id>` once the job has a session
of its own. The default is `false`.

**What the runner requires of the checkout.** Before spawning anything it
checks, in this order: the project is registered by NAME, its checkout exists
and has a `.git`, the `claude` CLI resolves (`NIGHTSHIFT_CLAUDE_BIN`, then
`PATH`), the checkout is clean (`git status --porcelain` empty) and it sits on
the default branch. A block is not a failure: the job goes back to `pending`
without spending an attempt and the reason is stored in `result` (the operator
note is never touched), so a later run picks it up once the checkout is in
shape.

**What it does NOT do in v1.** It never merges anything, never closes the cycle
after the pull request, keeps no token budget, ships no launchd (or any other)
scheduler, sends no notification and has no cockpit. It also never changes the
state of a git repository: the only git commands it runs are reads of the
checkout, and every branch and worktree is created by the pipeline itself.

## Writing a job

One job is one self-contained deliverable that can be reviewed and merged on its
own. Large work is ONE job with numbered stages written in the prompt — never
several jobs that depend on each other. A job that needs another job's pull
request merged first is cut wrong: fold it into that job. Independent jobs may
run in parallel and merge in any order.

```sh
nightshift queue add "Self-contained install. Stages: 1) runtime under ~/.nightshift; 2) shim + PATH prompt; 3) embedding opt-in; 4) rename bin to ns. Each stage verified before the next; one PR."
```

Run it from inside the repository the job is about: when that repository is not
a registered project yet, `queue add` offers to register it (`--yes` accepts the
offer without asking) and queues the job in the same step.

**There is no `--after`.** A job that waits for another job's pull request is an
incomplete deliverable: what it lands on main is half a change that nobody can
review on its own. It also breaks the unattended queue, which claims jobs by
priority across projects and has no way to hold one back until a pull request it
never sees is merged.

**Branch chains are v1.1**, and only for work that genuinely does not fit in one
run. Until then, the answer to "this depends on that" is one job with stages.

`nightshift queue add --help` prints this rule and the example.

## Doctor

```sh
nightshift doctor                  # one line per check: ok, warn or fail
nightshift doctor --json           # the same report, as the only thing on stdout
nightshift doctor --check-updates  # ...plus the newest version published in the registry
```

`nightshift doctor` reads the host and the home and writes nothing: it never creates
the database, never touches `settings.json` and never asks `claude` about
anything but its version. It checks the Node version, the `claude` and `gh`
CLIs, `config.json`, the mode of `secrets.json`, each of the three shims (a
missing shortcut only warns), a shim left over from the `shift` command, the
MCP registration, the registration in the Claude Desktop app (`claude desktop
mcp`, which is a `warn` when the app is installed and does not know the server
and an `ok` when the app is not installed at all), each of the three hooks, the
plugin, the embedding weights,
the optional embedding
library, the schema version of the database, the pause sentinel of the queue, the
pidfile of the runner (a registration whose process is gone only warns, and so does one
whose pid belongs to another user; the diagnosis never removes either), the jobs whose
runner died and every registered
project. It exits `1` when any check fails, `0` otherwise - a `warn` never fails
the run.

The diagnosis is offline: without `--check-updates` it opens no network
connection at all. With the flag it adds one last check, `registry`, which asks
the registry for the newest published version and compares it with the installed
runtime. That check is never a `fail`: a registry that does not answer is a
`warn` carrying the message of npm, because a registry being down says nothing
about this host and must not turn a local diagnosis into a failing exit code.

## Runtime contract

What a runtime has to provide, and what it can rely on:

- `NIGHTSHIFT_HOME` - home directory of the runtime, default `~/.nightshift`.
- `${NIGHTSHIFT_HOME}/runner.pid` registers the watch runner while one is up, as
  `{ "pid", "startedAt", "mode", "intervalS", "logPath", "uptimeS" }` with `startedAt` in
  ISO 8601. `uptimeS` is the uptime of the machine at the instant of the registration,
  which is what tells a registration left by an earlier boot session apart from a live
  one. It is written by the process that starts the watcher and removed by the
  watcher itself on a clean exit, or by `nightshift queue run --stop`.
- The output of a detached runner lives in
  `${NIGHTSHIFT_HOME}/logs/runner-<stamp>.log`, next to the one log per job.
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
- Authority of each literal: the LAST standalone `QUEUE_SLUG:` line of the
  orchestrator wins, and the `## Notice` and the pull request URL of the run are
  read from the FINAL `result` event - an intermediate message that echoes an
  earlier one never wins. A pull request URL only counts as delivered when it
  closes a line outside any code fence and that line does not report a failure;
  a URL cited inside a sentence, an example or an error message is a reference,
  and a run that delivers none ends as `gate`, never as `done`.

These names are a machine contract, not prose: the pipeline files are the
source of truth for them, and any runtime that reads them must match them
exactly.

The eleven MCP tools, with the parameters `nightshift mcp` actually accepts:

| tool | parameters |
|---|---|
| `lesson_recall` | `query?`, `project?`, `target?`, `exclude_ids?` |
| `lesson_save` | `title`, `root_cause`, `solution`, `prevention`, `attempts?`, `project?`, `target?` |
| `memory_recall` | `query?`, `project?` |
| `index_save` | `project`, `repo_root`, `files[{path, responsibility}]`, `libs?[{lib, version}]` |
| `index_recall` | `project`, `repo_root?`, `query?` |
| `pipeline_log` | `slug`, `tier`, `outcome`, `project?`, `task_type?`, `gate_stop?`, `duration_s?`, `phases?[{phase, model?, status?, retry?, duration_s?, note?}]` |
| `queue_add` | `project?`, `prompt`, `cwd?`, `register?`, `priority?` (1-9), `max_attempts?` (1-10), `timeout_s?` (60-86400) |
| `queue_status` | `job_id?`, `limit?` (1-50) |
| `queue_run` | `job_id?` |
| `queue_cancel` | `job_id`, `reason?` |
| `queue_retry` | `job_id`, `note?`, `fresh?`, `run?` |

The five queue tools are the same subsystem as `nightshift queue` (see `## Queue`):
`queue_add` takes the registered project NAME and never a path - or, with
`project` omitted, the absolute `cwd` of the caller, which resolves the project
that contains it; a `cwd` inside a git repository that is registered nowhere
answers `{ "needs_registration": true, "cwd", "suggested_name", "org", "hint" }`
instead of failing, and only a second call carrying `register: true` (after the
user confirmed it) registers the repository and queues the job. An unattended run
never registers anything: inside a job the call is refused. `queue_status`
never returns the prompt of a job and truncates `notice_md` and `result` at 500
characters and answers with the state of the runner next to the jobs, `queue_run`
starts the runner detached and answers right away with the path of its log,
`queue_cancel` refuses a job running under a live lease without writing anything,
and `queue_retry` sends a gated, failed or cancelled job back to the queue - its
`run` starts a DETACHED runner, the same one the `--run` of the CLI starts unless
it is asked for `--foreground`.

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

## Developing nightshift

`init` and `setup` install the package that is running: they pack it with
`npm pack` (honouring the `files` of its `package.json`) and install the tarball
into the runtime prefix. Nothing is ever linked, so the runtime never borrows the
`node_modules` of a checkout, and the registry is not consulted.

That is what makes a checkout testable end to end: `--from <dir>` packs that
directory instead, and `--from <file.tgz>` installs that tarball as it is. It
works the same on `setup`, on `init` and on `update`.

```sh
nightshift setup --from ~/code/nightshift   # install the runtime from a checkout
nightshift update --from ~/code/nightshift  # ...and again, after a change
nightshift update --from ./nightshift.tgz   # install a tarball exactly as it is
npm test                                    # the whole suite, hermetic, no network
npm run release:check                       # the suite, then the tarball and the versions
```

`npm run release:check` is the checklist before a release: it runs the suite,
refuses a working tree with uncommitted changes, runs `npm pack --dry-run` to
prove the tarball still builds, and checks that `package.json`, the top entry of
`CHANGELOG.md` and the `Licensed Work:` line of `LICENSE` all declare the same
version. Any divergence prints what disagrees and exits 1. It never publishes
anything.

Publishing itself is a pushed tag, never a local `npm publish`:
`docs/RELEASING.md` has the four-step flow and the one-time npmjs.com setup that
the release workflow depends on.

The decisions that shape the project live in `docs/decisions/`, one record per
decision, and neither that directory nor `scripts/` is part of the published
tarball.

## License

Business Source License 1.1. Change Date 2029-09-04, Change License
Apache License, Version 2.0. See `LICENSE`, which is the text that governs; what
follows is a summary of it.

- You may use nightshift in production, for any purpose, including commercial
  ones, and inside a company for internal use.
- You may not offer nightshift, or a derivative of it, to third parties as a
  hosted service or as a competing product.
- You may not redistribute it commercially.
- On 2029-09-04 the Change Date arrives, every restriction above ends, and the
  licensed work becomes available under the Apache License, Version 2.0.

**Project note, not part of the license text:** this BSL 1.1 text and its
parameters have not been through legal review yet. That review is pending and
has to happen before the first `npm publish` of this package.
