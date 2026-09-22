# nightshift

**An autonomous queue of coding agents with its own memory.**

Queue the work during the day. Start the batch when you step away. Come back to
pull requests — and to an agent that remembers what it learned last night.

<p>
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/install.md">Install</a> ·
  <a href="docs/queue.md">Queue</a> ·
  <a href="docs/memory.md">Memory</a> ·
  <a href="docs/cli.md">CLI</a> ·
  <a href="docs/runtime-contract.md">Runtime contract</a> ·
  <a href="docs/developing.md">Developing</a>
</p>

---

## What it is

nightshift turns a coding request into a full pipeline run instead of a chat
session. Every request is triaged against real evidence, explored, planned,
implemented, attacked by an adversarial QA and verified against the checks your
project already defines — then it opens the pull request. Every phase hands off
through a file, so a run can be inspected, resumed and audited after the fact.

It runs on **Claude Code**, with your own subscription, on your own machine.
Nothing leaves it.

## What it does

- **A backlog, not a chat.** `nightshift queue add` records a deliverable;
  `nightshift queue run` works through the whole backlog unattended and comes
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

## Why nightshift

| | A chat session | nightshift |
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
npx @maykonv/nightshift init                           # install the runtime and set Claude Code up
# open a new terminal so `nightshift` resolves
nightshift doctor                                      # check the host and the home

nightshift queue add "fix the flaky worker"            # queue one deliverable
nightshift queue add "add the retry to the uploader"   # and the next one
nightshift queue run                                   # start the batch, detached, when you step away

nightshift queue status                                # the next morning: what each job became
nightshift queue retry 7 --note "rename the column"    # answer a gate and send the job back
```

Inside Claude Code, `/nightshift:queue` turns the plan under discussion into a
job, and `/nightshift:resolve <request>` runs the pipeline on the spot.

## Commands

The full reference is in [docs/cli.md](docs/cli.md); this is the daily set.

```sh
# queue
nightshift queue add [project] "<request>" [--tier trivial|simple|complex] [--priority 1-9] [--run]
nightshift queue run [--watch [s] [--from HH:MM] --until HH:MM] [--job <id>] [--stop]
nightshift queue status [<id>] [--follow] [--json]
nightshift queue log <id> [--follow]
nightshift queue session <id> [--print]
nightshift queue retry <id> --note "<answer>"
nightshift queue cancel <id> --reason "<why>"
nightshift queue close <id>... | --merged [--decisions accept|reject|keep]
nightshift queue ship <id> [--force] [--foreground] [--json]
nightshift queue pause | resume

# memory
nightshift memory stats
nightshift decision list | show <number>     [--project <name> | --org <name>]
nightshift decision export <number> [--dir <path>] [--force]
nightshift decision import <file.md> [--status <s>] [--superseded-by <n>] [--supersedes <n,...>] [--unrelated <n,...>]
nightshift decision update <number> --status accepted|rejected|superseded [--superseded-by <n>]
nightshift roadmap                            [--project <name> | --org <name>]

# home
nightshift org add|list|rename|remove|repair
nightshift project list|move|remove
nightshift connection bind|test|list|remove
nightshift doctor
nightshift update [<version>]
```

**Writing a job.** One job is one self-contained deliverable that can be
reviewed and merged on its own. Large work is ONE job with numbered stages in
the prompt (`Stages: 1) ... 2) ...`), never several jobs that depend on each
other. See [Writing a job](docs/queue.md#writing-a-job).

**Running the queue overnight.** `nightshift queue run --watch --from 22:00 --until
04:00` works the queue only inside that local time window, then exits - a
midnight-crossing window needs no special syntax. It is one-shot: nothing brings it
back once it closes, so a nightly schedule is an OS-level job (`launchd`, `systemd`)
you set up yourself. The machine is kept awake while a runner or a job needs it
(`queue.keepAwake`), but the display can still sleep - a closed lid with no external
display still stops the run, so keep it open. See [Running the
queue](docs/queue.md#running-the-queue).

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
