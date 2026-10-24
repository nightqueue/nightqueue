# Plan

## Implementation plan
- Add the `active` filter to listJobs.

**Always-gate class:** no — the list keeps returning the same rows.

## Assumptions
- [P1] the list reads one table — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- [R1] 🔴 the default listing drops active rows — how to test it: node --test test/queue/jobs.test.mjs.
1. [R2] 🔴 the archived flag is read as truthy from a string — how to test it: a row with `archived = 'false'`.
- [R3] 🟢 the help text drifts — how to test it: the docs usage test.

```
- [R4] 🔴 a fenced example risk that is never counted
```
