# Install and update

One command installs everything; the rest is the daily flow, from anywhere, on a
machine that has nothing installed yet:

```sh
npx @nightqueue/nq init                       # install the runtime and set the host up
# then open a new terminal, or source your rc file, so `nightqueue` resolves
nightqueue doctor                                      # check the host and the home
nightqueue queue add "fix the flaky worker"            # queue one deliverable
nightqueue queue add "add the retry to the uploader"   # and the next one
nightqueue queue add api "rotate the webhook secrets"  # a job of another registered project
nightqueue queue run                                   # start the whole batch, detached, when you step away
```

The next morning, `nightqueue queue status` says what each job became and the
pull requests are waiting for review; `nightqueue queue run --watch` keeps a
runner picking up whatever you queue afterwards (see [Running the queue](queue.md#running-the-queue)).

**Run one job now.** `nightqueue queue add "fix the flaky worker" --run` queues
the request and starts the runner on that job right away, instead of leaving it
in the backlog, and `nightqueue queue log <id> --follow` watches that run as it
happens.

**A repository nobody registered yet.** Inside a git repository that is not a
registered project, `nightqueue queue add` asks one question — register it under
the basename of its root and queue the job — and does both in the same run.
`--yes` answers it for a script; with no terminal and no `--yes` the command
keeps failing as before, without registering anything.

`npx @nightqueue/nq init` is the whole installation. It puts the package
in `~/.nightqueue/runtime`, writes the shims `~/.nightqueue/bin/nightqueue`,
and `nq` (`--no-shortcuts` writes only `nightqueue`), offers to
put that directory on your PATH, registers the MCP server, the hooks and the
plugin **against the runtime**, and offers the semantic recall. Nothing depends
on where the command ran from: the npx cache and a development checkout both
converge on the same `~/.nightqueue/runtime`. The npm package is scoped,
`nightqueue`; the command it installs is still `nightqueue`.

Inside a repository it also registers that repository as a project and offers to
import the token of the GitHub CLI. Outside one it installs the host all the same
and closes by pointing at the single command that registers a project when you get
there: `nightqueue queue add "<task>"`, which offers to register it on the spot.
Either way the `Next steps` block says how to queue work from Claude Code, how to
start the batch and how to review it. A second `init` on an installed host prints
one line instead of the whole report; `--verbose` brings every step back.

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
that is running (see [Developing](developing.md)).

Every step of `init` the runtime cannot work without is fatal: a failed home,
runtime or shim exits 1, and the PATH block is only written once
`~/.nightqueue/bin/nightqueue --version` has answered. A step that only degrades
the experience - MCP server, hooks, plugin, semantic recall - is reported and the
command still exits 0, pointing at `nightqueue doctor`. The PATH block itself is
guarded, so sourcing your rc file again never prepends the directory twice:

```sh
# nightqueue
case ":$PATH:" in
  *":$HOME/.nightqueue/bin:"*) ;;
  *) export PATH="$HOME/.nightqueue/bin:$PATH" ;;
esac
# nightqueue end
```

The two marker lines delimit the block, and nothing between them is ours unless BOTH
are there: a `# nightqueue` you wrote for your own reason, followed by lines that happen
to look like ours, is never rewritten and never removed.

`nightqueue update` reinstalls the runtime from the registry at the newest
version, migrates the database with it, and re-points the host at it; config and
secrets stay untouched. `nightqueue update 0.2.0` asks the registry for that exact version
instead (a tag such as `next` works too), and `--from <dir|tgz>` installs a local
source instead of asking the registry at all (a directory gets its studio built
first when `studio/dist` is missing or stale: run `npm ci` there once, then
`nq update --from .`; see [Developing](developing.md)); a
version and `--from` together are a usage error, because they are two different
sources. The runtime line names both versions and the directory the new one was
installed into, as in `runtime: updated (v0.1.0 -> v0.2.0 at
~/.nightqueue/runtime/current -> ~/.nightqueue/runtime/versions/0.2.0-<stamp>)`.
`update` refuses while a runner is live, exactly as `setup` and `init` do. `update` is the
only command that reaches the registry to install, and a runtime it could not
reinstall is an exit code, never a quiet degraded line.

**The database schema changes only in `nightqueue update` and `nightqueue setup`.** No other
command, runner, MCP server or hook ever migrates the database: opening one written by an
older build is refused before a single byte is written, with

```
nightqueue: database at v20, this nightqueue expects v22: run `nightqueue update` (~/.nightqueue/nightqueue.db); when the installed nightqueue is already current, a second `nightqueue update` finishes the migration
```

The MCP tools answer `store-unavailable` with code `SCHEMA_OUTDATED` and that message, the
SessionStart hook prints its one warning line naming `nightqueue update`, a runner refuses to
start (and is never registered), and `nightqueue doctor` warns `schema v20, this nightqueue
expects v22` with the hint `run nightqueue update`. A database newer than the build is refused
as before.

After installing the runtime, `update` (and `setup`) runs the migration with the runtime it
just installed - a child `nightqueue update --schema-only` born from it, since only that build
knows the target schema - under the home lock the parent holds. The step prints one line:
`database schema: ok (v20 -> v22 (backup at ~/.nightqueue/nightqueue.db.pre-v22))`, `ok (v22
(current))` or `ok (no database yet)`. Before it writes anything it refuses, naming each one,
while:

- a runner or a close process is registered under `$NIGHTQUEUE_HOME/runners/` (`pid <n>`);
- a job holds a live lease (`J-<n> (live lease)`);
- a close holds a live close lease, in flight or the post-close hold of a closed job
  (`close J-<n> (live close lease)`).

The refusal exits `1` and ends `nothing was written`; stop the runners (`nightqueue queue run
--stop`), wait for the close, and run `nightqueue update` again. `--force` never bypasses it: it
only lets the runtime be swapped under a live runner. A job left `running` with an expired lease
(a runner that crashed) does not block it: it is named in a `warning:` line and the first runner
after the migration recovers it. When nothing blocks it, the migration copies the database
(write-ahead log included, through `VACUUM INTO`) to `nightqueue.db.pre-v<N>` first - beside an
earlier copy with a timestamp suffix, never over it - then migrates. A database file that is
not readable SQLite is left as it is for `nightqueue doctor --db`, so it never blocks the
install that may repair it. A step that migrated prints one more line asking to restart every
MCP client, so no server started by the old build keeps a connection to the migrated file. The
home lock records the pid that holds it, so however long the migration takes, no other command
treats the lock as abandoned while that process is alive.

**Upgrading from 0.5.x or earlier takes two updates, once.** The first `nightqueue update` runs
the update of the OLD build, which installs the new runtime but does not know the schema step;
every command then refuses with the message above. A second `nightqueue update` (or one
`nightqueue setup`) runs the new build's update, which migrates the database.

`nightqueue init` is `nightqueue setup` plus the project registration, always in that
order: every step below first, then the repository of the current directory (or
of `[path]`), then the token of the GitHub CLI. Running it again changes
nothing and says so in one line, `host already installed (v<version>) - nothing to
do`, followed by the registration line and the `Next steps` block; `--verbose`
prints every step as before. A semantic recall you turned down once is recorded in
`config.json` and never asked about again — `nightqueue embed install` (or
`init --embedding`) still installs it whenever you change your mind.

**The token of the GitHub CLI.** When `gh` is installed and authenticated and
the `github` slot of the org is still free, `nightqueue init` on a terminal asks
`GitHub CLI is authenticated as <login> — import its token as connection "gh"?
[Y/n]`. A yes reads `gh auth token`, stores it in `secrets.json` (`0600`), binds
it to the org and checks it against the API; the value never goes through argv,
stdout or stderr. `--gh` imports without asking, `--no-gh` never even calls the
binary, and without a terminal nothing is asked - only a line pointing at
`nightqueue init --gh`. A slot already taken, a connection already named `gh`, a
missing `gh` or one that is logged out all cost a single line and never an
error; the manual path stays open:

```sh
echo "$GITHUB_TOKEN" | nightqueue connection add gh --type github
```

`NIGHTQUEUE_GH_BIN` chooses which `gh` binary the import calls.

Restart Claude Code and the pipeline answers as `/nightqueue:resolve`. To check
the result of all of it at any point, run `nightqueue doctor`.

**The manual flow**, still supported one step at a time, on top of a global
install (`npm install -g @nightqueue/nq`) or a clone (`npm install` plus
`npm link`):

```sh
nightqueue setup                                   # install the runtime and register everything in the host
nightqueue init                                    # register this repository as a project
echo "$GITHUB_TOKEN" | nightqueue connection add gh --type github
```

`nightqueue setup` is idempotent and prints the state of every step (`created`,
`already present` or `updated`), in this order:

1. the configuration home (`0700`), `config.json` and `secrets.json` (`0600`).
2. the runtime in `$NIGHTQUEUE_HOME/runtime`, at the version of the package that
   ran the command; already at that version means no reinstall.
3. the shims `$NIGHTQUEUE_HOME/bin/nightqueue` and `nq` (`0755`
   each), plus the offer to add that directory to the PATH through a guarded
   block marked `# nightqueue` in `~/.zshrc`, `~/.bashrc` or
   `~/.config/fish/config.fish`.
4. the MCP server `nightqueue` at **user** scope, started as
   `node $NIGHTQUEUE_HOME/runtime/current/node_modules/nightqueue/bin/nightqueue.mjs mcp`
   - through the `current` link, so an install of a new version never rewrites it.
5. the same server in the configuration of the Claude Desktop app
   (`claude_desktop_config.json`), when that app is installed - an app that is
   not installed is a `skipped` step and never a directory this CLI creates.
   `--no-desktop` skips it.
6. the four hooks in `<claude config>/settings.json`: `SessionStart`,
   `UserPromptSubmit`, `SessionEnd` and `PreToolUse`, pointing at that same entry.
7. the runtime as a local marketplace, plus the plugin installed from it.
8. the semantic recall: the embedding library in `$NIGHTQUEUE_HOME/embedding`
   and its weights - the only step that opens the network, and the only one
   that is opt-in.

Steps 4 to 7 never run when step 2 could not finish: a hook pointing at a
runtime that is not there would break every session of the host.

`--remove` undoes steps 3 to 7 - the shims, the marked PATH block, the MCP server,
its entry in the Claude Desktop configuration,
the four hook entries, the plugin and the marketplace - and asks before
deleting `runtime/` and `embedding/`. It never touches `config.json`,
`secrets.json` or the database; only `--remove --purge` deletes
`$NIGHTQUEUE_HOME` whole.

**Coexistence with hooks of other tools.** The merge into `settings.json` is not
destructive: every entry that is not this package's is left as it is, matcher
included, and events nightqueue does not use are never even read. The file is
backed up as `settings.json.bak-<timestamp>` before the first change of a run,
and a run that has nothing to change does not rewrite the file at all - so a
second `nightqueue setup` leaves it byte for byte identical. A `settings.json` that
is not valid JSON stops the step with an error instead of being overwritten.

The hooks are registered at user scope, so they run in **every** Claude Code
session of the machine - but the two that inject context produce no output at
all outside a directory registered with `nightqueue init`. The exception is
`SessionEnd`, the reflection, which spends tokens on any session it sees: not
registering it, or `NIGHTQUEUE_REFLECT=1`, turns it off (see [Memory](memory.md)).

If the `claude` CLI is missing or one of its subcommands fails, the setup does
not stop: it prints the step as `failed`, prints the exact command to run by
hand, finishes the remaining steps and points at `nightqueue doctor`. The hooks are
plain file writes, so they land even with no `claude` at all.

`CLAUDE_CONFIG_DIR` is honored everywhere, so a throwaway host is one variable
away. `NIGHTQUEUE_CLAUDE_BIN` chooses which `claude` binary the setup and the
diagnosis call.

**Upgrading from the `shift` command.** The CLI used to be called `shift`. Run
`nightqueue setup` again: it re-points the hooks and the MCP server at
`bin/nightqueue.mjs` without duplicating any entry, writes the two new shims
and removes the old `~/.nightqueue/bin/shift`. A file of another tool sitting
under that name is kept, and `nightqueue doctor` says so instead of deleting it.

### Using nightqueue from Claude

With the MCP server registered, Claude drives the same backlog from inside a
session: ask it to queue the tasks as they come up, and to start the batch later
with `queue_run`. Claude does not start a job the moment it queues it - it waits
for the batch - unless you ask for that one job now. What each job became comes
back through `queue_status`, and a job stopped at a gate is answered with
`queue_retry`. In Claude Code, `/nightqueue:queue` is the shortcut for that
first step: it turns the plan under discussion into one job and records it.

`nightqueue setup` registers the same server in `claude_desktop_config.json`,
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

You find out that a new version exists without asking for it. `nightqueue queue
status` and the context block the session hook injects at the start of a Claude
Code session inside a registered project close with a single line whenever the
registry has something newer than the runtime you have installed:

```
nightqueue 0.2.0 is available (installed 0.1.0) - run `nightqueue update`
```

That line is passive and cheap. The registry is asked at most once every 24
hours; the answer is cached in `$NIGHTQUEUE_HOME/update-check.json` as
`{ "checkedAt", "latest" }` and every invocation in between reads that file
instead of the network. The request has a three second timeout and the whole
check is fail-open: a registry that does not answer, a reply that is not a
version or a cache that cannot be read never breaks the command and never prints
anything - the line simply does not appear. `--json` output never carries it,
and neither does a job the runner spawned, because an unattended session has
nobody to read a notice. `nightqueue doctor --check-updates` asks the same
question on demand (see [Doctor](cli.md#doctor)).

`nightqueue update` is how you take the new version (see [Install](install.md) for what it
reinstalls). It refuses while the queue is working:

```
nightqueue: a job is running - update after it finishes, or stop the runner first (nightqueue queue run --stop)
```

The refusal exits `1` and has two causes: a job holding a live lease, or any runner
registered under `$NIGHTQUEUE_HOME/runners/`. A job left behind by a crash
does not count - its lease is dead, so it never blocks the command that repairs
the installation. `nightqueue update --force` overrides both, for when you know
the state of the machine better than the registry does - for the runtime swap only: the
database migration that follows still refuses while anything uses the home (see above).

`NIGHTQUEUE_NO_UPDATE_CHECK=1` turns the check off entirely: no cache read, no
request, no line, on every surface.

**After an update that bumps the tool contract, restart the clients.** The MCP tools have a
contract number (`nightqueue doctor` shows it as `tool contract`, and every MCP answer carries
it as `contract`). It goes up when a tool's input changes incompatibly - contract 2 is the one
where issues and decisions are named by ref (`NQ-12`, `D-7`) instead of an internal id, and
contract 3 the one where the tracker tools are named `issue_*` and `queue_add` takes `issue_id`,
and contract 4 the one where the tracker is removed.
A client keeps the tool definitions it read when it connected, so after such an update reopen
the ones still running: Claude Code sessions (start a new one), Claude Desktop and Cowork
conversations (open a new conversation, or restart the app), and a running `nq open`. Until
then an old client is answered `your client has the tool definitions of an older nightqueue`,
or, during the grace release, its old ids are accepted with a `deprecated_input` warning and
`queue_status` adds the advisory `this client's tool contract is older than the server`.

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

The plugin loads that way, but `/nightqueue:resolve` stops at the Phase 0 preflight until an
MCP server named `nightqueue` is connected. `nightqueue mcp` is that server: it speaks the protocol
over stdio and exposes those six tools plus the five of the queue, and `nightqueue setup` is what
registers it.

