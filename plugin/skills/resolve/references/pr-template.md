# Pull request template

Fixed standard for the pull request that `/nightshift:resolve` opens at the end of
Phase 7. The title and the body come from here and from nowhere else, filled with the
artifacts of the run that is closing. Nothing is invented: a mandatory section with no
real data reads `None`, and only the lines marked optional below may disappear.

## Title

One line, the subject of the commit created in Phase 7:
`<type>(<scope>): <summary>` — at most 72 characters, no final period, no emoji, no
name of an agent, a model or a vendor. The scope is optional and follows the commit
convention detected in step 1 of Phase 7.

## Body

The six sections below are mandatory and go in this order. The fence delimits the MODEL
in this document; the real body is emitted without a fence.

```
## Summary

<2 to 4 lines: what changed and why, for whoever reads the pull request>

## Changes

- <area or file> — <what changed there>

## Tests run and passed

- <check that in fact ran and passed>

## QA

<the verdict of the adversarial QA and what it proved>

## Open items

<one line per open item of the run, or None>

## Run

- <phase> · <model> · <status> · <duration>
Lessons saved: <N> (targets: <unique target list>)
Tier: <tier>
Slug: <slug>

Opened by nightshift · run <slug>
```

## Where each section comes from

| Section | Real source | Rule |
| --- | --- | --- |
| `## Summary` | `01-triage.md` (`## Validated brief`, the Expected outcome field, `## Diagnosis` when it is a bug) plus the delivered result; in the trivial tier, the `## Brief` of Phase 0 | The same source the `## Notice` of Phase 8 uses — not the notice text, which is only written after this pull request is open. The Fast Lite Track does not run Phase 1: in the trivial tier there is no `01-triage.md`, and the summary comes from the `**Affected area:**`, `**Objective:**` and `**Expected outcome:**` fields of the Phase 0 brief, which exist in every tier — never `None`. |
| `## Changes` | `## Modified files` of `04-implementation.md`, described by the matching line of `**Files to create/modify:**` of `03-plan.md` | One bullet per file or per coherent area, at most 10 bullets. A path with no matching plan line (a deviation from the plan, or the trivial tier, which has no plan) carries the path alone or the coder's deviation note — never an invented description. More than 10 paths: group by directory or area, one bullet per area with the number of files. Every path of `## Modified files` appears in EXACTLY one bullet — alone or inside a group, never in both and never dropped. |
| `## Tests run and passed` | `06-verification.md` (tests, lint, tsc, build — only the ones that exist in the project and passed), the acceptance of Phase 6.5 (the real validation) and the risks validated in `05-qa.md` | Only what in fact ran and passed. A check the project does not have is not listed. Nothing ran: `None`. |
| `## QA` | `05-qa.md`: the verdict, the breaks that were proven and fixed, the risks that held | The Fast Lite Track does not run Phase 5: in the trivial tier write exactly `Skipped (trivial tier)`. |
| `## Open items` | The open items of the run: `## Suggestions` with `dedicated ticket: yes` in `05-qa.md`, a `NOT MET` (with or without `/ to confirm`) line in the acceptance gate of Phase 6.5, an unconfirmed decision, a telemetry or lesson capture that failed | No open item: `None`. Never drop a real open item to make the pull request look clean. |
| `## Run` | The execution log of step 5.1 plus `state.json` (`tier`, `slug`) | Rules right below. |

## The `## Run` section

- One line per line of the execution log of step 5.1, in the order the agents ran,
  including the re-entries of a fix loop: `<phase> · <model> · <status> · <duration>`.
  It is the same tuple the telemetry of Phase 8 persists in `phases`. The model is the
  one that launch passed; when a resumed run does not carry it, write `model unknown` —
  never a guess. That fallback is applied LINE BY LINE: only the phases whose model is
  in fact unknown read `model unknown`, and every other line keeps its real model. The
  status is `ok`, `failed` or `skipped`, and a re-run line adds `retry`.
- Phase 8 has not run yet when this pull request is opened, so it is not on the list.
- `Lessons saved: <N> (targets: <list>)` — the same count as the lesson-capture audit
  line of Phase 8, over the capture points that already ran; none recorded:
  `Lessons saved: 0`.
- `Tier:` and `Slug:` come from `state.json`.
- `Job: #<id>` — an extra line, only when the environment variable
  `NIGHTSHIFT_JOB_ID` is set (an unattended run out of the queue). Without it the line
  does not exist.

## Optional lines

- An issue reference (`Fixes <ID>`, `Closes #<n>`) as the last line of `## Summary`,
  only when the brief came with a real tracker ID, in the canonical form of that
  tracker. The v1 runtime has no issue tracker: with no ID in the brief the line does
  not exist.

## Forbidden in the title and in the body

- The name of an agent, a model or a vendor. To identify the automation, use the
  nickname `nightshift`.
- A `Co-Authored-By` trailer.
- Any placeholder in double curly braces, and any `<...>` example left over from the
  model above.
- A test that did not run, or any number that no artifact of the run supports.
- A section outside the six above, or the six out of order.

## Before `gh pr create`

Read the assembled body — the string that goes to the command, not this file — and
confirm: the six headings present and in the order above; no placeholder in double
curly braces and no `<...>` example left; the title within 72 characters and with no
final period. Any failure: fix the body and only then open the pull request. A pull
request outside this standard is never opened.
