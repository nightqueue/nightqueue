# Runtime contract

What a runtime has to provide, and what it can rely on:

- `NIGHTQUEUE_HOME` - home directory of the runtime, default `~/.nightqueue`.
- `${NIGHTQUEUE_HOME}/runtime/versions/<version>-<stamp>/` is one installed runtime, and
  `${NIGHTQUEUE_HOME}/runtime/current` is the symlink that names the one in use. Every
  path the host is registered against goes through the link, as
  `${NIGHTQUEUE_HOME}/runtime/current/node_modules/nightqueue`.
- `${NIGHTQUEUE_HOME}/runners/<pid>.json` registers ONE live runner - `watch`, `drain` and
  `once` alike - as `{ "pid", "startedAt", "mode", "jobId", "intervalS", "detached",
  "logPath", "runtimeDir", "uptimeS" }` with `startedAt` in ISO 8601. `uptimeS` is the
  uptime of the machine at the instant of the registration, which is what tells a
  registration left by an earlier boot session apart from a live one; `detached` is `false`
  only for a runner started with `--foreground`, and `runtimeDir` is the version directory
  that runner loaded from. The directory holds one file per live runner, mode `0700`, and
  every reader classifies each entry on its own as `alive`, `stale`, `foreign` or
  `unreadable`. A directory that is not there is an empty registry; a directory that cannot
  be LISTED (a permission, a mount failure) is itself an `unreadable` entry, and every
  reader then assumes a runner MAY be live: the install refuses without `--force`, the prune
  of the old runtime versions deletes nothing, `doctor` warns, and `queue status --json` and
  `queue_status` refuse instead of answering that nothing runs.
  The record is written whole by the process that STARTS the runner, inside
  the home lock; a runner started with `--foreground` registers itself under that same lock
  unless its parent already did it for it. **Any later writer reads, MERGES its own keys
  into and rewrites ONLY the file whose `pid` is its own, under the home lock** - that is
  how the `dbShm` witness of the shared-memory file reaches the record. It is removed by the
  runner itself on a clean exit, matched by pid, by `nightqueue queue run --stop`, or by the
  prune of any reader once no process answers for it. A `runner.pid` left by a version
  before the registry is adopted read-only: listed, counted by the install refusal, stopped
  by `--stop` and pruned when dead, never written again.
- The output of a detached runner lives in
  `${NIGHTQUEUE_HOME}/logs/runner-<stamp>.log`, next to the one log per job.
- The git worktree of a queued job lives in
  `${NIGHTQUEUE_HOME}/worktrees/<project_id>/<slug>/`, on branch `worktree-<slug>`: the
  runtime creates it (or reuses the one `state.json` records) before the spawn, the child
  runs with it as its cwd and `--setting-sources project`, and the runtime removes it after
  the finish when it is clean and published. Nothing of nightqueue is written into the
  project's checkout, its `.git/` or its `.claude/`.
- Run artifacts live in `${NIGHTQUEUE_HOME}/runs/<project_id>/<slug>/`, always
  outside the worktree, because the worktree is removed before the last phase
  reads them. The first segment is the project's id (a ULID), never its name, so
  a project rename leaves every run where it is; `nightqueue run dir` prints the
  directory, and a home from an older build has its `runs/<project>/` moved to
  `runs/<project_id>/` once (a `runs/.by-id` marker records it, and a run
  already present under the id is never overwritten). The runtime creates the
  directory before the session starts.
- Artifact names, in order: `01-triage.md`, `02-explore.md`, `03-plan.md`, `04-implementation.md`,
  `05-qa.md`, `06-verification.md`, `07-runtime.md`, with `04-files.generated.md` beside them when
  `run check 04` derives the file list. The phases are whole numbers, one
  artifact per phase: the QA analyst, every prover and the consolidation all write rounds of
  `05-qa.md`.
- `state.json` in the same directory carries the resumable state, and **the runtime
  is its only writer**: every key goes through `src/queue/run-state.mjs`, which the
  MCP tools `run_terminate`, `run_outcome` and `run_set`, the
  commands `nightqueue run check`, `nightqueue run pr` and `nightqueue run publish`, and the
  runner itself call. The pipeline never writes
  the file, and an `updatedAt` an older plugin hand-wrote is overwritten by the
  runtime's clock and never read. Every key, and who writes it:
  - `schemaVersion` (always `1`), `projectId` and `slug`: every write, as fixed
    fields. A `project` name left by an older build is kept as it is, never
    rewritten and never read to find the run.
  - `updatedAt` and the `at` of every record: the runtime's UTC clock, one stamp per
    write.
  - `claim{attempt, session, ordinal?}` on `outcome`, `termination`, `terminal` and each `phases[]` entry:
    the claim whose process wrote it, read from `NIGHTQUEUE_JOB_CLAIM` (`<attempt>:<worker>#<ordinal>`,
    the ordinal being the claim's `job_attempts` row, which the runner pins on the session and on
    its MCP server, and which a merger never gets) and from the row. Readers compare `ordinal` when
    the stamp and the reader both hold one, else `attempt`; `phases[]` is read whole, and a record
    with no stamp reads as current. See "A record speaks only for the claim that wrote it" in
    [Queue](queue.md).
  - `ignoredRecords[{kind, at, claim, record, notKept?}]`: what a claim that was over tried to
    write and what a newer claim displaced, `kind` being `outcome`, `termination`, `phase`, `check`,
    `fields` or `skip`, and `claim.over: true` on a late write. A late `record` longer than 4 KB
    is `{truncated}`, the start of its JSON; an attempt keeps at most five entries, and
    `notKept` on its last one counts the late writes past them. It is never consumed, and never
    read but to name the attempts in the notice.
  - `phases[{phase, at, artifact?, verdict?, note?, reason?, by?, claim?, attempt?, durationS?, model?}]`: `nightqueue run check` on
    a complete phase and `run publish`/`run pr` for the phase the manifest marks `delivers` (both `by: "runtime"`); append-only, so a phase recorded twice never erases the first record. The
    one removal is the runtime's own `qa` `SKIPPED`, dropped when a `lite` or `full` triage replaces it.
    Both writers stamp the entry's own measures inside the run lock: `attempt` is the claim's attempt;
    `durationS` is the whole seconds since the last entry of the same attempt (of any attempt with no
    claim), the first entry of an attempt measuring from the job's `attempt_started_at`, and left out
    when neither exists; `model` is the model of the phase's track `modelAgent`, else its first
    `agents` entry, with the project's override, and is left out when there is none (the delivery
    entry). `run report`, `run log`, the reflector timeline and the runner's telemetry read these
    fields and never the job log's lanes; an older entry without them reads as `-` and NULL.
  - `checks{<NN>: {line, ok, completed, digest, at, seq}, lastFailure?{check, line, at}}`:
    `nightqueue run check` alone, the memo of the last check of each artifact (its first
    notable line, the sha256 of the text it read, and `seq`, one past the highest `seq` any memo holds,
    which orders the checks without reading their time); it supplies the reason of a re-run and
    keeps a check run twice on the same text from appending twice. It is not a `run_set` field.
  - `termination{phase, reason, at, by?, claim?}`: `run_terminate`, and `nightqueue run check 01` on a
    terminal triage verdict (`by: "runtime"`). A termination speaks only for the claim that wrote
    it: a retry without `fresh` consumes it, whoever wrote it, unless its stamp names a claim
    older than the row's last, and the retried run is handed the phases it recorded. A completed `run check 01` that proceeds also lifts one the runtime
    wrote (`recorded: termination cleared`).
  - `wip{status, phase, at, commit?, short?, branch?, files?, amended?, reason?, ref?, parent?}`:
    `run_terminate` (in the same write as `termination`) and the runner at the finish
    of a job that ended `cancelled` by itself; what the runtime did with the terminated run's work (see
    "A terminated run keeps its work" below). `status` is `committed`, `clean`, `skipped` or
    `failed`. `ref` is the `refs/nightqueue/wip/<slug>` ref naming `commit`, `parent` its parent,
    `files` the paths the commit carries. It never records a `commit` phase nor an `outcome`.
  - `skips{<phase>:{by, reason?, at}}`: why a slot of the studio track did not run,
    for display only. Every run executes every phase, so the runtime writes no skip of
    its own; a `tier` entry (`by: "tier"`) an older runtime wrote is kept and shown as is.
    Agent entries (`by` an agent name, with a reason) an older run recorded are read the same way;
    nothing writes one since contract 14. The key is never in
    `phases` and is never read by resume, routing, the run report or the run context;
    a phase that still runs shows as run. `pipeline_phases.status` is post-run
    telemetry only: it is written by `nightqueue run report` (or an older plugin's
    `pipeline_log`) from `state.json` after the run, one row per `phases[]` entry with that
    entry's `model` and `durationS`, and is never a source of the live track.
  - `outcome{status, at, notice?, prUrl?, files?, draft?, draftFailures?, staysDraft?}`: `run_outcome` (`status`, and `notice` or, for a
    gate, the notice it composes from `question`/`from_artifact`),
    `nightqueue run pr` (`status: "done"`) and the runner, which writes `prUrl` at
    finalize from what the session really published - it is never a parameter.
    `files` is what HEAD changed when `run publish` or `run pr` pushed, in the same write as
    `done`; the job's `result.files` reads it first, then `wip.files`, else none.
    `status: "no_change"` is the run's deliberate conclusion that no code change is
    needed (triage verdict `NO-CHANGE-NEEDED`) and is refused without a `notice`, the
    conclusion its origins are told when the job is closed. An attempt's start erases nothing
    here; a retry without `fresh` removes `status` and `notice`, whatever the status, and keeps
    `prUrl` and `prTitle`, so a retried job is `done` only if it records `done` again.
    `draftFailures: <n>`: `nightqueue run publish --draft`, or a publish without the flag that leaves
    the run's own draft a draft because its body still lists a failure, with `n` the
    `Remaining failure:` lines of the body outside fences and HTML comments; `draft: true` joins it
    only when the pull request really is a draft, so `draftFailures` alone means gh refused the
    draft. `staysDraft: true`: a publish without the flag that gh would not let turn the run's own
    draft ready. Any other outcome written later drops all three, and writing `prUrl` keeps them.
  - `gateQuestionDigest`: `run_outcome` with `status: "gate"` whose composed or sent notice shows
    the plan's filled question; any other gate clears it, and a `done` leaves it. It is the sha256
    of the question's words: NFKC, format characters (`\p{Cf}`) removed, lowercased, and every run
    of anything but letters, marks and digits collapsed to one space. It lives at the top level so it survives the outcome a
    retry consumes. `run check 03` reads it, with `gateAnswersSeen`, to print `CONFIRM: answered (<at>)`, and
    `run report` reads it so an answered pause never counts against Happy. It is not a `run_set`
    field.
  - `gateAnswersSeen`: written with `gateQuestionDigest` and dropped with it, how many `answers`
    existed when that question paused. A later count is what "answered after this pause" means: a
    count and not a clock, because the retry consumes `outcome.status` and two stamps can tie. An
    absent key reads 0. It is not a `run_set` field.
  - `answers[{text, at, attempt}]`: `queue retry` and `queue_retry` with a note on a job whose run
    directory exists, in the same locked write that consumes the last conclusion, with `attempt` the
    attempt that paused; the row's `operator_note` stays NULL. A note on a job with no run directory
    yet stays on the row. A state.json that cannot be read is never overwritten: the note stays on
    the row. It is not a `run_set` field.
  - `lastClaim{attempt, phases, answers, decisions}`, `previousClaim`: the runner, at each claim that reaches a
    spawn, what it found recorded. Another attempt moves `lastClaim` to `previousClaim`, and an
    attempt given back and claimed again replaces `lastClaim` alone. `queue retry` reads them for the
    progress guard (see [Queue](queue.md)). Neither is a `run_set` field.
  - `draftPrUrl`: `nightqueue run publish`, the URL of the draft this run opened or converted. It
    lives at the top level for the same reason. It lets a later publish without the flag turn that
    draft ready, and only that one. A plain create or a turned-ready draft drops it. It is not a
    `run_set` field.
  - `qaMode{mode, reason, at}`: `nightqueue run check 05 --stage triage` only, the QA mode the
    triage decided (`skip`, `lite` or `full`) and its sentence. A repeated check with the same mode
    leaves it untouched, however the sentence is worded. A `qa` entry `SKIPPED` counts as a skip only
    beside a `qaMode` of `skip`: otherwise `run report` reads it `⚠️`. A
    `lite` or `full` decision removes the runtime's own `qa` `SKIPPED` in the same write, so the real
    QA after it is its first launch. It is not a `run_set` field.
  - `pipelineLoops{attempt, missing, fix, architect, retriage, stage, lastNext, fixPending, invalidated,
    pendingQaRow, counted}`: `nightqueue run check` only, what `NEXT:` needs to remember between checks: a
    cache of one attempt and nothing else; another attempt's cache is never read. On another attempt, or
    with no cache, the loops come from the last `decisions[]` record (every `invalidated` item any record
    holds, and `lastNext` only when that record's check was not run since on another text and no other
    memo was written at or after it: by `seq` when both carry one, else by an ISO `at`, and a memo whose
    order cannot be read counts as after), else,
    for a run with no record, the fix, architect, re-triage and fix-owed counts are replayed from
    `phases[]`. `missing` starts again on each attempt and
    counts per call, because a relaunch that wrote nothing must reach the still-missing row; a counted row
    (`counted{key, digest, next, unchanged}`, by check and digest) repeats on the same text and burns no
    iteration. The same text after another check ran relaunches that row's lane once, with a `note=` that
    its artifact did not change since the last check; a second unchanged text answers `publish --draft`, and
    on a stage row its `remaining=` names the stages not run. A late write is set aside like any other. It
    is not a `run_set` field.
  - `decisions[{check, digest, next, loops, at, seq, claim}]`: `nightqueue run check` only, the loop decisions
    a retry replays. One record is appended when `NEXT:` launches `coder-fix`, `architect` or `triager`, or
    when a loop fact it keeps changes (`fix`, `architect`, `retriage`, `stage`, `fixPending`, `invalidated`,
    `pendingQaRow`, `counted`); `loops` is the snapshot of those facts after the step. It is written with
    `pipelineLoops` in one write, append-only and stamped with the claim, and a re-run of a counted row on
    the same text appends none. A plain retry keeps it and `--fresh` starts over with the run directory. A
    late write is set aside like any other. `seq` is the one the record's own check memo takes, and a
    held count, stage or action outside its range or off the `NEXT:` grammar reads as none. It is not a
    `run_set` field, and the retry stall guard counts a new record as progress.
  - `prTemplate{source, path?, headings, at}`: `nightqueue run pr` (both the
    `--template` query and the publishing call), the template the body is checked
    against - `repo` with its path, or `nightqueue`.
  - `commitType`: `nightqueue run check 01` only, from the Brief's `**Commit type:**`
    (`run_set` does not take it).
  - `type`, `branch` and `worktree`: `run_set`; `nightqueue run check 01` also records
    the `type` (the Brief's, else derived from the triage when missing); the runner also records
    `type` from the `TYPE:` half of the slug declaration. A `tier`/`tierRaiseReason` an
    older runtime wrote stays in the file and is never read. Inside a queued job the runner records `branch` and
    `worktree` itself, before the spawn, when it creates the job's worktree; the pipeline
    sends them only in an interactive `/resolve`.
  - `terminal{status, prUrl, finishedAt, writtenBy, pid}`: the runner, once it has
    closed the job - the witness of the outcome, read only by the reconciliation.
  - `job{id, ref, projectKey, createdAt}`: the runner alone, ONCE,
    right after it creates the run directory and before it creates the worktree - so a job
    the worktree step gates still has it. `ref` is `J-<id>`, `projectKey` the project's key. A later attempt of
    the same job keeps the first block, a block of another job refuses the write, and a
    rename (`run check 01` or `SLUG:`) carries it along with the directory. `job` is runtime-only: `run_set`
    refuses `job` and every `job.*` name (``kept("`job` is written by the runtime only")``),
    and no pipeline write can change it. It is how a run knows itself without the database:
    the `run_*` tools and `nightqueue run` resolve a job's run from it when the row cannot be
    read.

  Nothing else of the file is touched, and the direction is never reversed - the row
  is rebuilt from the file, the file is never rebuilt from the row.

  A `state.json` exists from the spawn, so its existence no longer means the pipeline has
  started. **Run created** is a file holding the `job` block (and the runtime's `branch`
  and `worktree`) with no `phases` and no `outcome`; **pipeline started** is a file with a
  non-empty `phases` or an `outcome`. `nightqueue run log` refuses a run that was only
  created with ``the runtime created this run at <createdAt>; the
  pipeline has recorded no phase in <path> yet``, and a resume of it answers
  `invalid-state`, as before.
- `pending-writes.jsonl` in the same directory holds the writes a run could not make while
  the database was unavailable, one JSON line each, appended and fsynced under the lock
  `<runDir>/pending-writes.jsonl.lock`. An entry is
  `{"v":1,"key","kind","at","jobId","projectId","slug","payload"}`, and its key is fixed by its
  kind: `finish:<jobId>:<worker>`, `park:<jobId>:<worker>`, `telemetry:<jobId>:<worker>`,
  `run_facts:<jobId>:branch`, `session:<jobId>:<attempts>`, `measures:<jobId>:<attempt>`,
  `pipeline_log:<projectId>/<slug>:<at>` and `index_save:<projectId>:<at>` - a key already in
  the file is not appended twice. The writers are the runner's finish, park, telemetry, branch
  and session ids (the stream's session, queued per attempt; the slug a `SLUG:` line declares
  during an outage is not queued: the run keeps its slug and the job log says
  ``the run keeps the slug `<slug>`: … (the database is unavailable)``, while the `TYPE` is
  recorded in state.json anyway), the MCP `pipeline_log` and `nightqueue run index-save` inside a
  job, whose entry carries each file's modification time measured when it was queued. The file is
  replayed at the run's own finalize (right before its finish, while the row is still this
  claim's, and again after it), before every sweep of the orphans - a claim's and the preview of
  `queue run <id>` alike - by the maintenance and by a bare `nightqueue queue repair`:
  the entries apply in file order, and each gets a marker line
  `{"v":1,"applied":"<key>","at","result"}` with `result` one of `applied`, `filled`,
  `superseded` or `refused: <reason>`. A replay never demotes a row: a finish lands through
  the same `running` + worker guard as a live one, else it only FILLS a notice or a pull
  request the row lacks at the same status (`filled`), else it is `superseded` - a `done` or
  `closed` row is never rewritten. A `pipeline_log` entry is skipped when its run already
  logged since the entry's time, so applying twice changes nothing. A `session` entry only fills
  the row while the same claim runs it (`running`, same worker, same `attempts`) and never over
  a later attempt's session. A `measures` entry (the usage of an attempt the runner stopped on
  while the database was unavailable, or whose row a cancel or a sweep closed first) lands on
  the attempt row it names once - `superseded` when that row was already measured - and a
  finish that is `superseded` still lands the measures of the attempt it names the same way
  (`filled`). An `index_save` entry writes only the files and libs no save touched
  since the entry's time (a save in the same second counts as later), with the queued
  modification times, and is `superseded` when it wrote none. Once every key carries a
  marker the file is renamed to `pending-writes.<stamp>.done.jsonl` under the lock, so an
  append that races the rename starts a live file. A replay that meets the database still
  unavailable stops there and leaves the rest of the file untouched.
- Literals a runtime parses from the pipeline's stdout: `SLUG: <slug> TYPE: <type>`
  (the run renames itself), `## Requires user confirmation` (the narration marks a gate; it
  decides no ending), `## Notice` (the executive summary to deliver) and `QUEUE_SLUG:`, which
  **is deprecated in favour of `SLUG:`** and still read.
- Authority of each literal:
  - `SLUG:` - a standalone line, orchestrator text only. The FIRST valid declaration
    of the run wins and every later one is ignored, because a run is renamed once:
    the runtime renames the run directory it had already opened and re-points the
    row. A slug that is not a safe path segment, or one another run of the project
    already holds, is refused - the job keeps the slug the runtime gave it and the
    reason goes to the job log. `TYPE:` is optional and is recorded as the run's
    `type`. The shipped plugin no longer prints it - `run check 01` binds the slug
    from the triager's `**Slug:**` - and the runtime keeps parsing it for an older
    plugin.
  - `QUEUE_SLUG:` - the LAST standalone line wins. It is kept for a plugin older
    than the named prompt, which has no other way to bind its slug, and the runtime
    still asks for it in the prompt of a job whose row carries no run yet.
  - `## Notice` - read from the FINAL `result` event; an intermediate message that
    echoes an earlier one never wins. It is shown as `run_notice` and recovers a lost row
    (`queue repair --from-disk`); it never decides an ending and never fills `notice_md` of an
    attempt the runner classified.
- The prompt is the other direction of the same contract: `/nightqueue:<pipeline> <prompt>`
  (`jobs.pipeline`, a value outside `[a-z][a-z0-9-]{0,39}` refused at the prompt), the unattended
  line, then the runtime names the run before the first phase with `Project: <name>` and
  `RUN_DIR: <absolute path>` (the `QUEUE_SLUG` line on a first claim with no run), the job's origin
  block, the RUN FACTS block below and the `OPERATOR ANSWER TO THE GATE:` line of a note a job with
  no run directory holds. The open pull requests go to `<RUN_DIR>/origin/open-prs.md`, which the
  triager reads itself and the root prompt leaves out.
- **RUN FACTS block.** Printed whenever the job's run directory holds a readable state with at least
  one phase or one answer, re-read at each spawn, and the same for every pipeline:

  ```
  RUN FACTS (slug `<slug>`)
  RUN_DIR: <dir>
  Branch: <branch|none>   Worktree: <path|none>
  Recorded phases: triage · <verdict> · 01-triage.md · <at> | explore · … (or `none`)
  Wip commit: <short> (<n> files) | none
  Answers: 1. <at> — <text> | 2. … (or `none`)
  ```

  It carries records only, never a phase order, a next phase, a conclusion or an instruction: a
  field a phase did not record prints `-`. The decision of where to continue is the pipeline's own
  (`## Resume` of the resolve skill). Each text field is one line, capped like the operator note,
  with its markers escaped; the block has no total cap, since the runners run on macOS.
- The pull request of the run has two sources, in this order: the `outcome.prUrl` the runtime
  itself recorded in `state.json`, then the
  `{"type":"system","subtype":"code_change_published","url":…,"branch":…}` event the HOST emits
  when it publishes the change. The text of the stream is not a source. Only an event with
  `"action":"created"` publishes a delivery, and one session may publish for more than
  one repository: the run's own repository is the one of its FIRST publication. The run's own delivery is the LAST
  publication of THAT repository whose `branch` is the run's own branch - the `branch`
  of `state.json` or its published alias (`worktree-feat+x` is `feat/x`, and a job's
  `worktree-x` is `<commit type>/x` for any commit type of the pipeline, the rename
  `nightqueue run pr` applies and then records as the run's branch). A publication that
  names no branch, or that the run cannot compare because it recorded none, is unproven:
  it is the delivery only when the runtime recorded none. A publication naming ANOTHER
  branch - a QA's scratch pull request, say - is never the run's pull request, not even for
  lack of a better one, and no line names it any more; a row finished before this rule may still
  carry `⚠️ another pull request was published during this run and was NOT recorded as its
  delivery:`, which the notice reader strips. A publication for another repository, an event with
  any other `action` and a `url` of another shape are all ignored.
- The ending of an attempt is decided only from how the process ended and from `outcome` and
  `termination` in `state.json`, by the first matching row of the table in
  [Queue](queue.md): stopped, timed out, non-zero exit, then `done` with a pull request, `gate`
  with a notice, `no_change` with a notice, a termination, and `failed` with a notice starting
  `no outcome recorded:` for anything else. The record's `notice` is the job's notice. No heading,
  result text or `pipeline_runs` row takes part.
- A transient failure is read from the structured events of the last spawn, orchestrator only:
  the fields `is_error`, `api_error_status`, `subtype` and `errors[]` of the last `result`, and
  the `status` of the last `rate_limit_event`. It re-spawns at most `TRANSIENT_RESPAWNS` (2)
  times inside the claim and spends no attempt (see [Queue](queue.md)).

A notice holds only the job's own account: it carries no `Record:` line and a close appends
no `Closed:` line. The PR, the merge and the status are shown from the job's fields
(`pr_url`, `pr_title`, `close.data`, `status`); only a post-close `After close: ...` line for
a warning or skip is appended. The Discord thread reply is the whole notice, cut at the
embed limit with `…`.

The post-close steps of a close run in the order `ota` → `origin` → `log`, so what the
origin and the log tell carries the OTA outcome of the same run. `ota` is the only step that
runs a command, and its facts are fixed:
- it publishes only when the project's `expo.ota` is `true`; otherwise, and for a close without
  a code change, it is `skipped` and adds nothing to the budget;
- its own budget is 600 s, added to the 60 s post-close budget (and to the lease) only when
  `expo.ota` is `true`; every eas and git call of the step ends before that budget and before
  the post-close deadline, so origin and log keep their 60 s;
- `eas` (`NIGHTQUEUE_EAS_BIN`, else `eas` on the PATH) runs with an argv, never a shell, with
  an env stripped of every `NIGHTQUEUE_*` variable, in its own process group: a timeout or an
  interrupt kills the whole group, so no process it started outlives it;
- `expo.branch` is checked against the provider's branch pattern again at publish time; a
  value that fails it is a warning and nothing runs;
- it runs in a throwaway detached worktree at `close.data.mergeSha`, never in the checkout,
  with the checkout's `node_modules` symlinked in;
- the checkout root's untracked `.env*` files (listed by `git --literal-pathspecs ls-files`,
  gitignored ones included; not those of subdirectories) are copied into the worktree root,
  mode 0600, for the `EXPO_PUBLIC_*` values `expo export` inlines at bundle time; a tracked
  `.env*` keeps the merge commit's version; their content is never read into a note, a progress
  line or a log - a failed copy names only the file and the error code - and when the
  untracked files cannot be listed or one cannot be copied, nothing is published;
- the worktree, with the copies, is removed in a `finally` with no signal; an interrupted or
  overdue close waits for that removal (at most 35 s) before it ends; a process killed
  mid-publish can leave it under the OS temp dir for `git worktree prune`; a worktree that
  cannot be created posts the fixed reason `could not create the OTA worktree`, its detail kept
  in the local note only;
- it stores `close.data.ota = { status, branch, groupId, url, note }`: `status` is `done`,
  `warning` or `skipped`, `url` is the expo.dev update-group page or `null`, `note` is `null`
  on `done` and the reason plus the last 20 output lines on a `warning`;
- it never fails, stops or reverts a close: a throw, a timeout or a non-zero exit is a
  `warning`. A crash between the publish and the checklist write publishes again on resume.

These names are a machine contract, not prose: the pipeline files are the
source of truth for them, and any runtime that reads them must match them
exactly.

**The runtime is versioned, and never replaced under a live process.** An install
writes a new directory, `runtime/versions/<version>-<stamp>/`, and publishes it by
pointing `runtime/current` at it with a single rename, so no instant leaves the host
without a runtime and a failed install never touches the link. The shims, the MCP
server, the hooks, the Claude Desktop entry and the plugin marketplace all name
`current`, so they follow the switch without being rewritten. A process that is already
running keeps the directory it loaded from - the old version stays on disk, and the
runner records its path in its registration. After a successful switch the install keeps the
last two version directories and deletes the rest, never the one `current` names nor any one
a live runner is running from, whichever version each of them loaded. An installation made before this layout, directly
under `runtime/node_modules/`, keeps working and is never deleted by an install.

**`setup`, `setup --from`, `update` and `init` refuse to replace the runtime while it
is in use.** When ANY registration of the registry is alive or a job holds a live lease,
they exit `1` with `a runner is active (pid P / pid Q / J-N) - the runtime cannot be
replaced while it runs; stop it with nightqueue queue run --stop or wait for the queue to
drain`, naming every live pid, and install nothing. `--force` installs anyway and says so on stderr. A runner whose version
directory disappears anyway - a `--force`, or a hand-deleted tree - stops claiming,
finishes the job it is running and exits saying so.

**Any number of runners own the queue together.** Every start registers its runner under
the home lock, in the same critical section as the prune of the dead registrations:
`queue run`, `queue run --watch`, `queue run --job`, `queue add --run`, `queue retry --run`,
their `--foreground` forms and the `queue_run` and `queue_retry` MCP tools. None of them is
ever refused because another runner is live. Each runner works one job at a time; parallel
jobs come from several runners. A single-job start whose job could not be
claimed right now answers `waiting` with the reason and starts nothing, because its child
would run one cycle and exit without claiming; `queue_run` and `queue_retry` answer the same
thing as `{ "started": false, "waiting": { "reason": "cap-reached" }, "message": ... }`, a
reason that only happens when `queue.maxConcurrent` is set, since there is no ceiling by
default. `queue_status` answers `runners` with every live runner; the singular `runner` key
of 0.2.0 is gone since 0.7.0. `queue_status`, `queue_run` and `queue_retry` also answer
`advisories`, the advisory lines described in [Queue](queue.md); they never block a start.

**A runner outlives an unavailable database.** When the database answers a classified error
(see [Memory](memory.md)) the runner prints ONE line, ``nightqueue: the database is unavailable
(<code> at <home>): claims and sweeps retry every 30 s, doubling to 5 min; the running job keeps
going - run `nightqueue doctor --fix` ``, and retries its start, its claims and the store steps
of the job in hand before the spawn at 30, 60, 120, 240 and then every 300 seconds; it never
exits for it, and a stop signal still ends it. The child is never stopped: the heartbeat keeps
renewing the lease at its own cadence, and a renewal the database refuses means "unknown",
never "ownership lost". The first renewal that lands - or, while the job waits before its spawn,
a probe at the heartbeat cadence - renews the running job's lease AT ONCE, before any backoff
timer and before any sweep, prints `nightqueue: the database is reachable again` and wakes the
wait. The steal rule is unchanged: a lease is taken over only when it expired AND its pid is
dead or the job is past the hard ceiling, so an outage shorter than that never costs the job.
Writes the job cannot make meanwhile go to its `pending-writes.jsonl` (above); a finish that
could not be recorded keeps the worktree and writes the witness, and the report says
`unrecorded` with the pending path.

The HTTP surfaces - `nightqueue mcp --http` and `nightqueue studio` - bind `127.0.0.1` only
and share one gate: the `Host` must be a single loopback authority, an `Origin`, when sent,
must be a single loopback origin, and then the per-start token is required on every request.
`mcp --http` takes the token only as `Authorization: Bearer <token>`. The studio also takes it
as a cookie, because a page load, its assets and `EventSource` cannot send that header: the
URL it prints carries the token once as `?t=<token>`, and a GET with a valid `t` answers
`303` to the same target without `t` and `Set-Cookie: nq_studio_<port>=<token>; Path=/;
HttpOnly; SameSite=Strict` (one cookie name per port, so two studios on one host never share
one). A request that changes state (`POST /mcp`, `POST` or `DELETE /api/*`) authorised by that
cookie must also carry an `Origin` equal to the studio's own `http://127.0.0.1:<port>` - or the
`--dev-origin` of an `--api-only` studio - exactly, port included, since `SameSite` does not
tell two loopback ports apart; a bearer request keeps the loopback rule alone. The `/mcp`
endpoint stays stateless either way: the cookie is one more header checked in front of it.

The studio's one WebSocket, `/term/<id>`, is an RFC 6455 upgrade on that same server, with no
`ws` dependency, and its gate is stricter than the HTTP one. In order: the loopback gate
(`403`), the token by cookie or bearer (`401`), then an `Origin` equal to one of the studio's
own origins - or the `--dev-origin` of an `--api-only` studio - exactly, for the cookie AND the
bearer caller alike, an absent `Origin` included (`403`). Then the path must be
`/term/<16 hex>` (`404`), the handshake must be version 13 with a valid key (`400`) and the
terminal must be live (`404`). Every refusal, and any upgrade on another path (`/events`,
`/mcp`, ...), is a short HTTP answer with a JSON `{error}` and `Connection: close`; a plain GET
on `/term/...` is a `426`. The answer never negotiates an extension nor a subprotocol. Binary
frames carry the pty's bytes both ways; the one text frame understood is
`{"resize":{"cols":<2-500>,"rows":<1-200>}}`, any other text is ignored. A frame not masked,
with a reserved bit or a bad control frame closes with `1002`, a message over 1 MiB with
`1009`, invalid UTF-8 text with `1007`. The newest attach to one terminal wins: the older
socket closes with `4001 attached elsewhere`. When the child exits its socket closes with
`1000 exited <code>`. Upgraded sockets are tracked by the server, and `close()` sends each one
`1001 studio closing` and ends it. The CSP `connect-src` lists the `ws://` form of every
allowed origin.

The terminals themselves live in memory; each child is the runtime's CLI
(`nightqueue open` or `nightqueue queue session`), which starts `claude` in its own process
group. Each one also writes a registration file `<home>/studio/terminals/<port>-<id>.json`
(`id`, `port`, `owner_pid`, `pid`, `lstart`, `bin` (node), `entry` (the CLI path), `kind`,
`job_id`, `project`, `created_at`), removed when its child exits. A starting studio reaps those
files before it answers: an unreadable file, or one without `bin` or `entry`, is removed; a
file of another port whose `owner_pid` is alive is kept; every other file is removed, and its
pid's process group is sent `SIGHUP` (then `SIGKILL` after 2 s while the group lives) only when
a start time was recorded and `ps -ww -p <pid> -o lstart= -o command=` shows that same start
time and a command line containing the recorded `entry`, so a recycled pid, a registration
without a start time, or the operator's own `nightqueue open` in a shell is never killed. It
prints `studio: reaped N terminal(s) left by an earlier studio` when N > 0.

**The studio's narration wire and job artifacts.** The job stream (`/events?job=<ref>`)
narrates in a rich mode the CLI never uses: `nightqueue queue log` gets the same lines,
byte for byte, as before. On the wire, every narration event carries the fields `laneId`, `body`,
`body_truncated`, `body_offset`, `at`, `artifact`, `title` and `bytes`, `null` (or `false`)
when they do not apply.
- `text` (orchestrator or lane) has its whole text as `body`. A `toolError` has the last 40
  lines of the tool's output.
- A `laneClose` has the `summary` of the subagent's `task_notification`. Without one, it falls
  back to the report its Task `tool_result` handed back before the close, with the harness
  frame, the two-space indent, the `agentId:` line and the `<usage>` block removed. With
  neither, it is `null`.
- A body is capped at 32 KiB of UTF-8, cut on a code point boundary. When the cap cuts it,
  `body_truncated` is `true` and `body_offset` is the byte offset of its line in the job log.
- Every event inside a lane carries the lane's `laneId`.
- A `phase` event (`phase`, `agent`, `model`, `at` as ISO time) comes right before the event
  that enters a phase. Those events are an attempt (phase 0), a lane opening for a pipeline
  agent, and an orchestrator `nightqueue run start|publish|report` (0, 7, 8). A log with no
  attempt line opens phase 0 before its first event.
- A `report` event (`artifact`, `title` as the file's first markdown heading, `bytes`)
  follows a `nightqueue run check <NN>`, mapped to its phase artifact, or, in an old log, a
  `run_phase_done` naming a `*.md` basename. It is emitted only when the file is in the job's run directory,
  and once per artifact per phase. A stream opened before the job had a run slug re-reads
  the row once per batch that holds such a signal, so its reports still arrive.

`GET /api/jobs/<ref>/artifacts` answers `{artifacts: [{name, bytes, title, mtime}]}` for the
regular, non-dot `*.md` files of the job's run directory, sorted by name. The list is `[]`
while the job has no run directory, and an unknown job is a 404.
`GET /api/jobs/<ref>/artifacts/<name>` serves one of them as
`text/markdown; charset=utf-8` with `no-store` and `nosniff`, up to 1 MiB cut on a code point
boundary, adding `x-nightqueue-truncated: 1` when cut. The decoded name must be in a fresh
listing: a symlink, a directory, a dotfile, `state.json` or a name that leaves the directory is
a 404, and a malformed escape is a 400. `GET /api/jobs/<ref>/log?from=<byte>` answers up to
1 MiB of the log from that byte, and empty past its end. A `from` that is not a non-negative
integer is a 400. Without `from` the route answers the last MiB, as before. All of these are
read-only and sit behind the same token gate as the rest of `/api`.

**Spawn profile.** Every `claude` argv nightqueue builds comes from one declarative builder,
`profileArgs({ kind, ... })` in `src/queue/session-profile.mjs`, a module with no imports; each
caller computes the environment-dependent values (settings object, MCP config, plugin dir, agent
body) with its own helpers and passes them in. A kind declares its defaults and its flag order,
kept per kind so the argv stays byte-identical to what each launcher built before:

| Kind | Caller | Permission mode | Setting sources | Strict MCP | MCP config | Settings from | Stream JSON | Prompt form |
|---|---|---|---|---|---|---|---|---|
| `job` | `buildArgs` (spawn.mjs) | `bypassPermissions` | `project` | yes | `mcpConfigArg(env, jobId)` | `jobSettings` | yes | `-p <prompt>`, then `--model <alias>` only when the project routes the orchestrator |
| `merger` | `mergerArgs` (merger-spawn.mjs) | `acceptEdits` | `project` | yes | none | `mergerSettings` | yes | `-p <prompt>`, `--agent nightqueue:merger`, `--tools Read,Edit` |
| `operator` | `operatorArgs` (host/operator.mjs) | `default` | `user,project,local` | no | `mcpConfigArg(env, null, { operator })` | `operatorSettings` | no | interactive operand (the opening prompt, `--prompt`, or none on a bare `--resume`) |

With `queue.inheritUserEnvironment` on, a job drops `--strict-mcp-config`, `--setting-sources` and
`--settings`. An unknown kind throws.

**Operator sessions.** `nightqueue open` (and `nightqueue queue session`, and a studio
terminal through them) starts `claude` with `NIGHTQUEUE_MODE=operator`,
`NIGHTQUEUE_OPERATOR_PID=<pid of the launcher>`, `NIGHTQUEUE_OPERATOR_SESSION=<a ULID minted
per launch>` and, only when a project is preselected, `NIGHTQUEUE_PROJECT=<project id>`; an
inherited value of any of them is dropped first, and the runner strips them all from every job
it spawns. The same session id, `NIGHTQUEUE_MODE` and the pid are pinned explicitly in the MCP
server's env inside `--mcp-config` (a job's MCP env never carries them), and the argv pins
`--permission-mode default` (a job keeps `bypassPermissions`). `nightqueue open` runs in the home, never
in a checkout; a hook resolves the session's project from its directory, else from
`NIGHTQUEUE_PROJECT` (never inside a job, and only for a well-formed id), and SessionStart then
leads its block with `Current project (preselected by nightqueue open): <name>`. In operator mode only (never in a
job or a plain session) the block also carries `## Registered projects`: one line per project,
`name · key · <n> pending`, the pending count read from `jobs` in one SQL query (no runner tail,
no gh), the preselected project first, the rest by name, capped at 30 lines plus
`… and <n> more (nightqueue project list)`; it is present even with no preselected project, so the
operator's opening message needs no tool call. The section ends with `Runners online: <n>`, the
live queue workers of the runner registry (a readdir of the runners directory and a signal-0 pid
probe each; no log tail, no gh), omitted when the registry cannot be listed. The session's
`--settings` are the jobs' settings with two changes, neither of which reaches the host's
`settings.json` (`desiredHooks` and the doctor hook check are unchanged, so an edit in any other
Claude session never spawns a hook): the PreToolUse matcher becomes
`Agent|Task|Bash|Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit`, and `permissions.allow`
pre-approves `mcp__nightqueue__*`, `WebFetch` and `WebSearch` only: the operator reads the web
(a linked page, an issue, a library's docs) without a prompt; the guard does not judge those
two tools, since they neither edit nor execute. Edit, Write and Bash are never pre-approved.
The person's own MCP servers (loaded through the `user` setting source) are reachable and never
pre-approved: the guard passes every `mcp__<server>__` tool but nightqueue's to the host prompt.
The operator agent's `disallowedTools` also drops `RemoteTrigger`, which only a claude.ai login
exposes.

The `agent-foreground` hook in operator mode is the operator guard. Each refusal is a PreToolUse
`deny` whose reason is one line starting `operator guard:`, naming what is allowed instead; it never moves
a call to the foreground; an allowed call answers nothing (never `allow`), so the host's
permission prompt still applies. Every call of the main thread and of every subagent (a payload
with `agent_id`/`agent_type`) is judged in one order: a malformed call; the reads (`Read` is the
operator's only file tool, since Claude Code 2.1.3xx ships neither `Grep` nor `Glob`, which the
guard still judges when a host ships them; anything on
disk but `<home>/secrets.json` and any `.env*` file, never a Grep whose `path` is the home or a
parent of it, nor a path that cannot be resolved; an absolute Glob `pattern` or Grep `glob` is
judged by its static prefix); `Agent`/`Task` (main thread), allowed for every plugin agent but
the operator under `nightqueue:<name>` or `plugin_nightqueue_<name>` (`PIPELINE_AGENTS`; a bare
name, `nightqueue:triage`, `nightqueue:qa` are refused); the writes; then Bash. A write or a Bash
command lands in one of three bands:

- **never**, refused with `operator guard: never (<what>)` even when a consent would match:
  a write under the home, the Claude config dir, `~/.codex`, any `.claude/settings*.json` or
  `.codex/`, or a `.env*` file; a Bash command any segment of which (split on unquoted `;`,
  `&`, `|`, `(`, `)`, newline, `$(` and backtick, env assignments and wrappers such as `sudo`,
  `env`, `xargs`, `timeout <n>` skipped) deletes files (but one `home-maintenance` entry),
  force- or delete-pushes, runs
  `git branch -D|-d`, `reset --hard`, `clean` or `rm`, is a refused nightqueue form (every
  refused top-level command but `verify` and `sandbox <cmd>`, plus `sandbox worktree`,
  `queue session`, `project add|move`, `queue add --run`, `--follow`,
  `--foreground`), runs `sh -c`/`eval` text, names the home (but a `home-maintenance` entry,
  a salvage source or a worktree read), or names a `.env*` or
  `secrets.json` path (a `<rev>:<path>` included). A relative path word is resolved only after
  an explicit `cd` in the command. A home path counts only absolute or as `~/.nightqueue/…`,
  with no `.`/`..` component, reached through no link; `$HOME`/`$NIGHTQUEUE_HOME` stay never.
  A delete, `git worktree remove` or salvage whose entry is held is never:
  `<path> belongs to J-<n> (<status>)` for a `pending`, `running`, `gate` or closing owner (the
  owner matched by slug, `start_worktree` or run-state `worktree`), a running job of the project
  with no slug yet, a worktree locked by a live pid or by hand, or `who holds <path> cannot be
  checked` when the queue cannot be read; salvage also refuses a `done` or `failed` owner. A
  `done` owner with a pull request holds its entry until `gh pr view` (3 s for the whole
  decision, inside the hook's 5 s; the pull requests one command names are read once each, in
  parallel) answers merged or closed: `<path> belongs to J-<n> (done, pull request <url> is open)`,
  `is a draft`, `has conflicts` or `could not be confirmed merged or closed: <why>` (gh missing,
  failing or slow, `NIGHTQUEUE_NO_PR_CHECK=1`, a non-GitHub URL); a `done` job with no pull
  request does not hold. The
  check runs on every guard call and when the consent is recorded. A home path is judged as the
  entry stored on disk, so a case variant (`.../FIX-LOGIN` on a case-insensitive volume) names its
  owner too. `git worktree remove|move` whose worktree is not an absolute literal path (`.`, a
  bare name, `../…`, a link) is never in every spelling, and so is `doctor --fix` spelled other
  than `nightqueue doctor --fix` (`/abs/bin/nightqueue`, `bin/nightqueue.mjs`) or behind any
  wrapper but a leading `timeout <n>` (`env`, `nice`, `sudo`, `FOO=1`, `stdbuf`, `sh -c`). A git
  global option other than `-C <dir>`, `--no-optional-locks`, `--no-pager` and the exact pairs
  `-c core.fsmonitor=false`, `-c core.hooksPath=/dev/null` is never (`--config-env`,
  `--attr-source`, `--git-dir`, `-c <other>`, `--`, `--version`, an unknown flag), behind every
  wrapper. A read of a job worktree under the home in any spelling but the hardened one below is
  never. Any command with an unquoted `(` or `)` (outside `'…'`, `"…"` and `$'…'`; `"$(x)"`
  counts as unquoted) is never, checked on the raw command for every thread, consented commands
  and the `cd <dir>` anchor included, and refused as a consent scope: zsh runs a program through
  `=(…)` and glob qualifiers `*(e:…:)`. Any command with an unquoted `#` is never at the same
  points, since zsh reads it as a comment that drops the rest of the command, or as a pattern
  operator under EXTENDED_GLOB (`'#'` and `"fix #12"` stay allowed). Any command with a blank
  other than space or tab outside quotes (form feed, vertical tab, no-break space, U+2028, …) is
  never at the same point: zsh keeps such a blank inside a word, and the guard would split there.
  Any command with a control character other than a tab or a newline, quoted or not, is never at
  the same point: zsh cuts a word at a NUL byte, so it would run a shorter word than the one
  judged (`-C <outside>\0/../<checkout>`). Any command with an unquoted `^` anywhere in a word is
  never like `#`: under EXTENDED_GLOB zsh reads it as a pattern operator (`--^x` expands to the
  cwd's file names opening with `--`, `HEAD^` to `HEAD…`); `'^main'` and `"HEAD^"` stay allowed.
  The orchestrator's closed list refuses such a blank, control character and `^` too, and a
  backslash outside single quotes, which zsh removes or reads as an escape. A git command run after a
  `cd` into a job worktree is never, and its reason names `git -C <worktree>`. A `git grep` that is not the hardened free spelling is
  never: without the hardening pair and `--no-lazy-fetch` in that order, once each (the reason
  shows the spelling), with any other global option (`--no-optional-locks`, `--no-pager`), with
  an option off its exact allow list (`-O`, `-f`, `--textconv`, `--no-index`, `--untracked`,
  `--ext-grep`, submodules, any abbreviation), with any revision word before its real `--` (a
  ref, `HEAD`, `HEAD~n`, `'HEAD@{n}'`, an object id, `<rev>:<path>`, or a path written there),
  without the exclusion pathspec
  `':(top,exclude,glob)**/.env*'` after its real `--`, or with a backslash, a `$`, or an
  unquoted glob, brace or leading `^` before its real `--`. `--no-lazy-fetch` on any other git
  subcommand stays never.
- **free**: the main thread's one bare
  `nightqueue|nq <queue|project|org|connection|doctor|memory|lesson|libs|version> …` (not
  `queue session`, `project add|move`, `queue add --run`, `doctor --fix`, `--follow` or
  `--foreground`) or read-only `git -C <checkout> …`, also at the root of a job worktree under
  the home (`stash list` included) while its `.git` points to the admin dir git keeps for it in
  the checkout's `.git/worktrees` (else never: git would run a configuration the job controls),
  spelled only `git -C <worktree> -c core.fsmonitor=false -c core.hooksPath=/dev/null
  [--no-optional-locks] <read>`, `status` and `diff` with `--ignore-submodules=all`, never another
  `--submodule*`, `--ignore-submodules*` or `--recurse-submodules*` argument nor an abbreviation
  or negation git accepts for one (`--ignore-submod=none`, `--recurse-submod`);
  `grep` is a read only as `git -C <checkout|worktree> -c core.fsmonitor=false
  -c core.hooksPath=/dev/null --no-lazy-fetch grep [--cached] <options> <pattern> -- [<paths>]
  ':(top,exclude,glob)**/.env*'` (or `cd <checkout> && git -c core.fsmonitor=false
  -c core.hooksPath=/dev/null --no-lazy-fetch grep … -- ':(top,exclude,glob)**/.env*'`), the
  working tree or `--cached` only, never a revision (history: `git log -S<text>`,
  `git show <rev>`), full option names, OR as `-e a -e b`, globs and
  parentheses quoted; no free command holds an unquoted `* ? [ ] { }` or `^`, which zsh
  expands, so a revision is written `git show 'HEAD@{1}'` and the refusal says to quote it;
  a subagent's one bare `nightqueue|nq` read
  (`queue status|log`, `project list`, `org list`, `connection list`, `memory stats`, `doctor`
  without `--fix`, `libs`, `version`), the `git -C` reads (also as
  `cd <checkout> && git <read>`), `gh pr view|diff|checks|list|status` or `gh issue view|list`.
  Every top-level CLI command is classified as allowed or refused in one list, and so is every
  subcommand of `queue` and `project`; a test keeps both exhaustive.
- **consent**: a write is `edit` (an existing path, inside a registered checkout, else refused)
  or `create` (a new path); any other Bash is `git-write` (a git subcommand neither read nor
  never) or `run`, and must be one bare command as `cd <registered checkout> && <command>`,
  `git -C <registered checkout> <command>`, or bare from a cwd inside a checkout (any git global
  option but `-C <dir>`, `--no-optional-locks`, `--no-pager` and the two hardening `-c` pairs is
  refused; git, `doctor --fix` and home maintenance run as one bare command, never behind `env`,
  `nice`, `sudo`, an env assignment or another wrapper, nor git spelled by its path, both as a
  request and as a consent scope; only `timeout <n>` may lead). It passes only
  when a live consent of the session covers it, else
  `operator guard: needs consent (<kind> <scope>): …`. `nightqueue doctor --fix` (spelled so)
  is a `run` from any directory, covered only by a `run` consent whose words name `--fix`.
  `home-maintenance` is one bare `rm`/`rmdir`/`unlink`/`shred` of one run dir or worktree
  (`<home>/runs|worktrees/<project id>/<slug>`), `find <entry> -delete`,
  `git -C <checkout> worktree remove [-f] <absolute worktree path>` or
  `git -C <checkout> worktree prune` (also `cd <checkout> && …`; the git dir is always the
  project's checkout, never a worktree), never `git-write`; salvage from a worktree is
  `git -C <worktree root> format-patch` (`git-write`, its `.git` pointing to git's admin
  dir) or `cd <checkout> && cp <worktree>/… …` (`run`); `git stash` of a worktree under the
  home is never (it runs the clean filter of a nested repo the job planted). A `home-maintenance` or doctor `--fix`
  request on a subagent thread is never.

Consents live in `<home>/operator/<NIGHTQUEUE_OPERATOR_SESSION>.jsonl`, append-only, one JSON
event per line: a grant `{at, session, pid, project_id, project, kind, scope, reason, answer}` or
a revoke `{at, revoke: true, project_id, kind, scope, answer?}`; the live consents are the grants
no later revoke of the same project, kind and scope withdrew. A missing file is no consent, an
unparsable line is skipped, any other read error fails closed. Each event appends one line to
`<home>/logs/operator-<session>.log`. Coverage is never widened: a path consent covers its
canonical path and what lies under it (a symlink resolving into the never band stays never); a
command consent covers a command run in its project's current checkout whose words, after
`git`/`-C <dir>` and a leading `timeout <n>`, open with the consent's words (a `git-write` dir
may also be the project's worktree under the home); a `home-maintenance` consent covers its
exact words only, its entries in its own project and its git dir in that project's checkout;
a
`connection-write` consent covers one exact `<connection> <METHOD> <path>`. Without a session id
(no `nightqueue open`, or inside a job) there are no consents. The record is the audit and the
guard; the host's prompt is the barrier.

The guard fails closed: an error inside it refuses every tool but `Read`/`Grep`/`Glob`, an
`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash`, `Agent` or `Task` call whose `tool_input`
is not an object is refused, and a registry it cannot read refuses `git -C`.
Job mode is unchanged and still fails open.

In an operator session the MCP server's instructions replace the tools-only line with the
three-band line and add one line on `connection-write`; any other client sees them unchanged.

The thirty MCP tools of tool contract 15, with the parameters `nightqueue mcp` actually
accepts (every answer carries `contract: 15`; a call to a tool an older contract had and this one
dropped is answered with the older-definitions line; contract 13 removed `phase_prompt`, whose refusal
names the block of `## Phase prompts` of the resolve SKILL to launch from; contract 14 removed
`run_phase_done` and `run_skip`, renamed `context_for_phase` to `context_for_agent` with `agent` for
`target`, whose refusal names the new tool, and reads the `phase` of `run_terminate` from the manifest
of the run's pipeline; contract 15 added `allow_draft` and `allow_revert` to `queue_close`):

| tool | parameters |
|---|---|
| `lesson_recall` | `query?`, `project?`, `target?` (a lesson role the installed manifests declare), `exclude_ids?` |
| `context_for_agent` | `agent` (a role the installed manifests declare, in their order: today `triager`, `architect`, `coder`, `qa`, `verifier`, `explore`, `reflector`), `query?`, `project?`, `slug?` (`reflector` outside a job), `repo_root?`, `exclude_ids?` |
| `lesson_save` | `title`, `root_cause`, `solution`, `prevention`, `attempts?`, `project?`, `target?` (a lesson role the installed manifests declare, else refused naming them; a title the owner already has bumps its `attempts`; answers `deduped` and `violated` - `true` only inside a queue job, on a dedup onto a lesson this run was given, which also bumps the lesson's `violated`) |
| `memory_recall` | `query?`, `project?` |
| `lesson_delete` | `id` (`L344` or the plain number), `project` (name or key): deletes one lesson and its search entry; an unknown id or another project's is refused; refused inside a queue job; answers `{id, ref, title, project}` |
| `memory_delete` | `id` (`M446` or the plain number), `project` (name or key): deletes one memory and its search entry; an unknown id or another project's is refused; refused inside a queue job; answers `{id, ref, key, project}` |
| `memory_save` | `key`, `value`, `project?` (a key the owner already has is kept, never overwritten: answers `deduped: true` with the stored value; answers `{id, ref: "M<id>", project, deduped, value}`; allowed inside a queue job) |
| `index_save` | `project`, `repo_root`, `files[{path, responsibility}]`, `libs?[{lib, version}]` |
| `index_recall` | `project`, `repo_root?`, `query?` |
| `pipeline_log` | `outcome`, `project?`, `slug?`, `task_type?`, `gate_stop?`, `duration_s?`, `phases?` (accepted and ignored: the phase rows come from the run's `state.json`, with their recorded `note` and `reason`; inside a job a run already recorded in this attempt answers `already_recorded: true` and adds no row; outside a job, or in a job with no recorded attempt start, so does a run whose last record carries the same outcome and phase count; the operator's outcomes add a row per call) |
| `queue_add` | `project?`, `prompt`, `cwd?`, `register?`, `key?` (with `register`), `title?` (one line, at most 120 characters; blank is none), `priority?` (1-9), `timeout_s?` (60-86400), `origin?` (a list of `{kind, ref}`; omitted or null detects every recognised link of the prompt, `[]` is none; the old `{kind, ref}` or `false` is refused as an older client, contract 6); a `max_attempts` with a value is refused as an older client, contract 11 (a prompt that depends on another job or pull request is refused before anything is registered or queued; see "A job is self-contained" below) |
| `project_register` | `cwd`, `name?`, `key?`, `org?` (registers the repository of `cwd`, a linked worktree as its main checkout, only after the person said yes; answers `{registered, project, key, org, path, hint}`; nothing is queued) |
| `project_integrations` | `project`, `action` (`show`, `set`, `unset`), `key?` (`<kind>.<setting>`, required by `set`/`unset`), `value?` (text, required by `set`) (answers `{project, integrations, providers: [{kind, keys}]}` with the settings each provider of the build declares; `set` validates against the provider, `unset` of the last key leaves the project without integrations; `set`/`unset` refused from inside a job; never a secret) |
| `tracker_issues` | `team?` (the tracker's team key), `project?` (the tracker's project name), `state?` (`open` default, `closed`, `all`), `limit?` (1-50, default 25), `include_filters?`, `text?` (title or description contains it, case-insensitive, at most 200), `label?` (one label name, exact, case-insensitive) (read-only, the home's Linear connection, no nightqueue project; answers `{ok: true, provider, items, truncated, filters?}` or the normal answer `{ok: false, error: "no-connection" \| "provider-unavailable", hint, provider}`; filters cached five minutes) |
| `tracker_read` | `ref` (an issue reference or link) (read-only, allowed inside a job; answers `{ok: true, provider, issue: {ref, title, url, team: {key, name}, project, state: {name, type}, priority, priorityLabel, assignee, labels, parent, description, description_truncated, attachments, comments, comments_truncated, createdAt, updatedAt}}`, an empty field as `null` or `[]`, up to 50 comments returned oldest first, each cut at 10,000 characters, `comments_truncated` true when there are more, the description cut at 50,000; or the normal answer `{ok: false, error: "no-connection" \| "invalid-input" \| "not-found" \| "provider-unavailable", hint, provider}`) |
| `tracker_create` | `team`, `title` (at most 255), `description?` (at most 50,000), `priority?` (0-4), `state?`, `labels?`, `assignee?` (a name, display name, email or `me`) (writes only after the person's explicit ok; refused inside a job before anything is sent; answers `{ok: true, provider, issue: {ref, title, url}}`; an unknown or ambiguous name is `invalid-input` with the valid names and nothing is sent) |
| `tracker_comment` | `ref`, `body` (at most 50,000) (writes only after the person's explicit ok; refused inside a job; answers `{ok: true, provider, ref, comment: {url}}`) |
| `tracker_update` | `ref`, `title?`, `description?` (replaces the whole text), `priority?`, `state?`, `assignee?` (`none` unassigns), `labels_add?`, `labels_remove?` (writes only after the person's explicit ok; refused inside a job; answers `{ok: true, provider, issue, changed}`; a write that timed out or was not confirmed answers `provider-unavailable` with a hint to read the issue before trying again; no tracker tool deletes or archives) |
| `connection_call` | `connection` (a stored connection's name), `method?` (`GET` default, `POST`, `PATCH`, `PUT`; any other, `DELETE` included, is `invalid-input`), `path?` (at most 2,000; relative to the root: a scheme, a leading `//`, a `.` or `..` segment, `\`, `?`, `#`, whitespace or an encoded `.`, `/` or `\` is `invalid-input`), `query?` (an object of text, number, boolean or list of texts), `body?` (JSON, at most 50,000 characters serialized, never on a GET) (the runtime injects the secret and the host is fixed by the kind: Sentry `<url>/api/0/`, Linear `https://api.linear.app/graphql` with an empty path and the GraphQL in `body`, Discord the webhook URL itself with an empty path (GET or POST) or exactly `messages/<id>` (GET or PATCH, to read or edit a posted message), and only `thread_id` and `wait` in `query`; a redirect is never followed; 10 s timeout; answers `{ok: true, status, body, body_truncated?}` with the body redacted then cut at 50,000 characters, or the normal answer `{ok: false, error: "no-connection" \| "invalid-input" \| "provider-unavailable" \| "needs-consent", status, detail}` with a fixed detail, never the provider's message, the URL or a header; a GET reads, any other method only after the person's explicit ok to the exact connection, method, path and body; a non-GET is refused inside a job before anything is sent, a GET is allowed; in an operator session a non-GET with no live `connection-write` consent covering it answers `needs-consent` and sends nothing) |
| `operator_consent` | `kind` (`edit`, `create`, `run`, `git-write`, `home-maintenance`, `connection-write`), `scope` (at most 2,000: an absolute path for edit/create, one bare command for run, a writing git subcommand for git-write, the exact command removing one run dir or worktree, or `git worktree remove|prune`, for home-maintenance (refused naming the job that still holds the entry), `<connection> <POST\|PATCH\|PUT> <path>` for connection-write), `project?` (required but for connection-write), `reason?` and `answer?` (the person's answer quoted verbatim; both required on a grant), `revoke?` (records the person's consent in `<home>/operator/<session>.jsonl` and one line in `<home>/logs/operator-<session>.log`; a never-band scope, a revoke that matches nothing, a call inside a job or outside an operator session are refused; answers `{ok: true, consent, line}` or `{ok: true, revoked, line}`) |
| `queue_status` | `job_id?`, `pr_url?` (never with `job_id`), `limit?` (1-50) |
| `queue_run` | `job_id?` |
| `queue_stop` | `pid?` |
| `queue_session` | `job_id` |
| `queue_cancel` | `job_id`, `reason?`, `stop?`, `release_worktree?` |
| `queue_close` | `job_id`, `force?`, `allow_draft?`, `allow_revert?` |
| `queue_retry` | `job_id`, `note?`, `fresh?`, `run?` (a `closed` job, or a `done` job whose pull request is merged, is refused: a finished job does not resume; with neither `note` nor `fresh`, a run with no new phase and no new answer in its last two attempts is refused too) |
| `run_terminate` | `phase`, `reason`, `project?`, `slug?` (commits the recorded worktree's changes as the wip commit unless the worktree is adopted or on the default branch, the main checkout's branch or a detached HEAD; answers the record plus `wip{status, commit, branch, files, reason}` and `notice`, the paragraph that opens with `Terminated run: ` and carries `Retry: nightqueue queue retry J-<id>` inside a job and `New job from it: start_branch: <branch>`; a repeated call keeps the same wip commit, adopted through its `refs/nightqueue/wip/<slug>` ref even when the first call's record was refused; a refused phase or empty reason commits nothing) |
| `run_outcome` | `status` (`done`, `gate`, `no_change`), `notice?` (required with `no_change`), `question?` and `from_artifact?{file, section}` (`gate` only, never with `notice`: the runtime composes the whole `## Notice`; see "A gate notice is composed from the record" below), `project?`, `slug?` |
| `run_set` | `type?`, `branch?`, `worktree?`, `project?`, `slug?`; a `qa_stage_a` with a value is refused as an older client, contract 12, and `answers` or `lastClaim` as written by the runtime only |

The five `run_*` tools are the only way the pipeline records its run (see the
`state.json` list above). Inside a job each of them resolves the run from the job's
own row, and a `project` or a `slug` sent there is REFUSED instead of silently
overridden - naming another job's run from inside one is never an accident worth
guessing at; outside a job both are required. A row that carries no slug yet is
answered with the `SLUG:` line to print, never with a guessed run directory.

**A terminated run keeps its work.** `run_terminate`, and the runner at the finish of a job
that ended `cancelled` by itself (never an operator stop, a `failed` or a `done` ending),
commit the worktree's changes on the job's branch as one local commit
`wip(<slug>): terminated at <phase> — <first line of the reason, at most 120 characters>`.
That commit runs no repository hook (`core.hooksPath=/dev/null`) and is never pushed. It takes every path git does not
ignore except those under a `tmp/` or `.claude/` segment (the same rule as `run publish`). A
second terminate of the same run amends it. In the same step as the commit the runtime writes
the ref `refs/nightqueue/wip/<slug>` naming it; when that write fails the commit is undone and
`wip` is `failed`, so a runtime wip commit exists only while a `refs/nightqueue/wip/*` ref names
it. An amend drops every other wip ref that named the replaced commit. A repeated terminate
whose HEAD is the commit the slug's ref names keeps that commit, even with no `wip` recorded.
The runtime never commits in an adopted worktree, on the default branch, on the main
checkout's branch or on a detached HEAD. The finish rebuilds the notice's one
`Terminated run: ` paragraph from `state.json`'s `wip` and the job's id: the wip's short hash
and branch, `Retry: nightqueue queue retry J-<id>`, and
`New job from it: start_branch: <branch>`. Any other ending whose HEAD is a wip commit, the
recorded one or one a wip ref anchors, as on a `start_branch` job with no record of its own
(`failed`, an operator stop, a `run_outcome` gate, `done` without a PR) gets instead
`Wip commit: the branch <branch> keeps the wip commit <short> of a terminated attempt (local,
never pushed, not reviewed); changes made after it stay uncommitted in <worktree>.` and the
same `New job from it:` line, with no `Retry:` line. Earlier copies of either paragraph are
dropped.

At every claim, a same-job retry or a new job queued with `start_branch` alike, the session
starts on the branch as it is: the runner resets nothing, records nothing about the wip and adds
nothing to the prompt. The runtime never
creates a wip commit in an adopted worktree, which may hold the person's own uncommitted work. A
`--fresh` retry drops the run and leaves the old branch at its wip commit.
A retry without `fresh` consumes the termination, so the retried run is handed the phases it recorded, on the kept wip commit.

`run publish` reads `<base>..HEAD` before anything changes. A commit is the run's
own when its subject is `wip(<slug>): ...`, `refs/nightqueue/wip/<slug>` exists and reaches it,
and the slug is the run's, or the one its `wip.ref` names (a retry that renamed the run), or any
slug in a job whose row has `start_branch`. With no base ref there is nothing to read. Each of these prints one `REJECTED:` line, and nothing is
committed or pushed:

- a `wip(` subject that is not own, and a commit a wip ref names that is not own:
  `REJECTED: the branch carries the wip commit <short> (<ref or subject>), which is not this
  run's own and is never pushed: stop and record it as an open item; the operator squashes it`;
- any other commit above an own one: `REJECTED: the commit <short> (<subject>) sits above the wip
  commit <short>, which is never pushed: stop and record it as an open item; the operator
  squashes it`;
- an own wip with no parent.

Otherwise the own commits fold into the delivery commit: `git reset --soft <parent of the oldest
own>`, the listed paths staged, the carried paths the worktree changed since staged as the
worktree has them, then `git commit -F`. A carried path the list would refuse (`.claude/`,
`tmp/`, a scratch name, the run directory, a lockfile the paired-manifest rule refuses) is left
out: unstaged, still on disk and reported in `FOLDED: <n> wip commits (<m> files); left out: <path>
(<reason>)`. A manifest the wip committed counts as the pair of a lockfile listed now. Refused
listed paths still refuse the whole call. An empty list folds what the wip carries, and refuses
as nothing to commit only when every carried path is left out. If staging or the commit fails,
the branch and the index go back on the wip with `git reset <head>`, the worktree untouched, and
the error says so. A kill between the reset and the commit is read on the next call: when
`ORIG_HEAD` holds only own commits above HEAD and the index only paths they carry, the fold
finishes from there with the same left-out rule. The ref is never touched, so it keeps naming
the old commit. `run pr` does not fold: it refuses a branch carrying an own wip with
`REJECTED: the branch carries the runtime's wip commit <short>, which is never pushed: call
`nightqueue run publish`, which folds it into the delivery commit`, plus the same refusals above.
The refs are local: list them with `git for-each-ref refs/nightqueue/wip` and drop one with
`git update-ref -d <ref>` once its work is delivered or abandoned.

Retired fields (operator runs no longer exist). `queue_add` `run_dir`, and `run_set`
`origin`, `evidence_level` and `plan_status`, are gone from the schemas, and a call that still
sends one with a value is refused before validation with a `UserError` that names the field,
says it was removed with the operator runs and says to put what was found in `prompt` - the schema alone would
strip it silently. A `null`, absent
or blank value is ignored, so an older cached client that sends `run_dir: null` still queues.
The CLI `nightqueue queue add --run-dir <dir>` is
refused with the same reason. A legacy pending job whose stored prompt or `state.json`
still carries the operator-run markers (`## PRIOR RUN (operator)`, `origin: operator`) runs as
any other job: nothing reads them.

`queue_add` `tier` is retired the same way (there is no risk tier: every job runs the one
pipeline): a value is refused before validation with ``\`tier\` was removed: every job
runs the one /resolve pipeline (one model per agent, QA mode chosen by `run check 05 --stage triage`);
drop it - a client still sending it is an older nightqueue plugin, update it``, nothing is
registered or queued, and a `null` or blank `tier` is ignored. `nightqueue queue add
--tier <t>` is refused with the same line. `run_set` no longer takes `tier` or
`tier_raise_reason`.

`context_for_agent` returns `{project, block}`: the block is
`## Applicable lessons` + `## Project memory` (+ `## Structural index` for
`agent: "explore"`, + `## Related jobs` for `agent: "triager"`: at most
five `- [J-<n>] <title> [<status> · PR #<n> · <YYYY-MM-DD>]` lines, best first, of the
jobs of the project whose slug, brief or notice match the query, never the caller's own job;
before them come the jobs the caller's job prompt or the query cites by `J-<n>` or by GitHub pull
request URL, up to five on top of the matches, of the same project and never the caller's own:
`- [J-<n>] <title> [cited · <status> · PR <url> · branch <branch> · <YYYY-MM-DD>] notice: <first line>`,
a match already cited is not repeated, and a citation that resolves to no job of the project gets
one line saying so (`- [J-<n>] cited, not found in this project`, `- [PR] <url> cited, no job of
this project opened it`, or `- [PR] <url> cited, opened by more than one job of this project: J-<a>, J-<b>`);
a citation whose lookup failed reads `- [J-<n>] cited, could not be looked up` or `- [PR] <url> cited,
could not be looked up`, never as not found, and a `J-<n>` inside a URL is not a citation),
already formatted, and is empty when there is genuinely
nothing to inject. Inside a job it excludes the lessons this run was already given
and asks again without the exclusion when that would leave the phase with nothing -
`lesson_recall` does the same, so no caller keeps that bookkeeping by hand. `target: "reflector"`
answers `## Run timeline` + `## Lessons given to this run` with `open_items` instead, recalls
nothing and marks no lesson as seen; inside a job it reads the job's own run whatever the call
names, outside one the `project` and `slug` it names.

### Launching a subagent

The contract has one home per concern. The block of `## Phase prompts` in the resolve SKILL is the
contract of one launch: its `ARTIFACT_PATH`, its `INPUTS` (the run files with the sections to read,
the `state.json` fields and the `context_for_agent` parameters), its `## Deliver` (the headings
inside a `~~~` fence, each with a one-line purpose, and the round, stage or fix-loop append rule),
its `## Found` extras and its return. The agent file `plugin/agents/<agent>.md` is the method only:
how to judge, attack, prove or write, worded for any request, with no run file, run directory or
phase name - an agent file holds no run section. The pipeline manifest
(`plugin/skills/resolve/pipeline/manifest.json`) lists the mandatory sections each `run check`
reads, and a test holds every block's Deliver to it. `coder-fix`, `runtime` and `qa-prover` fetch
no context. A block has at most 32 written lines; its `<RETURN>`, `<LANE>` (long commands and the
shell rule) and `<ROUND>` (the append-only round rule) lines are the shared fences of those names,
written out in their place. The orchestrator fills the `<…>` of every line up to and including
`NOTE:` and copies every later line as written, so the agent-side placeholders of a Deliver survive.
The filled block is the whole `prompt` of the `Agent` call; no other call is needed.
A pipeline picks a model from the `models` that `nightqueue run start` answers: `subagent_type` and
`model` are the block's `AGENT` and `MODEL`. `run start` also answers the values a block needs that
only the run knows: `needsSlug`, `demoRepo`, `baseRef` (`HEAD` when none resolves), `pluginRoot` and
`stages`. It keeps the `commit-message.txt` and `pr-body.md` of a run that recorded Phase 6 or 7, naming
them in `drafts`, and deletes them otherwise, as a previous attempt's: the host refuses to overwrite an
unread file and the main thread cannot read one, so Phase 8 publishes a kept draft as it is or writes
under a new name. A prover appends
with `nightqueue run append 05 --group-label "<label>"`, the id derived by the runtime.

**The return syntax is declared by the prompt, and the runtime holds no format.** A prompt may
declare `RETURN-HEAD: <a line, its `<…>` placeholders any non-empty text>` and `RETURN-MAX-LINES:
<n>`, each at the start of a line, the last one of each winning. The `return-syntax` hook, on
`SubagentStop` (no matcher, job and interactive; not in the operator's `--settings`), reads them from
the first user event of `agent_transcript_path` and the final text from `last_assistant_message`.
Any prompt is held to the lines it declares outside a code fence, whichever way it opens; a declaration
only quoted inside a fence does not count, so the orchestrator launches a block with its fence removed.
When the final text's first line does not have the declared shape, or the text exceeds the declared
lines (every line counts: the runtime knows no line format of a pipeline, so a pipeline that allows extra lines declares them in its limit), it answers
`{"decision":"block","reason":…}` quoting the declaration, and the subagent
sends its final message again. `stop_hook_active: true` always passes, so it blocks once. A prompt
with no declaration, a missing field or any error passes: the check is fail-open. Both fields and the
single block were confirmed on one real subagent stop of Claude Code 2.1.316.

**The orchestrator reads no run artifact.** Its roots are the copies of the plugin and its own
session's spilled tool results (see the queue's isolation), so a `Read`, `Grep` or `Glob` of
`<RUN_DIR>` by the main thread is denied, and a subagent's passes. What Phases 8 and 9 used to read
reaches them as `## Facts for the report` of `nightqueue run report` (see the CLI reference).

### The skill's references

`plugin/skills/resolve/SKILL.md` is the orchestrator's skeleton: the contract, `## Resume`, Phase 0,
one index row per phase and `## Phase prompts`. What only
one phase or one mode needs lives in `references/` and is read when the phase says so:
`phases.md` (the artifact gate, the records, what each `NEXT:` action asks and the judgment it leaves,
once after the first subagent returns, or first on a resume), `interactive-worktree.md` (Phase 0
and Phase 8 outside a job; the only file of the skill that names the host's worktree tool),
`qa-phase.md` (Phase 5), `phase-8.md` with `commit-template.md` and `pr-template.md`
(Phase 8), `phase-9.md` (Phase 9: the report, the `## Notice` writing rules and the icon
tables). `report.md` is rendered by `nightqueue run report` and never read by the
orchestrator. The budget is pinned by `test/skill-budget.test.mjs`: `SKILL.md`, the only
always-loaded file, and each lazy reference have a
ceiling set to the measured size, lowered and never raised, and what a run reads before its first
launch stays at most 60% of what it was with rendered prompts (`test/fixtures/skill-main/`);
`SKILL.md` stays within 350 lines, every `### Phase N` section within 40 (Phase 0 within 70) and every
block within 12.

### The pipeline package

A pipeline is a package the runtime loads by name: `plugin/skills/<name>/pipeline/`, always from this
npm package's own plugin. `resolve` is the only one. Its `manifest.json` declares `name`, `version` (equal
to the plugin's, and pinned on the run as `state.json.pipeline`), the ordered `phases` (`id`, null on the
Brief's `00`; `check`; `artifact`; `sections`; the `verdicts` it may record; the `agents` that serve it; and
`rounds`, `appendable`, `derivesFileList`, `stages`, `gateStop`, `delivers` and `precedesDelivery` where
they apply), `agents`, `models`, `targets` (the launches a `next` may name), `recordable`, `track`,
`constants`, `renumbered`, `gateArtifact`, `fileListFallback`, `gateStops` and `report`. Its `check.mjs` has one export, `check`; the
other modules are its own. It imports from `src/` only `config/errors`, `config/store`, `host/paths`,
`memory/runs`, `queue/branch-name`, `queue/file-list`, `queue/orchestrator-scope`, `queue/pipeline-record`,
`queue/resume`, `queue/rounds`, `queue/question-text` and `queue/stream`.

`agents` is the list of `{name, role, lessons}` of every agent the pipeline launches: `name` is the agent
a phase's `agents` or a `models` key names, `role` (matching `^[a-z][a-z0-9-]{0,39}$`) is what the agent
passes to `context_for_agent` as `agent`, and `lessons` (a boolean) says whether that role learns lessons.
The roles, each once in the order they first appear across the installed pipelines (`resolve` first), are
the `context_for_agent.agent` enum; the roles with `lessons: true` are the `target` enum of `lesson_save`
and `lesson_recall`. The list must be consistent, or the manifest is refused: every agent a phase or
`models` names has an entry, no name appears twice, and no role is declared both with and without
`lessons`. A role a manifest adds is accepted with no change to the runtime; reordering the list reorders
the enums.

The optional keys the runtime reads in place of a phase name, each validated at load with one defect line:

- `gateStops` (a list of strings): the gate stops telemetry accepts, in order; `pipeline_runs.gate_stop`
  takes them plus `user`. A phase's `gateStop` must be one of them: it is the stop a run terminated at,
  or last failing at, that phase records.
- `delivers` (a boolean, on at most one phase): the phase `run publish` records once the pull request is
  open, and whose entry makes the outcome `local_commit`. `narrate` puts `run publish` and `run report` on
  its track slot.
- `precedesDelivery` (a boolean): a phase whose entry tells `run start` the delivery drafts of this run
  may already exist, so it keeps them.
- `track[].lane` and `track[].promptMode` (strings): a lane named `lane` whose prompt carries the line
  `Mode: <promptMode>` is that slot's, not its own agent's.
- `report.rows` (a list of `{phase, step, agent}`, `phase` a declared id or null): the rows of the
  `run report` table, in order. A null `phase` is the report's own row (⏳ `this report`). With no
  `report`, the table has one row per phase id, named by it.

`report.mjs`, optional, is loaded on every `run report` and must have no side effect at import. Every export
is optional:

| export | what the runtime does with it |
| --- | --- |
| `rowOf({ phase, entry, state, delivery, note })` | answers `{icon, word, note}` for a row, or null for the runtime's default (the verdict's icon and word, else ⚠️ `not recorded`) |
| `openItems({ read, state })` | the open-item lines, after the runtime's own failures and draft lines |
| `FACT_FILES` | the artifacts the facts read |
| `facts({ texts, state, root, evidence, worktree })` | the ordered facts, each a string or `{ text, max }`; the runtime clips each to one line and adds the evidence listing | What names nothing of a pipeline stays in the runtime: `src/queue/rounds.mjs` and
`src/queue/question-text.mjs`, which `run append`, the gate notice and `run publish` read too.

`nightqueue run check` resolves the name from the caller's job row (`jobs.pipeline`), else `state.json`'s
`pipeline.name`, else `resolve`, and refuses a name with no package in one line. `PHASE_NAMES` is gone: the
phases `state.json` and `run_terminate` accept come from the manifest of the pipeline the state pinned.

**Broken manifest.** No module reads a manifest when it is imported: every value derived from one is read
when it is used, and a successful read is kept for the process while a failed one is retried only once the
`manifest.json` file changes (its size or modification time), so a broken manifest is not re-read per call. A missing
`manifest.json`, one that is not JSON or one whose shape is wrong is refused in one line, `the pipeline
\`<name>\` has an invalid manifest: <reason> (<path>)` (a pipeline with no package directory keeps `has no
readable package`). With a broken manifest the MCP server still lists every tool: a role or gate-stop enum
falls back to a plain string and the `run_outcome` description names a generic artifact. `queue_status`,
the queue tools, `lesson_save`/`lesson_recall` (a `target` filter is dropped) and `memory_save` keep
answering; `run_outcome`, `run_terminate`, `run_set`, `context_for_agent` and a `pipeline_log` that sends
`gate_stop` answer the one line. The run tools refuse only for the installed pipeline the run pinned (a pin
with no package directory is not refused there), and the roles skip a broken pipeline other than `resolve`. On the CLI, `--help`, `queue …` and `doctor` run, and `run check`, `run
start` and `run report` refuse with the one line. `nightqueue doctor` prints one `pipeline` row per
installed pipeline: `ok` with its version, or `fail` with the reason and the path. A lesson stored with a
`target` no installed manifest declares is still recalled by a call with no target; saving one is refused,
naming the accepted roles.
A `check` is synchronous, because it runs under the run lock on a phase with rounds: `check({ phase, stage,
runDir, state, files, run, env })`, where `phase` is the check key, `files` is `{ read(name), changed,
worktree() }` (`changed` is what git says only for a `derivesFileList` phase, never under the lock) and `run`
is `{ slug, provisionalSlug }`. It answers:

| key | what it is |
| --- | --- |
| `lines` | the contract lines, the first line first and `REPAIRED:` second |
| `script` | the device script, printed after the effect lines under `SCRIPT:` |
| `record` | the `phases[]` entry (`phase`, `artifact`, `verdict`, `note?`, `reason?`, `decision?`), or null |
| `memo` | the check memo (`key`, `line`, `ok`, `completed`, `digest`) |
| `effects` | the closed list below, applied in order, with the memo and the record after those without `afterRecord` |
| `next` | one action, printed last as `NEXT: <action>`, after `SCRIPT:` |

`next` is one line of a closed grammar, and the post-check policy that was prose now lives in
`pipeline/next.mjs`, one fixture per row in `test/fixtures/next/`:

| action | what the orchestrator does |
| --- | --- |
| `launch <target> [stage=<n>] [note=<text>]` | fills that block of `## Phase prompts`; `target` must be in the manifest's `targets` |
| `gate <question>` | the one pause |
| `terminate <reason>` | `run_terminate`, then the report |
| `publish [--draft] [remaining=<text>]` | Phase 8 |
| `report` | Phase 9 |
| `check <NN>` | runs that check; `NN` must be a check of the manifest |

What the code cannot decide stays prose in `references/phases.md`: what else goes in a `note`, the
wording of a gate, the `run_set` of the Type valve, `run_outcome`, whether an answer is a go-ahead, the N
prover groups, the purely static change that takes `publish` for `launch runtime`, and the open-item and
PR-body duties.

| effect | fields | what the runtime does |
| --- | --- | --- |
| `writeRunFile` | `name`, `text`, `line?`, `what?`, `locked?` | writes a bare file name of the run directory; a `locked` write happens before any other effect, inside the lock span, and a failure stops the check |
| `recordFields` | `fields`, `line?`, `dropPhases?`, `afterRecord?` | writes fields the manifest's `recordable` declares and the runtime has one writer for: `type`, `commitType`, `qaMode`, `termination` (`{phase, reason}`, or `{phase, clear: true}` to lift it, printing its line only when one was lifted), `slug` (the runtime prints its own `renamed from` or `kept:` line), `pipelineLoops` (prints nothing on success) |
| `recordDecision` | `decision` (`{check, digest, next, loops}`), `loops` | needs `decisions` in the manifest's `recordable`; appends the decision to `decisions[]` and writes `pipelineLoops` in one write, and prints nothing on success |
| `saveIndex` | `text` | saves the explore map into the project index and prints the `index:` line |
| `say` | `line`, `afterRecord?` | prints one line |

The whole answer is validated before anything is written: an unknown effect, an undeclared field, a run file
that is not a bare name, a phase or a verdict off the manifest or a promise is refused in one line. An effect
that is refused prints `recorded: not recorded (<reason>)`, never failing the check. The artifact writes
that must not lose a concurrent `run append` (the fence repair, the QA consolidation) happen in the one lock
span that covers the read, `check` and the writes; everything that takes the lock itself runs after it. `run
check 04` never overwrites `04-implementation.md`: the list it derives goes to `04-files.generated.md`, and
`run publish`, the report facts and the studio read that file when the artifact lists no file.

`run report` and its facts load the package of the pipeline the state pinned (`resolve` when it pinned
none): its manifest's `report.rows` and its `report.mjs`. The table frame, the Time cells, the first
failing gate, the outcome and draft lines, the total and the fact clipping stay the runtime's own.

### Agent models and pipeline constants

`src/queue/routing.mjs` reads the model each agent runs on from the `models` of the pipeline's
manifest, plus the merger and the orchestrator, which are the runtime's own (`nightqueue run start --routing` prints the
table):

| Agent | Default model |
| --- | --- |
| triager | sonnet |
| explore | haiku |
| architect | opus |
| coder | opus |
| qa-triage | sonnet |
| qa-analyst | sonnet |
| qa-prover | haiku |
| verifier | haiku |
| reflector | haiku |
| merger | sonnet |
| orchestrator | default (the user's) |

The rationale of the defaults:

The agent models below are the single source. The dominant capability of the agent decides its model:
- writes/edits code or carries the design judgment every later phase builds on → `opus` (architect, coder);
- reasons and critiques without writing code in bulk → `sonnet` (triager: writes the Brief, critiques the
  request and reproduces the bug; qa-analyst: adversarial analysis grouped by root, the lite QA included;
  qa-triage: classifies the real diff under a written rule and decides how much attack it deserves);
- bounded, mechanical or command-driven work over material another agent already reasoned about → `haiku`
  (explore maps files the triage already scoped; provers write and run one PoC for one pre-analysed
  hypothesis; verifier runs the project's checks and the PoCs; reflector distils lessons from written artifacts).
The merger keeps `sonnet`. A project overrides any of them with `nightqueue project models`.
Phases 0/8/9 run in the orchestrator, on the project's orchestrator model (`project models --set orchestrator=<m>`), else the user's default. Every run executes every phase.

A project overrides any agent, the merger and the orchestrator included, with
`nightqueue project models <project> --set <agent>=<model>` (`opus`, `sonnet` or `haiku`;
`--unset <agent>` brings the default back). The override is stored as
`agents.<agent>.model` in the project's settings JSON (the `projects.integrations` column,
under the reserved `agents` key that `project integrations` never shows nor drops); a stored
value outside the aliases reads as no override.

The orchestrator has no default model: with no override the job session is spawned with no
`--model` (its argv byte-identical to a build without the role) and runs on the user's own model;
with one, the runner reads it once per claim and passes `--model <alias>` right after `-p <prompt>`
to every spawn of that claim. The read goes through the outage backoff; project settings it cannot
read (no settings column, or a stored value that is not a JSON object) gate the job unspawned with
the code `unreadable-settings` and no attempt spent, never a run on the default model.
Each attempt records `orchestrator_route` (the alias passed, null for the default; written on the
attempt row before the spawn) and `orchestrator_model` (the model the session's `system/init`
reported, control characters stripped, a full id such as `claude-sonnet-5-5`) when it is measured;
a later measures write only fills whichever of the two is still empty. `queue status` prints them as
`orchestrator: <alias|default> (<init model>)` and `run report` opens its facts with the same label,
the route read from the job's last attempt row, never from the project's current settings.

`run start` answers the resolved models as `models` and the orchestrator's as `orchestratorModel`
(`default` when none), and each block of `## Phase prompts`
names its own: `coder` and `coder-fix` take the coder's,
`verifier` and `runtime` the verifier's, `qa-triage` its own, `qa-lite` and `qa-analyst` the qa-analyst's,
`qa-prover` the qa-prover's, `reflector` the reflector's.

Every run shares the same constants: the verifier scope is the project's real checks
(typecheck, lint, build, tests) plus the QA's PoCs, at most 2 fix iterations, the
project's `CLAUDE.md` is named to the coder when it exists, `index_recall` and
`context_for_agent` always run, and there is no time target.

`nightqueue run report` records the run's telemetry itself, so the shipped plugin never
calls `pipeline_log`; the tool stays for an older plugin and for the operator's outcomes
(`investigated`, `queued`). Both write the same row through one module
(`src/queue/pipeline-record.mjs`): the phases come from `state.json`, one row per recorded
phase (`failed` for a ❌ verdict, `retry` for a phase seen before); `run report` also
derives the outcome (`pr_opened`, `local_commit`, `no_commit`) and the gate stop (`user`
for a gate outcome, else the terminated or last failed phase) from it, while
`pipeline_log` keeps the `outcome`/`gate_stop` it was sent. Inside a job the run is
recorded at most once per attempt (since the job's `attempt_started_at`); outside a job, or
in a job with no recorded attempt start, a run is not recorded again while the latest
`pipeline_runs` row of its project and slug carries the same outcome and phase count, and
the operator's `investigated`/`queued` outcomes of `pipeline_log` insert a row per call. A
`NO-CHANGE-NEEDED` run records no gate stop. A failed record is the fixed open item `the
run was not recorded in the telemetry` of the report, never a non-zero exit.

In `pipeline_log`, `phases`, `tier`, `tier_operator` and `tier_raise_reason` are accepted and
ignored: an older plugin still sends them, and none of them is read or written. The
`pipeline_runs.tier` column is NOT NULL in the shipped schema, so every new row carries
the constant `complex` (the one track every run executes); `tier_operator` and
`tier_raise_reason` stay NULL. The three columns are kept unread until a later schema
bump drops them. Inside a job, `project` and `slug` come from the job's own row
and whatever the call sent for them is overridden (not refused: an older plugin still
sends them); `task_type` may be left out when the run already recorded it with
`run_set`. The durations and the
models are measured by the runtime on the stream of the job - the total from the
attempt marker to the last message, and one lane per subagent, matched to its phase in
the order the phases were launched - and they overwrite what the call sent. A phase the
runtime measured no lane for keeps the value the call carried, and a phase the call
never recorded is not inserted.

When the database is unavailable (see [Memory](memory.md)) a tool answers `isError` with the
JSON `{ "ok": false, "error": "store-unavailable", "code", "home", "hint": "nightqueue doctor
--fix", "message", "contract" }`, and the same server answers the next call normally once the database is
back. A database older than the server's build answers the same shape with `"code":
"SCHEMA_OUTDATED"`, `"hint": "nightqueue update"` and the `message` `database at v<file>, this
nightqueue expects v<code>: run \`nightqueue update\` (...)`: the server never migrates it, and
it answers normally once `nightqueue update` did. `context_for_agent` is not an error there: it answers `block: ""` and one `warning`
line. Inside a job whose `state.json` carries its `job` block, the three `run_*` tools keep
working from that file. `pipeline_log` whose run resolves (from that block inside a job) queues
its fully resolved row in the run's `pending-writes.jsonl` and answers `{ "ok": true, "queued": true, "warning": "recorded in
<path>; replayed once the database is back", "pending": <path> }`; when it cannot queue it
answers `store-unavailable`.

The eight queue tools are the same subsystem as `nightqueue queue` (see [Queue](queue.md)):
`queue_add` takes the registered project NAME and never a path - or, with
`project` omitted, the absolute `cwd` of the caller, which resolves the project
that contains it; a `cwd` inside a git repository that is registered nowhere
answers `{ "needs_registration": true, "cwd", "suggested_name", "org", "hint" }`
instead of failing, and only a second call carrying `register: true` (after the
user confirmed it) registers the repository and queues the job. An unattended run
never registers anything: inside a job the call is refused. `prompt` is required. There is no prior-run seed any more: `run_dir` was removed with the operator runs (above), and no
code path writes a `## PRIOR RUN (operator)` block.
Every job `queue_status` answers (listing and one job) carries `title`, a string or `null`,
derived on read and never stored: the first non-empty line of the prompt's brief
with its leading markdown heading marker stripped (a bare `## Brief` or `# Task` heading
yields to the next line), clipped at 120 characters with the `…` counted in the 120; `null`
for an empty prompt. The field is additive: `contract` is unchanged.
Every job `queue_status` answers also carries, derived on read from `job_attempts` with
SELECTs only: `attempts_log`, one entry per claim of the job in order (`attempt`, `worker`,
`session_id`, `started_at`, `finished_at`, `duration_s` - null while the attempt is open -,
`outcome` among `gate|done|failed|cancelled|released|timed_out|lost` or null while open,
`exit_reason`, `spawns` - the host spawns inside that claim, above 1 when the runner
re-spawned after a transient failure -, `tokens_in`, `tokens_out`, `cache_read`,
`cache_creation`, `cost_usd`, `fresh`, `backfilled`, `orchestrator_route` - the alias the runner passed as `--model`, null for the user's default -, `orchestrator_model` - the model the session's `system/init` reported -; the route is written before the spawn, the model when the attempt is measured); `active_s`, the sum of the attempts'
durations with the open one counted up to the read; and `wall_s`, from the job's first start
to the end of its last attempt (the read, while one is open); the three are null/empty for a
job that never ran. `started_at` is the first claim of the job and `attempt_started_at` the
current one (null outside `running`); `tokens_*`, `cache_*`, `cost_usd` and the host and
orchestrator counters are totals across every attempt, `orch_ctx_last` and `baseline_ctx`
the last value. `attempts` is the job's own count, which inner re-spawns never move and which
limits nothing - the history count is `attempts_log.length`. A row answered by a write (the job a
cancel or a retry returns) carries none of the three keys. The keys are additive:
`contract` is unchanged.
`queue_status` never returns the prompt of a job and truncates `notice_md` and `result` at 500
characters in a listing; a row whose text was cut carries `notice_truncated: true` or
`result_truncated: true` (the key is absent when the text fits, and the detail of one job by
`job_id` is never cut), and `suggestions` plus the `hint` gain one line naming
`nightqueue queue status J-<id>`, where the whole text is. It answers with the state of the runner next to the jobs; it is a pure read
that never repairs nor prunes on call, and reports the last repair warning of the server's
maintenance (once at start, then every 60 s, never inside a job) as `warning`. Every `running` job carries a `live` block and every other job `live: null`; `sections` gains
`{ name: "live", ok, error, ms, jobs }`, where `jobs` counts the blocks filled and a log that is
missing or unreadable sets `ok: false` and leaves only its own job at `live: null`. The block is
derived on demand from the tail of the job log, never stored (not on the jobs row, in
`state.json` nor in pending-writes), adds no column and keeps `contract` at 2:

```json
{
  "source": "log-tail",
  "attempt": 1,
  "agent": "coder",
  "model": "sonnet",
  "phase": 3,
  "phases": 6,
  "intent": "Implement stage 2",
  "last": { "kind": "tool", "text": "Edit view.mjs", "at": "2026-01-01T00:00:00.000Z" },
  "lane_opened_at": "2026-01-01T00:00:00.000Z",
  "quiet_s": 4,
  "tokens": { "in": 10, "out": 20, "cache_read": 0, "cache_creation": 0 },
  "tokens_estimated": true,
  "truncated": false
}
```

The block is read from the whole current attempt (the log from its last `=== attempt N @ ... ===`
line to the end), read backwards and capped at 8 MB. `truncated` is `true` when the cap was hit
before that marker: the lane's opening is then unknown, so `agent`, `model` and `intent` are `null`
(`last` still comes from the events read) and `tokens` cover only what was read; it is `false` otherwise.

`agent` is the subagent lane still open, or `orchestrator` outside one (then `phase` follows
the `nightqueue run start|publish|report` commands and `model`, `lane_opened_at` are `null`);
`phase` is the 1-based position of the current phase in the nine-slot track and `phases` the size of
that track (`phase` is `null` when the phase is unknown); `last.kind` is `tool` or `text`;
`tokens` are the partial usage of the running attempt, estimated from the assistant turns until
the result event reports them, and no cost is ever estimated. `queue_run`
starts the runner detached and answers right away with the path of its log,
`queue_cancel` cancels a `pending`, `gate`, orphaned, `done` or `failed` job and answers `{ ok,
job, worktree }` - `worktree` is `{ path, status, reason? }` when cancelling a `done`, `failed` or
`gate` job released (`removed`) or kept (`kept`, with the reason) its worktree, and `null` otherwise; it
refuses a job running under a live lease, or one whose close is in flight or was interrupted, without
writing anything (an interrupted close is resumed with `queue_close`, never cancelled blind).
With `stop: true` it cancels a job running on a live registered runner of this host in one
owner-checked write and then stops that runner alone, answering `runner` (`{ outcome, pid,
message }`, null for a job that was not running); `release_worktree: true`, valid only with
`stop`, releases the worktree once that runner is gone. `queue_stop` ends every registered runner,
or with `pid` only that one, like `nightqueue queue run --stop`, and answers `{ ok, runners }`.
Both are refused inside a job (see [Queue](queue.md)).
`queue_close` starts the same DETACHED closing pipeline as `nightqueue queue close <id>` (the CLI
also offers `nightqueue queue close --merged`, which closes every `done` job whose pull request is
merged in one call), and `queue_retry` sends a gated, failed or cancelled job back to the queue - its
`run` starts a DETACHED runner, the same one the `--run` of the CLI starts unless
it is asked for `--foreground`. `queue_close` answers `{ ok, started, job_id, pid, logPath, follow }` without
waiting for the merge: a `done` job only - with a pull request, or resolved without change
(no pull request: preflight, conflict and merge recorded `skipped`, settle recording
`data.resolvedWithoutChange`, origin and log telling the origins with the run's conclusion) -
and every other status (``job `N` is already closed`` for a closed one), `force` on a job with no
pull request, or one already under a live close lease refused by name with nothing written;
`closed` means merged or resolved without change through this pipeline; calling it again resumes a
close that stopped at the step that failed. The STATUS cell of a job whose close holds or stopped
reads `closing`, `close failed` or `close stalled` alone (the step and the reason stay in the LAST cell and
in `queue status <id>`); the studio rows carry the same as `studio.status_label` plus
`studio.close_state` (`null`, `closing`, `stalled`, `failed` or `closed`), which styles the cell. A clean rebase (no conflict, no merger) of a head that had
at least one check (`checksOnHead` in the preflight data) skips the local suite and leaves CI to
gate the new head (the pushed head is not recorded as verified: the merge step merges it only on
green CI, or runs the suite on it when no CI reports), with the note `rebased onto origin/<base>,
suite skipped (CI gates the head), pushed <a> -> <b>`; with no checks, or after a merger
resolution, the suite runs, and the close's no-CI suite always runs, whatever the previous head's checks. `force: true` skips the pull request checks and the
rebase suite only - status and attribution still stop the close, and a conflict stops a forced
close (the merger never runs under force). A check GitHub cancelled before it ran
(`cancelled`, `timed_out`, `startup_failure` or `stale`) is `aborted`, never red: with no real
failure beside it the close re-runs its failed jobs once per head (`gh run rerun <runId> --failed`,
recorded as `rerun: { head, runIds, urls, at }` in the close checklist `data`, not in a step entry)
and waits for the checks; an aborted check whose details URL is one recorded in `urls` is the old
job GitHub still shows and counts as pending. The same head aborted again under a new details URL,
a refused re-run or a check with no run id stops the close with
`checks-aborted`, and `force` lists such checks as `aborted`. An open draft pull request stops
preflight with `draft` (and the merge step, on its last read, for a pull request drafted after a
done preflight) before anything is re-run, rebased or merged; `allow_draft: true` (`--allow-draft`)
runs `gh pr ready` once instead and records `markedReady` and `markedReadyAt` in the close data.
Right before the pinned merge call the revert guard stops the merge step with `reverts-base`
(`revertedPaths` in the close data, a note of up to 10 `<path> back to <sha7> (undoes <sha7>
<subject>)` lines) when the head's blob of a path the head changed since its merge base, and that
differs from the base tip, equals the blob before a commit of the base's first-parent history; a
deletion counts only when the commit that added the path is not on the head's first-parent line.
A guard git cannot run stops with `revert-check-failed`, as does a failed fetch of the base when
the guard flags nothing (the base may be stale). `allow_revert: true` (`--allow-revert`)
skips the guard and records `allowedRevert`. `force` lifts neither gate, and both reasons are
failed closes (`closes.failed` in `queue_status`), never stalled. A pull request
closed without merge ends the close by cancelling the job, one merged by hand is recorded as
`merged outside a close`. Inside a job
it is refused, like the CLI (see [Queue](queue.md#closing-a-job)).

Worktree disposal after a merged close: the settle step removes the job's worktree with
`git worktree remove --force` whatever its status (uncommitted changes, an unpushed branch),
because the pull request is merged and the work is done; the branch is kept. The one exception is
a lock held by a live session or set by hand: the worktree is kept with the lock reason. The
status is read once before the removal and what it drops is named in the close line and in the
settle step's `worktree` entry: `worktree removed: <path> (dropped uncommitted: a, b, c)` (at
most 10 names, then `, … and N more`); a clean removal stays `worktree removed: <path>`. The
runner's `done` path and a cancel of a `done` or `failed` job are unchanged: a dirty or unpushed
worktree is kept with its reason. A cancel of a `gate` job removes a clean worktree even when
unpushed, because its branch stays for a later retry; a dirty one is kept with its reason. `nightqueue doctor --fix` also force-removes a home worktree whose every owning job is `closed`
or `cancelled` (naming what it dropped; one no job names stays listed), prunes an entry git registers whose directory is gone, and removes an
orphaned empty directory; an orphaned directory with content is only listed with its `rm -rf`
command. These two paths are the only ones that remove a worktree with uncommitted work;
everywhere else such a worktree is kept.

The conflict step is the one place a close runs an agent. When the rebase stops on conflicts
that code finds eligible (no `--force`, a `scripts.test`, no risk-list or generated file, markers
in every file, at most 12 hunks in 6 files summed over every stop, at least 60 s of merger time
left), it spawns `nightqueue:merger` (sonnet, `--tools Read,Edit`, no MCP server, only the
`merger-guard` PreToolUse hook, which allows Read inside the throwaway worktree and Edit on the
conflicted files and denies everything else) in the stopped worktree, bounded by half of what
the close has left after the suite's reserve, at most 20 min. Its last line must be `RESOLVED`
or `UNRESOLVED: <reason>`. A resolution counts only after the runtime verifies it - no marker
left, `git diff --name-only` limited to the conflicted files - continues the rebase and runs the
suite green; then the push, with the note `resolved by merger: <n> hunks in <m> files (<names>);
suite green; pushed <a> -> <b>`. Everything else aborts the rebase and stops the close with
`real-conflict` and the files, exactly as before, the merger's reason appended to the note
(`; merger: <reason>`) when it ran. The step's data keeps `conflict` and adds `merger`
(`{ status: "resolved" | "unresolved" | "not-eligible", reason?, hunks?, files? }`).

Inside a job, a tool that takes a free id only reaches its own: `queue_retry`
retries the job it is running. Outside a job that restriction does not apply.

Every optional parameter accepts an explicit `null` and treats it exactly like
an absent one, so a caller that fills its whole argument object never gets an
error for a field it had nothing to put in. The closed
vocabularies are `target` (`triager`, `architect`, `coder`, `qa`, `verifier`, plus
`explore` for the `agent` of `context_for_agent`), the run `phase` (`triage`,
`explore`, `architecture`, `implementation`, `qa`, `verification`, `runtime`,
`commit`), the run `status` of `run_outcome` (`done`, `gate`, `no_change` - how the process
ended stays the runtime's call),
`task_type` (`bug/error`,
`feature/refactor`), `outcome` (`pr_opened`, `local_commit`, `no_commit`),
`gate_stop` (`critique`, `triage`, `architect`, `qa`, `verification`, `runtime`,
`user`), the phase `status` (`ok`, `failed`, `skipped`). A value outside them comes back as an error message, never as a stack.

**The artifact check answers the gates.** `nightqueue run check <NN>` reads the phase's
artifact (and, where a rule needs them, `01-triage.md`, `03-plan.md`, `state.json` and the job's
operator note) and prints one fact per line, in this fixed order:

1. `OK` | `MISSING: <sections>` | `GENERATED` (`04`), unchanged. After `MISSING:` nothing
   else is printed but a `REPAIRED:` line and, on `06`, its `OPEN: pre-existing-failure` lines: no
   gate is evaluated and nothing is recorded but the check memo. On a round artifact (`05`, `06`, `07`) whose open code fence the check closed, the
   `REPAIRED: …` line follows the first line, before `VERDICT:`; it never changes the memo nor
   completion. `01`
   with `NOT-REPRODUCIBLE` also requires `## Open items` with an item
   (`MISSING: ## Open items`, or `## Open items (empty)` when it holds only blank lines or
   `None`), because the next step reads it.
2. `VERDICT: <value>`: `01` the suffix of `## Verdict:` (`PROCEED`, `NO-CHANGE-NEEDED`,
   `NOT-REPRODUCIBLE`; a retired `NEEDS-CLARIFICATION` or `PROPOSE-ALTERNATIVE` still parses and
   reads as `PROCEED`, its Brief gates applied); `05` and `05 --stage analyst` the first non-blank line of
   `## Verdict` (`APPROVED`, `NEEDS FIX`, `NEEDS DISCUSSION`); `06` the suffix of
   `## Verification:` (`PASSED`, `PASSED-STATIC`, `FAILED`); `07` the first non-blank line of
   `## Runtime verdict` (`CONFIRMED`, `NOT-MET`, `SYMPTOM-PERSISTS`, `NEEDS-DEVICE`,
   `UNAVAILABLE`). A verdict outside the values is a `MISSING:` naming the expected line. A `06`
   round whose verdict line says `(stage N)` is a stage round: the line reads
   `VERDICT: <value> (stage N)`. A stated `FAILED` with at least one failure, each of them excused,
   does not read `FAILED`. A failure is an item of `## Failures` or a line of `## Checks run` whose
   status is not `PASSED`, `SKIPPED`, `OK` or `not run`. Its excuse is an item of
   `## Pre-existing failures` that opens with `<that check>:` and mentions every file the check's
   line blames, or, on a stage round with no `qa` phase and no `05*` check recorded, a failure that
   only says `05-qa.md`, the QA report, a PoC or runtime evidence is absent, and names no error. An
   item of `## Failures` is never excused by the base. The round reads `PASSED` on a stage round and
   `PASSED-STATIC` on a final one, whose Phase 7 stays owed.
3. `GATE: <code> — <evidence>`, one per firing item, the evidence one trimmed line of at most
   160 code points.
4. `OPEN: <text>`: `03` the coverage items below, `## Requires user confirmation has no filled
   **Question:**` and `type mismatch — <evidence> — kept <bug/error|feature/refactor>` (`bug/error`
   with `## Diagnosis` filled, else `feature/refactor`), `stages-unjustified — <n> stages, no reason
   line` (two or more stages titled under `## Implementation plan`, no `**Stage reason:**` line from
   the closed list and no Brief that numbers them) and `assumption-without-evidence — <first words>`
   per `## Assumptions` item (a bullet with what is nested under it, or a table row) with neither a
   `path:line` (a directory, or a source extension on a bare file name) nor `(unverified)`;
   `05` `<label> — <value>` per filled
   `omitted:`, `divergences:` or `unconfirmed decisions:` line other than `none`;
   `06` `pre-existing-failure — <item>` per item of `## Pre-existing failures`, whatever the verdict;
   `07` `<scenario> — to confirm` per `NOT MET / to confirm` row. Never a gate.
5. `TYPE-MISMATCH: <evidence> — triage: <bug/error|feature/refactor> (<## Diagnosis filled|## Diagnosis absent or empty>)` (`03`).
6. `CONFIRM:` (`03`, only with a filled question, the one human stop of a run):
   `CONFIRM: requires-user-confirmation — <question>`, or `CONFIRM: answered (<at>)`, the time of the
   last answer, when `state.answers` holds more entries than `state.gateAnswersSeen` and
   `state.gateQuestionDigest` is this question's digest, so re-typing
   the same question (markup, quotes, punctuation) still reads as answered and one with other words
   pauses again. The question is the block under the label of the confirmation section, at any
   heading level, with HTML comments and fenced lines ignored. The label is `**Question:**`,
   `**Question**:`, `**Question :**` or `__Question:__` anywhere in a line, `Question:` at a line's
   start, a heading titled `Question` (a level-2 one stays in the section), or a table row
   `| Question | text |` with a filled second cell (that cell alone; under a header row whose cell
   has no `?`, the first cell of the row below). The block ends at the next bold label or heading.
   One reader (`src/queue/question-text.mjs`) serves the check, the pause and the report. A question
   is a value with a `?` and at least one word; nothing else ever pauses a run. A label left unfilled
   (empty, one single `<…>` or `[…]` hint, or a placeholder word, `none`, `no question` or `nothing`
   that goes on to say nothing, such as `None needed`, `(none)`, `N/A - decided above`) is an `OPEN:`
   line. Any other labelled value with no `?` is a `MISSING:`, and so is a section with a `?` and no
   label, so the architect is relaunched once. A section with no label and no `?` asks nothing: an
   `OPEN:` line.
7. `QA-MODE: skip|lite|full — <why>` (`05 --stage triage` only, on a complete round): the first
   line of the `## QA mode` section of the last `source: qa-triage` round. The lane decides under
   the written rule of its prompt, from the real diff, the plan's risks and the Brief; the plan's
   `**Always-gate class:**` field and its 🔴 count are not read here. The check answers `MISSING:`
   for an empty section, a first line that is not a mode and a real sentence, a `skip` with a listed
   `## New risk`, a `skip` or `lite` with a filled `data/migration`, `route/endpoint`,
   `auth/permission`, `payment`, `concurrency`, `external-input parsing` or `personal data` line,
   a `skip` or `lite` with a line off the list of kinds (`copy/docs`, `config`, `test-only`, `rename`,
   `logic` and those), read in any case, and a `skip` with a `logic` line whose sentence names no
   test path: a path under a test directory or a file named as a test. Every test path such a
   sentence names must also be a regular file inside the run's worktree once `..` and links are
   resolved, and still read as a test there, with an extension on the closed list of code files
   (so `docs/spec/overview.md` or `test/data.json` is refused) and no vendored directory
   (`node_modules/`, `vendor/`, `third_party/`, `site-packages/` and the like, at any depth, in any
   case) on its path; an absolute path does not count, and a worktree the
   check cannot read answers `MISSING:` too, so none of these records a mode or a phase. This is the
   gate's one disk read: `run check` (`pipeline/worktree-tests.mjs` of the package) passes what it finds to
   `evaluateCheck` as gaps, and `evaluateCheck` itself reads no disk. The orchestrator's Phase 5
   reads this line and nothing else to pick the QA mode; a resume re-runs the check and launches
   the lane only on its `MISSING:`.
8. `QA-STAGE: provers|skip` (`05 --stage analyst` only): `skip` when the analyst's
   `## Break hypotheses` holds no item other than `None`, so the orchestrator goes straight to
   `run check 05`; `provers` otherwise.
9. `INVALIDATED: <item>`, one per item of `## Invalidated assumptions` other than `None` (`05`).
   It sends the plan back to the architect, never to the operator: `05` does not record `qa`,
   and the memo line is the first `INVALIDATED:` line.
10. `DIFF-APPLIES: yes|no` (`07`, from `Diff applies plan:`; omitted on `n/a` or absent).
11. `NEEDS-DEVICE` (`07`).
12. `index: saved N files, M libs` | `index: not saved (<reason>)` (`02`).
13. `recorded: …` lines.
14. `SCRIPT:` and the device script verbatim to the end of the output (`07` `NEEDS-DEVICE`:
    the lines of `## Runtime verdict` after the verdict, up to `Diff applies plan:`).

The check ids are `00` to `07`; `--stage analyst` and `--stage triage` are accepted only with `05` (any other stage,
or a stage on another check, is refused). A retired id of the old numbering is refused with
the one line `renumbered: use <NN>` (exit 1), and nothing is evaluated.

Every section read is fence-aware: a heading matches by prefix, never inside fenced code, and
HTML comments are stripped first, also mid-line, by one scanner that keeps fenced lines and code
spans byte for byte (a `<!--` inside inline code or a fence opens nothing; a comment never
closed stays visible); a section ends at the next `## ` outside a fence. Round artifacts (`05`,
`06`, `07`) are split into rounds first, left to right with no lookahead, and read on their last
`## Round`, or on the last `source: qa-triage` round for `05 --stage triage` (its HTML comments stripped inside that round only): a `## Round` heading inside fenced
code is never a round; a column-0 `## Round <n>` whose number is the highest so far plus one is a
round even inside an open HTML comment, and closes the comment only; any other `## Round` heading
counts only outside fenced code and HTML comments (also one opened mid-line), for the check and
for the next round number alike. Fence lines follow CommonMark, in one place (`fenceStep`): an
opener is 0-3 spaces then 3+ backticks or tildes, and a backtick info string holding a backtick
is no fence (```` ```node --test``` ```` is inline code); a closer is the opener's character, at
least as long, with no info string (```` ```js ```` never closes). Every reader — the gates,
`roundsOf`/`lastRound`/`nextRound`, `run append`, the consolidation's section reader and the
`04` file list — reads comments with one scanner (`scanMarkdown`): a `<!--` that never closes
opens nothing, it and all after it are literal text. The rounds a gate reads (the last round, or
the consolidation window for `run check 05`) must be well-formed, so a gate never picks an older
round or a phantom tail:
- an artifact that ends inside an open code fence (D1) is repaired before any evaluation, under
  the run lock: the check (and `run append`) appends the fence's own marker as the last line —
  a no-op for every reader, no round boundary moves — and prints `REPAIRED: the code fence of
  round <k> opened at line <X> of <file> never closed; the runtime appended `<marker>` at line
  <Z>` right after the first line;
- every other defect is one `MISSING:` part, earliest line first, joined by `; `, each asking
  the lane to append a new `## Round <next>` (never to edit an earlier round): a column-0
  `## Round <next>` inside a fence of a read round (D2 — a quote and a swallowed round cannot be
  told apart, so the round is never evaluated; a fenced heading of another number is plain
  content), a read round that leaves a `<!--` open (D3), and a first read round whose heading
  sits in a comment the round itself closes (D4). `run check 05` writes no consolidation over a
  window with a defect and answers its parts. The Type
every rule uses is `state.type`; without one, the triage's (a `## Diagnosis` with a filled
`Confirmed root cause:` or `Symptom proof:` is `bug/error`, else `feature/refactor`); without a
triage, `bug/error`. A method "names a re-runnable search" when it carries a backtick span or
one of the words `grep`, `rg`, `glob`, `ast-grep`, `git `, `find `, `ls `, `sed `, `awk `,
`node `, `npm `. Table cells are split the GFM way: one leading and one trailing `|` are
dropped, `\|` is a literal pipe, a pipe inside a code span (a backtick run closed by a run of
the same length on the line) is cell text, and an unmatched backtick is plain text. The gate
codes, in output order per phase:

- `01`, the `## Brief` of the triage, matched as a whole unfenced heading line (never a prefix):
  - `brief-missing` — `## Brief absent`, on every verdict (a later phase prompt needs it even
    on a terminated run);
  - only on `PROCEED`: `brief-field-empty` — `<field>`, for `Affected area`, `Context`,
    `Objective`, `Expected outcome` and `Commit type`, in that order, when the field is absent,
    blank, `n/a` or wholly a `<…>`/`[…]` placeholder; `brief-type-invalid` — `<value>` when the
    leading token of a present `**Type:**` is not `bug/error`/`feature/refactor`, so `bug/error
    (security)` passes (an absent Type is no gate: the `## Diagnosis` rule below applies);
    `brief-commit-type-invalid` — `<value>` when the leading token of the Commit type is not one
    of the accepted commit types, so `fix(queue)` passes. The leading token is the lower-cased run
    of `[a-z/_-]` the plain value opens with.
- `01` `symptom-proof-missing` — a `PROCEED` on a `bug/error` run whose `## Diagnosis` is
  absent, has no `Symptom proof:` line, or leaves it empty, `n/a` or a `<…>` placeholder.
- `07`, on the first table of the last round with a `Result` column:
  `runtime-not-met` — a row whose Result starts `NOT MET` without `to confirm`;
  `runtime-no-attempt` — a row whose Result is none of `MET`/`NOT MET…`, or whose Evidence is
  empty, `-`, `none` or `not run`.

`03` and `05` have no gate code. A `bug/error` plan with no `**Type mismatch:**` line with
evidence must still carry `## Symptom coverage` (`MISSING: ## Symptom coverage`, or `(empty)` with
no table row), and two findings on it print as `OPEN:`, never as a gate:
- `coverage-vector-no-reason` — a row whose Status is not `covered`/`not-covered`, or whose
  Reason is empty, `-`, `n/a` or `not applicable`;
- `coverage-enumeration-no-method` — `**How I enumerated:**` absent from the section, or its
  block (from the label to the first table row or the next bold label, bullets and fenced
  commands included) names no re-runnable search.

A `not-covered` row, a `**Always-gate class:** yes` line (no gate and no QA mode read it) and an
item the plan or triage leaves unconfirmed force no question. `05` reads the last round's
`## Validated risks` only for its `OPEN:` lines; a report's old `Usage coverage:` or
`Symptom coverage:` line opens nothing.

The check then acts on what it found, and no effect ever changes the first line or the exit
code. A check **completes** its phase when the first line is `OK` or `GENERATED`, no `GATE:`
fired and the verdict does not loop back (`06` `FAILED`, `07` `NOT-MET` and
`SYMPTOM-PERSISTS`); a `CONFIRM`, `TYPE-MISMATCH`, `NEEDS-DEVICE` or `UNAVAILABLE` line
completes, except `INVALIDATED:` on `05`, which never does. On completion it records the phase (`recorded: phase_done <phase> <verdict>`, plus
` — reason: <reason>` on a re-run: the line the same check failed with, else
`re-run after <check> <line>` of the newest failure, else `re-run`; ` (already)` when the same
text was already recorded); otherwise it prints `recorded: none (<line>)`, and a write the
state refuses prints `recorded: not recorded (<reason>)`. `01` records the Type, even on a
gate: the Brief's valid `**Type:**` wins over a recorded one (`recorded: type <type>`, or
`(was <old>)` when it replaces one); without it the Type the triage implies, only when
`state.type` has none. On completion `01` also writes the triage's `## Brief` section
verbatim into `<RUN_DIR>/00-brief.md` (`recorded: brief 00-brief.md`), records the
`commitType` (`recorded: commit type <c>`), on a terminal verdict (`NOT-REPRODUCIBLE`,
`NO-CHANGE-NEEDED`) the termination
(`recorded: run_terminate triage <VERDICT>`, reason
`<VERDICT>: <first item of ## Open items, else of ## Validated brief>`, `by: "runtime"`), and
on a `PROCEED` lifts a triage termination the runtime wrote (`recorded: termination
cleared`). The slug comes last, after every other write to the run dir: a job run that still
holds the provisional slug the runtime derived takes the Brief's `**Slug:**` (the row
rebound and the run dir renamed, as a `SLUG:` declaration does: `recorded: slug <new>
(renamed from <old>; run dir <path>)`, the path the orchestrator uses as `RUN_DIR` from then
on); any other run keeps its slug (`recorded: slug <slug>`, with `(kept: <reason>)` when the
Brief named one it cannot take: absent, not a safe segment, already taken, or the run already
has its slug). The runner re-reads the row's slug after the session, so it finishes on the
renamed run. The `recorded:` order of `01` is: type, brief, commit type, phase_done,
run_terminate, termination cleared, slug. `02` on `OK` saves the
File map and the libraries into the project index, the same as `run index-save`; a store that
is unavailable inside a job queues the write (`index: not saved (store unavailable; queued at <path>)`)
and any failure prints `index: not saved (<first line of the error>)`. `05 --stage analyst`
records no phase; its
check memo is kept apart from the memo of `05`. `05 --stage triage` records `qaMode`
(`recorded: qa_mode <mode>`, `(already)` when the same mode stands), with a memo of its
own; only a `skip` records a phase, `qa` with the verdict `SKIPPED`, its sentence as the `note` and
`QA skipped: <why>` as the `reason`, which puts it on the reflector's timeline. A reworded `skip`
answers `(already)` while the runtime's `SKIPPED` is the last `qa` entry, so a relaunch is no re-run. A `lite` or `full`
removes that `SKIPPED` from `phases`, and records its `qa` phase through `05`; `05` is never called on a skip, whose round carries no
`## Verdict`. `run_terminate` still works for an older plugin.

**The QA consolidation is the check's own.** `05-qa.md` holds three kinds of `## Round`, told
apart by the first non-blank line after the heading: `source: runtime consolidation` is a
consolidated round; `source: prover…` a prover round, whose group is read only from the line
`run append --group` stamps (`source: prover · group: <id>`; any other prover line has no group,
so its round never supersedes nor is superseded); otherwise a round with
`## Break hypotheses` is the analyst's, and any other round a lite one. Before it evaluates,
`run check 05` (no stage) takes the run lock and, when the last round is neither lite nor
consolidated and an analyst round exists, merges the window — the last analyst round plus every
prover round after it, the later round of a group replacing the earlier one — into a new
`## Round <n+1>` whose first line is `source: runtime consolidation · rounds <a>, <b>, …`; it
validates that round with the same D1-D4 rules the final check reads it by and, when one fires
(e.g. a fenced `## Round <n+2>` quote carried from the analyst), writes nothing and fails with
`the consolidated round <n+1> of 05-qa.md would be ill-formed, so nothing was written: …`. It
carries, in this order and only when some merged round has it, `## Mapped rules`,
`## Proven breaks`, `## Suggestions (non-blocking)`, `## Access map (QA)`, `## Validated risks`,
`## Invalidated assumptions`, `## Generated PoCs` and `## Prevention`: each the analyst's body
first, then the provers' in round order, raw (HTML comments kept byte for byte; a heading
inside a fence or a comment opens no section), blank-line separated, bodies that say nothing
dropped (every line blank, a none spelling — `None`, `Nothing`, `N/A`, `No proven breaks`,
`(none)`, any bullet, bold, italic or backtick decoration, the whole line or followed by
punctuation and an explanation, never a prefix such as `None of the callers…` — with the prose
lines that explain it, a dash, or a header-only table; all of
them keeps the first body); `## Mapped rules` and `## Access map (QA)` come from the
analyst only. Its `## Verdict` counts proof, not the analyst's verdict over open hypotheses:
any merged round whose `## Proven breaks` has a break item gives `NEEDS FIX`; a break item is
any unfenced line (fenced output is evidence) that is not blank, a none spelling, a dash, a table
header or separator, a table row whose cells are all empty, none or dashes, a prose line (no
bullet, no table row, not opening with `H<n>`) in a body that holds a none spelling, or a
regression that passed in any wording (the line or row carries a regression mark —
`type=regression`, `(regression)`, a `.regression.` file or `regression PoC|test|net` — and a
`pass`/`passes`/`passed`, and no failure besides `0 fail`) — such a body is kept in the merged section; else, with
prover rounds, the provers' verdicts plus the coverage of the analyst's hypotheses (any
`NEEDS FIX` gives `NEEDS FIX`, else any `NEEDS DISCUSSION` or an unreadable verdict, named on a
note line, gives `NEEDS DISCUSSION`, else `APPROVED`); with no prover round, an analyst with
hypotheses gives `NEEDS DISCUSSION` (`no prover round for the analyst's hypotheses`) and one
without gives its own verdict. The coverage reads the `H<n>` ids that open the items of the
analyst's `## Break hypotheses` and the `H<n>: BROKE|HELD|INCONCLUSIVE` lines of the counted
prover rounds' `## Validated risks` (`REFUTED` reads as `HELD`; `PROVEN` reads as `BROKE`, and as
`HELD` on a hypothesis whose line says `type=regression` or `type: regression`; the
first status word wins; a bullet or a numbered item allowed; both outside fences and comments,
bold and backticks ignored): any `BROKE` line gives `NEEDS FIX` (`BROKE: H<a>, …`); else an analyst id with no
prover line or an `INCONCLUSIVE` line gives `NEEDS DISCUSSION` (`no prover line for H<a>, …`,
`INCONCLUSIVE: H<c>, …`), so a prover that never appended shows up as its ids. Analyst
hypotheses with no `H<n>` id keep the provers' verdict and add the note `the analyst's
hypotheses carry no H<n> id; coverage not checked`. The check then answers over that round, and a second check writes nothing
(the last round is already a consolidation) until a later prover round arrives. Stage A
(`05 --stage analyst`) requires every section check `05` reads, so an analyst-only skip round
always passes the final check. A `source: qa-triage` round precedes the analyst's and is never
consolidated.

**`nightqueue run append 05 --group-label <label> --from <file>`** (or `--group <id>`) is the one path a prover writes its
round by. `<id>` is the group's slug plus
8 hex of its sha256, derived from `<label>` by the runtime, and the runtime stamps
`source: prover · group: <id>` as the round's first line, dropping the draft's own
`source: prover…` line. It refuses a check other than `05`, a missing or invalid `--group`
(`^[a-z0-9][a-z0-9-]{0,63}$`), a missing `--from`, an empty draft, a draft with a column-0
`## Round` line (fenced or not; a leading one is dropped), a draft that leaves a code fence or
an HTML comment open (naming its line), and a draft whose source is `source: runtime
consolidation`. It rewrites the draft's `H<n>: REFUTED` lines of `## Validated risks` (outside
fences and comments, decorations kept) as `H<n>: HELD (REFUTED)` and keeps an `H<n>: PROVEN` as
written (its reading depends on the hypothesis type, which only the consolidation knows), every
other byte unchanged. Under the
same run lock as `state.json` it reads `05-qa.md`, closes a code fence an earlier round left
open (printing the `REPAIRED:` line before `APPENDED:`), numbers the round from the file (the highest
round plus one), refuses to write when the new heading would not read as the last round,
writes it atomically and prints `APPENDED: ## Round <n> to <path>`, so provers appending at the
same time never lose a round nor share a number.

**A gate notice is composed from the record.** `run_outcome` with `status: "gate"` takes
`question`, `from_artifact: {file, section}`, or both, and composes the whole `## Notice`:
`file` is a bare artifact name of the run directory (`^[A-Za-z0-9][A-Za-z0-9._-]*\.md$`, read
on its last `## Round` when it is a round artifact) and `section` a heading found by prefix,
outside fences, at its exact level first and then by the same title at any level (`#` to
`######`), so every section `run check` requires or announces (`CONFIRM`, `## Open items`,
`## Runtime verdict`, `## Usage coverage`) is found. A confirmation section, at any heading level, is carried verbatim; any other is
nested under that heading; the question follows; inside a job the body ends with
`Answer with: nightqueue queue retry J-<id> --note "<your answer>"`. A missing file or section,
a path, `question`/`from_artifact` with another status, or either one together with `notice`
is refused, and nothing is recorded. The answer echoes the composed `notice`. The pipeline
then ends its turn with one plain line: the job ends at `gate` with the recorded notice, and a
`## Notice` in the text never replaces it.
The shipped pipeline's one pause is Phase 3's, with `from_artifact.file` `03-plan.md`. A gate whose
notice shows the plan's filled question, however it was sent, records `gateQuestionDigest` and
`gateAnswersSeen` in the same locked write, and any other gate clears both; an answer recorded after
that pause is what the next `run check 03` reads as `CONFIRM: answered (<at>)`.

**A job is self-contained, and a finished job does not resume.** `queue_add` refuses, before
anything is registered or queued, a prompt that conditions the work on another job or pull
request, answering "This brief depends on another job's pull request. A job must be
self-contained: fold this work into that job (as a stage) or make it independent. Nothing was
changed. Matched: `<phrase>`." The patterns (`src/queue/dependent-prompt.mjs`) are matched
case-insensitively, anywhere, on the prompt without its fenced code and `<comment-thread>`
blocks: `after [job] J-<n>`, `once PR|pull request #<n> is|has been|gets merged`,
`depends on J-<n>` / `depends on job`, `when [PR] #<n> lands`. The CLI `queue add` and the
studio do not apply it. `queue_retry` and `queue retry` refuse a `closed` job
(``J-<n> is closed: a finished job does not resume; queue a new one``) and a `done` job whose
pull request gh reads as merged (``J-<n> is done and its pull request is merged: …``), before
writing anything; an unreadable answer or `NIGHTQUEUE_NO_PR_CHECK=1` proves no merge. With neither
`note` nor `fresh` they also refuse a run whose last two attempts recorded no new phase, no new
answer and no new loop decision (``J-<n> made no progress in its last two attempts (same <n> phases, no new answer): answer
with a note, or retry --fresh``), nothing written.

**The commit message follows the template in effect.** `run start` answers
`commitTemplate{source, path, label}`, first match wins: `config` (git's `commit.template` read
in the run's checkout, `~` and relative paths resolved, a missing file falls through), `repo`
(the repository's commit convention file; `.gitmessage` gives `path`), `nightqueue` (the
fallback, `plugin/skills/resolve/references/commit-template.md`). `run publish --message-file`
checks the message before staging anything and prints one
`REJECTED: commit message — <reason>` per violation: an empty subject or one starting with `#`,
a body whose line 2 is not blank, a `Co-Authored-By:` line (any case, at line start) or a
`Refs:` line; under the fallback, a subject that is not Conventional Commits. Once the pull
request is open, `run publish` and `run pr` record the `commit` phase (`by: "runtime"`).

**A recorded QA skip is told in the pull request.** When `state.qaMode.mode` is `skip`,
`run publish` refuses, before it commits anything, a body without the plain line
`QA: skipped — <state.qaMode.reason>`. The comparison is exact and against the state, never against
agent text, so another reason is refused too, and a fenced or commented copy does not count. The
template's rules read the body without that line, so a `#<number>`, a placeholder shape or the run
slug in the reason cannot make it unpublishable; that text reaches the pull request as recorded.
`lite`, `full` and no `qaMode` owe no line. `run pr` does not enforce it.

**A lockfile is published only when it is proved reproducible.** `run publish` refuses every lockfile (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
`bun.lockb`, `bun.lock`) EXCEPT when all three hold: (1) the `package.json` of the same
directory is in the publish set and differs from the base branch; (2) the lockfile differs
from the base branch; (3) the manager's frozen install - `npm ci --ignore-scripts`, or
`yarn`/`pnpm`/`bun install --frozen-lockfile --ignore-scripts` - run by the runtime in the
lockfile's directory succeeds, under `queue.bashTimeoutS.default`. A lockfile with no changed
manifest is refused as `a dependency lockfile`; (1) without (2) is refused as `manifest
changed but the lockfile did not: run <manager> install`; a failing install is refused with
the tail of its output. Every refusal keeps the `--extra` sentence, and `nightqueue verify`
still treats a lockfile as an intruder (it never installs).

**Traceability is the runtime's, never the agent's.** `nightqueue run pr`
publishes a copy of the body, `<RUN_DIR>/pr-body.published.md` (the agent's file
untouched), ending in the footer `Opened by nightqueue · J-<n>` inside a job, followed by
` · <kind> <ref>` for every origin of the job in stored order (`Opened by nightqueue · J-12 · linear MK-42 · sentry 4507`),
and `Opened by nightqueue` outside a job. A body that already carries an
`Opened by nightqueue` line, a whole `Refs` line, a job ref (`J-<n>`, or the
caller's own `job <id>`) or the run slug is rejected naming the line
(``REJECTED: line <n> carries <what>, which `run pr` appends from the job row:
<line>``); fenced blocks and code spans (a span wrapped over lines included) are
not read. A body that ends inside an unclosed fenced block or `<!--` comment is
rejected naming the line that opens it, since the footer would render inside
it. A footer that cannot be built pushes nothing. `nightqueue run publish` commits the
message untouched, and a message that carries a `Refs:` line is rejected (``REJECTED: commit message — line <n> is a
`Refs:` trailer, ...``) with nothing staged.

`pipeline_runs.model` and `pipeline_runs.session_id` are not parameters: the
server reads them from `NIGHTQUEUE_MODEL` and `NIGHTQUEUE_SESSION_ID` in its own
environment, and stores `NULL` when they are not set.

