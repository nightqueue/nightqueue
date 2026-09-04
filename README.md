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

There is **no** working runtime in this repository: the `shift` CLI is a
placeholder that only prints an error (see the section on it below), and there
is no database, no queue, no hooks and no scheduler. The only functional thing
that ships today is the Claude Code plugin in `plugin/`; everything else at the
root — `package.json`, `LICENSE`, `bin/shift.mjs` — is packaging around it.
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

- Claude Code — the only hard requirement.
- Recommended: an MCP server named `harness-memory`, exposing `lesson_recall`,
  `memory_recall`, `index_save`, `index_recall`, `progress_update` and
  `pipeline_log`.
- Optional: the Context7 MCP server (used by the architect to read third-party
  library docs).

`harness-memory` is what makes a run cheaper than the last one, but **no phase
aborts without it**. A memory read that fails, is unavailable or comes back
empty is treated as "nothing relevant": the phase drops the corresponding
section and moves on with what it already has. A memory write that fails
(`index_save`, `pipeline_log`, the vault entry) is recorded as an open item in
the artifact or the report, and the run continues.

So without that MCP server the pipeline still runs end to end, only memoryless:
no lessons injected per phase, no structural index reused, no project memory
recalled and no run telemetry persisted. Every run then starts from zero and
leaves nothing behind for the next one.

## Try it

```
claude --plugin-dir ./plugin
```

## The `shift` CLI

`bin/shift.mjs` is a placeholder — it prints `not implemented yet` and exits
with code 1. The runtime (queue, memory MCP server, hooks) lands in a future
version and will be published as the npm package `nightshift`, of which this
plugin is the pipeline half.

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
