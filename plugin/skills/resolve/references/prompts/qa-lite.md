## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/05-qa.md
Read before acting (via Read):
- `{{RUN_DIR}}/04-implementation.md` — ## Modified files (the files to attack).
- `{{RUN_DIR}}/03-plan.md` (open it only AFTER step 0 of the Access map (QA), when it
  applies) — see the QA attack brief above, pasted here by the orchestrator.

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
Finish with ## Proven breaks, ## Validated risks, ## Generated PoCs and
## Invalidated assumptions (or "None").

{{>_context}}
{{>_shell-rule}}

{{>_footer}}
{{>_qa-skill}}
