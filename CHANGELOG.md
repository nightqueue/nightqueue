# Changelog

Every notable change of this project is recorded here, newest first. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

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

- `npm run release:check` also refuses a working tree with uncommitted changes,
  before the version and the pack checks, because a publish ships what is on
  disk and not what is committed.

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
