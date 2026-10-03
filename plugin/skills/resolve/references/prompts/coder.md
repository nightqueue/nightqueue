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
A change that adds or bumps a dependency regenerates the lockfile with the manager's own install
(`npm install`) and lists `package.json` and the lockfile together under `## Modified files`:
`run publish` includes a lockfile only when the manifest changed too and the frozen install
(`npm ci --ignore-scripts`) passes from it.

{{>_context}}
{{>_shell-rule}}

{{>_footer}}
