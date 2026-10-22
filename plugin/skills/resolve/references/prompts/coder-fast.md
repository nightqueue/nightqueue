## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/04-implementation.md
Read before acting (via Read): {{#TRIAGED}}`{{RUN_DIR}}/01-triage.md` — ## Validated brief and the confirmed cause.{{/TRIAGED}}{{^TRIAGED}}none{{/TRIAGED}}
{{>_handoff}}

Inputs: the brief below; the affected files; the project conventions when named; the `## Applicable lessons` and `## Project memory` when the context carries them.

Brief:
{{BRIEF}}

Affected files (read them yourself, via Read):
Affected area: {{AFFECTED_AREA}}
{{#INDEX_PATHS}}
{{INDEX_PATHS}}
{{/INDEX_PATHS}}

{{#CLAUDE_MD}}
Project conventions (via Read): {{CLAUDE_MD}}

{{/CLAUDE_MD}}
{{>_context}}
Apply the simplest possible change the brief defines. Do not introduce abstractions.
{{#SIMPLE}}
Follow the test patterns already in the project and
cover the new behaviour in the test file that already covers this area.
{{/SIMPLE}}

{{>deliverables/implementation}}

{{>_job-limits}}
{{>_shell-rule}}

{{>_footer}}
