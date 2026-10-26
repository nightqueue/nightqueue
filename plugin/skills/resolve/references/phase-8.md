# Phase 8 — Commit and PR

Only execute this phase if Phase 6 returned `## Verification: PASSED` **and** Phase
7 (when applicable) confirmed the change at runtime (a real payload confirmed in
case (a), a screenshot in case (b), the user's verdict in case (c), the complete acceptance
criteria in case (d)). If the verification failed after the fix iterations,
or if the runtime validation showed the bug persisting, **do not commit** — go
straight to Phase 9 and report.

The command below owns the mechanics — staging, the commit, the branch name, the push and
`gh pr create`. What stays yours is the judgment: which files, which message, which body.
An interactive `/resolve` (no `NIGHTQUEUE_JOB_ID`) also follows `references/interactive-worktree.md`
before step 2 and after the pull request exists.

1. **Decide what goes into the commit and write its message.**
   - The list is `## Modified files` of `<RUN_DIR>/04-implementation.md` plus the QA's
     real, hermetic tests that passed (including the bug's `*.regression.test.*`), each added with one
     `--extra <pathspec>`; a PoC lives under `<RUN_DIR>/poc/` and is never committed (`run publish` refuses `*.poc.*`, `*SCRATCH*`, `*-QA-*`). Leave out Phase 7's screenshots/artifacts and anything Step 2.7 of
     the verifier flags; `.claude/`, `tmp/` and lockfiles the command refuses on its own. Check
     `git status --short` first: a file that is neither in `## Modified files` nor a QA test is
     left out and recorded as an ⚠️ open item — never opened, never included in the dark; a file
     IN the scope that mixes pre-existing unrequested hunks (read from the verifier's
     diff-hygiene finding in `06-verification.md`) → ask the user BEFORE committing.
   - Follow the `commitTemplate` `run start` answered; when its `source` is `nightqueue` (the
     fallback), read `references/commit-template.md` first.
   - The message is yours: follow the convention the repository declares (`run start` answered it as `commitConvention`; the command prints it again as
     `CONVENTION: <what it found>`) or, with none declared, **Conventional Commits** with the
     `<type>` of Phase 0. Include a body when the task is not trivial, with a `Tests:` line
     listing only the checks that actually passed and the tracker's canonical ID (e.g. `Fixes
     PROJ-123`) when the task came from one. No `Co-Authored-By` trailer, agent, model or
     vendor name. Never write a `Refs:` trailer; `run publish` adds it.
   - Write the message with Write to `<RUN_DIR>/commit-message.txt`, which lives outside the
     worktree and is therefore never committed.

2. **Open the pull request** (one command, `nightqueue run publish`):
   - The template of the body is the `prTemplate` `run start` answered — the repository's own
     (`source: "repo"`, its `label`) or nightqueue's fallback — with its `headings` in order: never
     decide it yourself, and never Read the repository's template file. Assemble the title and the
     body per `references/pr-template.md` for THAT template, filling every section with this run's
     artifacts (`01-triage.md`, `03-plan.md`, `04-implementation.md`, and the last `## Round` of
     `05-qa.md` and `06-verification.md`). Invent nothing. In the PR description, identify the automation, when
     needed, by the nickname `nightqueue` — never an agent, model or vendor name, and no
     `Co-Authored-By` trailer.
   - **How it was validated goes inside the template's own test section.** Nightqueue template:
     the `## QA` section, one `###` subsection per method that really ran, one bullet per test, each backed by a non-empty file
     under `<RUN_DIR>/evidence/<method>-<name>.<ext>` (`<method>` ∈ `automated`, `api`,
     `browser`, `emulator`), then the `Not tested:` line. The evidence files are already there: the
     verifier wrote `automated-verification.md` (Phase 6) and the runtime lane wrote
     `api-*.log`, `browser-*.png|.log`, `emulator-*.png|.log` (Phase 7); when the QA
     produced `05-qa.md`, you may add `automated-qa.md` with Write from its last round's PoC excerpt. A
     method with no evidence file has no row. Repository template: its own test section, in its own
     format.
   - **No bare `#<number>` in the title or body** — GitHub cross-references an unrelated
     issue/PR and notifies it. The only `#<number>` allowed is a real issue of this repository in the `Fixes`/`Closes` line.
   - **No job ref (`J-24`), run slug, `Refs` line or `Opened by nightqueue` line in the body**
     — `nightqueue run publish` appends the traceability footer from the job row and refuses a
     body that carries one.
   - Write the body with Write to `<RUN_DIR>/pr-body.md` (outside the worktree, like the message
     of step 1) and run
     `nightqueue run publish --message-file <RUN_DIR>/commit-message.txt --body-file <RUN_DIR>/pr-body.md`,
     with one `--extra <pathspec>` per file outside the artifact's list. It checks the body BEFORE
     anything is committed, stages exactly the list — never a blind `git add -A` — and commits it
     ONCE (a retry answers `COMMITTED: <sha> (already committed)`), renames the branch to its final
     name (a job's `worktree-<slug>` becomes `<commit type>/<slug>`, the type read from the commit
     subject; an interactive `worktree-<type>+<slug>` becomes `<type>/<slug>`), pushes it and opens
     the pull request, answering `CONVENTION:`, `COMMITTED: <sha> (<n> files)`, `BRANCH:`,
     `PR: <url>` and `WORKTREE: <path>`. You never run `git add`, `git commit`, `git branch -m`,
     `git push` or `gh pr create` by hand.
   - `REFUSED: <path> (<reason>)` names a path the pipeline never commits (`.claude/`, `tmp/`, a
     lockfile, anything outside the worktree) and nothing was committed: `--extra` does not
     override it — drop that path (with `--files-from` a list of your own under `<RUN_DIR>` when
     it came from the artifact), call the command again and record the refusal as an ⚠️ open
     item of Phase 9.
   - `REJECTED: <reason>` and `MISSING: <what>` (one line per violation; the evidence one
     reads `MISSING: evidence for QA section <method>`) mean the body failed the check of the
     template in effect (a heading missing or out of order, a nightqueue heading against a
     repository template, the `## QA` subsections or the `Not tested:` line, a bare `#<number>`, a
     placeholder or a leftover `<...>` example) and nothing was pushed. Fix the body or the
     evidence and call the command again.
   - `run publish` records the delivery itself.
   - If `gh` is not installed or could not open the pull request, the command says so with the
     branch already pushed: inform it and leave the pull request to be opened by hand.

3. **Cycle closing belongs to the runtime, not to this pipeline.** The pipeline ends at an open PR;
   merge, delivery, the issue tracker and the executive notice are the runtime's — never run them inline.
