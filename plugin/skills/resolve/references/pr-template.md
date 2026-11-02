# Pull request template

Standard for the pull request that `/nightqueue:resolve` opens at the end of Phase 8.
The title and the body are filled from `## Facts for the report` (`nightqueue run report --facts`)
and the subagents' returns. Nothing is invented.

The execution record of the run — phases, models, durations, lesson count — is
NOT part of the pull request: that data lives in the telemetry and in the report of
Phase 9.

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

One line, the subject of the commit created in Phase 8:
`<type>(<scope>): <summary>` — at most 72 characters, no final period, no emoji, no
name of an agent, a model or a vendor. The scope is optional and follows the commit
convention detected in step 1 of Phase 8.

## The nightqueue template (fallback)

Four sections, mandatory, in this order:

- `## Report` — what was reported as happening, symptom from the reporter's point of view (user, Sentry, QA, issue), no root cause.
- `## Cause` — what was producing the behavior, specific file/function/condition; if a hypothesis was discarded, one line saying which and why.
- `## Changes` — what changed and where; known side effects / what was deliberately left untouched.
- `## QA` — how it was validated, only what actually ran for this PR: one `###` subsection per method that ran, one bullet per test. `### Automated` (tsc / lint / test) with the command; `### API` with request, endpoint, status, payload; `### Browser` with URL, flow, what was observed; `### Device` (Android / iOS emulator or device) with build or OTA, flow, what was observed. Then a mandatory line `Not tested: <what was left out and the risk>`.

The fence delimits the MODEL in this document; the real body is emitted without a fence.

```
## Report
<...>
## Cause
<...>
## Changes
- <...>
## QA
### Automated
- `<command>` — PASSED ✅
Not tested: <what was left out and the risk>
```

Only the subsections that ran, in any order, each with at least one bullet
`- <what ran> — <result>`, the result ending in `PASSED`, `FAILED` or `SKIPPED (<reason>)`
and an optional ✅/❌, e.g. `- http://localhost:3000/login, flow login → dashboard — the redirect was observed, PASSED ✅`.
`Not tested:` comes after the last subsection. A table, another `###` subsection or an `N/A` is refused.
A QA skip: one line `QA: skipped — <why>` right under the QA heading.

## Evidence

Every subsection of `## QA` is backed by a non-empty file under
`<RUN_DIR>/evidence/`, named `<method>-<name>.<ext>`:

| Subsection | `<method>` | What the file holds |
| --- | --- | --- |
| Automated | `automated` | the verifier's real output (`automated-verification.md`), plus the `Generated PoC:` lines of the Facts when the QA produced one |
| API | `api` | the HTTP log or the recorded request and response of Phase 7 |
| Browser | `browser` | the screenshot or the page log of Phase 7 |
| Device (Android / iOS emulator or device) | `emulator` | the screenshot or the log of the build or OTA exercised in Phase 7 |

Extensions: `.log`, `.md`, `.txt`, `.png`, `.jpg`. A method with no evidence file has no
subsection — never a subsection without a file. `nightqueue run pr` answers
`MISSING: evidence for QA section <method>` for a subsection whose file is absent or empty.

## Where each section comes from

| Section | Real source | Rule |
| --- | --- | --- |
| `## Report` | the `Validated brief:` lines | The symptom as the reporter saw it, never the cause. For a feature: what was asked and by whom. |
| `## Cause` | the `Confirmed root cause:`, `Diagnosis:` and `Decision taken:` lines | For a feature, write what motivated the change — no invented root cause. |
| `## Changes` | the `Modified file:`/`Modified files:` lines, described by the matching `Planned change:` line | One bullet per file or per coherent area, at most 10 bullets, one line each. A path with no matching plan line (a deviation from the plan) carries the path alone or the coder's deviation note (`Implementation left:`) — never an invented description. More than 10 paths: group by directory or area, one bullet per area with the number of files. Every path listed appears in EXACTLY one bullet — alone or inside a group, never in both and never dropped. |
| `## QA` | the `Evidence:` lines | One `###` subsection per file-backed method that really ran, one bullet per test; `Not tested:` names what was left out (a `NOT MET` line of Phase 7, a `## Suggestions` item with `dedicated ticket: yes`, a part that depends on another system) and its risk. **Never drop a real open item to make the pull request look clean.** |

## Optional lines

- An issue reference (`Fixes <ID>`, `Closes #<n>`) as the last line of `## Report`,
  only when the brief came with a real tracker ID, in the canonical form of that
  tracker. With no ID in the brief the line does not exist.

## Forbidden in the title and in the body

- **A bare `#<number>` anywhere.** GitHub reads it as a reference to an issue or a
  pull request OF THIS REPOSITORY: it opens a cross-reference in an unrelated thread
  and notifies it. Any other number goes inside a code span (`` `#24` ``). The only `#<number>` allowed is a real
  reference to an issue of this repository in the `Fixes`/`Closes` line.
- A job ref (`J-24`), the run slug, a `Refs` line or an `Opened by nightqueue` line:
  `nightqueue run pr` appends the traceability footer from the job row and refuses a
  body that carries one.
- In the nightqueue template, a fifth `## ` section: the four above are the whole body.
  A repository template has no such limit.
- The execution record of the run: phases, models, statuses, durations, `Lessons
  saved`, `Slug` as a field. It belongs to the telemetry of Phase 9, not here.
- The name of an agent, a model or a vendor. To identify the automation, use the
  nickname `nightqueue`.
- A `Co-Authored-By` trailer.
- Any placeholder in double curly braces, and any `<...>` example left over from the
  model above.
- A test that did not run, a behaviour that was not exercised, or any claim that no
  artifact of the run supports.

## Size

The body fits on one screen — past that it stops being read. `## Changes` at most 10
bullets of one line; the `## QA` section one subsection per method.

## Before `nightqueue run pr`

Before you Write the assembled body — the text the command reads, not this document — confirm,
item by item:

1. The template is the one `nightqueue run pr --template` printed.
2. Repository template: every heading of it present, in its order, and no nightqueue
   heading it does not have.
3. Nightqueue template: `## Report`, `## Cause`, `## Changes`, `## QA` present, in this
   order, and no fifth `## `; the `## QA` subsections, each with at least one
   bullet ending in PASSED, FAILED or SKIPPED (reason), no `N/A`, and the `Not tested:` line after the last one; every subsection backed by its file under
   `<RUN_DIR>/evidence/`.
4. No bare `#<number>` outside the `Fixes`/`Closes` line.
5. No placeholder in double curly braces and no `<...>` example left over.
6. The title within 72 characters and with no final period.

Any failure: fix the body and only then call the command. `REJECTED:` or `MISSING:`
lines mean nothing was pushed.
