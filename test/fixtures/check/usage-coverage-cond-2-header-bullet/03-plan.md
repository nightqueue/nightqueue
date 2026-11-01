# Plan

## Implementation plan
- Add the `active` filter to listJobs and exportJobs.


## Usage coverage

- **Diff axis:** filter — the diff changes which rows the list and the export return · changed=YES
**Always-gate class:** yes — the queries change which rows they return
**Scenarios consulted:** `grep -rn "listJobs\|exportJobs" src`

- list view · today: all rows · after: active rows only · changed=yes · source=literal ticket "the list view shows only active jobs"
- export csv · today: archived rows listed · after: archived rows left out · changed=yes · source=operator decision "keeps the archived rows out of the export"
- detail view · today: one row · after: one row · changed=no · source=pipeline

## Assumptions
- [P1] the list reads one table — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
