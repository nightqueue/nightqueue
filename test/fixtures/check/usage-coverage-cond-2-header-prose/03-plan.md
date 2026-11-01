# Plan

## Implementation plan
- Add the `active` filter to listJobs and exportJobs.


## Usage coverage

**Diff axis:** filter — the changed queries return fewer rows
**Always-gate class:** yes — the changed queries return other rows
**Scenarios consulted:** every changed query, `grep -rn "listJobs\|exportJobs" src`

Each line below says what changed and who decided it.

- list view · today: all rows · after: active rows only · changed=yes · source=literal ticket "the list view shows only active jobs"
- export csv · today: archived rows listed · after: archived rows left out · changed=yes · source=operator decision "keeps the archived rows out of the export"
- detail view · today: one row · after: one row · changed=no · source=pipeline
> audit log notes: nothing changed=yes here beyond the two items above.

## Assumptions
- [P1] the list reads one table — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
