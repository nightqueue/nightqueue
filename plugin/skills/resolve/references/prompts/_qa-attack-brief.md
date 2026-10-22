{{#HAS_USAGE_COVERAGE}}
Step 0 — BEFORE reading 03-plan.md: read
`{{RUN_DIR}}/04-implementation.md` (## Modified files) and the target code and write YOUR
## Access map (QA), in the format and vocabulary of the explore's `## Access map` — a Map written after the
plan is a rubber stamp, not an enumeration.

{{/HAS_USAGE_COVERAGE}}
What `03-plan.md` (once open) demands: ## Identified risks (MANDATORY to attack each one),
## Assumptions (attack each one with real evidence), ## Pre-mortem (validate each declared
mitigation AND attack each "accepted because" justification).

Pre-mortem mitigations — two attacks, both mandatory, on every item. (1) "mitigation:
adjustment already made in the plan": confirm it ACTUALLY exists in the diff — a mitigation
declared and not implemented is a break in ## Proven breaks. (2) "mitigation: accepted because <reason>":
attack the JUSTIFICATION with real evidence — it is the most fragile hypothesis of the plan
and today nobody checks it; "Accepted" never waives the attack. A false justification is a
live and unmitigated risk: what you prove goes to ## Proven breaks (or ## Break hypotheses in
ANALYST mode, when it depends on runtime); if you knock the justification down without proving
the failure, report it in ## Invalidated assumptions (back to the architect, not the coder).

{{#IS_BUG}}
## Symptom coverage — TWO attacks, both
mandatory. (1) Is each vector marked `covered` ACTUALLY covered in the diff? Covered in the
plan and absent from the diff = a break. (2) Is the list COMPLETE? Do NOT trust it: re-run
the command declared in `**How I enumerated:**` and widen it on your own (writers of the
state, entry points, handlers/listeners, jobs, error paths). A path that
produces the ticket's symptom and is NOT in the table is an **omitted vector** = a break in
## Proven breaks, with the command used and `file:line`. Record it on the `Symptom coverage:`
line of ## Deliver.

{{/IS_BUG}}
{{#HAS_USAGE_COVERAGE}}
## Usage coverage — with YOUR
## Access map (QA) of step 0 already written, only then read 02-explore.md and that section
of the plan and diff the two against it. Every prohibition of ## What to avoid and every
`source=pipeline` line is a hypothesis to attack: a named consumer (file:line + entry point) →
a proven break; without one → the label `the decision remains unconfirmed by the operator`,
and `HELD` is FORBIDDEN on those items. ## Access map (QA) is mandatory whenever this front
applies. Record it on the `Usage coverage:` line of ## Deliver (its two counts are defined
there).
{{/HAS_USAGE_COVERAGE}}
