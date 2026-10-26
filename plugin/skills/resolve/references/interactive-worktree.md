# Interactive `/resolve` (no `NIGHTQUEUE_JOB_ID`)

Everything here applies only to a run started by hand, outside the queue. Inside a queued job
the runtime does all of it: never apply this file there.

## The run

- `request` of the triager's `phase_prompt` = the user's request verbatim (after a gate answer:
  the request plus the answer).
- Start the run with `nightqueue run start --project <project> --slug <a short kebab-case slug of the request>`.
  No `RUN_DIR:` line in the prompt → never derive it from the project name (run directories are
  keyed by the project's id): the `runDir` `run start` answers is the `RUN_DIR`
  (`nightqueue run dir` prints it again). Never rename the run by hand: `run check 01` names it
  from the triager's Brief and prints the new `RUN_DIR` (Phase 1).

## The worktree

- Confirm you are inside a git repository: `git rev-parse --is-inside-work-tree`. If not,
  skip the worktree, warn the user and follow the pipeline in the current directory.
- Detect the current branch: `git branch --show-current`.
- If you are on `main`, create a separate worktree and branch for the task: `git fetch origin`,
  then `git worktree add <path> -b worktree-<slug> origin/main`, and pass the absolute path to
  every phase — every later phase runs inside it. A host with its own worktree tool may use it
  instead as a shortcut (Claude Code: `EnterWorktree` with `name: "<slug>"`, base `fresh`, from `origin/main`).
- If you are **not** on `main`, **do not ask** — do not create a worktree and follow the
  pipeline in the current directory/branch. Warn in 1 line: **"Current branch
  `<current-branch>` (non-main): proceeding without a worktree."**
- Record the worktree once it exists: `run_set` with `branch` + `worktree`.
- **On a valid resume** with a `worktree` recorded in the state: if the directory still exists,
  REUSE it. If gone, recreate it from the recorded `branch` (or from `origin/main` if the branch
  no longer exists) with the same `git worktree add`.

## Phase 8

- **Before any external action, show the user and wait for confirmation:** the branch/worktree
  name, the complete commit message, `git diff --stat` and a status line (e.g. "QA ✅ ·
  Verification ✅ · Runtime ✅"). Do not repeat the execution table here — it only reappears in
  the Phase 9 report if the run is not happy. Ask whether to go ahead with push + PR.
- **Close the worktree immediately after the PR is created** (or after confirming that the
  commit stayed local): `git worktree remove <path>` from the main checkout (Claude Code:
  `ExitWorktree` with `action: "delete"`). The branch is already on the remote via push and the
  PR is open.
  - Inform the user of the PR link and warn: **"Worktree removed. The branch
    `<type>/<slug>` is on the remote — use `git checkout <type>/<slug>` or
    open a new worktree for new edits."**
