# Phase 8 — Commit and PR

A limit of Phase 6 or 7 adds `--draft` to the command below and one `Remaining failure: <what>`
line per failure to the body's test section; it answers `DRAFT:`. A terminated run's wip commit
is the runtime's, never a delivery nor `run publish`.

The command below owns the mechanics — staging, the commit, the branch name, the push and
`gh pr create`; yours are the files, the message and the body.
With no `NIGHTQUEUE_JOB_ID`, before step 2 show the user the branch, the commit message,
`git diff --stat` and a status line (Do not repeat the report table here; Phase 9 prints it) and
wait for the go; then add `--remove-worktree` to `run publish` (`WORKTREE REMOVED:`/`WORKTREE KEPT:`).

Run `nightqueue run report --facts` first (outside a job, with `--project <project> --slug <slug>`):
it records nothing; its `## Facts for the report` and the subagents' returns are this phase's material.

`drafts` of `run start`: what an earlier Phase 8 left, which Write cannot overwrite. Publish one still right as is; a rejected one, or after a phase re-ran, takes a new name in `<RUN_DIR>`.

1. **Decide what goes into the commit and write its message.**
   - The list is `## Modified files` of the implementation, which `run publish` reads itself, plus the QA's
     real, hermetic tests that passed (including the bug's `*.regression.test.*`), each added with one
     `--extra <pathspec>`; a PoC lives under `<RUN_DIR>/poc/` and is never committed (`run publish` refuses `*.poc.*`, `*SCRATCH*`, `*-QA-*`). Leave out Phase 7's screenshots/artifacts and anything Step 2.7 of
     the verifier flags; `.claude/`, `tmp/` and lockfiles the command refuses on its own. A
     `Changed outside the list:` line that is not a QA test is
     left out and recorded as an ⚠️ open item — never opened, never included in the dark; a file
     IN the scope that mixes pre-existing unrequested hunks (the `Diff hygiene:` line) → commit it, ⚠️ open item.
   - Follow the `commitTemplate` `run start` answered; when its `source` is `nightqueue`,
     read `references/commit-template.md` first.
   - The message is yours: follow the convention the repository declares (`run start` answered it as `commitConvention`; the command prints it again as
     `CONVENTION: <what it found>`) or, with none declared, **Conventional Commits** with the
     `Commit type:` of the Facts. Include a body when the task is not trivial, with a `Tests:` line
     listing only the checks that actually passed and the tracker's canonical ID (e.g. `Fixes
     PROJ-123`) when the task came from one. No `Co-Authored-By` trailer, agent, model or
     vendor name. Never write a `Refs:` trailer; `run publish` adds it.
   - Write the message with Write to `<RUN_DIR>/commit-message.txt`, never committed.

2. **Open the pull request** (`nightqueue run publish`):
   - The template of the body is the `prTemplate` `run start` answered — the repository's own
     (`source: "repo"`, its `label`) or nightqueue's fallback — with its `headings` in order: never
     decide it yourself, and never Read the repository's template file. Assemble the title and the
     body per `references/pr-template.md` for THAT template, filling every section from the Facts
     and the subagents' returns. Invent nothing. In the PR description, identify the automation, when
     needed, by the nickname `nightqueue` — never an agent, model or vendor name, and no
     `Co-Authored-By` trailer.
   - **How it was validated goes inside the template's own test section.** Nightqueue template:
     the `## QA` section, one `###` subsection per method that really ran, one bullet per test (the `Check run:` lines), each backed by a non-empty file
     under `<RUN_DIR>/evidence/<method>-<name>.<ext>` (`<method>` ∈ `automated`, `api`,
     `browser`, `emulator`), then the `Not tested:` line. The evidence files are already there (Phases 6
     and 7), on the `Evidence:` lines; when the QA produced PoCs, you may add `automated-qa.md` with Write from the `Generated PoC:` lines. A
     method with no evidence file has no row. Repository template: its own test section, in its own
     format. A QA skip: `QA: skipped — <why>` (from `QA-MODE:` or the Facts' `QA mode:`) right under its section's heading.
   - **No bare `#<number>` in the title or body** — GitHub cross-references an unrelated
     issue/PR and notifies it. The only `#<number>` allowed is a real issue of this repository in the `Fixes`/`Closes` line.
   - **No job ref (`J-24`), run slug, `Refs` line or `Opened by nightqueue` line in the body**
     — `nightqueue run publish` appends the traceability footer from the job row and refuses a
     body that carries one.
   - Write the body with Write to `<RUN_DIR>/pr-body.md` and run
     `nightqueue run publish --message-file <RUN_DIR>/commit-message.txt --body-file <RUN_DIR>/pr-body.md`,
     with the `--extra`s of step 1. It checks the body BEFORE
     anything is committed, stages exactly the list and commits it
     ONCE (a retry answers `COMMITTED: <sha> (already committed)`), renames the branch to its final
     name (`worktree-<slug>` becomes `<commit type>/<slug>`, the type read from the commit
     subject), pushes it and opens
     the pull request, answering `CONVENTION:`, `COMMITTED: <sha> (<n> files)`, `BRANCH:`,
     `PR: <url>` and `WORKTREE: <path>`. Never run any of that git/gh by hand.
   - `REFUSED: <path> (<reason>)` names a path the pipeline never commits and nothing was committed: `--extra` does not
     override it — drop that path (when it came from the artifact: `coder-fix` with `NOTE:` = drop it
     from `## Modified files`), call the command again and record the refusal as an ⚠️ open item of Phase 9.
   - `REJECTED: <reason>` and `MISSING: <what>` (one line per violation; the evidence one
     reads `MISSING: evidence for QA section <method>`) mean the body failed the check of the
     template in effect (a heading missing or out of order, a nightqueue heading against a
     repository template, the `## QA` subsections or the `Not tested:` line, a bare `#<number>`, a
     placeholder or a leftover `<...>` example) and nothing was pushed. Fix the body or evidence
     and retry; a `… wip commit` one is not yours (yours folds): never rewrite history, open item, no PR.
   - `run publish` records the delivery itself.
   - If `gh` is missing or failed, the command says so with the branch already pushed: inform it;
     the pull request is opened by hand.
     A refused `--draft` opens a normal pull request; the report keeps the failures.

3. **Cycle closing belongs to the runtime, not to this pipeline.** The pipeline ends at an open PR;
   merge, delivery, the issue tracker and the executive notice are the runtime's — never run them inline.
