# Pull request template

Standard for the pull request that `/nightqueue:resolve` opens at the end of Phase 7.
The title and the body are filled with the artifacts of the run that is closing.
Nothing is invented.

The execution record of the run — phases, models, durations, lesson count, tier,
proposed decisions — is NOT part of the pull request: that data lives in the telemetry
and in the report of Phase 8.

## Which template applies

The repository's own template comes first; nightqueue's is only the fallback. The
runtime looks for it at the root of the run's checkout, in this order, and the first
match wins:

1. `.github/PULL_REQUEST_TEMPLATE.md` — the whole file.
2. `.github/pull_request_template.md` — the whole file.
3. `docs/PR_TEMPLATE.md` — the whole file.
4. A pull request section of `CONTRIBUTING.md`.
5. A pull request section of `CLAUDE.md`.

A whole-file template is every heading of that file, in its order, outside code fences
and HTML comments. A pull request section is a heading whose text carries the words
`pull request` or `PR` (whole words, any case); its template is, in document order, the
first fenced block of that section whose info string is empty, `markdown` or `md` and
that carries at least one heading — its headings are the template. A section with no such
block is no template, and the search moves to the next candidate. No candidate matched:
the nightqueue template below applies.

Run `nightqueue run pr --template` first; the `TEMPLATE:`/`HEADINGS:` lines it prints
(also recorded as `prTemplate` in `state.json`) decide which template you write. Never
decide it yourself.

## A repository template in effect

- Write every heading of it, in its order, each filled with this run's facts.
- Never add `## Report`, `## Cause`, `## QA` (or `## Changes`) unless that heading is
  the repository's own: `nightqueue run pr` rejects a nightqueue heading the repository
  template does not have.
- The repository template's own test section is written in its own format; no evidence
  check applies to it.

## Title

One line, the subject of the commit created in Phase 7:
`<type>(<scope>): <summary>` — at most 72 characters, no final period, no emoji, no
name of an agent, a model or a vendor. The scope is optional and follows the commit
convention detected in step 1 of Phase 7.

## The nightqueue template (fallback)

Four sections, mandatory, in this order:

- `## Report` — what was reported as happening, symptom from the reporter's point of view (user, Sentry, QA, issue), no root cause.
- `## Cause` — what was producing the behavior, specific file/function/condition; if a hypothesis was discarded, one line saying which and why.
- `## Changes` — what changed and where; known side effects / what was deliberately left untouched.
- `## QA` — how it was validated, only what actually ran for this PR, as a markdown table with columns `Method | Executed | Result` and one row per method actually executed among: Automated (tsc / lint / test) with command and PASSED/FAILED/SKIPPED (reason); API with request, endpoint, status, relevant payload; Browser with URL, flow walked through, what was observed; Android / iOS emulator or device with build or OTA installed, flow walked through, what was observed. Rows that did not run are removed, never marked N/A. After the table a mandatory line `Not tested: <what was left out and the risk>`.

The fence delimits the MODEL in this document; the real body is emitted without a fence.

```
## Report
<...>
## Cause
<...>
## Changes
- <...>
## QA
| Method | Executed | Result |
| --- | --- | --- |
| Automated | `<command>` | PASSED |
Not tested: <what was left out and the risk>

Opened by nightqueue · run <slug>
```

The `## QA` table starts with exactly the header `| Method | Executed | Result |` and
its `| --- |` separator, carries at least one row, and is followed by the `Not tested:`
line. The method cell starts with the method name: `Automated`, `API`, `Browser`,
`Android / iOS emulator or device` (`Android`, `iOS`, `Emulator` or `Device`).

## Evidence

Every row of the `## QA` table is backed by a non-empty file under
`<RUN_DIR>/evidence/`, named `<method>-<name>.<ext>`:

| Row | `<method>` | What the file holds |
| --- | --- | --- |
| Automated | `automated` | the verifier's real output: a copy of `06-verification.md` (`automated-verification.md`), plus the PoC excerpt of `05-qa.md` when the tier produced one |
| API | `api` | the HTTP log or the recorded request and response of Phase 6.5 |
| Browser | `browser` | the screenshot or the page log of Phase 6.5 |
| Android / iOS emulator or device | `emulator` | the screenshot or the log of the build or OTA exercised in Phase 6.5 |

Extensions: `.log`, `.md`, `.txt`, `.png`, `.jpg`. A method with no evidence file has no
row — never a row without a file. `nightqueue run pr` answers
`MISSING: evidence for QA row <method>` for a row whose file is absent or empty.

## Where each section comes from

| Section | Real source | Rule |
| --- | --- | --- |
| `## Report` | `01-triage.md` (`## Validated brief`); in the trivial tier, the `## Brief` of Phase 0 (`**Affected area:**`, `**Objective:**`, `**Expected outcome:**`) | The symptom as the reporter saw it, never the cause. For a feature: what was asked and by whom. |
| `## Cause` | `01-triage.md` `## Diagnosis`, `03-plan.md` | For a feature, write what motivated the change — no invented root cause. |
| `## Changes` | `## Modified files` of `04-implementation.md`, described by the matching line of `**Files to create/modify:**` of `03-plan.md` | One bullet per file or per coherent area, at most 10 bullets, one line each. A path with no matching plan line (a deviation from the plan, or the trivial tier, which has no plan) carries the path alone or the coder's deviation note — never an invented description. More than 10 paths: group by directory or area, one bullet per area with the number of files. Every path of `## Modified files` appears in EXACTLY one bullet — alone or inside a group, never in both and never dropped. |
| `## QA` | the files under `<RUN_DIR>/evidence/` | One row per file-backed method that really ran; `Not tested:` names what was left out (a `NOT MET` line of Phase 6.5, a `## Suggestions` item with `dedicated ticket: yes`, a part that depends on another system) and its risk. **Never drop a real open item to make the pull request look clean.** |

A decision proposed by this run is NOT part of this body: it goes only to the Phase 8
report, where the operator decides whether it deserves a ticket.

## The closing line

One line, not a section, as the last line of the body:
`Opened by nightqueue · run <slug>`, with `<slug>` taken from `state.json`. When the
environment variable `NIGHTQUEUE_JOB_ID` is set (an unattended run out of the queue),
the line ends with ` · job <id>` — the number bare, never `#<id>`. Without the
variable the suffix does not exist.

## Optional lines

- An issue reference (`Fixes <ID>`, `Closes #<n>`) as the last line of `## Report`,
  only when the brief came with a real tracker ID, in the canonical form of that
  tracker. With no ID in the brief the line does not exist.

## Forbidden in the title and in the body

- **A bare `#<number>` anywhere.** GitHub reads it as a reference to an issue or a
  pull request OF THIS REPOSITORY: it opens a cross-reference in an unrelated thread
  and notifies it. A queue job id, a decision number or any nightqueue-internal number
  is written without the `#` (`job 24`, `decision 1`) or inside a code span
  (`` `#24` ``). The only `#<number>` allowed is a real reference to an issue of this
  repository in the `Fixes`/`Closes` line.
- In the nightqueue template, a fifth `## ` section: the four above are the whole body.
  A repository template has no such limit.
- A QA row marked `N/A`: a method that did not run has no row.
- The execution record of the run: phases, models, statuses, durations, `Lessons
  saved`, `Tier`, `Slug` as a field. It belongs to the telemetry of Phase 8, not here.
- The name of an agent, a model or a vendor. To identify the automation, use the
  nickname `nightqueue`.
- A `Co-Authored-By` trailer.
- Any placeholder in double curly braces, and any `<...>` example left over from the
  model above.
- A test that did not run, a behaviour that was not exercised, or any claim that no
  artifact of the run supports.

## Size

The body fits on one screen — past that it stops being read. `## Changes` at most 10
bullets of one line; the `## QA` table one row per method. Write it already fitting; do
not write long expecting someone to cut it.

## Before `nightqueue run pr`

Read the assembled body — the file the command reads, not this document — and confirm,
item by item:

1. The template is the one `nightqueue run pr --template` printed.
2. Repository template: every heading of it present, in its order, and no nightqueue
   heading it does not have.
3. Nightqueue template: `## Report`, `## Cause`, `## Changes`, `## QA` present, in this
   order, and no fifth `## `; the `## QA` table with the exact header, at least one row,
   no `N/A` row, and the `Not tested:` line after it; every row backed by its file under
   `<RUN_DIR>/evidence/`.
4. No bare `#<number>` outside the `Fixes`/`Closes` line.
5. No placeholder in double curly braces and no `<...>` example left over.
6. The title within 72 characters and with no final period.

Any failure: fix the body and only then call the command. `REJECTED:` or `MISSING:`
lines mean nothing was pushed.
