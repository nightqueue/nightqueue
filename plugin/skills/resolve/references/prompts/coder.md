## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/04-implementation.md
Read before acting (via Read):
- `{{RUN_DIR}}/01-triage.md` — ## Validated brief.
- `{{RUN_DIR}}/03-plan.md` — ## Implementation plan (its stage, when staged) and ## Assumptions: the plan to execute (attack on the cause/criterion).
{{#STAGE}}
- `{{RUN_DIR}}/04-implementation.md` — what earlier stages did, when it exists.
{{/STAGE}}
{{>_handoff}}

Inputs: the artifacts above; the stage when the plan is staged; the `## Applicable lessons` and `## Project memory` when the context carries them.

{{#STAGE}}
Stage: {{STAGE}} — implement only this stage of the plan.

{{/STAGE}}
Apply the plan following the project's standards (CLAUDE.md). The simplest possible
solution.
A change that adds or bumps a dependency regenerates the lockfile with the manager's own install
(`npm install`) and lists `package.json` and the lockfile together under `## Modified files`:
`run publish` includes a lockfile only when the manifest changed too and the frozen install
(`npm ci --ignore-scripts`) passes from it.

{{>deliverables/implementation}}

{{>_context}}
{{>_job-limits}}
{{>_shell-rule}}

{{>_footer}}
