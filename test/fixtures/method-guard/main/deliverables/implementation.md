## Deliver

Write these sections to ARTIFACT_PATH, in this order and with these headings. `## Modified files` is mandatory (`nightqueue run check 04` reads it; with no list it derives one from the worktree's own changes).

## Modified files
<absolute path of each file created or modified, one per line, nothing else — cumulative across stages and fix loops>

## Done
### Stage <n> — <title>
<what was implemented; one block per stage, a single block when the plan has no stages>

## Left
<what is left or deviates from the plan, or `nothing`>

## How it was tested
<the commands run and their result>

A stage appends its `### Stage <n>` block under `## Done` and rewrites the cumulative `## Modified files`; nothing else is rewritten.
{{#FIX_LOOP}}
This launch is fix loop {{FIX_LOOP}}: do NOT rewrite ARTIFACT_PATH — your complete output is the updated list plus one appended block. Keep every section as it is, update the cumulative `## Modified files` list in place, and append at the END of the file:
```
### Fix loop {{FIX_LOOP}} — what was wrong / what changed
- What was wrong: <one sentence>
- What changed: <one sentence>
- How it was tested: <the commands and their result>
```
{{/FIX_LOOP}}
The return also lists the files touched.
