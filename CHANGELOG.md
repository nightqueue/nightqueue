# Changelog

Every notable change of this project is recorded here, newest first. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Org-scoped decisions and roadmap: a decision or a roadmap item now belongs to
  exactly one owner - a project or an org - and is numbered inside it (`#7` per
  project, `acme#3` per org, enforced by the database). A write names `project` or
  `org`, never both; a read by `project` answers the project's rows PLUS its
  org's, org rows first and each carrying its `scope` and its `owner`, while a
  read by `org` answers that org's rows alone and no other org's. Phase 0 of
  `/resolve` injects both levels in the same single `decision_recall`,
  `nightshift decision list --org <name>`, `nightshift decision show <number>
  --org <name>` and `nightshift roadmap --org <name>` read an org from the
  terminal, and `nightshift org rename` carries the rows of the org with it while
  `org remove` refuses an org that still owns any. An org roadmap item becomes a
  job with an explicit `--project <name>` (`project` in `queue_add`) of that org,
  or the project of the current directory: it stays `open` and unlinked, so the
  same item is queued for every project of the org and only the operator closes
  it. The schema migrates by itself to v6 - every existing row reads as
  `scope='project'` and keeps its number, with no manual step.
- Versioned runtime: an install writes a new
  `~/.nightshift/runtime/versions/<version>-<stamp>/` and publishes it by
  renaming a symlink onto `~/.nightshift/runtime/current`, in one step, so no
  instant leaves the host without a runtime and a failed install never touches
  the link. The shims, the MCP server, the hooks, the Claude Desktop entry and
  the plugin marketplace all resolve through `current`, a process that is
  already running keeps executing the directory it loaded from, and the last two
  version directories are kept - never the one `current` names, never the one a
  live runner recorded. `doctor` reports the installed version and the directory
  it resolves to, and an installation still at the old
  `runtime/node_modules/` layout keeps working and is never deleted by an
  install. The decision is recorded in
  `docs/decisions/0003-versioned-runtime-single-runner.md`.
- A terminal write is now durable, verified and witnessed: the transaction of a
  finish commits with `PRAGMA synchronous = FULL`, a fresh read-only connection
  reads the three terminal columns back, a mismatch is reported as `finish
  verification failed` in the log of the job and on stderr and retried once, and
  the write-ahead log is checkpointed afterwards. The same shape guards the
  `pipeline_log` insert. The runner then writes `terminal { status, prUrl,
  finishedAt, writtenBy, pid }` into the `state.json` of the run, and
  `nightshift queue status`, every runner cycle and the MCP `queue_status`
  restore any job whose row still says `running` or `pending` while that witness
  says how it ended, marking the result `repairedFrom: "state.json"`. A job
  under a live lease is never touched, and a retry clears the witness so the
  previous attempt can never close the next one.
- A runner records the version directory it loaded from, and watches it: when
  that tree disappears it warns once, finishes the job it is running and exits
  without claiming another. `queue status` and `doctor` name the runtime of the
  live runner.
- A terminal `merged` status for the queue: a job that delivered a pull request
  is checked with `gh pr view` and becomes `⇡ merged` once that pull request is
  merged, carrying the instant of the merge in `merged_at` and the commit in
  `merge_sha`, both in `queue status <id>` and in `--json`; a closed or open
  pull request only updates `pr_checked_at` and the job stays `done`. The check
  runs at the start of `queue status` (every `--follow` tick included), of every
  runner cycle and of the MCP `queue_status`, over at most ten jobs and at most
  once per job every five minutes, never inside an unattended job session and
  never in a hook. It fails open and in silence - with `gh` missing, logged out
  or offline nothing is written, nothing is printed and the command still exits
  `0` - and `NIGHTSHIFT_NO_PR_CHECK=1` switches it off. `queue cancel` and
  `queue retry` refuse a `merged` job, and `queue retry` still accepts only
  `failed`, `cancelled` and `gate`.

- The operator sets the risk tier of a job, and the pipeline runs the track of
  that tier: `nightshift queue add --tier trivial|simple|complex` and the `tier`
  parameter of `queue_add` store it in a new nullable column of `jobs` (one
  migration, schema v5), `nightshift queue status <id>` and the `--json` of the
  list and the detail show it, and the unattended prompt carries the line
  `Tier: <tier> (set by the operator - the pipeline may only raise it, with
  evidence, never lower it)` into the run. The `/nightshift:queue` skill proposes
  a tier, names it in the single confirmation it already asks and lets the user
  override it in that same answer. `/resolve` gained three tracks: `trivial`
  (coder plus a verifier on tsc, lint and the tests of the touched files, under 5
  minutes), `simple` (a triager only when the request is a bug, then a coder and
  a verifier on the FULL test suite, under 15 minutes, with no architect and no
  qa-guardian) and `complex` (the whole pipeline, unchanged). The mandatory
  escalation to `complex` whenever a fix changed a condition is gone: a tier is
  raised only on evidence found, never on the shape of the change, and the raise
  is written into the Brief as `Tier raised: <from> -> <to>: <evidence>`. An
  operator tier is never lowered. `pipeline_log` records `tier_operator` and
  `tier_raise_reason` next to the final `tier`, so a raised run is the runs whose
  two tiers differ, with the evidence beside them.

- Decisions and roadmap, per project and private to the home: a numbered
  decisions log (context, decision, consequences and a status among `proposed`,
  `accepted`, `superseded` and `rejected`) and a `now`/`next`/`later` roadmap,
  both reachable through seven new MCP tools and never written into the
  repository. `queue_add` with `roadmap_item_id`, and its CLI twin
  `nightshift queue add --roadmap <id>`, build the job prompt from a roadmap
  item, its linked decision and the accepted decisions around it instead of
  asking for it again, mark the item `queued` and close it as `done` when the
  job finishes. `/resolve` recalls the accepted decisions as the
  `## Standing decisions` of its Brief, passes them to the architect as binding
  constraints, and records the decision a plan takes as `proposed` for the
  operator to accept on the pull request. Three read-only commands print all of
  it in a terminal: `nightshift decision list`,
  `nightshift decision show <number>` and `nightshift roadmap`, each resolving
  the project from the current directory when `--project` is omitted, opening
  the database read-only - they never create it, and a home where nothing was
  saved reads as an empty one. Inside an unattended run, `decision_update` and
  `roadmap_update` only accept ids of the project of the job that is running,
  and the operator text a roadmap prompt carries is escaped, so it can never
  forge one of the prompt's headings nor a literal of the runtime contract.
- Release by tag: pushing a `v*` tag publishes the package to npm with
  provenance, through OIDC trusted publishing and without any npm token in the
  repository, and opens the GitHub Release of that tag with the CHANGELOG
  section of the version. A second workflow runs the suite on Node 22 and Node
  24 for every pull request and every push to `main`, and `docs/RELEASING.md`
  documents the flow plus the one-time trusted publisher setup on npmjs.com.
- Passive update notice: `nightshift queue status` and the session-start context
  block close with one line when a newer version is published. The registry is
  asked at most once every 24 hours and the answer is cached in
  `$NIGHTSHIFT_HOME/update-check.json`; the check is fail-open, so a registry
  that does not answer costs nothing and prints nothing. `--json` output and
  unattended jobs never carry the line, and `NIGHTSHIFT_NO_UPDATE_CHECK=1` turns
  the check off entirely.
- `nightshift update` refuses while a job holds a live lease or a watcher is
  registered, pointing at `nightshift queue run --stop`; a job left behind by a
  crash never blocks it, and `--force` overrides both refusals.

### Changed

- Any number of runners now work the queue together. A runner registers as
  `~/.nightshift/runners/<pid>.json`, one file per live process, carrying `pid`,
  `startedAt`, `mode`, `jobId`, `intervalS`, `detached`, `logPath`, `runtimeDir`
  and `uptimeS`; no start is ever refused because another runner is live.
  `queue status` prints one `runner:` line per live runner and prunes the
  registrations no process answers for, `doctor` reports one row per runner with
  its own runtime, `queue run --stop` ends every registered runner (one report
  line each, one shared ten-second timeout) and `queue run --stop <pid>` ends
  exactly one, and `setup`, `setup --from`, `update` and `init` refuse while ANY
  registration is alive, naming every live pid. A single-job start that could not
  claim its job now answers `job #N waiting: concurrency cap reached` and spawns
  nothing, instead of reporting a runner that would claim nothing; a drain start
  on a paused queue says so; a watcher always starts. A `runner.pid` left by a
  previous version is adopted read-only until it is stopped or pruned. A
  registry directory that cannot be LISTED - a permission, a mount failure - is
  never read as a home without runners: it is its own `unreadable` entry, so the
  install refuses (`--force` still goes through), the prune of the old runtime
  versions deletes nothing, `doctor` warns naming the directory, `queue status`
  opens with `runner: unknown`, and `queue status --json` and the MCP
  `queue_status` refuse instead of answering that nothing runs. The
  decision is recorded in
  `docs/decisions/0004-parallel-runners-registry.md`.
- Two jobs of the same project may now run at the same time: the claim no longer
  filters by project, so the only limits are the atomic claim of one job and
  `queue.maxConcurrent` - which also means the whole ceiling may be spent on one
  repository, and that merge conflicts between the pull requests of two jobs of
  one project are the operator's to resolve. The clean-canonical-checkout
  preflight stays: in a project that does not ignore the directory the pipeline
  creates its worktree in, the second same-project job is blocked with
  `dirty-checkout`, keeps its attempt and is retried by the drain until the first
  one finishes. The `project-busy` claim reason is gone.
- A drain that meets the concurrency ceiling now waits 15 s and passes again
  instead of exiting: the set of reasons it waits on named `concurrency-cap`, a
  string the claim never produces, and now names `cap-reached`.
- The refusal `nightshift update` already had is now shared by `nightshift
  setup`, `setup --from` and `nightshift init`: while a runner is registered
  alive or a job holds a live lease, all four exit 1 with `a runner is active
  (pid P / job #N) - the runtime cannot be replaced while it runs; stop it with
  nightshift queue run --stop or wait for the queue to drain` and install
  nothing. `--force` installs anyway and warns on stderr, naming the tree it is
  replacing.
- One runner owns the queue. Every start path - `queue run`, `--watch`,
  `--job`, `queue add --run`, `queue retry --run`, their `--foreground` forms
  and the `queue_run` and `queue_retry` MCP tools - passes the same guard, under
  the home lock and in the same critical section as the registration, so two
  starts a few milliseconds apart can never both win. A start refused because a
  runner is live now answers `runner already active (pid <pid>, <mode>) - it
  will pick the job up` and exits 0, spawning nothing and leaving the job
  pending; a second watcher used to exit 1 and every other path used to spawn
  unconditionally. The process that starts a runner is the one that registers
  it, so `runner.pid` exists as soon as the command returns, for `watch`,
  `drain` and `once` alike - which also means `queue status`, `doctor` and
  `queue run --stop` now see all three.
- `npm run release:check` also refuses a working tree with uncommitted changes,
  before the version and the pack checks, because a publish ships what is on
  disk and not what is committed.

### Deprecated

- The singular `runner` key of `nightshift queue status --json` and of the MCP
  `queue_status` answer. It is now the first entry of `runners` (and the same
  all-null object as before when no runner is live), kept for one release and
  removed in the next minor - read `runners`. `runnerAnswer.runner`, which
  describes the runner a `queue_run` or `queue_retry` call itself started, is not
  part of this deprecation and stays.

## 0.1.0 - 2026-09-09

First public release.

### Added

- Unattended queue (`nightshift queue`): enqueue a request, run it through
  `/nightshift:resolve` and get a pull request back. The runner starts detached
  by default, `--foreground` keeps it in the terminal, `queue run --watch`
  registers a pidfile and `queue run --stop` ends it. `queue retry` sends a
  gated, failed or cancelled job back to the queue, and `queue log --follow`
  narrates a run while it happens.
- Hybrid memory on `node:sqlite`: BM25 keyword recall always, semantic recall
  once the opt-in embedding library is installed into its own prefix, plus the
  lessons, the memories, the repository index and the pipeline log.
- MCP server (`nightshift mcp`): the eleven stdio tools of the memory and of the
  queue, over the official SDK.
- Claude Code plugin: the `/nightshift:resolve` pipeline, `/nightshift:qa-guardian`
  and the six subagents, distributed through the marketplace of this package.
- Configuration CLI: `nightshift init` and `nightshift setup` install the runtime
  into `~/.nightshift` and register the MCP server, the three hooks and the
  plugin in the host, idempotently and reversibly; `nightshift update` reinstalls
  the runtime from the registry; `nightshift doctor` diagnoses the host and the
  home without ever writing to them, and asks the registry for the newest
  published version only behind `--check-updates`.
- Orgs, projects and connections: named scopes for the memory and for the queue,
  with the secrets kept in a file only the owner can read.
- Published to npm as `@maykonv/nightshift`; the command it installs is `nightshift`.

[0.1.0]: https://github.com/maykonVinicius/nightshift/releases/tag/v0.1.0
