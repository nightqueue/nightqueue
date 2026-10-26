## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/05-qa.md (append-only: this launch is ## Round {{ROUND}})
{{>_round}}
Read before acting (via Read):
- `{{RUN_DIR}}/04-implementation.md` — ## Modified files (the files to attack).
- `{{RUN_DIR}}/03-plan.md` (open it only AFTER step 0 of the Access map (QA), when it
  applies) — ## Identified risks, ## Assumptions, ## Pre-mortem, and ## Symptom coverage /
  ## Usage coverage when present; see the QA attack brief below.
{{#HAS_USAGE_COVERAGE}}
- `{{RUN_DIR}}/02-explore.md` when it exists — ## Access map, read only after your own ## Access map (QA).
{{/HAS_USAGE_COVERAGE}}
{{>_handoff}}

Inputs: the artifacts above; the QA attack brief; the plugin paths of your methodology; the `## Applicable lessons` and `## Project memory` when the context carries them.

QA attack brief:
{{>_qa-attack-brief}}

Mode: LITE

Attack every pre-mortem mitigation per the QA attack brief above; prove the consequence with an
executable PoC and report it in ## Proven breaks.

Try to break each risk (execute the architect's steps or derive equivalents;
HELD/BROKE) and apply your adversarial methodology. Attack each
assumption too: if you find evidence that invalidates it, report it in ## Invalidated
assumptions — the plan was designed on top of it. On a bug, use the criterion of the
break from the user's point of view (fallback-zero in the bug's scenario = BROKE). Do NOT
fix anything — prove each break with an executable PoC and hand it back to the coder.
A PoC is throwaway and lives under `{{RUN_DIR}}/poc/`, never in the repo; only a real, hermetic
test with a real name (no `.poc.` in the name, no SCRATCH/-QA- marker) may be committed — no
third state.

{{#IS_BUG}}
MANDATORY (the bug's regression net): besides the break PoCs, create
<module>.regression.test.* encoding the EXACT SCENARIO of the bug (state of the bug
account + input of the symptom) asserting the correct behavior. It must PASS
against the fixed code; when feasible, prove that it would fail without the fix
(git stash → run → git stash pop). Without a scenario exercisable at runtime,
justify it explicitly in ## Generated PoCs.

{{/IS_BUG}}
{{>deliverables/qa-report}}

{{>_context}}
{{>_demo-repo}}
{{>_shell-rule}}

{{>_footer}}
{{>_qa-skill}}
