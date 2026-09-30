## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/{{ARTIFACT}}
Read before acting (via Read): {{RUN_DIR}}/01-triage.md (## Validated brief, ## Diagnosis on a bug) ·
{{RUN_DIR}}/03-plan.md (## Usage coverage when present) · {{RUN_DIR}}/04-implementation.md · {{RUN_DIR}}/06-verification.md
Write the COMPLETE output (all your mandatory sections) to ARTIFACT_PATH via Write.
Return to the orchestrator AT MOST 10 lines: runtime verdict + the handoff file written + open
items — never file contents, never a diff.

Mode: RUNTIME
Type: {{TYPE}}
Bug account: {{BUG_ACCOUNT}}
Expected outcome: {{EXPECTED_OUTCOME}}
Apply your Mode: RUNTIME cases (a)–(d2); every manual CLI/MCP run goes through `nightqueue sandbox <cmd>`.

{{>_shell-rule}}

{{>_footer}}
