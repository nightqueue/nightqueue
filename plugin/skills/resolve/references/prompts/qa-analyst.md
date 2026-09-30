## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/05a-qa-analyst.md
Read before acting (via Read):
- `{{RUN_DIR}}/04-implementation.md` — ## Modified files (the files to attack).
- `{{RUN_DIR}}/03-plan.md` (open it only AFTER step 0 of the Access map (QA), when it
  applies) — see the QA attack brief above, pasted here by the orchestrator.

QA attack brief:
{{>_qa-attack-brief}}

Mode: ANALYST

Attack every pre-mortem mitigation per the QA attack brief above: static proof (by reading)
goes to ## Proven breaks, runtime-dependent proof becomes a ## Break hypotheses item.

Apply the COMPLETE analytical attack (fronts, risks, assumptions, callers,
robustness), but follow the rules of the ANALYST Mode: do NOT write or run a runtime
PoC — each runtime break becomes a hypothesis in ## Break hypotheses
(grouped by probable root, with type, minimum context and an assigned PoC name).
A static break (proof by reading) is yours: report it in ## Proven breaks.
Discover and record the project's ## Test recipe — the provers are going to use it
without rediscovering the setup. On a bug, use the criterion of the break from the user's point of view
(fallback-zero in the bug's scenario = BROKE).

{{#IS_BUG}}
MANDATORY: include in ## Break hypotheses an item with type=regression with the
EXACT SCENARIO of the bug (state of the bug account + input of the symptom) and the name
<module>.regression.test.* — the prover is going to build it to PASS against the
fixed code.

{{/IS_BUG}}
Finish with ## Proven breaks (static), ## Break hypotheses,
## Test recipe, ## Validated risks (analytical HELD or "→ hypothesis
H<n>") and ## Invalidated assumptions (or "None").

{{>_context}}
{{>_shell-rule}}

{{>_footer}}
{{>_qa-skill}}
