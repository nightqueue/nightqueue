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

Mode: ANALYST

Attack every pre-mortem mitigation per the QA attack brief above: static proof (by reading)
goes to ## Proven breaks, runtime-dependent proof becomes a ## Break hypotheses item.

Apply the COMPLETE analytical attack (fronts, risks, assumptions, callers,
robustness), as an analysis without runtime PoCs: do NOT write or run a runtime
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
{{>deliverables/qa-report}}

This request also delivers, right after ## Proven breaks (the artifact gate requires both):

## Break hypotheses
- H<n> · group: <probable root> · type: break | regression · <file:line> · vector: <…> · the PoC asserts: <correct behavior> · context: <files> · PoC: <unique assigned file name>

## Test recipe
(the exact command — runner, preload/setup —, the naming conventions and the project's gotchas)

and writes ## Generated PoCs as `None — this request writes no runtime PoC`.

{{>_context}}
{{>_shell-rule}}

{{>_footer}}
{{>_qa-skill}}
