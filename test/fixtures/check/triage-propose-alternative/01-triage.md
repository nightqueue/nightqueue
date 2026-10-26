# Triage

## Brief
**Affected area:** src/queue/listing.mjs
**Context:** the job listing shows every job, archived ones included
**Objective:** list only the active jobs on request
**Expected outcome:** `queue list --active` shows only the pending and running jobs
**Type:** feature/refactor
**Commit type:** feat

## Verdict: PROPOSE-ALTERNATIVE

Evidence level: 1

## Validated brief
Add an option to list only the active jobs.

## Out of scope
- None.

## Request gaps
- None.

## Open items
- Alternative: filter the existing `queue list` with `--status pending,running` instead of a new flag.
- Trade-off: no new option to document, but the operator types two statuses.
