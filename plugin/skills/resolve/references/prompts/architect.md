## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/03-plan.md
Read before acting (via Read):
- `{{RUN_DIR}}/01-triage.md` — ## Validated brief; on a bug, ## Diagnosis (the plan MUST
  attack this cause; the symptom proof is the baseline that Phase 6.5 re-runs
  without-fix vs with-fix); ## Intent note and ## Depth note when they exist.
- In the complex tier: `{{RUN_DIR}}/02-explore.md` — the Explore's findings.
Return summary (≤10 lines, per the handoff contract of step 5.2): status + artifact path +
whether it emitted ## Requires user confirmation + open items.

Type: {{TYPE}}

In the complex tier, the `## Access map` of 02-explore.md is a mandatory input of axis 3 of
your Step 1.5. Declare `**Diff axis:**` and `**Always-gate class:**`, and produce
`## Usage coverage` when the conditions of your Step 5 match.

{{#DELIVERY_CONSTRAINTS}}
Delivery constraints (the limit of what may be delivered — NEVER design; omit the line if there is none):
{{DELIVERY_CONSTRAINTS}}

{{/DELIVERY_CONSTRAINTS}}
Project conventions: read `{{REPOSITORY}}/CLAUDE.md` yourself via Read if it exists (the orchestrator no longer reads repository files).

{{>_context}}
{{#STANDING_TITLES}}
## Standing decisions
{{STANDING_TITLES}}
{{#STANDING_DETAIL}}
### In full (the 8 closest to this Brief)
{{STANDING_DETAIL}}
{{/STANDING_DETAIL}}
These are the standing constraints of the project and of its org, decided before this task
(a ref written `<ORGKEY>/D-<n>` belongs to the org and binds every project of it).
They are binding context, never a proposed solution: a design that contradicts one either
follows the decision or takes the conflict to `## Requires user confirmation` naming its
ref.

{{/STANDING_TITLES}}
{{#PROPOSED_TITLES}}
## Proposed (not binding)
{{PROPOSED_TITLES}}
These decisions were proposed and nobody accepted them yet: they bind nothing, and a design
may go against them without a confirmation.

{{/PROPOSED_TITLES}}
{{>_shell-rule}}

{{>_footer}}
