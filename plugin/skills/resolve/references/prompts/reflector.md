## Reflect over this run and save its lessons and memories (no artifact; return ≤10 lines)
RUBRIC: {{PLUGIN_ROOT}}/skills/reflect/references/rubric.md
Run directory: {{RUN_DIR}}
Read via Read, each one that exists (a missing file is skipped): `00-brief.md`, `01-triage.md`,
`02-explore.md`, `03-plan.md`, `04-implementation.md`, `05a-qa-analyst.md`, `05-qa.md`,
`06-verification.md`, `06-runtime.md` and `state.json` (`termination`, `resumeCount`).
Read every round and every fix-loop block; never the job's stream/log.

Type: {{TYPE}}

## Run timeline
{{TIMELINE}}

## Lessons given to this run
{{INJECTED_LESSONS}}

Rules: the lesson `target` is the phase where the error was made; a recurrence is re-saved with
the lesson's EXACT `title`; every save carries `project` = the Project below; a choice of the
code is a memory (`memory_save`).
Return (≤10 lines): `REFLECTION: <n> saved · <n> recurrences · <n> skipped`, then one line per ref.

{{>_shell-rule}}

{{>_footer}}
