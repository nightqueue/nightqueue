# nightqueue

**An autonomous queue of coding agents with its own memory.**

[![npm](https://img.shields.io/npm/v/%40nightqueue%2Fnq?label=npm)](https://www.npmjs.com/package/@nightqueue/nq)
[![ci](https://github.com/nightqueue/nightqueue/actions/workflows/ci.yml/badge.svg)](https://github.com/nightqueue/nightqueue/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/%40nightqueue%2Fnq)](package.json)
[![license: BUSL-1.1](https://img.shields.io/badge/license-BUSL--1.1-blue)](LICENSE)

Queue the work during the day. Start the batch when you step away. Come back to
pull requests — and to an agent that remembers what it learned last night.

<p>
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/install.md">Install</a> ·
  <a href="docs/queue.md">Queue</a> ·
  <a href="docs/memory.md">Memory</a> ·
  <a href="docs/cli.md">CLI</a> ·
  <a href="docs/runtime-contract.md">Runtime contract</a> ·
  <a href="docs/developing.md">Developing</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

## What it is

nightqueue turns a coding request into a full pipeline run instead of a chat
session. Every request is triaged against real evidence, explored, planned,
implemented, attacked by an adversarial QA and verified against the checks your
project already defines — then it opens the pull request. Every phase hands off
through a file, so a run can be inspected, resumed and audited after the fact.

It runs on **Claude Code**, with your own subscription, on your own machine.
Nothing leaves it.

## What it does

- **A backlog, not a chat.** `nightqueue queue add` records a deliverable;
  `nightqueue queue run` works through the whole backlog unattended and comes
  back with one pull request per job.
- **An 8-phase pipeline.** Triage, exploration, architecture, implementation,
  adversarial QA, verification, runtime validation, commit and report — each
  phase run by a dedicated agent, each one gated by the previous artifact.
- **A memory that compounds.** Lessons, project decisions and structural indexes
  survive between runs. The recall is hybrid (BM25 + optional local
  embeddings), scoped per project and per org, and every run makes the next one
  cheaper.
- **Human gates, not silent failures.** A job that needs a decision stops with a
  written notice; you answer it with one command and the job goes back to the
  queue.
- **Orgs and projects.** One home, many repositories, grouped by org, each with
  its own decisions log and roadmap.

## How a job runs

```
queue add ─▶ triage ─▶ explore ─▶ architect ─▶ implement ─▶ adversarial QA ─▶ verify ─▶ runtime check ─▶ commit + PR
                │                                                                                          │
                └── every phase writes an artifact the next one is gated on; a gate stops the job ────────┘
                    with a written notice, and `queue retry <id> --note` sends it back
```

Each phase is a dedicated subagent with its own instructions (`plugin/agents/`),
running inside a git worktree of your repository, in a job environment it cannot
leave. What it learns — lessons, decisions, structural indexes of the codebase —
is written to a local SQLite home and recalled by the next job through the
nightqueue MCP server. The full promise between the pipeline and the runner is
written down in [docs/runtime-contract.md](docs/runtime-contract.md).

## Why nightqueue

| | A chat session | nightqueue |
|---|---|---|
| Who drives | you, prompt by prompt | the pipeline, phase by phase |
| Memory | gone when the window closes | lessons and decisions persist per org |
| Quality gate | whatever you remember to ask | adversarial QA + your project's own checks, every run |
| Output | a diff in a terminal | a reviewable pull request with a report |
| When it runs | while you watch | while you sleep |

Free, local and yours. A hosted **Team** tier — one shared queue and memory per
org, runners on your team's machines — is planned; the local product stays
free and is never degraded to push it.

## Quick start

Requirements: [Claude Code](https://claude.com/claude-code) and Node >= 22.

```sh
npx @nightqueue/nq init                       # install the runtime and set Claude Code up
# open a new terminal so `nightqueue` (and its shortcut `nq`) resolves
nightqueue doctor                                      # check the host and the home

nightqueue queue add "fix the flaky worker"            # queue one deliverable
nightqueue queue add "add the retry to the uploader"   # and the next one
nightqueue queue run                                   # start the batch, detached, when you step away

nightqueue queue status                                # the next morning: what each job became
nightqueue queue retry 7 --note "rename the column"    # answer a gate and send the job back
```

Inside Claude Code, `/nightqueue:queue` turns the plan under discussion into a
job, and `/nightqueue:resolve <request>` runs the pipeline on the spot.

## Commands

The full reference is in [docs/cli.md](docs/cli.md); this is the daily set.

```sh
# queue
nightqueue queue add [project] "<request>" [--tier trivial|simple|complex] [--priority 1-9] [--run]
nightqueue queue run [--watch [s] [--from HH:MM] --until HH:MM] [--job <id>] [--stop]
nightqueue queue status [<id>] [--follow] [--json]
nightqueue queue log <id> [--follow]
nightqueue queue session <id> [--print]
nightqueue queue retry <id> --note "<answer>"
nightqueue queue cancel <id> --reason "<why>"
nightqueue queue close <id> [--force] [--foreground] [--decisions accept|reject|keep] [--json]
nightqueue queue close --merged [--decisions accept|reject|keep] [--json]
nightqueue queue pause | resume

# memory
nightqueue memory stats
nightqueue decision list | show <number>     [--project <name> | --org <name>]
nightqueue decision export <number> [--dir <path>] [--force]
nightqueue decision import <file.md> [--status <s>] [--superseded-by <n>] [--supersedes <n,...>] [--unrelated <n,...>]
nightqueue decision update <number> --status accepted|rejected|superseded [--superseded-by <n>]
nightqueue roadmap                            [--project <name> | --org <name>]

# home
nightqueue org add|list|rename|remove|repair
nightqueue project list|move|remove
nightqueue connection bind|test|list|remove
nightqueue doctor
nightqueue update [<version>]
```

**Writing a job.** One job is one self-contained deliverable that can be
reviewed and merged on its own. Large work is ONE job with numbered stages in
the prompt (`Stages: 1) ... 2) ...`), never several jobs that depend on each
other. See [Writing a job](docs/queue.md#writing-a-job).

**Closing a job.** A job ends `done` with an open pull request, and becomes `closed`
only when `nightqueue queue close <id>` merges that pull request through a recorded
pipeline - preflight, conflict, merge, settle - that resumes where it stopped.
`--force` skips the pull request checks and the rebase suite, never the job's status,
its attribution or a real conflict. A job you give up on is `queue cancel`-ed instead,
which also releases its worktree. See [Closing a job](docs/queue.md#closing-a-job).

**Running the queue overnight.** `nightqueue queue run --watch --from 22:00 --until
04:00` works the queue only inside that local time window, then exits - a
midnight-crossing window needs no special syntax. It is one-shot: nothing brings it
back once it closes, so a nightly schedule is an OS-level job (`launchd`, `systemd`)
you set up yourself. The machine is kept awake while a runner or a job needs it
(`queue.keepAwake`), but the display can still sleep - a closed lid with no external
display still stops the run, so keep it open. See [Running the
queue](docs/queue.md#running-the-queue).

## Status

nightqueue is pre-1.0 and used daily on real repositories. The CLI, the MCP tools
and the on-disk formats can still change between minor versions; every change a
user would notice is in [CHANGELOG.md](CHANGELOG.md), and a breaking one is
marked as such. Bugs and ideas go to the
[issues](https://github.com/nightqueue/nightqueue/issues); see
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and
[SECURITY.md](SECURITY.md) for anything a guard should have caught. Everyone here
follows the [code of conduct](CODE_OF_CONDUCT.md).

## Documentation

| | |
|---|---|
| [Install](docs/install.md) | `init`, what it sets up, updating, trying without installing |
| [Queue](docs/queue.md) | jobs, runners, tiers, gates, logs, writing a job |
| [Memory](docs/memory.md) | lessons, recall, decisions and roadmap, the MCP tools |
| [CLI](docs/cli.md) | every command, configuration, `doctor` |
| [Runtime contract](docs/runtime-contract.md) | what the pipeline and the runner promise each other |
| [Developing](docs/developing.md) | tests, releases, contributing |

## License

Business Source License 1.1 — use it in production, for any purpose, including
inside a company; do not offer it to third parties as a hosted service or a
competing product. On 2029-09-04 it becomes Apache 2.0. `LICENSE` is the text
that governs.
