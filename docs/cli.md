# CLI, configuration and doctor

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

The queue lives in `nightshift queue` (see [Queue](queue.md)); the scheduler that would
start it by itself lands in a future version, published as the npm package
`nightshift`, of which this plugin is the pipeline half.

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
and an `ok` when the app is not installed at all), each of the three hooks, the
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

The diagnosis is offline: without `--check-updates` it opens no network
connection at all. With the flag it adds one last check, `registry`, which asks
the registry for the newest published version and compares it with the installed
runtime. That check is never a `fail`: a registry that does not answer is a
`warn` carrying the message of npm, because a registry being down says nothing
about this host and must not turn a local diagnosis into a failing exit code.

