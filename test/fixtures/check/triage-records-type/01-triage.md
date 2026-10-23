# Triage

## Brief
**Affected area:** src/queue/listing.mjs
**Context:** the job listing shows every job, archived ones included
**Objective:** list only the active jobs on request
**Expected outcome:** `queue list --active` shows only the pending and running jobs
**Commit type:** feat

## Verdict: PROCEED

Evidence level: 1

## Validated brief
Add an option to list only the active jobs.

## Out of scope
- None.

## Request gaps
- None.
