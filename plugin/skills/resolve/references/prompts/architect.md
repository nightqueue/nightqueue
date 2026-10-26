## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/03-plan.md
Read before acting (via Read):
- `{{RUN_DIR}}/01-triage.md` — ## Validated brief; on a bug, ## Diagnosis (the plan MUST
  attack this cause; its symptom proof is the baseline the runtime validation re-runs
  without-fix vs with-fix); ## Intent note and ## Depth note when present (the intent note of
  your Step 1, the depth note of your Step 1.5); ## Intent signals and ## Request gaps (axis 3).
- `{{RUN_DIR}}/02-explore.md` when it exists — ## File map (the file map of
  your Step 2), ## Access map with its `unimplemented intent` lines (the access map of axis 3),
  ## Third-party libraries (the installed versions of Step 3).
- `{{REPOSITORY}}/CLAUDE.md` when it exists — the project conventions.
{{>_handoff}}
The return also says whether you emitted ## Requires user confirmation.

Inputs: the artifacts above; the Type; the delivery constraints when there are any (the LIMIT of what may be delivered — never a design); the `## Applicable lessons` and `## Project memory` when the context carries them.

Type: {{TYPE}}

{{#DELIVERY_CONSTRAINTS}}
Delivery constraints (the limit of what may be delivered — NEVER design; omit the line if there is none):
{{DELIVERY_CONSTRAINTS}}

{{/DELIVERY_CONSTRAINTS}}
{{>_context}}

## Deliver

Write these sections to ARTIFACT_PATH, with these headings. `## Implementation plan`, `## Assumptions`, `## Pre-mortem` and `## Identified risks` are mandatory on every plan (`nightqueue run check 03` fails without any of them); the other three follow their own condition. When `## Requires user confirmation` is emitted it comes FIRST, before the plan, and the plan describes the proposed solution marked as pending confirmation.

## Requires user confirmation  (when a trigger of your When to stop and ask fired)
- **What the ticket expected:** [the literal reading of the brief/ticket]
- **Why that is a problem:** [the conflict with the code/semantics/logic, with evidence]
- **Proposed solution:** [the logic you designed, in 2-4 lines]
- **Expected result:** [the observable behavior the proposal delivers]
- **Question:** [the objective confirmation you need in order to move on]

A `changed=no` scenario is a record, not a question: only the `changed=yes` and the `to confirm` lines go into the question.

## Implementation plan
**Files to create/modify:**
- /absolute/path/file.ts — [what changes]

**Approach:**
[How to solve it, in short paragraphs. Direct.]

**Fix level:**
- root (dissolves the family — does not enumerate variants) | symptom (real root = <X>, untouchable due to <reason>, follow-up = <ticket>)

**External APIs/libs:**  (omit if there are none; cite the source read)
- [Lib] v[version]: [confirmed semantics of the relevant method/parameter]

**Arsenal reused:**  (omit if there is none)
- [Native primitive/API of the installed version used in place of custom code] — or "evaluated; no native one covers the case, custom justified by <reason>"

**Upgrade impact:**  (only when the scope touches a version)
- [Change that touches this code] — classification: user confirmation | mechanical | exposed debt (out of scope)

**What to avoid:**
- [Pitfall specific to the context — not a generic list]

**Success criteria:**
[Observable behavior that confirms the implementation is correct. It REFINES the Expected outcome of the brief — never replaces it with another target. Disagreeing with the target is `## Requires user confirmation`, not a redefinition.]

Declare `**Diff axis:**` and `**Always-gate class:**` here too when `## Usage coverage` is omitted.

## Symptom coverage  (mandatory when the Type is bug/error)
**Ticket symptom:** [the observable behavior reported, in the ticket's terms]
**How I enumerated:** [the real COMMANDS you ran, with the literal pattern (`grep -rn "<pattern>" <scope>`, glob, etc.) + the universe swept — writers of the state, entry points, handlers/listeners, jobs, error paths. They are RE-RUN to hunt for an omitted vector: a method without a re-runnable command/criterion does not count, and "I analyzed the code" is a rubber stamp]

| # | Path/trigger that produces this symptom | Status | Reason |
|---|---|---|---|
| V1 | [file:line · event · input] | covered | [how the fix catches it] |
| V2 | [file:line · event · input] | not-covered | [why + trade-off taken to ## Requires user confirmation] |

Rules: list ALL the paths that produce the symptom of the ticket, not only the reproduced one. `not applicable`/`n/a` is FORBIDDEN — a single path is listed with how you confirmed it is the only one. A path that literally produces the symptom of the ticket is never "outside the reported symptom". Every `not-covered` vector requires `## Requires user confirmation` in the SAME plan.
The one exit without a table: when the Type says bug/error but the brief/triage describes no observable symptom, write only `**Type mismatch:** the request declared bug/error, but <literal quote from the brief/triage that shows the absence of a symptom>`. The quote is mandatory: a claim without a quoted excerpt is an escape.

## Usage coverage  (mandatory when the Type is bug/error and the diff touches 2+ scenarios of the access map, or when the always-gate class is yes)
**Diff axis:** scope | filter | auth | other — <justification in 1 line>
**Always-gate class:** yes | no — <the diff changes/does not change WHICH records a query returns, with file:line>
**Scenarios consulted:** <the access map | the spec's usage scenarios | own enumeration + the exact command you ran>

- <scenario> · today: <current behavior + evidence> · after: <behavior after the diff> · changed=yes · source=pipeline
- <scenario> · today: <…> · after: <…> · changed=no · source=literal ticket

Rules: one line per scenario, always in this spelling (`·` as the separator, `changed=` and `source=` without spaces around the `=`). `source=literal ticket` requires the quote of the ticket excerpt on the line itself. **Every `changed=yes · source=pipeline` line requires `## Requires user confirmation` in the SAME plan.** Declaring "the diff touches only 1 scenario" without having listed the access map you consulted is an escape, not a measurement: when in doubt, produce the section.

**Sibling fields of the same card** — mandatory when the diff introduces or swaps the data source of a UI field: one line per remaining field of the SAME component/card that displays a fixed literal, a placeholder or a fallback (`'-'`, `'ACTIVE'`, `'N/A'`, `|| '-'`), with the command used to find them:

- <field> of the same card · today: <exact literal/placeholder/fallback + file:line> · after: <uses the new source | stays <literal>> · changed=<yes|no> · source=pipeline · decision=<uses the new source | out of scope: <reason>>

Its own gate: **every `<field> of the same card` line with `decision=out of scope` and `source=pipeline` requires `## Requires user confirmation` in the SAME plan.** The single exit without a gate: `source=literal ticket` with the quote of the ticket excerpt on the line itself.

## Assumptions
- [P1] <assumption> — invalidated if: <evidence that would refute it>
Or `- None (everything confirmed by evidence)`.

## Pre-mortem
The plan itself failed — its 2-3 most likely causes (wrong approach, forgotten file/entry point, an API that does not behave as supposed, an unmapped side effect):
- [PM1] <likely cause of the plan's failure> — mitigation: <adjustment already made in the plan | "accepted because <reason>">
A likely cause with neither a mitigation nor a justification means the plan is not ready: redesign before emitting it.

## Identified risks
Every scenario the change can break or degrade, even a low-probability one, concrete and testable — it feeds whoever attacks the plan:
- [R1] 🔴|🟡|🟢 <failure scenario> — how to test it: <minimum steps>
Each risk line carries ONE severity marker: 🔴 high (breaks a contract, data, security or a primary flow), 🟡 medium, 🟢 low. `run check 03` counts the 🔴 lines: two or more → the QA runs `full`, else `lite`.
Or `- None`; never omit the section.

{{>_shell-rule}}

{{>_footer}}
