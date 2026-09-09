# Changelog

Every notable change of this project is recorded here, newest first. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/maykonVinicius/nightshift/releases/tag/v0.1.0
