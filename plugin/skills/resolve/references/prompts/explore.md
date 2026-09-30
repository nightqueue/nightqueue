## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/02-explore.md
Read before acting (via Read): none.
Return summary (≤10 lines, per the handoff contract of step 5.2): status + artifact path +
"index saved: N files" (or the reason for not having saved it) + open items.

Find the files related to: {{AFFECTED_AREA}}
Task objective: {{OBJECTIVE}}

{{#INDEX_MAP}}
Already known map of the project (index from earlier runs):
{{INDEX_MAP}}
Already known libs: {{INDEX_LIBS}}
Do NOT rediscover the fresh files of the map — trust them and complement only what
is missing for this area. Revalidate ONLY the ones marked REVALIDATE (they changed or
disappeared since the indexing). Fix the responsibilities that are wrong.

{{/INDEX_MAP}}
The index is persisted by the runtime from your artifact (`nightqueue run index-save`); these two lines only name where it lands:
project: {{PROJECT}}
repo_root: {{REPOSITORY}}

{{>_context}}
Produce also the `## Access map` of the target code (max 3 hops, each consumer walked up to
a terminal) and the `unimplemented intent: <param> · governs <scope | filter |
auth | other>` lines for every parameter/field/flag read and not used in a decision. The cap of
30 files includes the files of the map.

{{>_shell-rule}}

{{#NOTE}}
Relaunch note:
{{NOTE}}

{{/NOTE}}
Limit: at most 30 relevant files.
