# CLI, configuration and doctor

`bin/nightshift.mjs` is the CLI: it manages orgs, projects and the connections (and
their secrets), and it drives the memory runtime.

- `nightshift --help` lists every command: `setup`, `doctor`, `init`, `org`,
  `project`, `update`, `connection`, `mcp`, `hook`, `reflect`, `embed`,
  `memory`, `queue`, `verify`, `sandbox`, `libs`, `run` and `version`.
- `nightshift --version` (same as `nightshift version`) prints the installed version
  and exits `0`.
- Exit codes: `0` ok, `1` user error (a single line on stderr), `2` unexpected
  error (a stack on stderr). `nightshift doctor` and `nightshift verify` also
  exit `1` when a check fails.
- Every `list` accepts `--json`; on `--json`, stdout is either valid JSON or
  empty, because warnings and errors always go to stderr.

The queue lives in `nightshift queue` (see [Queue](queue.md)); the scheduler that would
start it by itself lands in a future version, published as the npm package
`nightshift`, of which this plugin is the pipeline half.

## The run of a job (`nightshift run`)

`nightshift run` is the family the pipeline calls from *inside* a job: each
subcommand acts on the run of the job it is called from, which it resolves from
`NIGHTSHIFT_JOB_ID` and that job's own row. It is not `nightshift queue run`,
which starts the runner over the whole queue. Naming another run from inside a
job is refused; outside one, `--project <name> --slug <slug>` is required.

```sh
nightshift run check 03       # is the plan there, with the sections the pipeline reads?
nightshift run log            # one line per phase of this run, plus the total
nightshift run log --json     # the same table as the only thing on stdout
nightshift run commit --message-file msg.txt   # stage what the implementation listed, and commit it
nightshift run pr --body-file body.md          # check the body, push and open the pull request
```

`run check <NN>` is the artifact gate of a phase: it reads
`<RUN_DIR>/<NN-phase>.md` and prints `OK` or `MISSING: <sections>` - the
sections required are `## Verdict` (`01`), the four sections of the plan (`03`),
`## Modified files` (`04`), `## Break hypotheses` + `## Test recipe` (`05a`),
`## Validated risks` (`05`) and `## Verification` (`06`); `02` is checked for
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
one is refused before anything is staged. It prints `COMMITTED: <sha> (<n>
files)`. Anything under
`.claude/` or `tmp/`, any dependency lockfile and any path outside the run's
worktree is refused: the command prints `REFUSED: <path> (<reason>)`, stages
nothing and exits `1`. `--extra` adds files to the list, it never overrides that
refusal. Before committing it prints `CONVENTION: <...>` - the file that
declares the repository's commit convention (a commitlint config, `.husky/`,
`.gitmessage`, `CONTRIBUTING*` or a `commitlint` block in `package.json`) and
what the last 30 subjects really read like - so the message is written to the
shape the repository uses.

`run pr` checks the body BEFORE anything leaves the machine, with the rules of
`references/pr-template.md`: the three sections `## Summary`, `## Changes` and
`## QA` present and in that order with no fourth `## `, the lines `Verdict:` and
`Proven:` inside `## QA`, no bare `#<number>` outside a `Fixes`/`Closes` line,
and no `{{placeholder}}` or `<...>` example left over from the template. A body that fails prints `REJECTED:
<reason>` and exits `1` with nothing pushed. Otherwise it renames the branch
when it still carries the `worktree-` prefix (`worktree-feat+login-google` →
`feat/login-google`, falling back to `<type>/<slug>` from `state.json` when the
name carries no `+`), pushes it with `git push -u origin <branch>`, opens the
pull request with `gh pr create` and records the outcome `done` in `state.json`.
The `PR: <url>` line it prints is information only - the pull request of the run
is the one the host published in its own `code_change_published` event (see
[Runtime contract](runtime-contract.md)). It closes with `WORKTREE: <path>` and
removes the worktree only when asked with `--remove-worktree`, because the
session that called it still lives in that directory. That default is unchanged:
in a queue job the runner itself removes a clean, pushed worktree once the run ends
`done`, and `nightshift queue close` removes it for a job that stopped anywhere else
(see [Queue](queue.md)).

## Configuration

`NIGHTSHIFT_HOME` (default `~/.nightshift`) is a single directory that holds
both the configuration at its root and the run artifacts under `runs/` (see
[Runtime contract](runtime-contract.md)) - one home, two kinds of content, not two environment
variables:

```
$NIGHTSHIFT_HOME/          # 0700
  config.json              # orgs, projects, queue settings
  secrets.json             # 0600, connection secrets
  nightshift.db            # the memory database (see [Memory](memory.md))
  runtime/versions/        # one directory per installed version, the last two kept
  runtime/current          # symlink into versions/, what the host is registered against
  bin/                     # the shims: nightshift, nshift and nsft
  embedding/               # npm prefix of the embedding library, opt-in
  models/                  # embedding weights, downloaded on demand
  state/                   # per-session hook state
  runs/<project>/<slug>/   # run artifacts, written by the runtime
  logs/                    # one log per queue job plus one per runner
  queue.paused             # sentinel file, present only while the queue is paused
  runners/<pid>.json       # one registration per live runner, any number of them
```

`NIGHTSHIFT_HOME` must sit on local disk. The memory database is SQLite in WAL
mode, and WAL correctness depends on the operating system really enforcing POSIX
advisory locks - in particular the connection-lifetime "dead man's switch" lock
that tells a connection being closed whether it is the last one still attached to
the database. Network and FUSE mounts (`nfs`, `nfs3`, `nfs4`, `smbfs`, `cifs`,
`afpfs`, `webdav`, `9p`, and anything carrying `fuse`) are known to drop those
locks or to emulate them incorrectly. When that happens the shared-memory index of
the WAL (`nightshift.db-shm`) is unlinked and recreated while another process is
still attached to the old one: that process keeps reading and writing an index the
rest of the system has already abandoned, which loses finish commits and reverts
leases. `nightshift doctor` reports both halves of this - see [Doctor](cli.md#doctor).

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
nightshift org repair [--to <org>]                 # settle an interrupted rename; adopt orphan rows

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
and an `ok` when the app is not installed at all), each of the four hooks, the
plugin, the embedding weights,
the optional embedding
library, the schema version of the database, the pause sentinel of the queue, the
pidfile of the runner (a registration whose process is gone only warns, and so does one
whose pid belongs to another user; the diagnosis never removes either), the jobs whose
runner died and every registered
project. It exits `1` when any check fails, `0` otherwise - a `warn` never fails
the run.

Two of the checks are about the storage under the home (see [Configuration](cli.md#configuration)):

- `db shm` warns when the shared-memory index of the WAL was replaced under a
  connection still attached to it: hidden orphans left beside the database
  (`.fuse_hidden*`, `.nfs*`, which survive a restart and are the only trace a
  past split leaves), or a live runner whose registered `nightshift.db-shm` is
  gone or is no longer the file on disk. A runner registered by an older version
  carries no witness, and the check then says so instead of passing.
- `home mount` names the filesystem the home sits on - read from
  `/proc/mounts` (or `/proc/self/mountinfo`) on Linux and from `mount` on macOS -
  and warns for `nfs`, `nfs3`, `nfs4`, `smbfs`, `cifs`, `afpfs`, `webdav`, `9p`
  and any type containing `fuse`. It only sees the mount in effect at the moment
  it runs, so it says nothing about a mount that has since been unmounted: `db
  shm` is the check that survives a restart. Where neither source answers, the
  line states an unknown rather than a pass.

For every registered project that has a `.claude/worktrees/` directory, one `warn` row
`worktree <project>/<dir>` names each directory there that no job still open (any status but
`closed`) records as its worktree, with the command that cleans it - the diagnosis never runs
it, and deletes nothing:

- registered in git, not locked: `git -C '<checkout>' worktree remove '<dir>'`;
- registered and locked by a pid that is gone, or with no pid: `git -C '<checkout>' worktree
  unlock '<dir>' && git -C '<checkout>' worktree remove '<dir>'`;
- not registered in git (orphaned): `rm -rf '<dir>'`.

A directory a live session holds locked, and the worktree of an open job (its cleanup is
`nightshift queue close`), are not reported. When the queue cannot be read, one `worktrees`
row says the owner is unknown and nothing is listed; when git cannot list the worktrees of a
checkout, one `worktrees <project>` row says so. The owners are read through a read-only store.

The diagnosis is offline: without `--check-updates` it opens no network
connection at all. With the flag it adds one last check, `registry`, which asks
the registry for the newest published version and compares it with the installed
runtime. That check is never a `fail`: a registry that does not answer is a
`warn` carrying the message of npm, because a registry being down says nothing
about this host and must not turn a local diagnosis into a failing exit code.

## Verify

```sh
nightshift verify                                  # every detected check, one line each, exit 1 on any failure
nightshift verify --scope touched --files a.ts,b.ts  # narrow the checks that accept a file list to those paths
nightshift verify --scope +poc                     # the same block plus the PoC check
```

`nightshift verify` runs the checks the repository under the current directory
declares, always in the same order - `typecheck`, `lint`, `build`, `test`, `poc`,
`diff-hygiene` - and prints one line per check:

```
PASSED|FAILED|SKIPPED <check> <duration_s>s
```

Under a `FAILED` line come at most twenty indented lines of that check's own
output. It exits `1` when any line is `FAILED` and `0` otherwise: a `SKIPPED`
never fails the run, the same rule `nightshift doctor` follows for a `warn`.

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

`nightshift verify` **never installs anything** and never opens the network on
its own account: no `install`, no `ci`, no `--frozen-lockfile`. A missing
dependency is not guessed from the filesystem either - in a git worktree Node
resolves the parent checkout's `node_modules`, so an absent directory proves
nothing. The signal comes from the process's own resolution failure: the spawn
itself finding no binary (`ENOENT`), or a line the runtime wrote for itself -
`Error: Cannot find module …`, `ERR_MODULE_NOT_FOUND`, a shell line ending in
`: command not found`, Windows' `is not recognized as an internal or external
command`, `executable file not found in $PATH`. Such a check is `FAILED` with
`dependencies not installed — nightshift verify never installs` as its first
snippet line. The match is anchored to those lines: a check that legitimately
fails and happens to quote one of the phrases inside its own message keeps its
real reason. A declared check that could not
run is never dressed up as a `SKIPPED`. The repository under test is not written
to at all: no install, no `git add`, no formatter, no lockfile write. (The
project's own checks are still the project's own - a `go build` or a test that
calls a service may reach the network; that is the repository's business, not
this command's.)

Every check is spawned against a throwaway `NIGHTSHIFT_HOME` and
`CLAUDE_CONFIG_DIR`, created under the system temp directory and removed when the
command exits, so a check that itself runs `nightshift` never touches the
operator's home. That covers the checks `verify` spawns and nothing else: a
`nightshift` command typed by hand still needs its own throwaway home, which
`nightshift sandbox` provides.

The last check, `diff-hygiene`, needs no script. It reads `git status --short
--untracked-files=all` and `git diff --stat` in the current directory: the first
snippet line is the summary of `git diff --stat` (`no tracked file changed` when
there is none), the scale of the change, and the check is `FAILED` when a path
under `.claude/`, a lockfile or `tmp/` appears in the working tree, with the
intruding paths listed under the summary. Outside a git repository the check is
`SKIPPED`.

## Sandbox

```sh
nightshift sandbox node --version   # runs `node --version` against a throwaway home
```

`nightshift sandbox <command> [args...]` runs exactly one command with a
throwaway `NIGHTSHIFT_HOME` and `CLAUDE_CONFIG_DIR`, both created before the
command starts and removed once it exits, whatever the exit code — the same
isolation `verify` gives its own checks, offered for a `nightshift` command
typed by hand. The rest of the environment and the current directory are
inherited unchanged, and the command's own arguments are never parsed by
`nightshift`: everything after `sandbox` is forwarded verbatim, so a flag like
`--version` reaches the wrapped command instead of the CLI. Stdin, stdout and
stderr are inherited, and the exit code is the child's own — 128 plus the
signal number when the child was killed by one, or `127` with a message on
stderr when the command itself could not be spawned (for example, an unknown
binary).

## Libs

```sh
nightshift libs zod express        # the INSTALLED version of each name, one line each
```

`nightshift libs <name>...` prints one `<lib> <version>` line per argument, in
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
nightshift run --help                                      # the steps, one usage line each
nightshift run index-save <RUN_DIR>/02-explore.md          # persist an explore artifact into the project index
nightshift run index-save <artifact> --repo-root ~/code/api --project api
nightshift run secrets-sweep --files src/a.js,src/b.js     # log calls that may print a secret
```

`nightshift run <step>` holds the mechanical steps the pipeline's agents used to
perform by hand. It has exactly two steps, and `nightshift run` with no step (or
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

