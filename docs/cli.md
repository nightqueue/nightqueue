# CLI, configuration and doctor

`bin/nightqueue.mjs` is the CLI: it manages orgs, projects and the connections (and
their secrets), and it drives the memory runtime.

- `nightqueue --help` lists every command: `setup`, `doctor`, `init`, `org`,
  `project`, `update`, `connection`, `mcp`, `hook`, `reflect`, `embed`,
  `memory`, `queue`, `open`, `verify`, `sandbox`, `libs`, `run` and `version`.
- `nightqueue --version` (same as `nightqueue version`) prints the installed version
  and exits `0`.
- Exit codes: `0` ok, `1` user error (a single line on stderr), `2` unexpected
  error (a stack on stderr). `nightqueue doctor` and `nightqueue verify` also
  exit `1` when a check fails.
- Every `list` accepts `--json`; on `--json`, stdout is either valid JSON or
  empty, because warnings and errors always go to stderr.

The queue lives in `nightqueue queue` (see [Queue](queue.md)); the scheduler that would
start it by itself lands in a future version, published as the npm package
`nightqueue`, of which this plugin is the pipeline half.

## The run of a job (`nightqueue run`)

`nightqueue run` is the family the pipeline calls from *inside* a job: each
subcommand acts on the run of the job it is called from, which it resolves from
`NIGHTQUEUE_JOB_ID` and that job's own row. It is not `nightqueue queue run`,
which starts the runner over the whole queue. Naming another run from inside a
job is refused; outside one, `--project <name> --slug <slug>` is required.

```sh
nightqueue run dir            # the absolute directory of this run: runs/<project_id>/<slug>
nightqueue run check 03       # is the plan there, with the sections the pipeline reads?
nightqueue run log            # one line per phase of this run, plus the total
nightqueue run log --json     # the same table as the only thing on stdout
nightqueue run commit --message-file msg.txt   # stage what the implementation listed, and commit it
nightqueue run pr --template                   # print and record the PR template in effect
nightqueue run pr --body-file body.md          # check the body, push and open the pull request
nightqueue run start --tier simple --type bug/error --commit-type fix   # the run's routing row, phases and tasks, as JSON
nightqueue run start --routing                 # the whole routing table, every tier, as markdown
nightqueue run publish --message-file msg.txt --body-file body.md      # check the body, commit once, push and open the PR
nightqueue run report                          # the tables of the final report, from the run's own records
```

`run start --tier <t> --type <bug/error|feature/refactor> --commit-type <c>
[--expect-slug <slug>]` is Phase 0's mechanics in one call. It refuses a tier, a
type or a commit type outside the pipeline's own (naming the accepted values),
records `type` and `tier` in `state.json` (the same write as `run_set`) and the
pull request template in effect (the same as `run pr --template`), and prints one
JSON line: `project`, `slug`, `runDir`, the `worktree` and `branch` the runtime
recorded (it never creates a worktree), `tier`, `type`, `commitType`, the ONE
`routing` row of the tier (from `src/queue/routing.mjs`), the `phases` and `tasks`
of the tier and type, `prTemplate` and `commitConvention`. With `--expect-slug`,
inside a job, it waits up to 10 seconds for the runner to bind the slug the
orchestrator just declared (`SLUG: <slug> TYPE: <type>`) and answers `slugDeclared`
and `slugBound`; it never renames anything itself. Calling it again answers the
same JSON. `run start --routing` takes no other option: it prints the whole routing
table of `src/queue/routing.mjs` as markdown, one row per line, and resolves no run
and writes nothing, inside a job or outside.

`run publish --message-file <p> --body-file <p> [--files-from <p>] [--extra
<pathspec>]... [--title <t>] [--remove-worktree]` is `run commit` then `run pr` in
one call, in the safe order: the body is checked against the template in effect
first, then the list is checked for refused paths and scratch files, and only then
is anything committed - any problem prints its `MISSING:`/`REJECTED:`/`REFUSED:`
lines and `nothing was committed or pushed`, and exits `1`. A retry after the commit
already happened (every listed path clean and the branch ahead of its base) prints
`COMMITTED: <sha> (already committed)` instead of committing again. The title is
`--title`, else the body's `# <title>` line, else the subject of the commit message.
It prints the same `CONVENTION:`, `COMMITTED:`, `BRANCH:`, `PR:` and `WORKTREE:`
lines as the two commands, which keep working unchanged.

`run report [--json]` renders the tables of Phase 8 from `state.json`, the job log
and `03-plan.md`: the step table (complex) or the compact `Verification ✅ · PR
<url>` line (trivial/simple), the `Lessons saved:` audit line (the orchestrator's
`lesson_save` calls of the last attempt that did not error), a `Happy: yes|no —
<first failing gate>` line decided by the fail-safe rule (a termination, a failed
verdict, a re-run, a planned phase never recorded, a plan with `## Requires user
confirmation`, no delivery recorded), and, when not happy, the execution table with
the measured Time column and the `**Total:**`. The layout it fills is
`plugin/skills/resolve/references/report.md`, rendered by the same template engine
as `phase_prompt`; the orchestrator never reads that file, it pastes the output.

`run check <NN>` is the artifact gate of a phase: it reads
`<RUN_DIR>/<NN-phase>.md` and prints `OK` or `MISSING: <sections>` - the
sections required are `## Brief` (`00`, the `00-brief.md` the orchestrator writes in Phase 0), `## Verdict` (`01`), the four sections of the plan (`03`),
`## Modified files` (`04`), `## Break hypotheses` + `## Test recipe` (`05a`),
`## Validated risks` (`05`), `## Verification` (`06`) and `## Runtime verdict`
(`06.5`, the runtime lane's `06-runtime.md`); `02` is checked for
existence alone. `04` is the only artifact with a fallback: with no file list,
the command derives one from the changes of the run's worktree (`git diff
--name-only HEAD` plus `git ls-files --others --exclude-standard`), writes the
artifact and prints `GENERATED` - and a worktree with no change at all prints
`MISSING: ## Modified files (no changed files)` without writing anything. The
three answers exit `0`: they are findings the agent judges (relaunch the phase
or terminate), not failures of the command; only an unknown `<NN>` or a run that
cannot be resolved exits `1`.

`run log` prints one tab-separated line per phase recorded in `state.json` -
`<phase>  <model>  <status>  <duration>` - and closes with `total  <duration>`.
The model and the durations are the ones the runtime measured on the stream of
the job (see [Runtime contract](runtime-contract.md)), so the agent pastes the
Time column of its report instead of timing the phases itself; a phase the
runtime measured no lane for prints `-`.

`run commit` stages exactly the paths `04-implementation.md` listed under `##
Modified files` (`--files-from <path>` reads the list somewhere else) plus every
file a `--extra <pathspec>` really matches, and commits them with `git commit -F
<the --message-file>` - the message stays the agent's, and an empty or missing
one is refused before anything is staged. For a job queued from an issue
it commits a copy of the message with a `Refs: <KEY>-<n>` trailer added from the
job row; a message that already carries a `Refs:` line is refused. It prints `COMMITTED: <sha> (<n>
files)`. Anything under
`.claude/` or `tmp/`, a dependency lockfile that is not paired with a changed
manifest and a green frozen install (see the runtime contract) and any path
outside the run's worktree is refused: the command prints `REFUSED: <path> (<reason>)`, stages
nothing and exits `1`. `--extra` adds files to the list, it never overrides that
refusal. Before committing it prints `CONVENTION: <...>` - the file that
declares the repository's commit convention (a commitlint config, `.husky/`,
`.gitmessage`, `CONTRIBUTING*` or a `commitlint` block in `package.json`) and
what the last 30 subjects really read like - so the message is written to the
shape the repository uses.

`run pr` first resolves the run's checkout and finds the pull request template
in effect there, first match wins: `.github/PULL_REQUEST_TEMPLATE.md`,
`.github/pull_request_template.md`, `docs/PR_TEMPLATE.md`, then a pull request
section of `CONTRIBUTING.md` or of `CLAUDE.md` (the first fenced markdown block of
that section carrying headings). It prints `TEMPLATE: repo (<path>)` or
`TEMPLATE: nightqueue (fallback)` and `HEADINGS: <headings>`, and records them as
`prTemplate` in `state.json`; `--template` stops there, reads no body and pushes
nothing. Then it checks the body BEFORE anything leaves the machine, with the
rules of `references/pr-template.md`. Against a repository template: every heading
of it present and in its order, and no nightqueue heading (`## Report`,
`## Cause`, `## Changes`, `## QA`) the template does not have. Against the
nightqueue fallback: `## Report`, `## Cause`, `## Changes` and `## QA` in that
order with no fifth `## `, a `## QA` made of `###` subsections (`Automated`,
`API`, `Browser`, `Device`) with at least one `- <what ran> — <result>` bullet each,
the result ending in `PASSED`, `FAILED` or `SKIPPED (<reason>)` (none marked
`N/A`, no table), a `Not tested:` line after the last one, and a non-empty file
under `<RUN_DIR>/evidence/<method>-*` (`automated`, `api`, `browser`, `emulator`)
for every subsection. Both: no bare `#<number>` outside a `Fixes`/`Closes` line, no
`{{placeholder}}` or `<...>` example left over from the template, and none of the
traceability the runtime appends itself - an `Opened by nightqueue` line, a whole
`Refs` line, a job ref or the run slug. It then publishes a copy of the body with
the footer read from the job row (`Opened by nightqueue ·
<KEY>-<n>` for an issue's job, `Opened by nightqueue` otherwise; see
[Runtime contract](runtime-contract.md)). A body that
fails prints one `REJECTED: <reason>` or `MISSING: <what>` line per violation
and exits `1` with nothing pushed. Otherwise it renames the branch
when it still carries the `worktree-` prefix (`worktree-feat+login-google` →
`feat/login-google`; a queued job's `worktree-<slug>`, which carries no `+`, becomes
`<commit type>/<run slug>` with the type read from the Conventional Commits subject of
`HEAD` - `worktree-login-google` with `refactor(auth): ...` → `refactor/login-google` -
falling back to `feat` or `fix` from the `type` in `state.json`), pushes it with `git push -u origin <branch>`, opens the
pull request with `gh pr create` and records in `state.json` the outcome `done`,
the pull request URL gh answered and, as the run's `branch`, the name it pushed
(a record it cannot write is reported on stderr, never fatal: the pull request is
open). The `PR: <url>` line it prints is information only - the pull request of the
run is the host's publication when it is on the run's branch, otherwise the one this
command recorded (see [Runtime contract](runtime-contract.md)). It closes with `WORKTREE: <path>` and
removes the worktree only when asked with `--remove-worktree`, because the
session that called it still lives in that directory. That default is unchanged:
in a queue job the runner itself removes a clean, pushed worktree once the run ends
`done`, `nightqueue queue close` removes it once the job's pull request is merged, and
`nightqueue queue cancel` removes it for a `done` or `failed` job the operator gives up on
(see [Queue](queue.md)).

## Configuration

`NIGHTQUEUE_HOME` (default `~/.nightqueue`) is a single directory that holds
both the configuration at its root and the run artifacts under `runs/` (see
[Runtime contract](runtime-contract.md)) - one home, two kinds of content, not two environment
variables:

```
$NIGHTQUEUE_HOME/          # 0700
  config.json              # queue settings, connection bindings by org id, default org
  secrets.json             # 0600, connection secrets
  nightqueue.db            # the memory database, orgs and projects included (see [Memory](memory.md))
  runtime/versions/        # one directory per installed version, the last two kept
  runtime/current          # symlink into versions/, what the host is registered against
  bin/                     # the shims: nightqueue and nq
  embedding/               # npm prefix of the embedding library, opt-in
  models/                  # embedding weights, downloaded on demand
  state/                   # per-session hook state
  runs/<project_id>/<slug>/  # run artifacts, written by the runtime
  logs/                    # one log per queue job plus one per runner
  queue.paused             # sentinel file, present only while the queue is paused
  runners/<pid>.json       # one registration per live runner, any number of them
```

Orgs and projects are rows of the memory database, each identified by an id
(a ULID) and carrying a name that can change: every job, decision, lesson and
run directory points at the id, so a rename touches one row. `config.json` keeps
only what is not identity - the queue and embedding settings, the connection
bound to each org (`orgConnections`, keyed by org id) and `defaultOrg` (an org
id) - and any top-level key it does not know is kept as it is. A home written by
an older build migrates once, in `nightqueue update` (or `setup`), never on an open: the
orgs and projects of `config.json` move into the database, `runs/<project>/` is
moved to `runs/<project_id>/`, and a copy of the database as it was is left
beside it as `nightqueue.db.pre-v18`. While a runner holds a live lease on a job
the migration refuses and asks to stop the runners first
(`nightqueue queue run --stop`); nothing is written until it succeeds. A v18 database
then goes to v19 the same way, in the same migration, with its own copy
`nightqueue.db.pre-v19`: every project and org gets a key (below), and every issue
gets its number within its owner, in the order the issues were created.
A v19 database then goes to v20 in the same migration, with its copy
`nightqueue.db.pre-v20`: every reference to another row gets a foreign key, and a
row pointing at a row that does not exist refuses the migration, naming the row,
with nothing written - checked before the first pending step, so an older home
stays at its version too; `nightqueue doctor` reports such rows.
A v20 or v21 database then goes to v22 in the same migration, with its copy
`nightqueue.db.pre-v22`: the tracker tables are renamed to `issues`, `issue_projects`
and `issue_comments`, every row, counter and ref kept, and the v21 columns untouched.
`nightqueue run dir --project <name> --slug <slug>` prints the directory of a
run, so nothing has to build the path from a project name.

`NIGHTQUEUE_HOME` must sit on local disk. The memory database is SQLite in WAL
mode, and WAL correctness depends on the operating system really enforcing POSIX
advisory locks - in particular the connection-lifetime "dead man's switch" lock
that tells a connection being closed whether it is the last one still attached to
the database. Network and FUSE mounts (`nfs`, `nfs3`, `nfs4`, `smbfs`, `cifs`,
`afpfs`, `webdav`, `9p`, and anything carrying `fuse`) are known to drop those
locks or to emulate them incorrectly. When that happens the shared-memory index of
the WAL (`nightqueue.db-shm`) is unlinked and recreated while another process is
still attached to the old one: that process keeps reading and writing an index the
rest of the system has already abandoned, which loses finish commits and reverts
leases. `nightqueue doctor` reports both halves of this - see [Doctor](cli.md#doctor).

Secrets are kept in a `0600` file rather than in the operating system
credential store, because the runtime is meant to run unattended, with nobody
there to unlock anything.

A command that writes holds the directory `$NIGHTQUEUE_HOME.lock` while it
runs, so two `nightqueue` processes never overwrite each other's changes; read-only
commands such as `list` never take it. The memory and queue commands (`mcp`,
`hook`, `reflect`, `embed`, `memory`, `queue`) never take it either: they rely
on SQLite for concurrency, so a running server - or a runner that works all
night - never blocks a `nightqueue init`. The one exception is the registration
`nightqueue queue add` (and `queue_add`) offers inside an unregistered
repository: that single registration takes the lock by itself, so it never
races a `nightqueue project add` (and the database refuses a second project on
the same path or name either way).

```sh
nightqueue setup                                   # install the runtime and register everything in the host
nightqueue setup --remove --purge                  # undo the registrations, or delete the home as well
nightqueue update                                  # reinstall the runtime, migrate the database with it, and re-point the host at it
nightqueue update 0.2.0                            # ...at one exact version from the registry
nightqueue update --from .                         # ...from a checkout: npm ci when node_modules is missing or package-lock.json changed since the last studio build, then the studio build
nightqueue update --from . --no-install            # ...never run npm ci; the dependencies line says what it would have done
nightqueue update --schema-only                    # internal: the database migration alone, run by update/setup from the installed runtime
nightqueue doctor --json                           # check the host and the home, exit 1 on any failure
nightqueue doctor --check-updates                  # ...and ask the registry for the newest version
nightqueue doctor --fix                            # ...and git worktree repair the job worktrees whose checkout or home moved, and repair the database files
nightqueue init                                    # set the host up and register the current repository
nightqueue init ~/code/api --org acme --name api   # ...or an explicit path, org and name
nightqueue init --no-embedding --no-path --no-gh   # ...answering every question up front
nightqueue init --key API                          # ...registering it under the key API

nightqueue org add acme                            # create an org (its key is suggested, or asked on a TTY)
nightqueue org add acme --key ACM                  # ...under an explicit key
nightqueue org key acme AC                         # change its key; the old one keeps resolving
nightqueue org list --json                         # orgs (with their id, key and old keys), connection slots, project counts
nightqueue org rename acme acme-inc                # one row: its projects, decisions and bindings follow
nightqueue org remove acme-inc                     # refused while it still owns projects or rows

nightqueue project add ~/code/api --key API        # register a repository under an explicit key
nightqueue project key api AP                      # change its key; API-<n> refs keep resolving
nightqueue project list                            # name, key, path (or "no path"), org, whether the path still exists
nightqueue project rename api api-v2               # one row: its jobs, decisions, memory and runs follow
nightqueue project move api acme                   # move a project to another org
nightqueue project move api --path ~/code/api      # give it a new checkout (or one it never had)
nightqueue project remove api                      # refused while it owns rows, listing them and hinting --purge
nightqueue project remove api --purge [--yes]      # delete it and every row it owns (jobs, lessons, memory, issues, runs dir); asks first, refused while a job runs or closes, or while it has comments on org issues (they stay)
nightqueue project integrations api show [--json] # one <kind>.<key>=<value> line per setting, or "no integrations"
nightqueue project integrations api set <kind>.<key>=<value> ...   # validated against the provider that declares the key
nightqueue project integrations api unset <kind>.<key> ...         # the last key removed leaves the project without integrations

echo "$GITHUB_TOKEN" | nightqueue connection add gh --type github
nightqueue connection bind gh --org acme           # bind (or rebind) an org slot
nightqueue connection test gh                      # prints login and scopes, never the token
echo "$SENTRY_AUTH_TOKEN" | nightqueue connection add sn --type sentry --set org=acme [--set url=https://sentry.example.com]
nightqueue connection test sn                      # prints org=<slug>, never the token
echo "$DISCORD_WEBHOOK_URL" | nightqueue connection add team-chat --type discord   # reads the webhook's channel and guild, added to the org's list
nightqueue connection test team-chat               # prints channel=<id> guild=<id>, never the URL
nightqueue connection list --json
nightqueue connection remove gh                    # unbinds from every org, then deletes the secret
```

The secret is read from stdin when stdin is not a terminal, and asked for in a
hidden prompt otherwise. It is never accepted as a command-line argument, and
never printed back - not by `list`, not by `--json`, not by an error message.
A type that needs more than its secret takes it as `--set <field>=<value>`, validated
against the fields the type declares before the secret is read: a `sentry` connection
needs `org` (its organization slug) and takes an optional `url` (an https origin, default
`https://sentry.io`, for a self-hosted Sentry); a missing required field, an unknown one or
a malformed value is refused and nothing is stored. These fields are not secret.
A `discord` connection is a channel webhook: its secret is the webhook URL
(`https://discord.com/api/webhooks/<id>/<token>`), checked for that shape and read once at
`add` to store the webhook's `channelId` and `guildId`; a URL of another shape or one the
service does not answer is refused without being echoed, and nothing is stored. An org holds
any number of discord webhooks: `add` appends the new one to the org's list and `bind` adds
it to another org's list (`org list` shows `discord=team-chat,ops`); `remove` takes it out of
every list. The URL is never listed, logged or written in a notice. config.json keeps these
lists under `orgConnectionLists`, apart from the single-slot `orgConnections`, so an older
nightqueue that rewrites the file keeps them as they are instead of dropping them; a webhook an
older build removes stays listed as missing until this build's `connection remove`.

**Project integrations.** `project integrations <project>` holds what a project does with the
services its jobs come from, one setting per `<kind>.<key>` (a key may itself be dotted, stored
nested under the provider). The keys come from the providers of the build - `show --json` lists
them under `providers` - and an unknown key is refused with the valid ones. Values are text: an
enum takes one of its values, a boolean `true` or `false`, a list is comma-separated, and a
connection value must name a stored connection of that provider bound to the project's org.
`show` also prints `<kind>: org connection <name|none>` for each enabled provider with a single
org slot. Several `set`/`unset` arguments are applied together: one invalid one changes nothing.
Unsetting the last key leaves the project without integrations, behaving exactly as before.
`set` and `unset` are refused from inside a job; the MCP tool `project_integrations` does the same.

A path that starts with `-` has to come after `--` (`nightqueue init -- -weird-dir`),
otherwise it is parsed as an unknown option and rejected.

**Keys and refs.** Every project and every org carries a key: 2 to 5 uppercase letters or
digits, starting with a letter, unique across projects and orgs together. `init`, `project add`,
`org add` and the registration `queue add` offers suggest one from the name (`nightqueue` →
`NQ`, `feat-api-web` → `FAW`, a letter added on a collision: `NQA`); on a terminal the
question is ``Key for project `<name>` [NQ]:`` - Enter keeps it - and `--key <KEY>` answers it
up front; without a terminal the suggestion is taken. `project key <name> <KEY>` and `org key
<name> <KEY>` change a key in one row and keep the old one as an alias of the same owner, so a
ref written with it still resolves and no other owner can take it. Everything the runtime
prints names things by ref, and every command and tool that takes one accepts it:

- a job is `J-<id>` (the plain id is still accepted);
- an issue is `<KEY>-<n>`, numbered within its project or org (`NQ-12`, `DLW-3`);
- a decision is `D-<n>` inside its project, `<ORGKEY>/D-<n>` for an org decision, and
  `<KEY>/D-<n>` anywhere else;
- a row with no owner uses the key `G` (`G-4`, `G/D-2`).

Items and decisions no longer take an internal id anywhere; the decision commands below
still take a plain per-owner number with `--project`/`--org`.

## Queue

The full reference of `nightqueue queue` is [Queue](queue.md); these subcommands are
recent enough that this is their first mention here.

```sh
nightqueue queue add --issue NQ-12 ["<note>"]         # an issue's job, with an optional operator note
nightqueue queue status J-42                          # one job, by its ref (or its plain id)
nightqueue queue status https://github.com/acme/api/pull/7   # ...or by the pull request it opened
nightqueue queue status                               # the table; TOKENS is the total including cache (see below)
nightqueue queue session 42                          # resume the session of a job's last attempt
nightqueue queue session 42 --print                   # print the resume command instead of running it
nightqueue queue session 42 --json                    # session, attempt and cwd, as the only thing on stdout
nightqueue queue session 42 --prompt "look at the gate"   # resume it with a request as the next message

nightqueue queue close 42                             # merge a done job's pull request and close the job, detached
nightqueue queue close 42 --foreground                # run the four steps in this process, one line per step
nightqueue queue close 42 --foreground --json         # JSON on stdout, with the decisions the close accepted
nightqueue queue close --merged                       # close every done job gh confirms merged, accepting each one's proposals
nightqueue queue close 42 --force                     # skip the pull request checks and the rebase suite, nothing else
nightqueue queue close 42 --steps origin,log          # re-run only the post-close steps of a closed job, in this process
nightqueue queue close 42 --steps log --again         # clear the named steps' done marks first, so they post again (only with --steps)
nightqueue queue cancel 42 --reason "abandoned"       # cancel a done or failed job and release its worktree

nightqueue queue run --watch --from 22:00 --until 04:00   # watch only inside that window, local wall clock, then exit
nightqueue queue run --watch --until 04:00                # `--from` defaults to now

nightqueue queue repair [--json]                      # replay the pending writes every run left while the database was unavailable
nightqueue queue repair 42 [--json]                   # re-classify a gated or failed job from its own log
nightqueue queue repair --from-disk [42] [--json]     # recreate the jobs the table lost, from their runs on disk
```

The TOKENS column of `queue status` is the total including cache: input + output +
cache read + cache creation. While a job runs, the cell is the estimate read from the
streamed assistant usage and carries a `~` prefix (`~66.9M`); it loses the prefix once the
result reports. The cache counters stream faithfully (within 1% of the result), but the
output tokens of subagents never reach the orchestrator stream, so a partial input + output
total would be useless mid-run, while the total with cache is a good proxy that converges.
`queue status <id>` keeps the four counters separate; no cost is ever estimated.

The last column of the `queue status` table is `TITLE/LAST` (it was `SLUG/LAST`). A running
job shows what it is doing, as before. Every other job shows its title, then ` — ` and the
reason it stands there (notice first line, close note, parked label) when the width allows.
The title is derived on read and never stored: the title of the issue the job was queued
from, otherwise the first non-empty line of the prompt's brief without its heading marker
(a bare `## Brief` or `# Task` heading yields to the next line), clipped at 120 characters
with `…` counted in them. The slug no longer sits in the table; `queue status <id>` prints it.

`queue repair` has three forms. Bare, it replays every `pending-writes.jsonl` a run left while
the database was unavailable (see [Runtime contract](runtime-contract.md)) and prints one
`<project_id>/<slug>: applied <n>, filled <n>, superseded <n>, refused <n>` line per run
directory, or `nothing pending`. With an id it re-classifies a gated or failed job from its own
log, as described in [Queue](queue.md). With `--from-disk` it recreates every job `doctor --db`
lists under `lost jobs` - or only the one named - from its run on disk: status from the
`terminal` witness, then the recorded `outcome`, then the last attempt of its log (a run that
left none is `failed` with `recovered from disk: the run left no outcome`), the notice from the
stream's `## Notice`, the pull request, slug and branch; the row carries
`result.recovered = { from: "disk", at, runDir }` and the job log gains
`recovered from disk: status=<s> prUrl=<u|->`. It prints one `J-<n> <project>/<slug>: <result>`
line per job, where the result is `recovered as <status>`, `exists` (the row is there - a second
run, or the loser of two concurrent ones), `skipped: still running` or `project-missing`, then
the tail of the job logs no run explains, which cannot be rebuilt. Nothing is written to the
issues or to the decisions. A recovered row is a record, not a task: its prompt was not kept on
disk, so `queue retry` (and `queue_retry`) refuses it with ``J-<n> was rebuilt from disk by
`nightqueue queue repair --from-disk` and its prompt was not kept, so it cannot run again; queue
the task anew with `nightqueue queue add` ``.

A session that could not reach the nightqueue MCP server - its `init` lists `nightqueue` as
`failed`, or its first nightqueue tool call fails (`is_error`) with nothing but
`Connection closed` (optionally prefixed by `MCP error <n>: `) - is not a failed attempt; a
result that merely quotes the phrase, such as a recalled lesson or this very gate notice, never
counts: the job stops at a `gate` with `blocked_code` `store-unavailable`, the attempt is given
back and the worktree kept, exactly like any other preflight block. The notice names
`nightqueue doctor --fix` and ends in `nightqueue queue retry J-<n> (no note needed)`.

`queue status <PR URL>` (and `queue_status` with `pr_url`) finds the job that opened that
pull request, whatever the case of the owner, a trailing slash or a `/files` suffix. A URL no
job opened answers ``no job opened `<url>` ``, one that is not a GitHub pull request is
refused, and one opened by more than one job is refused with their refs
(``… was opened by more than one job: J-3, J-9; pass one of them``) - never the latest.

`queue session <id>` opens the `claude` session of a job's LAST attempt - `last_session_id`
when the job carries one, else its first `session_id` - by resuming it with `nightqueue open
--resume <session>` (the operator launch, see [Open](#open)) in the cwd the run itself used: the run's worktree when it is still on disk, or the
project's checkout with a warning line (`(worktree released, using the checkout)`) once the
worktree was already released. A `pending` or a `running` job is refused by name - a live
runner owns a running job's session, a pending one has none yet - and so is a job that never
reached the agent at all. The resumed session runs under the operator guard (D-58, see
[Open](#open)): it reads and queues, and delegates only to `triage`, `qa` and `reviewer`. `--print` stops there and prints the equivalent `cd '<cwd>' && nightqueue
open --resume <session>` line instead of running it, and `--json` prints `{ jobId, attempt, session,
cwd, worktreeReleased, command }` as the only thing on stdout; without either flag the exit
code is the resumed session's own. `--prompt <text>` is passed to `nightqueue open --resume
<session> --prompt <text>`; `--print`/`--json` include it, shell-quoted, and, as with
[Open](#open), `ps` shows it while the session runs. The MCP tool `queue_session` resolves the same session but
only ever reads it - it answers `job_id`, `attempt`, `session`, `cwd` and `worktree_released`,
and never resumes or executes anything itself.

`queue close <id>` is the operator's act that takes one `done` job with a pull request to
`closed` through the closing pipeline described below - the only way any job becomes `closed` -
and releases the job's worktree once it is closed, printing `worktree removed: <path>` or
`worktree kept: <path> - <reason>`. `queue close --merged` runs the same pipeline, in this
process, on every `done` job whose pull request `gh` itself confirms merged, prints `closed
J-<id>` or `J-<id> not closed: <reason>` for each, and reports `<n> jobs left unchecked; run
nightqueue queue close --merged again` when some could not be checked within the call's own
deadline. A `failed`, `gate` or `cancelled` job is never closed, whatever its pull request
says: retry it, or cancel it.

The settle step accepts every decision the job proposed, in the same transaction that closes
the job. Each one prints `accepted <D-ref>: <title>`, and `--json` carries them under
`decisions`; the detached child does the same into its log. `--decisions` no longer exists and
is refused with the usage line.

`queue cancel <id>` accepts a `pending`, gated, orphaned, `done` or `failed` job. For a `done`
or `failed` one it also releases the job's worktree, printing `worktree removed: <path>` or
`worktree kept: <path> - <reason>` after `cancelled J-<id>`; `--json` prints `{ job,
worktree }`. A job running under a live lease, or being closed under one, is refused by name
with nothing written. So is a `done` job whose close was interrupted (its lease died mid-close,
possibly after the merge): resume it with `nightqueue queue close <id>`, which records a merged
pull request as closed and cancels the job when the pull request was closed without merge.
From an agent session the MCP `queue_cancel` with `stop: true` cancels a running job in one call
(see [Queue](queue.md)), and `queue_stop` mirrors `queue run --stop [pid]`.

`queue close <id>` takes a `done` job's pull request from open to merged and closes the job,
through four steps recorded on the job - preflight (fetch, pull request state, green checks,
uncommitted files the pull would touch), conflict (a rebase in a throwaway worktree, the
project's `npm test` unless the head had CI checks and the rebase was clean, a `--force-with-lease` push; skipped when GitHub reports it mergeable),
merge (`gh pr merge --squash`, confirmed by re-reading the merge commit) and settle (close the
job and append `Closed: PR #<n> merged as <sha7> on <date>` to its notice). It starts detached
and prints the pid and its log, `<home>/logs/close-<id>-<stamp>.log`; `--foreground` runs it here
and exits `0` only when the job closed; `--json` prints `{ started, jobId, pid, logPath }`
detached, or one `{ job, outcome, decisions }` object in the foreground. A close that stops shows `close failed` in the STATUS cell (the step and reason are in LAST) and prints `⛔ close stopped at <step>:
<reason> - run again with: nightqueue queue close J-<id>`, leaves the job `done`, and running it
again resumes at that step - never merging twice. A pull request closed without merge cancels
the job instead (`J-<id> cancelled: PR #<n> was closed without being merged; nothing to
close`), and one merged by hand is recorded as `merged outside a close`. `--force` skips the
pull request checks and the rebase suite and nothing else: status and attribution
(`pr-not-the-job-branch`) still stop the close, and a conflict always stops a forced close:
the merger never runs under `--force`. Without it, a small textual conflict may be resolved by
the bounded merger agent before the suite runs. A second close of a closed
job answers ``job `<id>` is already closed``. `queue.closeTimeoutS` (default `1800`, range
`60..3600`) bounds the whole close, the merger included. For a project with integrations, the
post-close steps origin and log run after settle on the closed job and never stop it: a failure
is an `After close: <step> warning - <note>` line in the notice; `queue close <id> --steps
origin,log` re-runs only those steps (each skips what it already did) and exits `1` on a
warning; `--again` (only with `--steps`, never with `--merged` or `--force`) clears those steps'
done marks first so they post again, and the summary says `(again)` after each. The MCP tool `queue_close` (`job_id`, `force?`) starts the
same detached close. See [Queue](queue.md#closing-a-job) for the steps, the lease and what a
close never does.

`queue run --watch --from HH:MM --until HH:MM` bounds a watcher to one local
wall-clock window and exits at its end; see [Queue](queue.md#running-the-queue) for
the full resolution rule (midnight-crossing windows, the one-shot nature, what the
runner does at `from` and at `until`). Both flags only have meaning with `--watch`,
`--from` requires `--until`, and neither is accepted next to `--job`. `queue.keepAwake`
(`"auto"` default, `"always"`, `"off"`) in `config.json` keeps the machine from
sleeping while a runner or a job needs it; see the same section for what it does and
does not cover. `queue.bashTimeoutS` (`{ "default": 900, "max": 3600 }`, in seconds) sets
the Bash timeouts of the `claude` a job runs: `default` is what a command gets with no
`timeout` parameter, `max` the most it may ask for. Both must be positive integers with
`max >= default`; any other value falls back to the defaults as a whole. See
[Queue](queue.md) for why a command that outlives it is killed, never backgrounded.
`queue.inheritUserEnvironment` (`false` default) isolates a job from the operator's
own MCP servers, plugins, skills, agents and user hooks; only a literal `true` opts a
job back into inheriting them. See [Queue](queue.md) for what an isolated job's
environment is and is not, and for the `job environment` row of `nightqueue doctor`.

## Decisions

```sh
nightqueue decision list                                                 # the log of the current project, plus its org's
nightqueue decision list --org acme --status accepted                    # one org's accepted decisions only
nightqueue decision show 7                                               # one decision, in full
nightqueue decision export 7 --dir docs/decisions                        # write it as a markdown file
nightqueue decision import docs/decisions/0007-foo.md                    # save a markdown decision file
nightqueue decision import docs/decisions/0007-foo.md --supersedes 3,4   # ...replacing D-3 and D-4 whole
nightqueue decision update 7 --status accepted                           # accept a proposed decision
nightqueue decision update 7 --status superseded --superseded-by 9       # supersede D-7 with D-9
```

`decision list`, `show <number>`, `export <number>` and `import <file.md>` each resolve the
owner from `--project <name>` (the registered NAME, never a path), `--org <name>`, or the
project of the current directory when neither is given - naming both is refused. `show`,
`export` and `update` also take a ref: `D-7` is read in that same owner, and `DLW/D-3` names
its owner by key, needs no flag and is refused next to a flag naming another owner.
`--superseded-by`, `--supersedes` and `--unrelated` take numbers or refs of the same owner. `list` and
`show` open the database read-only, so they never create it and never migrate it: a home where
nothing was ever saved reads as an empty one instead of a SQLite error.

`decision update <number> --status accepted|rejected|superseded [--superseded-by <n>]`
is the terminal's way to settle a proposal a closed job left behind, or to change a
decision's status by hand - the same write `decision_update` does. `superseded` requires
`--superseded-by <n>`, the number of the decision that replaced it (of the same owner);
any other status refuses that flag. It prints the updated decision the same way `show`
does.

`decision export <number>` writes the decision as `<dir>/<nnnn>-<slug>.md` (default
`docs/decisions/` of the current directory), refusing to replace an existing file unless
`--force`. `decision import <file.md>` reads that same shape back - `# <title>`, a `Status:`
line, `## Context`, `## Decision`, `## Consequences` - and saves it through the same gate
`decision_save` uses (below); `--status` overrides the file's own `Status:` line, and
`--superseded-by <n>` implies `superseded` and conflicts with any other `--status`. On success
it prints `imported as <label>` and stamps the pointer line into the file's header, so a re-run
of the same file is refused as already imported instead of saved twice.

A `decision_save` call and `decision import` are gated the same way. Before saving, the title
(and, for the MCP tool, the title plus the decision text) is checked against every accepted and
proposed decision of the same owner. An overlap saves nothing and answers `needs_review` with
the candidates it found; the caller names EVERY one of them before anything is written -
`supersedes <n,...>` for the ones the new decision replaces WHOLE (they become `superseded` and
point at the new row, so the new text has to restate whatever of theirs still holds),
`unrelated <n,...>` for the ones it leaves untouched. A candidate left unnamed refuses the save
again, naming it once more.

## Doctor

```sh
nightqueue doctor                  # one line per check: ok, warn or fail
nightqueue doctor --json           # the same report, as the only thing on stdout
nightqueue doctor --check-updates  # ...plus the newest version published in the registry
nightqueue doctor --fix            # ...and git worktree repair the job worktrees whose checkout or home moved, drop the stale qa worktrees, remove the shm orphans and repair the database files
nightqueue doctor --db             # ...plus the database files, a quick_check and the jobs on disk the table lost
```

`nightqueue update --from <dir> [--no-install]` installs a checkout. Before building the studio
it runs `npm ci --no-audit --no-fund` in `<dir>` when `node_modules` is missing, when the sha256
of `package-lock.json` differs from the `lock_sha256` of `studio/dist/.stamp.json`, or once
when the build fails on a missing module or command (then it builds once more), and prints
`dependencies: installed (<why>)` or `dependencies: up to date`. `--no-install` skips the
install and prints `dependencies: skipped (--no-install; would run npm ci: <why>)`. A studio
build that cannot pass never blocks the runtime: the step prints `studio: degraded - <first
error line>; the studio serves the previous build (or no build) until npm run studio:build
passes`, and the shims, MCP, hooks and plugin are installed as usual. `nightqueue doctor` has
a `studio build` line: `ok` with the stamp's sha, a `warn` when the runtime has no stamp or it
was written for another version than the runtime.

`nightqueue doctor` reads the host and the home and writes nothing, except `git worktree
repair`, the drop of the stale qa worktrees, the removal of the `db shm` orphans and the database actions with `--fix` (below): it never creates
the database, never touches `settings.json` and never asks `claude` about
anything but its version. It checks the Node version, the `claude` and `gh`
CLIs, `config.json`, the mode of `secrets.json`, each of the three shims (a
missing shortcut only warns), a shim left over from a previous command name (`shift`,
`nightshift`, `nsft`, `nshift`: a `legacy shim <name>` warning, removed by `nightqueue setup` or
`nightqueue update` only when this package wrote it, else the path to delete by hand), the
`~/.nightshift/` directory of the command before the rename (a `legacy home` warning with
the `rm -rf` command; nothing deletes it), the
MCP registration, the registration in the Claude Desktop app (`claude desktop
mcp`, which is a `warn` when the app is installed and does not know the server
and an `ok` when the app is not installed at all), each of the four hooks, the
plugin, the embedding weights,
the optional embedding
library, the schema version of the database, the pause sentinel of the queue,
whether the machine is kept awake for a runner or a job (`queue.keepAwake`, and on
macOS whether `caffeinate` was found), the
pidfile of the runner (a registration whose process is gone only warns, and so does one
whose pid belongs to another user; the diagnosis never removes either), the jobs whose
runner died, the host commands of the last 20 finished jobs (`host commands: 0
backgrounded, 0 killed, 3 timed out in the last 20 jobs`, a `warn` when any was
backgrounded or killed), what the orchestrator of those same jobs did itself
(`orchestrator: 30 turns, 0 reads outside the run, 10 Bash (0 exploration), last
context 250000 (avg 125000) in the last 20 jobs (2 measured)`, a `warn` when it read
outside its run or ran a Bash command outside its closed list - see
[the queue](queue.md)) and every registered
project. It exits `1` when any check fails, `0` otherwise - a `warn` never fails
the run.

The `studio terminal` line says whether the studio can embed a terminal. `ok` reads
`node-pty <version>: the studio can embed a terminal`. Otherwise it is a `warn`, `node-pty
unavailable (<reason>)` - the package is missing, failed to build or was built for another
Node - with the hint that the studio falls back to copy-the-command and that `nightqueue
update` on a host with a C++ toolchain installs it. On darwin a `spawn-helper` that is not
executable gives `spawn-helper not executable (<path>)` with the hint `chmod +x <path>`;
doctor only reports it, the studio fixes it itself when it loads `node-pty`.

Each stored connection gets one `connection <name>` line: doctor runs the same test as
`nightqueue connection test <name>`, all connections in parallel, each within 5 seconds.
`ok` reads `<type>: ok`. A test that fails or times out is a `warn`, `<type>: failed - <detail>`
(an HTTP status, `timeout (5s)` or `network failure`, never the secret), with the hint
`nightqueue connection test <name>`. A connection whose type this build does not know is a
`warn`, `unknown type <type>`. These lines are never a `fail`, because a service outage says
nothing about this host. A home with no stored connection prints no such line and makes no
request.

Three of the checks are about the storage under the home (see [Configuration](cli.md#configuration)):

- `db shm` warns when the shared-memory index of the WAL was replaced under a
  connection still attached to it: hidden orphans left beside the database
  (`.fuse_hidden*`, `.nfs*`, which survive a restart and are the only trace a
  past split leaves), or a live runner whose registered `nightqueue.db-shm` is
  gone or is no longer the file on disk. A runner registered by an older version
  carries no witness, and the check then says so instead of passing. With `--fix` the
  orphans are removed, but only when no live runner is registered (a `runners/*.json` whose
  pid is alive) and the registry can be listed; otherwise the row stays a `warn` and says
  `not removed: a live runner is registered (pid <n>)`. Without `--fix` nothing is deleted.
- `quarantine _broken-<stamp>` names each `_broken-*` directory of the home last modified
  more than 30 days ago as removable, with its size (`2.0 KB`) and its path, and the
  `rm -rf` command. It never deletes it.
- `home mount` names the filesystem the home sits on - read from
  `/proc/mounts` (or `/proc/self/mountinfo`) on Linux and from `mount` on macOS -
  and warns for `nfs`, `nfs3`, `nfs4`, `smbfs`, `cifs`, `afpfs`, `webdav`, `9p`
  and any type containing `fuse`. It only sees the mount in effect at the moment
  it runs, so it says nothing about a mount that has since been unmounted: `db
  shm` is the check that survives a restart. Where neither source answers, the
  line states an unknown rather than a pass.

The `database` check compares the schema version on disk with the one this build expects: a
database behind is a `warn` (`schema v20, this nightqueue expects v22`, hint `run nightqueue update`),
and a database written by a NEWER version is a `fail` (upgrade nightqueue to the version that
wrote it). A database SQLite itself cannot read - `SQLITE_NOTADB`, `SQLITE_CORRUPT`,
`SQLITE_IOERR` or `SQLITE_READONLY` (see [Memory](memory.md)) - is a `warn`, never a `fail`:
the row reads `<code>: <detail>` with the hint `nightqueue doctor --fix`, the one hint every
place that meets a sick database prints.

`--db` only adds rows to the report, after `db shm`; it never changes what `--fix` does:

- `db files` - the sizes of `nightqueue.db`, `-wal` and `-shm`, and the inode of the `-shm`
  (`main <size>, wal <size>, shm <size> (inode dev:ino)`);
- `db integrity` - `quick_check ok`, or a `warn` carrying what `PRAGMA quick_check` answered,
  with the hint `nightqueue doctor --fix`;
- `lost jobs` - every job whose run is on disk (its `state.json` job block or witness, its log,
  its worktree) and whose row the table no longer has, one
  `J-<n> <project>/<slug> last=<status> pr=<url|->` each, plus `and <n> job logs with no run and
  no row (J-…)` for a log nothing else explains: a `warn` with the hint
  `nightqueue queue repair --from-disk`, or `ok` `no job on disk is missing from the table`.
  Logs with no run and no row alone (the logs a `project remove --purge` keeps, for instance)
  never make the row warn, since no repair can rebuild them: it stays `ok` and names them,
  `no job on disk is missing from the table; and <n> job logs with no run and no row (J-…), kept
  for reading only`.
  When the table cannot be read the row says `unknown: the table cannot be read` and still lists
  the ids on disk.

`--fix` extends to the database, with one row per action it took, whether or not `--db` is given:

- `db checkpoint` - when the `-wal` is not empty and the database answers, it folds the log
  into the main file (`wal_checkpoint(TRUNCATE)`, on a connection that never migrates):
  `folded <n> frames (busy=0)`, or a `warn` `busy: a live connection kept <n> frames` with the
  hint `stop the runner, then nightqueue doctor --fix`. An empty `-wal` prints no row.
- `db repair` - only when the database answers `SQLITE_NOTADB` or `SQLITE_CORRUPT` (or a
  `quick_check` that is not `ok`). A copy of the main file ALONE is checked in a temporary
  directory, so the live file never gets a second sqlite:
  - the main file is intact and no other process holds the database: `-wal` and `-shm` are moved
    into `_broken-<stamp>/` in the home, the database is reopened and `integrity_check` runs -
    `moved nightqueue.db-wal, nightqueue.db-shm into <dir>; integrity ok`;
  - the main file is intact but a live runner is registered: a `warn`
    `not moved: a live runner is registered (pid <n>)`, and nothing moves;
  - the main file is intact but another process has the database files open - an MCP server or
    a hook registers nowhere, so the files themselves are asked, through `lsof -t`: a `warn`
    `not moved: pid <n>[, …] still has the database open`, or, when `lsof` cannot run or answers
    anything unexpected, `not moved: cannot tell whether a process holds the database (<why>)`.
    Nothing moves, and the hint is
    `stop every nightqueue process (runners and MCP clients), then nightqueue doctor --fix`. The
    doctor first closes its own connection; one it had to retire as broken makes it say
    `this doctor process holds a broken connection; run \`nightqueue doctor --fix\` again`;
  - the main file itself is broken: a `fail` - the one database row that fails, because
    `--fix` was asked and could not act. Nothing moves; the detail lists every backup in the
    home with its size and time (every `nightqueue.db.pre-v<N>` copy, stamped ones included, and the files of
    each `_broken-*` directory), or `no backup found in <home>`, and the hint is
    `stop every nightqueue process (runners and MCP clients), then: cp '<newest backup>' '<db path>'`.

Job worktrees live under the home, at `<NIGHTQUEUE_HOME>/worktrees/<project_id>/<slug>`, and
an older nightqueue left them under `.claude/worktrees/` of each checkout; the diagnosis reads
both places and writes nothing in either, except `git worktree repair` with `--fix` (the qa
worktrees below have their own `--fix`). One row
`worktree <project>/<dir>` is printed per directory that needs a word:

- under the home, a directory whose two-way link with its checkout broke (its `.git` file names
  an administrative directory that is gone or outside the `worktrees` directory of the
  checkout's git common directory - `git rev-parse --git-common-dir`, so a checkout whose own
  `.git` is a file is read right - or that directory no longer points back at it - what a
  moved checkout or a moved home leaves behind): a `warn`
  `git no longer links it to <checkout> (the checkout or the home moved)` with the hint
  `run: nightqueue doctor --fix`. With `--fix` the diagnosis runs ONE
  `git worktree repair <dir...>` per project from its checkout, then checks each link again:
  the row reads `repaired: git links it to <checkout> again` only when the link now holds, and
  otherwise stays a `warn` - git's reason, or `still not linked after git worktree repair` -
  with the `git -C '<checkout>' worktree repair '<dir>'` command;
- under the home, a directory holding a `.git` link when git cannot read its checkout at all:
  a `warn` `cannot check its link: git could not read <checkout>`, with no repair and no
  removal offered;
- under `.claude/worktrees/`, a directory an open job (any status but `closed`) still records
  as its worktree: an `ok` `legacy-in-use by J-<n> (old location .claude/worktrees): released
  when the job closes`;
- in either place, a directory no open job records as its worktree: a `warn` (prefixed
  `legacy location, ` under `.claude/worktrees/`) with the command that cleans it - the
  diagnosis never runs it, and deletes nothing:
  - registered in git, not locked: `git -C '<checkout>' worktree remove '<dir>'`;
  - registered and locked by a pid that is gone, or with no pid: `git -C '<checkout>' worktree
    unlock '<dir>' && git -C '<checkout>' worktree remove '<dir>'`;
  - not registered in git and holding no `.git` link (orphaned): `rm -rf '<dir>'`; a directory
    that still holds a `.git` link is never offered `rm -rf`, but a `worktree repair` first.

A directory under `<NIGHTQUEUE_HOME>/worktrees/` named after an id no registered project with a
checkout has (a project removed with `--purge` leaves it) is one `warn` row
`worktrees <id>` `project not registered`, with `inspect '<dir>'`.

The operator's QA worktrees (D-58) live at `<NIGHTQUEUE_HOME>/qa/<project_id>/<id>`, apart from
every job's (see [Sandbox](#sandbox)); one row `qa <project>/<id>` is printed per entry:

- stale (older than 6 hours, its session's pid gone, or its directory gone while git still
  registers it): a `warn` `stale (age <n>h | session pid <N> gone | its directory is gone):
  dropped by the next nightqueue open or nightqueue doctor --fix`, hint `nightqueue doctor
  --fix`; with `--fix` it is dropped and the row reads `ok` `removed: stale qa worktree` (or
  `pruned: …` for a gone directory), or stays a `warn` with git's reason;
- held by a live session: `ok` `in use by pid <N> (age <n>m)`;
- young and unlocked: `ok` `age <n>m, no session recorded`;
- locked by hand: a `warn` with the `git -C '<checkout>' worktree unlock '<dir>'` command;
- anything else under `qa/` (a name that is not an id, an id no registered project has, a
  directory git does not register): a `warn` `not a qa worktree; inspect <path> (<reason>)`,
  never removed, `--fix` included.

Without `--fix` the qa rows write nothing.

QA worktrees an operator made before D-58 live at
`<NIGHTQUEUE_HOME>/operator-qa/<project_id>/<slug>`. Nothing creates them any more; each
directory there is a read-only leftover row `operator-qa (legacy) <project>/<dir>` with the
same cleanup commands as above (never `rm -rf` for a directory that still holds a `.git` link),
and an id no registered project has is one `warn` row `operator-qa (legacy) <id>`
`project not registered`. `--fix` never touches them.

A directory a live session holds locked, and the worktree of an open job under the home (its
cleanup is `nightqueue queue close`, or `nightqueue queue cancel` for a `done` or `failed` job),
are not reported. When the queue cannot be read, one `worktrees` row says the owner is unknown
and nothing is listed; when git cannot list the worktrees of a checkout, one
`worktrees <project>` row says so. The owners are read through a read-only store.

One more `warn` row, `decision proposals`, names every decision a queue job proposed and nobody
settled before its job was closed, by number and job - settle it with `decision_update`
(`status: accepted|rejected`) or `nightqueue decision update <number> --status
accepted|rejected`.

On a database at the current schema, the `issue workflow` row names every issue or org
project row whose status disagrees with what its linked job's row means (for example `NQ-12
in_progress (J-40 done, expected in_review)`, or `DLW-7 row api ...` for an org item's row): a job
write whose issue follow failed. The next `nightqueue queue run` claim cycle re-syncs those on its
own. It also names every org item whose persisted status disagrees with what its project rows derive
(for example `DLW-7 todo (derived from its project rows: in_progress)`), re-derived at its next row
change or set by hand with `issue_update`. It is a `warn`, never a failure.

`nightqueue issues [--project <name> | --org <name>] [--status <s>]... [--priority <n>]...
[--type <t>]... [--json]` prints the issues grouped by status in workflow order (`backlog`, `todo`,
`in_progress`, `in_review`, `done`, `cancelled`), one `p<priority> <REF> <title>` line per item (`NQ-12` for a
project item, `DLW-7` for an org item: the ref carries its owner's key), p1 first. `--status`, `--priority` and `--type` repeat to keep several values. Read by a
project, an org item shows the status of that project's own row in parentheses; read with `--org`,
each org item lists its project rows under it (`<project>: <status> J-<id> (<job status>)`), the
item × project matrix. It survives a reader
that closes the pipe early (`nightqueue issues | head`): the CLI stops writing instead of
crashing with `EPIPE` (or `ENOTCONN`/`ECONNRESET`, the same closed reader on a socket). `nightqueue issues show <ref> [--json]` prints one issue in full - its
ref, type, status and priority, its untruncated title and detail, an org item's project
rows under `projects:` - and then its comment thread in chronological order, one `<when> <author> <kind>` line per comment with its body
indented under it. Both read the database and never write to it.

The diagnosis is offline: without `--check-updates` it opens no network
connection at all. With the flag it adds one last check, `registry`, which asks
the registry for the newest published version and compares it with the installed
runtime. That check is never a `fail`: a registry that does not answer is a
`warn` carrying the message of npm, because a registry being down says nothing
about this host and must not turn a local diagnosis into a failing exit code.

## Verify

```sh
nightqueue verify                                  # every detected check, one line each, exit 1 on any failure
nightqueue verify --scope touched --files a.ts,b.ts  # narrow the checks that accept a file list to those paths
nightqueue verify --scope +poc                     # the same block plus the PoC check
```

`nightqueue verify` runs the checks the repository under the current directory
declares, always in the same order - `typecheck`, `lint`, `build`, `test`, `poc`,
`diff-hygiene` - and prints one line per check:

```
PASSED|FAILED|SKIPPED <check> <duration_s>s
```

Under a `FAILED` line come at most twenty indented lines of that check's own
output. It exits `1` when any line is `FAILED` and `0` otherwise: a `SKIPPED`
never fails the run, the same rule `nightqueue doctor` follows for a `warn`.

The checks are detected, never guessed. The package manager comes from the
lockfile alone (`bun.lockb`/`bun.lock` → bun, `pnpm-lock.yaml` → pnpm,
`yarn.lock` → yarn, `package-lock.json` → npm, none → npm) and every script is
invoked as `<pm> run <script>`, never through `npx`/`bunx`, so a check always
runs at the version the repository installed. When there is no `package.json`,
the ladder falls through to `Makefile`, `pyproject.toml`, `go.mod` and
`Cargo.toml`. A check the project does not declare is `SKIPPED`: a repository
with no test script reports every check `SKIPPED` and exits `0` - and says so on
stderr, because "nothing was verified" is not the same event as "everything
passed".

A workspace root is read as the workspace it is. A script the root manifest does
not declare is looked for in the members its `workspaces` array (or yarn's
`workspaces.packages`, or pnpm's `pnpm-workspace.yaml`) names, `*` expanding one
level and `**` every level down to the bounded depth of the walk, with `!`
patterns excluded. Each member that declares the script contributes one run of
`<pm> run <script>` **in its own directory**; the check passes when every run
passes and stops at the first failure, whose snippet opens with `in <member>`. A
script the root declares wins over the members, because the root script is the
project's own entry point. When the root declares workspaces and no member
carries a `package.json`, the run says so on stderr instead of reporting an empty
workspace as a project with no checks.

`--scope` takes exactly three values. `full` (the default) runs every detected
check over the whole project; `touched` passes the file list to the only checks
that can honestly take one (a package-manager `lint` script, after a `--`
separator) and runs the rest whole, because a typecheck or a build cannot be
narrowed without lying; `+poc` is `full` plus the `poc` check, which prefers a
`test:poc`/`test:fuzz` script and otherwise runs the project's test script over
the `*.poc.test.*`, `*.fuzz.test.*` and `*.regression.test.*` files it finds.
Any other value is refused instead of silently treated as the default. `--files`
is repeatable and its values are comma-separated; without it, `touched` reads the
files from `git status --short` plus `git diff --name-only`. Only `touched`
consumes `--files`: under `full` or `+poc` the flag is ignored and the run says
so on stderr, naming the scope, so a narrowing that never happened is never
discarded in silence.

`nightqueue verify` **never installs anything** and never opens the network on
its own account: no `install`, no `ci`, no `--frozen-lockfile`. A missing
dependency is not guessed from the filesystem either - in a git worktree Node
resolves the parent checkout's `node_modules`, so an absent directory proves
nothing. The signal comes from the process's own resolution failure: the spawn
itself finding no binary (`ENOENT`), or a line the runtime wrote for itself -
`Error: Cannot find module …`, `ERR_MODULE_NOT_FOUND`, a shell line ending in
`: command not found`, Windows' `is not recognized as an internal or external
command`, `executable file not found in $PATH`. Such a check is `FAILED` with
`dependencies not installed — nightqueue verify never installs` as its first
snippet line. The match is anchored to those lines: a check that legitimately
fails and happens to quote one of the phrases inside its own message keeps its
real reason. A declared check that could not
run is never dressed up as a `SKIPPED`. The repository under test is not written
to at all: no install, no `git add`, no formatter, no lockfile write. (The
project's own checks are still the project's own - a `go build` or a test that
calls a service may reach the network; that is the repository's business, not
this command's.)

Every check is spawned against a throwaway `NIGHTQUEUE_HOME` and
`CLAUDE_CONFIG_DIR`, created under the system temp directory and removed when the
command exits, so a check that itself runs `nightqueue` never touches the
operator's home. That covers the checks `verify` spawns and nothing else: a
`nightqueue` command typed by hand still needs its own throwaway home, which
`nightqueue sandbox` provides.

The last check, `diff-hygiene`, needs no script. It reads `git status --short
--untracked-files=all` and `git diff --stat` in the current directory: the first
snippet line is the summary of `git diff --stat` (`no tracked file changed` when
there is none), the scale of the change, and the check is `FAILED` when a path
under `.claude/`, a lockfile or `tmp/` appears in the working tree, with the
intruding paths listed under the summary. Outside a git repository the check is
`SKIPPED`.

## Studio

```sh
nightqueue studio                        # serve the studio on 127.0.0.1:4747 and open it in the browser
nightqueue studio --port 0 --no-open     # any free port, print the URL only
nightqueue studio --api-only --port 4747 --token <t> --dev-origin http://127.0.0.1:5173   # what `npm run studio:dev` starts
```

`nightqueue studio [--port <n>] [--token <t>] [--api-only] [--dev-origin <url>] [--no-open]`
serves nightqueue studio, the local web cockpit, on `127.0.0.1` only. One process answers:

- the built page, `studio/dist` of the installed package (a missing dist is warned about on
  stderr and the page answers a minimal "Studio not built" with `503`; the API and `/mcp` keep
  working);
- `/mcp`, the same stateless Streamable HTTP endpoint as `nightqueue mcp --http`;
- `/api`: `GET /api/info`, `GET /api/projects`, `POST /api/runners/start` (a watch runner,
  with an optional `from`/`until` window), `POST /api/queue/pause|resume`,
  `GET /api/jobs/<ref>/log` (the last mebibyte of the job's log, as text) and
  `GET|POST /api/terminals`, `DELETE /api/terminals/<id>` (below);
- `/events`: a server-sent event stream with the `queue_status` snapshot and, every second,
  the patch of what changed; `/events?job=J-<n>` streams the narrated current attempt of one
  job, its phase timeline and its touched files;
- `/term/<id>`: the WebSocket of one embedded terminal (below).

The process also runs the maintenance timer of the home, as `mcp --http` does; the
`/events` poll itself only reads.

**Token.** `--token`, else `NIGHTQUEUE_STUDIO_TOKEN`, else a random one per start. The
command prints `studio listening on http://127.0.0.1:<port>/?t=<token>` and opens that URL
unless `--no-open` (or `--api-only`) is given. The first load trades `?t=` for an HttpOnly,
`SameSite=Strict` cookie named `nq_studio_<port>` and redirects to the same page without the
token. From then on every request - page, asset, `/api`, `/events`, `/mcp` - is refused
with 401 unless it carries that cookie or `Authorization: Bearer <token>`. A restart needs
the new URL.

**Security.** The `Host` must be loopback and any `Origin` must be loopback (a repeated
one is refused), as for `mcp --http`. A request that changes state (`POST /mcp`, `POST` or
`DELETE /api/*`) authorised by the cookie must also carry the studio's own origin exactly, port
included, so a page served on another local port cannot drive the queue. A `/term/<id>`
upgrade needs that exact origin from every caller, the bearer one included, and any other
upgrade is refused with a short HTTP answer (see [the runtime
contract](runtime-contract.md)). No response
carries CORS headers, and every one carries a strict `Content-Security-Policy`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

**Terminals.** The studio can embed a `claude` terminal, shown in a dock at the bottom of
every page (tabs, a height kept in the browser, hide, full page at `/terminal/<id>`) and
drawn by xterm.js. It needs the optional dependency `node-pty`; on darwin the studio makes its
`spawn-helper` executable (`0755`) inside nightqueue's own runtime the first time it loads it.
Without `node-pty`, or when it fails to load, the install still succeeds, `GET /api/terminals`
answers `available: false` with the reason, a create answers `503`, and every entry point
shows `terminal unavailable: <reason>` with the command to copy instead
(`nightqueue queue session J-<n>`, `nightqueue open <project>` or `nightqueue open`).

`POST /api/terminals` takes only `{kind, job | project?, instruction?}`; any other key, `cwd`
included, is a `400`: the directory, the session and the binary always come from the job row,
its run state and the project registry. Two kinds exist:

- `session`: runs `nightqueue queue session J-<n>`, which resumes the job's Claude session in
  its worktree, or the project checkout when the worktree was released. Only a job in `gate`,
  `failed`, `done` or `cancelled` is accepted; any other status is a `409` naming it. One live
  session per job: a second create returns the same terminal (`reused: true`), or a `409` when
  it carries an instruction.
- `operator`: runs `nightqueue open`, the operator session in the nightqueue home (D-58), with
  `<project>` preselected when the body names one (`nightqueue open <project>`). A named project
  must be registered (`404` otherwise, `400` when blank); one whose checkout is gone still
  opens.

Both run the current runtime's CLI (`node <runtime>/bin/nightqueue.mjs`), which starts
`claude` exactly as when typed, with `TERM=xterm-256color`, 120x32, as foreground children of
`nightqueue studio` - never detached. The child's environment is the studio's minus every
`NIGHTQUEUE_STUDIO_*` variable, so the studio's token never reaches `claude` or the tools it
runs. Both go through the operator launcher, so opening a terminal runs `git worktree prune`
in every registered checkout, with no `--expire` (every stale worktree entry, one whose
directory is gone, is dropped at once, not after git's own expiry), and drops the stale qa
worktrees. At most 6 terminals
are open at once; the 7th is a `409` (`6 terminals are open, the cap; close one first`). A
create from inside a job against the runner's own home is a `403`. An optional `instruction`
(at most 1000 characters, refused above, never cut; control characters and newlines become
spaces; one that starts with `-` is refused) is passed as `--prompt`; claude submits it once
its own prompt is up, and the studio never types into the terminal on your behalf. The listing
marks it `given`. The listing (`GET /api/terminals`) is in memory; an exited terminal stays in
it as `exited` for 60 s.

Hiding the dock or switching tabs ends nothing. `DELETE /api/terminals/<id>` (the tab's `×`,
after a confirm) sends `SIGHUP` to the process group of the `nightqueue` child, which holds
`claude` and its MCP servers and tools, and `SIGKILL` 2 s later if anything of it is still
alive. When the `nightqueue` child ends while something of its group still runs, the studio
ends the group the same way. Ctrl+C on `nightqueue studio` does
the same to every terminal before the server closes, and an exit handler sends `SIGKILL` to
whatever is left. A studio that died without that cleanup is covered by the registration
files described in [the runtime contract](runtime-contract.md): the next start on that port
reaps them. `nightqueue doctor` reports whether `node-pty` loads (`studio terminal`).

The entry points are `Resume in terminal` on a job page (disabled, with the reason as its
tooltip, outside the four statuses; `Copy session cmd` stays beside it), `Open operator` in
the issues toolbar and `Operator` on each issue (instruction `Analyse <ref>: <title>`), which
open the operator with that project preselected and are disabled on all projects, and
`Operator` in the header, never disabled: home mode with the project picked in the queue
toolbar preselected, or no project on all projects.

**Development.** `--api-only` serves no page; `--dev-origin <url>` (only with `--api-only`,
a loopback `http://host:port`) is the second origin the write rule and the `/term` upgrade
accept. `npm run studio:dev` starts both sides: this API on port 4747 and the Vite dev server
on `http://127.0.0.1:5173`, whose proxy adds the bearer token, `/term` included. It sets
`NIGHTQUEUE_STUDIO_SPAWN_SELF=1` on the API side, so its terminals run the working tree's
CLI (the tree the studio runs from) instead of the installed runtime's.

## Sandbox

```sh
nightqueue sandbox node --version   # runs `node --version` against a throwaway home
```

`nightqueue sandbox <command> [args...]` runs exactly one command with a
throwaway `NIGHTQUEUE_HOME` and `CLAUDE_CONFIG_DIR`, both created before the
command starts and removed once it exits, whatever the exit code — the same
isolation `verify` gives its own checks, offered for a `nightqueue` command
typed by hand. The rest of the environment and the current directory are
inherited unchanged, and the command's own arguments are never parsed by
`nightqueue`: everything after `sandbox` is forwarded verbatim, so a flag like
`--version` reaches the wrapped command instead of the CLI. Stdin, stdout and
stderr are inherited, and the exit code is the child's own — 128 plus the
signal number when the child was killed by one, or `127` with a message on
stderr when the command itself could not be spawned (for example, an unknown
binary).

```sh
nightqueue sandbox worktree my-app                 # QA_WORKTREE: <home>/qa/<project id>/<id>
nightqueue sandbox worktree --drop <path>          # dropped <path> (or: gone <path>)
```

`nightqueue sandbox worktree <project> | --drop <path>` is the one exception to the verbatim
forwarding: a first argument `worktree` manages the ephemeral QA worktrees of the operator's
`qa` subagent (D-58) instead of running a program of that name. `<project>` (a registered name,
else id; an unknown one is refused, and git's first line is the error when the checkout cannot
give a worktree) gets a worktree detached at the checkout's `HEAD` under
`<NIGHTQUEUE_HOME>/qa/<project id>/<id>`, `<id>` a fresh ULID; exactly one line
`QA_WORKTREE: <path>` is printed. Inside an operator session (`NIGHTQUEUE_OPERATOR_PID` set) the
worktree is locked with `git worktree lock --reason "nightqueue qa (pid <N>)"`, which records
the session that owns it. `--drop <path>` accepts only a path that is exactly
`<qa>/<project id>/<id>` of this home, unlocks it, runs `git worktree remove --force` and
`git worktree prune`, removes a leftover directory only when it is empty, and prints
`dropped <path>`, or `gone <path>` when there was nothing to drop. `--drop` refuses a worktree
whose lock names a live pid other than `NIGHTQUEUE_OPERATOR_PID`, so one session never drops
another's; an unlocked one, one this session holds or one whose owner is gone is dropped. Both
are refused from inside a job against the runner's own home.

A qa worktree is stale when git registers it and either its id says it is older than 6 hours
or its lock names a pid that is gone; a worktree locked by hand (no pid in the reason) is never
stale. `nightqueue open` drops the stale ones; `nightqueue doctor` lists them and
`nightqueue doctor --fix` drops them; the SubagentStop hook of an operator session drops the
worktree its `qa` subagent announced on the first line of its final message
(`QA_WORKTREE: <path>`, or, with no final message, the first such line of its last assistant
entry in its transcript) when that session holds the lock
or nobody does - a worktree another live session holds is never dropped. Nothing under `qa/`
that git does not register is ever removed, except an empty directory.

The `qa` subagent's Bash is held to its worktree by the guard hook, which is a best-effort
**anchor, not a sandbox**: every command other than the two `sandbox worktree` forms must have
the exact shape `cd <path inside a qa worktree> && …` - a bare command is refused even when the
shell already stands in the worktree - and the rest may hold no `cd`, `pushd` or `popd`, no
`..` segment, no `$(…)`, `$'…'`, backtick, backslash or `$VAR`, no leading `~`, no newline, no
glob or brace next to a dot, and no absolute path outside that worktree except `/dev/null` (an
option glued to one, `-C/etc`, included). In any segment of the chain, `nightqueue` runs only as
`nightqueue sandbox <cmd>`, `gh` only as `gh pr view|diff|checks|list|status` or
`gh issue view|list`, and `git` never as `push`, `remote` or `config`. A program the command
runs can still reach outside it; tests that touch a nightqueue home go through
`cd <path> && nightqueue sandbox <cmd>`.

## Open

```sh
nightqueue open                          # the operator, in the nightqueue home; the project of this checkout, if any, preselected
nightqueue open my-app                   # the same with a registered project preselected by name (or id), from any directory
nightqueue open --resume <session>       # resume an operator (or job) session
nightqueue open my-app --prompt "Analyse KEY-3: fix the login"   # start the session with a request
```

`nightqueue open [project] [--resume <session>] [--prompt <text>]` starts an interactive `claude` with the
`nightqueue:nightqueue-operator` agent as the main thread (`--append-system-prompt` with the
agent's body when `claude --help` does not list `--agent`; `nightqueue doctor` reports which),
the operator settings, `--setting-sources project,local` (the operator's interactive session keeps
the `local` source; a queued job's child gets `--setting-sources project` only), the plugin and
the nightqueue MCP server, and `NIGHTQUEUE_MODE=operator`, which puts the guard hook in operator
mode (D-58, below). It never holds the config lock.

**Home mode (D-58).** The operator is generalist: the session always runs in the nightqueue
home (`NIGHTQUEUE_HOME`, `~/.nightqueue` by default), never in a checkout, and a missing home is
refused with one line naming `nightqueue setup`. A project is only *preselected*: the one named
(`open <project>`, by name, else by id; an unknown one is refused, a registered project whose
checkout is gone still opens), else the one registered for the current directory, else none.
The preselection reaches the session as `NIGHTQUEUE_PROJECT=<project id>` and nothing else; the
SessionStart hook then opens its context block with `Current project (preselected by nightqueue
open): <name>`, even when the project has no memory yet, and the memory hooks and the reflection
read that project. With no project the operator lists the registered ones and asks which.
`NIGHTQUEUE_OPERATOR_PID` carries the pid of the `nightqueue open` process, which owns the qa
worktrees the session creates. A `NIGHTQUEUE_PROJECT`, `NIGHTQUEUE_MODE` or
`NIGHTQUEUE_OPERATOR_PID` inherited from the caller is never passed on, and a job a runner
started from inside an operator session never inherits any of the three.

With `--resume <session>` the cwd is the directory the session was born in (the first `cwd` its
transcript under `CLAUDE_CONFIG_DIR/projects` records, when that directory still exists), else
the current directory when it lies inside the preselected project's checkout, else the home:
claude only resumes a session from the directory it was born in.

Before claude starts, `git worktree prune` runs in every registered checkout that exists, with
no `--expire`: every stale worktree entry (one whose directory is gone) is dropped at once, not
after git's own expiry; a failure is one warning line. Then the stale qa worktrees are dropped
(see [Sandbox](#sandbox)) and, when there were any, one line says
`operator · dropped <n> stale qa worktree(s)`. `queue session` and a studio terminal run both
too, through the same launcher.

**The guard (D-58).** The operator investigates, plans and queues; it never edits and never
executes. The PreToolUse hook of an operator session (matcher
`Agent|Task|Bash|Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit`) answers every refusal with
one line starting `D-58:`:

- main thread: `Edit`, `Write`, `MultiEdit` and `NotebookEdit` are refused; `Read`, `Grep` and
  `Glob` only under a registered checkout, `<home>/qa`, `<home>/runs`, `<home>/worktrees`, the
  plugin and the session's spill directory (never the home root, which holds `config.json`,
  `secrets.json` and the database; a `Glob` without a `path` targets the home and is refused, and
  an absolute Glob `pattern` or Grep `glob` is judged by its static prefix);
  Bash only as one bare command (no `;`, `&&`, `|`, redirection, substitution or backslash) that
  is either `nightqueue|nq <command> …` with `<command>` one of `queue`, `issues`, `decision`,
  `project`, `org`, `connection`, `doctor`, `memory`, `libs`, `version` - never `queue session`,
  `decision export|import`, `project add|move`, `queue add --run` or `doctor --fix`, never
  `--follow` or `--foreground` - or `git -C <checkout> [--no-optional-locks] <read> …` on a
  registered checkout, `<read>` one of `log`, `show`, `diff`, `blame`, `ls-tree`, `ls-files`,
  `rev-parse`, `branch --list` and `--no-optional-locks status` (never `--output*`,
  `--ext-diff`, `--no-index`, `--exec`, nor a global option other than `-C`); `Agent`/`Task`
  only for the `triage`, `qa` and `reviewer` subagents;
- the `qa` subagent: `Edit`/`Write`/`MultiEdit`/`NotebookEdit` only inside a qa worktree
  `<home>/qa/<project id>/<id>`; Bash only as `nightqueue sandbox worktree <project>`,
  `nightqueue sandbox worktree --drop <path>`, or `cd <path inside a qa worktree> && …` (see
  [Sandbox](#sandbox));
- any other subagent (`triage`, `reviewer`): no edit tool; Bash is one bare nightqueue read
  (`queue status|log`, `issues`, `project list`, `decision list|show`, `org list`,
  `connection list`, `memory stats`, `doctor` without `--fix`, `version`), the main thread's
  `git -C` reads, `gh pr view|diff|checks|list|status` or `gh issue view|list`;
- every subagent reads only under the main thread's read roots, so delegating never widens them.

A registry that cannot be read refuses the checkout reads and `git -C` (the reason names
`nightqueue doctor`), an error inside the guard refuses every tool but the reads, and an edit,
`Bash`, `Agent` or `Task` call whose `tool_input` is not an object is refused: the operator
guard fails closed, unlike a job's.

A fresh session opens with the operator's greeting: who it is (the nightqueue operator), the
preselected project or the list of registered ones, what it does, what it never does, and
where to start. A resumed session is not greeted again. The `nightqueue` MCP tools are
pre-approved for the session (`permissions.allow: ["mcp__nightqueue__*"]` in the settings it
is started with), so the operator never asks before reading the queue, the issues or the
memory; every other tool keeps Claude Code's own prompts.

`--prompt <text>` starts the session with that request instead of the opening prompt (after
`--resume <session>` when resuming): it is passed verbatim as claude's first positional
prompt, which claude submits itself once its own prompt is up, after any startup dialog
(workspace trust, MCP approval) has been answered. A value that starts with `-` or is empty is
refused. A value that is exactly one of claude's command names (`mcp`, `update`, `purge`,
`plugin`, `help`, ...) is passed with one trailing space: claude dispatches its first operand
as a command when it names one, even after `--`, so the bare word would run that command
instead of opening the session with it as the first message. The text is on the command line of the `claude` process (and of `nightqueue`
itself), so `ps` shows it to any user of the machine while the session runs; do not put
secrets in it.

## Libs

```sh
nightqueue libs zod express        # the INSTALLED version of each name, one line each
```

`nightqueue libs <name>...` prints one `<lib> <version>` line per argument, in
the order the arguments were given, read from the lockfiles of the current
directory. It reports the version that is **installed**, never the range the
manifest declares. A name no lockfile carries prints `<lib> not-found` rather
than no line at all, so the caller can always zip its input to the output, and
the exit code is `0` either way: `libs` is a report, not a check.

The lockfiles are read in this order, the first one carrying the name answering:
`package-lock.json` (v1, v2 and v3), `pnpm-lock.yaml`, `yarn.lock` (classic and
berry), `poetry.lock`, `requirements.txt`, `Cargo.lock`, `go.sum` and `go.mod`.
`bun.lockb` is deliberately **not** read - it is a binary format that would need
a `bun` subprocess - so a bun-only project reports every name `not-found`.
Python names are matched the way pip identifies a distribution (case-insensitive,
`-`, `_` and `.` equivalent); crate names are matched exactly, because
`serde_json` and `serde-json` are different crates.

The command opens no network connection, spawns no subprocess, reads no database
and writes nothing; it looks only at the current directory, never at a parent.
A directory with no lockfile at all still prints a `not-found` line per name on
stdout and says why on stderr, exiting `0`. A lockfile that exists but cannot be
read or parsed is a user error (exit `1`) naming the file, instead of a silent
`not-found`.

## Run

```sh
nightqueue run --help                                      # the steps, one usage line each
nightqueue run index-save <RUN_DIR>/02-explore.md          # persist an explore artifact into the project index
nightqueue run index-save <artifact> --repo-root ~/code/api --project api
nightqueue run secrets-sweep --files src/a.js,src/b.js     # log calls that may print a secret
```

`nightqueue run <step>` holds the mechanical steps the pipeline's agents used to
perform by hand. It has exactly two steps, and `nightqueue run` with no step (or
`--help`) prints them.

**`index-save <artifact> [--project <name>] [--repo-root <path>]`** reads the
`## File map` and `## Third-party libraries` sections of an explore artifact
(`## Libs` is accepted as an alias for the second) and saves them into the
project index, so the Explore subagent no longer keeps two identical lists in
sync. It prints `index saved: N files, M libs` and exits `0`. `--repo-root`
(default: the current directory) is the path the file-map entries are stored
relative to, and `--project` defaults to that same path - the runtime resolves a
path inside a registered project to the project's name. The database is reached
only through the store, the same door the `index_save` MCP tool uses.

The file map is parsed strictly and the libs section leniently: a bullet that is
not `<path> — <responsibility>` is a user error (exit `1`) naming the line
number, because a dropped entry writes a silently incomplete index, while a libs
bullet that is not `<lib>@<version>` is skipped with a note on stderr (a `None`
bullet is the documented "no libs" marker and is not even reported). A missing
artifact, an artifact with no `## File map` and a repository that is not
registered are each exit `1` with a message naming what was missing.

Both paths are resolved through the filesystem, every component of them, before
anything is read: the artifact must be an existing **regular file** and
`--repo-root` an existing **directory**, each refused by name otherwise. Neither
is required to sit under the current directory - the pipeline's run directory
lives outside the worktree on purpose - and the write side stays bounded by the
store, which still refuses a repository that is not a registered project.

**`secrets-sweep --files <list>`** prints the log calls whose arguments may carry
a secret. `--files` is repeatable and comma-separated, the same shape `verify`
uses. For every file it finds the log calls of the sinks it recognises
(`console.*`, `logger.*`, `fmt.Print*`, `System.out.print*`, `printf`,
`println!`, `print`, `var_dump`, `puts` and their neighbours) and flags a call
whose argument identifiers - or the line where such an identifier is **defined in
the same file** - name a token, password, secret, key, cookie or credential. That
second hop is the point: the leak is rarely `console.log(apiToken)`, it is
`console.log(requestCurl)` where `requestCurl` was built from an
`Authorization` header. Each candidate is two lines:

```
<file>:<line>: <source line>
    def <file>:<line>: <definition line>
```

and the sweep ends with `secrets-sweep: N candidates in M files`. The match is on
identifier parts, not substrings, and string literals are blanked before the
arguments are read, so `console.log(keyboard)` and `console.log("token
refreshed")` are not candidates. The exit code is **always** `0` for a sweep that
ran - the command reports, the reviewer judges, and `0 candidates` is not a clean
bill of health. A file that cannot be read and a binary file are each named on
stderr and the remaining files are still swept; `--files` absent altogether is a
user error (exit `1`), which is not the same event as a `--files` list that is
empty. A file that resolves outside the current directory - by an absolute path,
by `..`, or through a symlinked component - is a user error (exit `1`) naming the
path: the sweep reads the files of the worktree it was called in and nothing
else. Nothing is written, and no database is opened.

