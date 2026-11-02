## File handoff (contract — read first)
ARTIFACT_PATH: {{RUN_DIR}}/03-plan.md
Read before acting (via Read):
- `{{RUN_DIR}}/01-triage.md` — ## Validated brief; on a bug, ## Diagnosis (the plan MUST
  attack this cause; its symptom proof is the baseline the runtime validation re-runs
  without-fix vs with-fix); ## Intent note and ## Depth note when present (the intent note of
  your Step 1, the depth note of your Step 1.5); ## Intent signals (axis 3) and ## Request gaps (each one a line of `## Decisions taken`).
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
{{#OPERATOR_ANSWERS}}
Operator answers to the gate, oldest first:
{{OPERATOR_ANSWERS}}

{{/OPERATOR_ANSWERS}}
{{>_context}}

## Deliver

Write these sections to ARTIFACT_PATH, with these headings. `## Implementation plan`, `## Assumptions`, `## Pre-mortem` and `## Identified risks` are mandatory on every plan (`nightqueue run check 03` fails without any of them); the other four follow their own condition. You decide the gaps of the request; you do not ask. When `## Requires user confirmation` is emitted it comes FIRST, before the plan, and the plan describes the recommended option.

## Requires user confirmation  (ONLY when a decision changes observable behaviour, data or scope AND the request does not settle it AND choosing wrong would be costly to undo)
**Question:** [one concrete question]
**Options:** [the options, with the recommended one marked]
**On go ahead:** [what ships when the answer is "go ahead"]

The question carries its `?`: only that reads as a question, and with nothing to ask the section is left out. A relaunch whose note carries the operator's answer applies it to the plan and its rows and drops the answered `## Requires user confirmation`; keep that section only for a NEW question.

## Implementation plan
**Files to create/modify:**
- /absolute/path/file.ts — [what changes, per function]

**Approach:**
[How to solve it, in short paragraphs. Direct.]

**Order of work:**
[The sequence of the changes, each step leaving the code working.]

**Tests:**
[The tests that prove the change, each with what it asserts.]

**Fix level:**
- root (dissolves the family — does not enumerate variants) | symptom (real root = <X>, untouchable due to <reason>, follow-up = <ticket>)

**External APIs/libs:**  (omit if there are none; cite the source read)
- [Lib] v[version]: [confirmed semantics of the relevant method/parameter]

**Arsenal reused:**  (omit if there is none)
- [Native primitive/API of the installed version used in place of custom code] — or "evaluated; no native one covers the case, custom justified by <reason>"

**Upgrade impact:**  (only when the scope touches a version)
- [Change that touches this code] — classification: decision taken | mechanical | exposed debt (out of scope)

**What to avoid:**
- [Pitfall specific to the context — not a generic list]

**Success criteria:**
[The acceptance criteria: observable behavior that confirms the implementation is correct, tied to the Expected outcome of the brief. It REFINES that outcome — never replaces it with another target. Disagreeing with the target is a decision of `## Decisions taken`, not a redefinition.]

Without `## Usage coverage`, declare `**Diff axis:**` and `**Always-gate class:**` here.

## Decisions taken  (mandatory when `## Request gaps` has an item)
- <gap> · <option chosen> · <why>

## Symptom coverage  (mandatory when the Type is bug/error)
**Ticket symptom:** [the observable behavior reported, in the ticket's terms]
**How I enumerated:** [the real COMMANDS you ran, with the literal pattern (`grep -rn "<pattern>" <scope>`, glob, etc.) + the universe swept — writers of the state, entry points, handlers/listeners, jobs, error paths. They are RE-RUN to hunt for an omitted vector: a method without a re-runnable command/criterion does not count, and "I analyzed the code" is a rubber stamp]

| # | Path/trigger that produces this symptom | Status | Reason |
|---|---|---|---|
| V1 | [file:line · event · input] | covered | [how the fix catches it] |
| V2 | [file:line · event · input] | not-covered | [why + the decision taken] |

Rules: list ALL the paths that produce the symptom of the ticket, not only the reproduced one. `not applicable`/`n/a` is FORBIDDEN — a single path is listed with how you confirmed it is the only one. A path that literally produces the symptom of the ticket is never "outside the reported symptom". A `not-covered` row states its reason and the decision taken inline.
Each row carries ONE status, `covered` or `not-covered`: the one the plan ships. An either/or decision is taken by you and recorded in `## Decisions taken`, never left in a row's Status or Reason.
The one exit without a table: when the Type says bug/error but the brief/triage describes no observable symptom, write only `**Type mismatch:** the request declared bug/error, but <literal quote from the brief/triage that shows the absence of a symptom>`. The quote is mandatory: a claim without a quoted excerpt is an escape.

## Usage coverage  (mandatory when the Type is bug/error and the diff touches 2+ scenarios of the access map, or when the always-gate class is yes)
**Diff axis:** scope | filter | auth | other — <justification in 1 line>
**Always-gate class:** yes | no — <the diff changes/does not change WHICH records a query returns, with file:line>
**Scenarios consulted:** <the access map | the spec's usage scenarios | own enumeration + the exact command you ran>

- <entry point> · today: <current behavior + evidence> · after: <behavior after the diff> · changed=yes · decision: <the decision taken>
- <entry point> · today: <…> · after: <the same> · changed=no · decision: <the decision taken>

Rules: one line per entry point of the diff (`·` separators, no spaces around `=`). The always-gate class describes the diff: `yes` raises the QA to `full` and never pauses. "The diff touches only 1 scenario" without the access map consulted is an escape: when in doubt, produce the section.

**Sibling fields of the same card** — mandatory when the diff introduces or swaps the data source of a UI field: one line per remaining field of the SAME component/card that displays a fixed literal, a placeholder or a fallback (`'-'`, `'ACTIVE'`, `'N/A'`, `|| '-'`), with the command used to find them:

- <field> of the same card · today: <exact literal/placeholder/fallback + file:line> · after: <uses the new source | stays <literal>> · changed=<yes|no> · decision: <uses the new source | out of scope: <reason>>

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
Each risk line carries ONE severity marker: 🔴 high (breaks a contract, data, security or a primary flow), 🟡 medium, 🟢 low. Any 🔴 line makes the QA triage answer `full`.
Or `- None`; never omit the section.

{{>_shell-rule}}

{{>_footer}}
