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
- Run artifacts live in `${NIGHTQUEUE_HOME}/runs/<project>/<slug>/`, always
  outside the worktree, because the worktree is removed before the last phase
  reads them. The runtime creates the directory before the session starts.
- Artifact names, in order: `00-main-measure.md` (post-merge resume only),
  `01-triage.md`, `02-explore.md`, `03-plan.md`, `04-implementation.md`,
  `05a-qa-analyst.md`, `05-qa.md`, `06-verification.md`, `06-runtime.md`.
- `state.json` in the same directory carries the resumable state, and **the runtime
  is its only writer**: every key goes through `src/queue/run-state.mjs`, which the
  MCP tools `run_phase_done`, `run_terminate`, `run_outcome` and `run_set`, the
  command `nightqueue run pr` and the runner itself call. The pipeline never writes
  the file, and an `updatedAt` an older plugin hand-wrote is overwritten by the
  runtime's clock and never read. Every key, and who writes it:
  - `schemaVersion` (always `1`), `project` and `slug`: every write, as fixed fields.
  - `updatedAt` and the `at` of every record: the runtime's UTC clock, one stamp per
    write.
  - `phases[{phase, at, artifact?, verdict?, note?}]`: `run_phase_done`, append-only,
    so a phase recorded twice never erases the first record.
  - `termination{phase, reason, at}`: `run_terminate`; a run terminated this way is
    never resumed by a retry.
  - `outcome{status, at, notice?, prUrl?}`: `run_outcome` (`status`, `notice`),
    `nightqueue run pr` (`status: "done"`) and the runner, which writes `prUrl` at
    finalize from what the session really published - it is never a parameter.
  - `prTemplate{source, path?, headings, at}`: `nightqueue run pr` (both the
    `--template` query and the publishing call), the template the body is checked
    against - `repo` with its path, or `nightqueue`.
  - `type`, `tier`, `tierRaiseReason`, `branch`, `worktree` and
    `qaStageA{artifact, verdict?, at}`: `run_set`; the runner also records
    `tier`/`tierRaiseReason` from the `Tier raised:` line and `type` from the `TYPE:`
    half of the slug declaration.
  - `resumeCount`: the runner alone, when it hands a resume over to the pipeline.
  - `terminal{status, prUrl, finishedAt, writtenBy, pid}`: the runner, once it has
    closed the job - the witness of the outcome, read only by the reconciliation.

  Nothing else of the file is touched, and the direction is never reversed - the row
  is rebuilt from the file, the file is never rebuilt from the row.
- Literals a runtime parses from the pipeline's stdout: `SLUG: <slug> TYPE: <type>`
  (the run renames itself), `Tier raised: <from> -> <to>: <evidence>` (the Brief
  raised the tier), `## Requires user confirmation` (the run is waiting on a human
  gate), `## Notice` (the executive summary to deliver) and `QUEUE_SLUG:`, which
  **is deprecated in favour of `SLUG:`** and still read.
- Authority of each literal:
  - `SLUG:` - a standalone line, orchestrator text only. The FIRST valid declaration
    of the run wins and every later one is ignored, because a run is renamed once:
    the runtime renames the run directory it had already opened and re-points the
    row. A slug that is not a safe path segment, or one another run of the project
    already holds, is refused - the job keeps the slug the runtime gave it and the
    reason goes to the job log. `TYPE:` is optional and is recorded as the run's
    `type`.
  - `QUEUE_SLUG:` - the LAST standalone line wins. It is kept for a plugin older
    than the named prompt, which has no other way to bind its slug, and the runtime
    still asks for it in the prompt of a job whose row carries no run yet.
  - `Tier raised:` - a standalone line, the LAST of an event wins. `<to>` becomes the
    run's `tier` and `<evidence>` its `tierRaiseReason`; the Brief prints it before
    the run has a slug, so the raise waits in memory until there is a `state.json` to
    record it into.
  - `## Notice` - read from the FINAL `result` event; an intermediate message that
    echoes an earlier one never wins.
- The prompt is the other direction of the same contract: the runtime names the run
  before the first phase with `Project: <name>` and `RUN_DIR: <absolute path>`, and a
  run that can be resumed also carries the block ``RESUME CANDIDATE (slug `<slug>`)``
  with `RUN_DIR:`, `Branch:`, `Worktree:`, `Last completed phase:`, `Resume from
  phase:` and `From stage:` - the decision is already taken when the prompt is built,
  and the pipeline reads it instead of re-deriving it (see [Queue](queue.md)).
- The pull request of the run has one source chain, in this order: the
  `{"type":"system","subtype":"code_change_published","url":…,"branch":…}` event the HOST emits
  when it publishes the change - only when it proves it is the run's own delivery -, then the
  `outcome.prUrl` the runtime itself recorded in `state.json`, then a publication that cannot
  prove it, then the text of the stream. Only an event with
  `"action":"created"` publishes a delivery, and one session may publish for more than
  one repository: the run's own repository is the one the rest of the classification
  reports, or the one of its FIRST publication. The run's own delivery is the LAST
  publication of THAT repository whose `branch` is the run's own branch - the `branch`
  of `state.json` or its published alias (`worktree-feat+x` is `feat/x`, the rename
  `nightqueue run pr` applies and then records as the run's branch). A publication that
  names no branch, or that the run cannot compare because it recorded none, is unproven:
  it loses to a recorded `outcome.prUrl` and is only the delivery when the runtime
  recorded none. A publication naming ANOTHER branch - a QA's scratch pull request, say -
  is never the run's pull request, not even for lack of a better one. Every publication
  dropped by these rules is named in the notice, on one line starting with
  `⚠️ another pull request was published during this run and was NOT recorded as its delivery:`.
  A publication for another repository, an event with any
  other `action` and a `url` of another shape are all ignored. In the text - the last source, which serves
  another provider and a runtime older than the event - a URL only counts as delivered
  when it closes a line outside any code fence and that line does not report a failure;
  a URL cited inside a sentence, an example or an error message is a reference, and a
  run that delivers none is never `done`; it is a `gate` only when the run itself asked
  for a decision - a recorded `outcome.status: "gate"` in `state.json`, or the
  `## Requires user confirmation` marker in the stream - AND its resolved notice itself
  carries that heading (`hasGateMarker`, reused from the stream); when the run's
  `03-plan.md` is readable and has its own `## Requires user confirmation` section (heading
  to the next level-2 heading, outside fences), a notice shorter than that section by more
  than `GATE_NOTICE_MARGIN_CP` (200 code points, `src/queue/classify.mjs`) is read the same
  way - a gate whose notice does not carry the question is `failed`, with the
  fixed notice `the run stopped at a gate but its notice does not carry the question - see
  <plan path>` (`<plan path>` unknown when the classifier was given none); a clean run
  reaching neither reading is `failed` otherwise, keeping its final text as the reason.

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
they exit `1` with `a runner is active (pid P / pid Q / job #N) - the runtime cannot be
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
default. `queue_status` answers `runners` with every live runner, and keeps `runner` as an
alias of the first for one release. `queue_status`, `queue_run` and `queue_retry` also answer
`advisories`, the advisory lines described in [Queue](queue.md); they never block a start.

The twenty-seven MCP tools, with the parameters `nightqueue mcp` actually accepts:

| tool | parameters |
|---|---|
| `lesson_recall` | `query?`, `project?`, `target?`, `exclude_ids?` |
| `context_for_phase` | `target` (`triager`, `architect`, `coder`, `qa`, `verifier`, `explore`), `query?`, `project?`, `repo_root?`, `exclude_ids?` |
| `lesson_save` | `title`, `root_cause`, `solution`, `prevention`, `attempts?`, `project?`, `target?` |
| `memory_recall` | `query?`, `project?` |
| `index_save` | `project`, `repo_root`, `files[{path, responsibility}]`, `libs?[{lib, version}]` |
| `index_recall` | `project`, `repo_root?`, `query?` |
| `pipeline_log` | `outcome`, `project?`, `slug?`, `tier?`, `tier_operator?`, `tier_raise_reason?`, `task_type?`, `gate_stop?`, `duration_s?`, `phases?[{phase, model?, status?, retry?, duration_s?, note?}]` |
| `queue_add` | `project?` (for an org roadmap item: a project of the org, or `all`), `prompt?`, `roadmap_item_id?`, `cwd?`, `register?`, `priority?` (1-9), `max_attempts?` (1-10), `timeout_s?` (60-86400), `tier?` (`trivial`, `simple`, `complex`) |
| `queue_status` | `job_id?`, `limit?` (1-50) |
| `queue_run` | `job_id?` |
| `queue_session` | `job_id` |
| `queue_cancel` | `job_id`, `reason?` |
| `queue_close` | `job_id`, `force?` |
| `queue_retry` | `job_id`, `note?`, `fresh?`, `run?` |
| `decision_save` | `project`, `title`, `context`, `decision`, `consequences?`, `status?` (`proposed`, `accepted`, `superseded`, `rejected`; default `accepted`) |
| `decision_update` | `id`, `title?`, `context?`, `decision?`, `consequences?`, `status?`, `superseded_by?` |
| `decision_list` | `project`, `status?` |
| `decision_recall` | `project`, `query?`, `limit?` (1-20) |
| `roadmap_save` | `project`, `title`, `type` (`bug`, `feature`, `improvement`, `chore`, `incident`), `detail?`, `priority?` (1-9, default 5, 1 first), `status?` (default `todo`; `in_progress` is refused), `decision_id?`; `horizon` is refused by name |
| `roadmap_update` | `id`, `title?`, `detail?`, `type?`, `status?` (`backlog`, `todo`, `in_review`, `done`, `cancelled`; `in_progress` is refused), `priority?`, `position?`, `decision_id?`; `horizon` is refused by name |
| `roadmap_get` | `project`, `status?` (list), `priority?` (list), `type?` (list); or `id` alone for one item with its comment thread |
| `roadmap_comment` | `id`, `body` |
| `roadmap_search` | `query?`, `file?` (a recorded path, exact or a directory above it), `project` or `org` (inside a job: the job's own project), `limit?` (1-5) |
| `run_phase_done` | `phase`, `artifact?`, `verdict?`, `note?`, `project?`, `slug?` |
| `run_terminate` | `phase`, `reason`, `project?`, `slug?` |
| `run_outcome` | `status` (`done`, `gate`), `notice?`, `project?`, `slug?` |
| `run_set` | `type?`, `tier?`, `tier_raise_reason?`, `branch?`, `worktree?`, `qa_stage_a?{artifact, verdict?}`, `project?`, `slug?` |

The four `run_*` tools are the only way the pipeline records its run (see the
`state.json` list above). Inside a job each of them resolves the run from the job's
own row, and a `project` or a `slug` sent there is REFUSED instead of silently
overridden - naming another job's run from inside one is never an accident worth
guessing at; outside a job both are required. A row that carries no slug yet is
answered with the `SLUG:` line to print, never with a guessed run directory.
`run_outcome` never touches the roadmap: the item the job was queued from follows
the job's row (see below). `context_for_phase` returns `{project, block}`: the block is
`## Applicable lessons` + `## Project memory` (+ `## Structural index` for
`target: "explore"`, + `## Related roadmap items` for `target: "triager"`: at most
five `- [<ref>] <title> [<status>, p<priority>, <type>]` lines `roadmap_search`
finds for the query in the job's project), already formatted, and is empty when there is genuinely
nothing to inject. Inside a job it excludes the lessons this run was already given
and asks again without the exclusion when that would leave the phase with nothing -
`lesson_recall` does the same, so no caller keeps that bookkeeping by hand.

In `pipeline_log`, `tier` is the FINAL tier the run executed, `tier_operator` is the
tier the operator declared on the job (absent when there was none), and a run whose
`tier_operator` differs from its `tier` is a run whose tier was raised, with the
evidence of that raise in `tier_raise_reason`. There is no "raised" flag: it is derived
from those two values. Inside a job, `project` and `slug` come from the job's own row
and whatever the call sent for them is overridden (not refused: an older plugin still
sends them); `tier`, `task_type` and `tier_raise_reason` may be left out when the run
already recorded them with `run_set`, and a `tier` neither the call nor the run
resolves is refused naming `run_set`, before any row is written. The durations and the
models are measured by the runtime on the stream of the job - the total from the
attempt marker to the last message, and one lane per subagent, matched to its phase in
the order the phases were launched - and they overwrite what the call sent. A phase the
runtime measured no lane for keeps the value the call carried, and a phase the call
never recorded is not inserted.

The eight queue tools are the same subsystem as `nightqueue queue` (see [Queue](queue.md)):
`queue_add` takes the registered project NAME and never a path - or, with
`project` omitted, the absolute `cwd` of the caller, which resolves the project
that contains it; a `cwd` inside a git repository that is registered nowhere
answers `{ "needs_registration": true, "cwd", "suggested_name", "org", "hint" }`
instead of failing, and only a second call carrying `register: true` (after the
user confirmed it) registers the repository and queues the job. An unattended run
never registers anything: inside a job the call is refused. `prompt` is required
unless `roadmap_item_id` names a roadmap item, which builds the prompt and owns
the project (see [Decisions and roadmap](memory.md#decisions-and-roadmap)); passing both is refused.
`queue_status` never returns the prompt of a job and truncates `notice_md` and `result` at 500
characters in a listing; a row whose text was cut carries `notice_truncated: true` or
`result_truncated: true` (the key is absent when the text fits, and the detail of one job by
`job_id` is never cut), and `suggestions` plus the `hint` gain one line naming
`nightqueue queue status <id>`, where the whole text is. It answers with the state of the runner next to the jobs; it is a pure read
that never repairs nor prunes on call, and reports the last repair warning of the server's
maintenance (once at start, then every 60 s, never inside a job) as `warning`. `queue_run`
starts the runner detached and answers right away with the path of its log,
`queue_cancel` cancels a `pending`, `gate`, orphaned, `done` or `failed` job and answers `{ ok,
job, worktree }` - `worktree` is `{ path, status, reason? }` when cancelling a `done` or `failed`
job released (`removed`) or kept (`kept`, with the reason) its worktree, and `null` otherwise; it
refuses a job running under a live lease, or one whose close is in flight or was interrupted, without
writing anything (an interrupted close is resumed with `queue_close`, never cancelled blind).
`queue_close` starts the same DETACHED closing pipeline as `nightqueue queue close <id>` (the CLI
also offers `nightqueue queue close --merged`, which closes every `done` job whose pull request is
merged in one call), and `queue_retry` sends a gated, failed or cancelled job back to the queue - its
`run` starts a DETACHED runner, the same one the `--run` of the CLI starts unless
it is asked for `--foreground`. `queue_close` answers `{ ok, started, job_id, pid, logPath, follow }` without
waiting for the merge: a `done` job with a pull request only, and every
other status (``job `N` is already closed`` for a closed one), a job without a pull request or one
already under a live close lease refused by name with nothing written; calling it again resumes a
close that stopped at the step that failed. `force: true` skips the pull request checks and the
rebase suite only - status, attribution and real conflicts still stop the close. A pull request
closed without merge ends the close by cancelling the job, one merged by hand is recorded as
`merged outside a close`, and the tool never settles the job's proposed decisions. Inside a job
it is refused, like the CLI (see [Queue](queue.md#closing-a-job)).

Inside a job, a tool that takes a free id only reaches its own: `queue_retry`
retries the job it is running, and `decision_update` and `roadmap_update` accept
only ids belonging to the project of that job - another project's id is refused
naming both projects, and nothing is written. `roadmap_get` by `id` and
`roadmap_comment` accept an item of the job's project or of its org, never a
sibling project's; a comment written there is signed `job:<id>` and owned by the
job's project, and the thread read there leaves out a sibling project's comments
and project rows. `roadmap_search` inside a job always reads the job's own
project (and its org's items, never a sibling project's comments), and refuses
any other owner by name.
Outside a job none of these restrictions apply, and a comment is signed `operator`.

Every optional parameter accepts an explicit `null` and treats it exactly like
an absent one, so a caller that fills its whole argument object never gets an
error for a field it had nothing to put in. The closed
vocabularies are `target` (`triager`, `architect`, `coder`, `qa`, `verifier`, plus
`explore` for the `target` of `context_for_phase`), the run `phase` (`triage`,
`explore`, `architecture`, `implementation`, `qa`, `verification`, `runtime`,
`commit`), the run `status` of `run_outcome` (`done`, `gate` - how the process
ended stays the runtime's call),
`tier` (`trivial`, `simple`, `complex`), `task_type` (`bug/error`,
`feature/refactor`), `outcome` (`pr_opened`, `local_commit`, `no_commit`),
`gate_stop` (`critique`, `triage`, `architect`, `qa`, `verification`, `runtime`,
`user`), the phase `status` (`ok`, `failed`, `skipped`), the decision `status`
(`proposed`, `accepted`, `superseded`, `rejected`), the roadmap `priority` (1-9,
1 first, like a job's) and the roadmap `status` (`backlog`, `todo`,
`in_progress`, `in_review`, `done`, `cancelled`, of which `in_progress` is the
only one `roadmap_save` and `roadmap_update` refuse to set: only a job sets it),
the roadmap `type` (`bug`, `feature`, `improvement`, `chore`, `incident`) and the
comment `kind` (`note`, `queued`, `pr`, `gate`, `merged`, `failed`, `reopened`,
`closed`). A value outside them comes back as an error message, never as a stack.

A roadmap item linked to a job follows the job's own row, never the run's report:
`in_progress` while the job is pending, running or at a gate, `in_review` once it
is `done`, `done` (with `closed_at`) once it is closed - its pull request merged
through `queue close` - and `todo` when it fails or is cancelled (a close that
finds the pull request closed without merge cancels the job). The store
applies it after every job-status write (`roadmap-workflow.mjs`,
`JOB_TO_ROADMAP`), and every claim cycle re-syncs an item a missed event left
behind; `run_outcome` moves nothing. Each event also appends one comment to the
item's append-only thread, signed `job:<id>`, in the same transaction as the
status: `queued` (queued or retried), `gate`, `pr` (the job is done), `failed`
(failed or cancelled) and `closed` (the close, with the merge sha in `refs.sha`);
running, a release and a park leave none. Its `refs` are read from the job's row: `{job_id, pr, branch,
sha, files: [{path}], decision_id}`, `files` being what the run's
`04-implementation.md` lists under `## Modified files`, recorded by the runner.
An operator's move back from `in_review` or `done` appends `reopened`. A job
queued from a roadmap item gets a `## Roadmap item` block in its prompt
(`Roadmap: <owner>#<id>`, `Type:`, `Commit type:`), its tier defaults from the
type (`bug`/`improvement`/`incident` → `simple`, `feature` → `complex`, `chore` →
`trivial`; an explicit tier wins), and `nightqueue run pr` publishes its body with
a last `Roadmap: <owner>#<id>` line - a copy in the run directory
(`pr-body.roadmap.md`), the agent's file untouched, and nothing added when the
body already has a `Roadmap:` line.

An org item is queued per project (`project` names one project of the org, or
`all`), each on its own `roadmap_item_projects` row linked to that project's
job; the item itself carries no job. Each row follows its job exactly as above,
its comments carry the row's `project`, and a job of a row publishes
`Roadmap: <org>#<id>`. The org item's status is derived from its rows in the
same transaction: `in_progress` while any row is, `done` once every row is
`done` or `cancelled`, otherwise the lowest open status among them. Closing it by
hand cancels every open row with a `closed` comment each. `nightqueue doctor`
reports an org item whose persisted status disagrees with its rows.

`pipeline_runs.model` and `pipeline_runs.session_id` are not parameters: the
server reads them from `NIGHTQUEUE_MODEL` and `NIGHTQUEUE_SESSION_ID` in its own
environment, and stores `NULL` when they are not set.

