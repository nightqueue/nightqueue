# Plan

## Implementation plan
- Fix the notice on the retry path.

## Symptom coverage

**How I enumerated:** `grep -rn "composeNotice" src`

| # | Path/trigger that produces this symptom | Status | Reason |
|---|---|---|---|
| 1 | retry path | covered | fixed in notice.mjs |
| 2 | cli path | not-covered | another subsystem; decision: left as it is, the request names the retry path |

## Usage coverage

**Diff axis:** filter — the diff changes which rows the list returns
**Always-gate class:** yes — the query changes which rows it returns
**Scenarios consulted:** `grep -rn "listJobs" src`

- export csv · today: all · after: active · changed=yes · source=pipeline

## Assumptions
- [P1] the list reads one table (`src/queue/list.mjs:12`) — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] the default changes — how to test it: node --test.
