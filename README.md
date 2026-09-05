# nightshift

Autonomous queue of coding agents with its own memory.

## What it is

nightshift turns a coding request into a full pipeline run instead of a chat
session: the request is triaged against real evidence, explored, planned,
implemented, attacked by an adversarial QA and only then verified against the
checks the project itself defines. Every phase hands off through a file
artifact, so a run can be inspected, resumed and audited after the fact.

The long-term product is a queue that runs those pipelines unattended, on top
of a memory of its own — lessons, project decisions and structural indexes that
survive between runs and make each run cheaper than the last.

## Status — v0

There is **no** working runtime in this repository: the `shift` CLI ships
configuration commands only (see `## Configuration`); there is still no
database, no queue, no hooks and no scheduler. The other functional thing that
ships today is the Claude Code plugin in `plugin/`; everything else at the
root — `package.json`, `LICENSE` — is packaging around them.
Everything the plugin needs from a runtime is described as a contract (see
`## Runtime contract`), not as code you can run from here.

## What ships today

- `/nightshift:resolve` — the 8-phase pipeline (triage, exploration,
  architecture, implementation, adversarial QA, verification, runtime
  validation, commit and report).
- `/nightshift:qa-guardian` — self-contained adversarial QA: risk matrix,
  proven breaks, fuzz templates.
- Six subagents, invoked as `nightshift:<agent>`: `architect`, `coder`,
  `explore`, `qa-guardian`, `triager`, `verifier`.

## Requirements

- Claude Code.
- An MCP server named `nightshift`, exposing `lesson_recall`, `lesson_save`, `memory_recall`,
  `index_save`, `index_recall` and `pipeline_log`. All six are hard requirements: there is no
  memoryless mode — Phase 0 opens with a preflight call to `lesson_recall` and the run stops
  right there when the host does not expose it.

An **empty** memory is not a problem: on a fresh install every recall comes back empty, and an
empty recall only makes the phase drop the corresponding section and move on with what it
already has. A memory **write** that fails is recorded as an open item in the artifact or in
the report, and the run continues — that covers `index_save` and `pipeline_log`, and also
`lesson_save`, which the Phase 0 critique gate calls when it avoided a wrong execution. What
stops a run is the server being **absent**, never it being empty.

## Try it

```
claude --plugin-dir ./plugin
```

The plugin loads that way, but `/nightshift:resolve` stops at the Phase 0 preflight until an
MCP server named `nightshift` is connected. That runtime is not distributed yet — it lands in
a future version.

## The `shift` CLI

`bin/shift.mjs` is the configuration CLI: it manages orgs, projects and the
connections (and their secrets) that a future runtime will consume. It has no
dependency beyond Node >= 20.

- `shift --help` lists every command: `setup`, `init`, `org`, `project` and
  `connection`.
- Exit codes: `0` ok, `1` user error (a single line on stderr), `2` unexpected
  error (a stack on stderr).
- Every `list` accepts `--json`; on `--json`, stdout is either valid JSON or
  empty, because warnings and errors always go to stderr.

The rest of the runtime — queue, memory MCP server, hooks — does not exist yet
and lands in a future version, published as the npm package `nightshift`, of
which this plugin is the pipeline half.

## Configuration

`NIGHTSHIFT_HOME` (default `~/.nightshift`) is a single directory that holds
both the configuration at its root and the run artifacts under `runs/` (see
`## Runtime contract`) — one home, two kinds of content, not two environment
variables:

```
$NIGHTSHIFT_HOME/          # 0700
  config.json              # orgs, projects, queue settings
  secrets.json             # 0600, connection secrets
  runs/<project>/<slug>/   # run artifacts, written by the runtime
```

Secrets are kept in a `0600` file rather than in the operating system
credential store, because the runtime is meant to run unattended, with nobody
there to unlock anything.

A command that writes holds the directory `$NIGHTSHIFT_HOME.lock` while it
runs, so two `shift` processes never overwrite each other's changes; read-only
commands such as `list` never take it.

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
never printed back — not by `list`, not by `--json`, not by an error message.

A path that starts with `-` has to come after `--` (`shift init -- -weird-dir`),
otherwise it is parsed as an unknown option and rejected.

## Runtime contract

What a runtime has to provide, and what it can rely on:

- `NIGHTSHIFT_HOME` — home directory of the runtime, default `~/.nightshift`.
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

## License

Business Source License 1.1. Change Date 2029-09-04, Change License
Apache License, Version 2.0. See `LICENSE`.

**Project note, not part of the license text:** this BSL 1.1 text and its
parameters have not been through legal review yet. That review is pending and
has to happen before the first `npm publish` of this package.
