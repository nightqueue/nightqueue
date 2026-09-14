# Runtime contract

What a runtime has to provide, and what it can rely on:

- `NIGHTSHIFT_HOME` - home directory of the runtime, default `~/.nightshift`.
- `${NIGHTSHIFT_HOME}/runtime/versions/<version>-<stamp>/` is one installed runtime, and
  `${NIGHTSHIFT_HOME}/runtime/current` is the symlink that names the one in use. Every
  path the host is registered against goes through the link, as
  `${NIGHTSHIFT_HOME}/runtime/current/node_modules/@maykonv/nightshift`.
- `${NIGHTSHIFT_HOME}/runners/<pid>.json` registers ONE live runner - `watch`, `drain` and
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
  runner itself on a clean exit, matched by pid, by `nightshift queue run --stop`, or by the
  prune of any reader once no process answers for it. A `runner.pid` left by a version
  before the registry is adopted read-only: listed, counted by the install refusal, stopped
  by `--stop` and pruned when dead, never written again.
- The output of a detached runner lives in
  `${NIGHTSHIFT_HOME}/logs/runner-<stamp>.log`, next to the one log per job.
- Run artifacts live in `${NIGHTSHIFT_HOME}/runs/<project>/<slug>/`, always
  outside the worktree, because the worktree is removed before the last phase
  reads them.
- Artifact names, in order: `01-triage.md`, `02-explore.md`, `03-plan.md`,
  `04-implementation.md`, `05a-qa-analyst.md`, `05-qa.md`,
  `06-verification.md`.
- `state.json` in the same directory carries the resumable state:
  `schemaVersion`, `slug`, `project`, `type`, `tier`, `branch`, `worktree`,
  `resumeCount`, `updatedAt`, `termination`, `qaStageA` and
  `phases[{phase, artifact, verdict}]`. Once a runner has closed the job it merges one
  more key into that same file, `terminal{status, prUrl, finishedAt, writtenBy, pid}`:
  the witness of the outcome, written only by the runner and read only by the
  reconciliation. Nothing else of the file is touched, and the direction is never
  reversed - the row is rebuilt from the file, the file is never rebuilt from the row.
- Literals a runtime parses from the pipeline's stdout: `QUEUE_SLUG:`,
  `## Requires user confirmation` (the run is waiting on a human gate) and
  `## Notice` (the executive summary to deliver).
- Authority of each literal: the LAST standalone `QUEUE_SLUG:` line of the
  orchestrator wins, and the `## Notice` and the pull request URL of the run are
  read from the FINAL `result` event - an intermediate message that echoes an
  earlier one never wins. A pull request URL only counts as delivered when it
  closes a line outside any code fence and that line does not report a failure;
  a URL cited inside a sentence, an example or an error message is a reference,
  and a run that delivers none ends as `gate`, never as `done`.

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
replaced while it runs; stop it with nightshift queue run --stop or wait for the queue to
drain`, naming every live pid, and install nothing. `--force` installs anyway and says so on stderr. A runner whose version
directory disappears anyway - a `--force`, or a hand-deleted tree - stops claiming,
finishes the job it is running and exits saying so.

**Any number of runners own the queue together.** Every start registers its runner under
the home lock, in the same critical section as the prune of the dead registrations:
`queue run`, `queue run --watch`, `queue run --job`, `queue add --run`, `queue retry --run`,
their `--foreground` forms and the `queue_run` and `queue_retry` MCP tools. None of them is
ever refused because another runner is live. A single-job start whose job could not be
claimed right now answers `waiting` with the reason and starts nothing, because its child
would run one cycle and exit without claiming; `queue_run` and `queue_retry` answer the same
thing as `{ "started": false, "waiting": { "reason": "cap-reached" }, "message": ... }`.
`queue_status` answers `runners` with every live runner, and keeps `runner` as an alias of
the first for one release.

The eighteen MCP tools, with the parameters `nightshift mcp` actually accepts:

| tool | parameters |
|---|---|
| `lesson_recall` | `query?`, `project?`, `target?`, `exclude_ids?` |
| `lesson_save` | `title`, `root_cause`, `solution`, `prevention`, `attempts?`, `project?`, `target?` |
| `memory_recall` | `query?`, `project?` |
| `index_save` | `project`, `repo_root`, `files[{path, responsibility}]`, `libs?[{lib, version}]` |
| `index_recall` | `project`, `repo_root?`, `query?` |
| `pipeline_log` | `slug`, `tier`, `outcome`, `project?`, `tier_operator?`, `tier_raise_reason?`, `task_type?`, `gate_stop?`, `duration_s?`, `phases?[{phase, model?, status?, retry?, duration_s?, note?}]` |
| `queue_add` | `project?`, `prompt?`, `roadmap_item_id?`, `cwd?`, `register?`, `priority?` (1-9), `max_attempts?` (1-10), `timeout_s?` (60-86400), `tier?` (`trivial`, `simple`, `complex`) |
| `queue_status` | `job_id?`, `limit?` (1-50) |
| `queue_run` | `job_id?` |
| `queue_cancel` | `job_id`, `reason?` |
| `queue_retry` | `job_id`, `note?`, `fresh?`, `run?` |
| `decision_save` | `project`, `title`, `context`, `decision`, `consequences?`, `status?` (`proposed`, `accepted`, `superseded`, `rejected`; default `accepted`) |
| `decision_update` | `id`, `title?`, `context?`, `decision?`, `consequences?`, `status?`, `superseded_by?` |
| `decision_list` | `project`, `status?` |
| `decision_recall` | `project`, `query?`, `limit?` (1-20) |
| `roadmap_save` | `project`, `horizon` (`now`, `next`, `later`), `title`, `detail?`, `decision_id?` |
| `roadmap_update` | `id`, `horizon?`, `title?`, `detail?`, `status?` (`open`, `done`, `dropped`; `queued` is refused), `position?`, `decision_id?` |
| `roadmap_get` | `project` |

In `pipeline_log`, `tier` is the FINAL tier the run executed, `tier_operator` is the
tier the operator declared on the job (absent when there was none), and a run whose
`tier_operator` differs from its `tier` is a run whose tier was raised, with the
evidence of that raise in `tier_raise_reason`. There is no "raised" flag: it is derived
from those two values.

The five queue tools are the same subsystem as `nightshift queue` (see [Queue](queue.md)):
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
characters and answers with the state of the runner next to the jobs, `queue_run`
starts the runner detached and answers right away with the path of its log,
`queue_cancel` refuses a job running under a live lease without writing anything,
and `queue_retry` sends a gated, failed or cancelled job back to the queue - its
`run` starts a DETACHED runner, the same one the `--run` of the CLI starts unless
it is asked for `--foreground`.

Inside a job, a tool that takes a free id only reaches its own: `queue_retry`
retries the job it is running, and `decision_update` and `roadmap_update` accept
only ids belonging to the project of that job - another project's id is refused
naming both projects, and nothing is written. Outside a job none of these
restrictions apply.

Every optional parameter accepts an explicit `null` and treats it exactly like
an absent one, so a caller that fills its whole argument object never gets an
error for a field it had nothing to put in. The closed
vocabularies are `target` (`triager`, `architect`, `coder`, `qa`, `verifier`),
`tier` (`trivial`, `simple`, `complex`), `task_type` (`bug/error`,
`feature/refactor`), `outcome` (`pr_opened`, `local_commit`, `no_commit`),
`gate_stop` (`critique`, `triage`, `architect`, `qa`, `verification`, `runtime`,
`user`), the phase `status` (`ok`, `failed`, `skipped`), the decision `status`
(`proposed`, `accepted`, `superseded`, `rejected`), the roadmap `horizon` (`now`,
`next`, `later`) and the roadmap `status` (`open`, `queued`, `done`, `dropped`,
of which `queued` is the only one `roadmap_update` refuses to set). A value
outside them comes back as an error message, never as a stack.

`pipeline_runs.model` and `pipeline_runs.session_id` are not parameters: the
server reads them from `NIGHTSHIFT_MODEL` and `NIGHTSHIFT_SESSION_ID` in its own
environment, and stores `NULL` when they are not set.

