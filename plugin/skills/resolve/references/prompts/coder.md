## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/04-implementation.md
Read before acting (via Read):
- `{{RUN_DIR}}/01-triage.md` — ## Validated brief.
- `{{RUN_DIR}}/03-plan.md` — the complete implementation plan (attack on the cause/criterion).
{{#STAGE}}
- `{{RUN_DIR}}/04-implementation.md` — what earlier lanes did, when it exists.
{{/STAGE}}
Return to the orchestrator AT MOST 10 lines: verdict/status + the handoff file written + open
items — never file contents, never a diff.

{{#STAGE}}
Stage: {{STAGE}}

{{/STAGE}}
Apply the plan following the project's standards (CLAUDE.md). The simplest possible
solution. Write ARTIFACT_PATH per your Required output.

{{>_context}}
{{>_shell-rule}}

{{>_footer}}
