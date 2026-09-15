# Pull request template

Fixed standard for the pull request that `/nightshift:resolve` opens at the end of
Phase 7. The title and the body come from here and from nowhere else, filled with the
artifacts of the run that is closing. Nothing is invented: a mandatory section with no
real data reads `None`, and only the blocks marked optional below may disappear.

The pull request answers three questions and no more: what changed, where it changed,
and what proves it works. The execution record of the run — phases, models, durations,
lesson count, tier, proposed decisions — is NOT part of it: that data lives in the
telemetry and in the report of Phase 8.

## Title

One line, the subject of the commit created in Phase 7:
`<type>(<scope>): <summary>` — at most 72 characters, no final period, no emoji, no
name of an agent, a model or a vendor. The scope is optional and follows the commit
convention detected in step 1 of Phase 7.

## Body

The three sections below are mandatory and go in this order. The fence delimits the
MODEL in this document; the real body is emitted without a fence.

```
## Summary

<2 to 4 lines: what changed and why, for whoever reads the pull request>

## Changes

- <area or file> — <what changed there>

## QA

Verdict: <the verdict of the adversarial QA and, in one sentence, what it proved>

Proven:
- <one behaviour that was in fact exercised and held>

Not covered:
- <one line per real open item — omit the whole block when there is none>

Opened by nightshift · run <slug>
```

## Where each section comes from

| Section | Real source | Rule |
| --- | --- | --- |
| `## Summary` | `01-triage.md` (`## Validated brief`, the Expected outcome field, `## Diagnosis` when it is a bug) plus the delivered result; in the trivial tier, the `## Brief` of Phase 0 | The same source the `## Notice` of Phase 8 uses — not the notice text, which is only written after this pull request is open. The Fast Lite Track does not run Phase 1: in the trivial tier there is no `01-triage.md`, and the summary comes from the `**Affected area:**`, `**Objective:**` and `**Expected outcome:**` fields of the Phase 0 brief, which exist in every tier — never `None`. At most 4 lines: what changed and why, not how. |
| `## Changes` | `## Modified files` of `04-implementation.md`, described by the matching line of `**Files to create/modify:**` of `03-plan.md` | One bullet per file or per coherent area, at most 10 bullets, one line each. A path with no matching plan line (a deviation from the plan, or the trivial tier, which has no plan) carries the path alone or the coder's deviation note — never an invented description. More than 10 paths: group by directory or area, one bullet per area with the number of files. Every path of `## Modified files` appears in EXACTLY one bullet — alone or inside a group, never in both and never dropped. |
| `## QA` | `05-qa.md` (verdict, breaks proven and fixed, validated risks), `06-verification.md` (only the checks that in fact ran and passed) and the acceptance gate of Phase 6.5 (the real validation) | This section absorbs the tests: there is no separate test section. Rules right below. |

## The `## QA` section

Three blocks, in this order. `Verdict:` and `Proven:` are mandatory; `Not covered:`
only exists when there is a real open item.

- **`Verdict:`** — one line: the verdict the qa-guardian returned and, in one sentence,
  what the adversarial QA proved (the break it found and that was fixed, or the fact
  that the attacked risks held). The Fast Lite Track does not run Phase 5: in the
  trivial tier write exactly `Verdict: Skipped (trivial tier)` and fill `Proven:` from
  Phase 6 and Phase 6.5 alone.

- **`Proven:`** — the list of what this change was in fact put through and survived,
  each bullet naming the **behaviour** that was exercised, in the language of whoever
  uses the product, never the name of a test file, of a case or of a command.
  `- rejects a diet PDF over the size limit` is a bullet; `- 12/12 green in
  diet-toast.test.ts` is not. Sources, merged into one list: the risks of `05-qa.md`
  that held under attack, the break that was proven and fixed, the checks of
  `06-verification.md` that ran and passed, and the criteria the acceptance gate of
  Phase 6.5 confirmed at runtime. One bullet per behaviour, at most 10 — when there
  are more, keep the ones a reviewer would want to see fail. Suite-level results are
  not a behaviour: fold them into ONE closing bullet,
  `- full suite green (<N> tests, <runner>)`, and only when it in fact ran. A check
  the project does not have is not listed. Nothing ran and nothing was proven:
  `Proven: None`.

- **`Not covered:`** — the real open items of the run, one line each, at most 5: a
  `## Suggestions` item of `05-qa.md` with the literal `dedicated ticket: yes`, a
  `NOT MET` line (with or without `/ to confirm`) of the acceptance gate of Phase 6.5,
  a `not-covered` vector of `## Symptom coverage` of `03-plan.md`, a part of the
  request that depends on another system or another repository. Say in one line what
  is open and that it is handled separately. **Never drop a real open item to make the
  pull request look clean.** No open item: omit the block, heading included.

A decision proposed by this run is NOT an open item of this body: it goes only to the
Phase 8 report, where the operator decides whether it deserves a ticket.

## The closing line

One line, not a section, as the last line of the body:
`Opened by nightshift · run <slug>`, with `<slug>` taken from `state.json`. When the
environment variable `NIGHTSHIFT_JOB_ID` is set (an unattended run out of the queue),
the line ends with ` · job <id>` — the number bare, never `#<id>`. Without the
variable the suffix does not exist.

## Optional lines

- An issue reference (`Fixes <ID>`, `Closes #<n>`) as the last line of `## Summary`,
  only when the brief came with a real tracker ID, in the canonical form of that
  tracker. The v1 runtime has no issue tracker: with no ID in the brief the line does
  not exist.

## Forbidden in the title and in the body

- **A bare `#<number>` anywhere.** GitHub reads it as a reference to an issue or a
  pull request OF THIS REPOSITORY: it opens a cross-reference in an unrelated thread
  and notifies it. A queue job id, a decision number or any nightshift-internal number
  is written without the `#` (`job 24`, `decision 1`) or inside a code span
  (`` `#24` ``). The only `#<number>` allowed is a real reference to an issue of this
  repository in the `Fixes`/`Closes` line.
- A fourth `## ` section. The three above are the whole body.
- The execution record of the run: phases, models, statuses, durations, `Lessons
  saved`, `Tier`, `Slug` as a field. It belongs to the telemetry of Phase 8, not here.
- The name of an agent, a model or a vendor. To identify the automation, use the
  nickname `nightshift`.
- A `Co-Authored-By` trailer.
- Any placeholder in double curly braces, and any `<...>` example left over from the
  model above.
- A test that did not run, a behaviour that was not exercised, or any claim that no
  artifact of the run supports.

## Size

The body fits on one screen — past that it stops being read. Summary at most 4 lines,
`## Changes` at most 10 bullets of one line, `Proven:` at most 10 bullets,
`Not covered:` at most 5. Write it already fitting; do not write long expecting
someone to cut it.

## Before `gh pr create`

Read the assembled body — the string that goes to the command, not this file — and
confirm, item by item:

1. The three headings `## Summary`, `## Changes` and `## QA` present, in this order,
   and no fourth `## ` in the body.
2. Inside `## QA`, the lines `Verdict:` and `Proven:` present; `Not covered:` present
   if and only if the run has a real open item.
3. No bare `#<number>` outside the `Fixes`/`Closes` line.
4. No placeholder in double curly braces and no `<...>` example left over.
5. The caps of the section above respected.
6. The title within 72 characters and with no final period.

Any failure: fix the body and only then open the pull request. A pull request outside
this standard is never opened.
