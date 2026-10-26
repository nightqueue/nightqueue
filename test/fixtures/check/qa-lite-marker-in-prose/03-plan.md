# Plan

## Implementation plan
- Add the `active` filter to listJobs.

**Always-gate class:** no — the list keeps returning the same rows.

## Assumptions
- [P1] the list reads one table — invalidated if: a view joins it.

## Pre-mortem
- [PM1] archived rows leak — mitigation: a test.

## Identified risks
- Legend: 🔴 high, 🟡 medium, 🟢 low
- [R1] 🟡 the retry may loop (not 🔴: it self-heals) — how to test it: node --test test/queue/jobs.test.mjs.
  - 🔴 only when the store is offline
- [R2] 🟢 a typo in the help (cf. the 🔴 of R9) — how to test it: the docs usage test.

| # | Severity | How to test |
|---|---|---|
| R3 | 🟡 | escalate if 🔴 seen |
