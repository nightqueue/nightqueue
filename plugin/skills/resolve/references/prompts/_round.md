{{#GROUP}}
Write this launch's whole round to `{{DRAFT_PATH}}`, starting at `## Proven breaks` (no `## Round` heading
and no `source:` line: the runtime numbers the round and stamps its group). Then run
`nightqueue run append 05 --group {{GROUP_ID}} --from {{DRAFT_PATH}}` once and carry its `APPENDED:` line
in your return. Never Read-and-Write `05-qa.md` yourself: other provers append to it at the same time.
{{/GROUP}}
{{^GROUP}}
If ARTIFACT_PATH exists, Read it and Write it back with every earlier round unchanged, then append
`## Round {{ROUND}}` at the end with this launch's whole output (every mandatory section, the verdict
line included). Never edit an earlier round; otherwise create it with `## Round {{ROUND}}`.
Inside a code block, indent any `## Round` line you quote by one space, and close every code fence and every `<!--` before your round ends (a literal `<!--` goes in backticks).
{{/GROUP}}
