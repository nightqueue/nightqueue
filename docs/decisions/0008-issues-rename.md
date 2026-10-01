# 0008 - The tracker is named issues, with no roadmap alias

Status: Accepted (2026-10-01).

## Context

The tracker nightqueue keeps per project and per org is a list of typed items (`bug`, `feature`, `improvement`, `chore`, `incident`) with a status workflow (`backlog` to `done`), a priority, an append-only comment thread and a ref (`NQ-12`). It was named "roadmap", which tells a reader it holds dated plans, and it maps onto neither GitHub Issues nor Linear, the two trackers its users already know. The name also leaked into every layer: the CLI (`nightqueue roadmap`, `queue add --roadmap`), the MCP tools (`roadmap_*`, `roadmap_item_id`), the prompts (`## Roadmap item`) and the schema (`roadmap_items`, `roadmap_comments`, `roadmap_item_projects`).

## Decision

Rename the tracker to issues everywhere, as a hard rename with no alias:

- CLI: `nightqueue issues [show <ref>]` and `queue add --issue <ref>`.
- MCP: `issue_get`, `issue_save`, `issue_update`, `issue_search`, `issue_comment`; `queue_add` takes `issue_id` and answers `issueId` / `issue_ref`. The tool contract goes to 3.
- Prompts: a job queued from an issue gets `## Issue` with `Issue: <ref>`; the triager's context gets `## Related issues`.
- Schema v22: a one-shot migration of a v20 or v21 database (the v21 columns untouched) copies the three tables into `issues`, `issue_projects` and `issue_comments` (with `issues_fts` and `issue_comments_fts`), keeps every row, counter and delete rule, leaves a `nightqueue.db.pre-v22` copy and refuses while a runner holds a live lease or a row points at a missing row.
- Unchanged: refs (`<KEY>-<n>`), the `item_id` columns, the `itemRef` key of `state.json`, the `items` key of a listing and the text already stored in prompts, comments and notices.

Only the migration modules and the tests that build a pre-v22 database keep the old word; `test/issues-name-boundary.test.mjs` pins them by count.

## Consequences

MCP clients must be restarted after the upgrade: a client that cached the contract-2 definitions gets "tool not found" for a `roadmap_*` tool, and a `queue_add` still carrying `roadmap_item_id` is refused with the stale-contract line, never queued without its issue. Scripts that call `nightqueue roadmap` or `--roadmap` break and must be updated. A 0.5.0 process refuses a v22 database by its own newer-schema check. Decisions D-6, D-44 and D-46 still use the old vocabulary; rewording them means superseding them, which is left to the operator.
