/**
 * The store is the only path from the rest of `src/` to SQLite: `src/memory/` is its private,
 * synchronous implementation and nothing outside `src/store/` opens a connection or prepares a
 * statement. Every method is async so the same contract can one day be answered by a remote
 * implementation; today every body is a single delegation with no `await` in it, which is what
 * keeps transactions whole and the concurrency model identical to the synchronous code it wraps.
 *
 * Every read answers on the store's own connection, so a process that polls for hours - a follow loop, the
 * MCP server - takes its store from `withReadOnlyStore(env, fn)` and never from `openStore(env)`.
 *
 * A method's name is the exported name of the `src/memory/` function it delegates to, verbatim.
 * The only exceptions are the names the contract fixes: `jobs.listWithSlug`, `jobs.status`, the
 * `orgs` and `projects` registry domains, `db.files`, `health` and `close`.
 */

/**
 * Every writer that can move a job's status (`JOB_STATUS_WRITERS` of `local.mjs`) is followed, once it
 * reports success, by `issues.followJob`: one reconciler reads the job's current row and moves each
 * linked issue through the `JOB_TO_ISSUE` table of `issue-workflow.mjs`. A refused write
 * follows nothing, a failure of the follow never costs the job write, and `sweepOrphans` re-syncs,
 * on every claim cycle, whatever a missed event left behind (`issues.followDriftedJobs`).
 * @typedef {object} JobsDomain
 * @property {(spec: object) => Promise<object>} addJob the job's project by `projectId`; a `slug` binds the job to a run, refused in the same transaction while a job not yet closed is bound to it; an `origin` `{kind, ref}` is validated, otherwise one is detected in the prompt, stored in `jobs.origin` (v21) and answered as `origin`
 * @property {(spec: object) => Promise<object|null>} claimNextJob
 * @property {(id: number, spec: object) => Promise<object|null>} claimJobById
 * @property {(id: number, spec: object) => Promise<boolean>} releaseJob
 * @property {(id: number, spec: {worker: string, code: string, message: string, noticeMd: string}) => Promise<boolean>} gatePreflightJob stops a claimed job at a gate on a preflight block, giving the attempt back and keeping `blocked_code` as the mark of a retry that needs no note
 * @property {(id: number, spec: object) => Promise<boolean>} parkJob back to pending, due only at the instant a rate limit resets
 * @property {(id: number, spec: object) => Promise<boolean>} renewLease
 * @property {(id: number, spec: object) => Promise<boolean>} countAttempt
 * @property {(options?: object) => Promise<{failed: number, requeued: number}>} sweepOrphans
 * @property {(id: number, facts: object) => Promise<boolean>} persistRunFacts
 * @property {(id: number, spec: {worker: string, candidates: string[]}) => Promise<{status: "bound"|"taken"|"lost", slug?: string, heldBy?: number}>} bindRunSlug claims the first run slug no other job of the project holds
 * @property {(jobId: number, ref: object) => Promise<number>} linkPipelineRun
 * @property {(id: number, outcome: object) => Promise<boolean>} finishJob
 * @property {(id: number, spec: {status: string, noticeMd?: string|null, prUrl?: string|null}) => Promise<boolean>} fillFinishGaps fills the notice and the pull request a row already at `status` is missing, never moving its status; the replay of a queued finish the row already took by another path
 * @property {(id: number, spec: {worker: string, attempts: number, sessionId?: string|null, lastSessionId: string, lastSessionAttempt: number}) => Promise<boolean>} fillSessionFacts fills the session facts of one attempt while the same claim still runs the row, never rewinding a later attempt's session; the replay of a queued `session` record
 * @property {(id: number, options?: object) => Promise<object>} cancelJob
 * @property {(id: number, spec: {worker: string, reason?: string}) => Promise<object|null>} cancelRunningJob cancels a running job only while that worker still owns it; null when the row moved on
 * @property {() => Promise<object[]>} listCloseCandidates done jobs that carry a pull request url, the candidates `queue close --merged` may confirm and close
 * @property {(number: number) => Promise<{id: number, pr_url: string}[]>} jobsWithPrNumber the jobs whose pull request URL carries `/pull/<number>`; the caller compares the whole URL
 * @property {(id: number, options?: object) => Promise<object>} retryJob
 * @property {(id: number) => Promise<object|null>} getJob
 * @property {(id: number) => Promise<{projectKey: string|null, itemRef: string|null, decisionRefs: string[]}>} jobSpawnRefs the refs the runtime records in a run's job block before the spawn
 * @property {(options?: object) => Promise<object[]>} listJobs
 * @property {() => Promise<Record<string, number>>} countsByStatus
 * @property {() => Promise<number>} countBlockedGates gated jobs a preflight block stopped
 * @property {() => Promise<number>} countActiveJobs
 * @property {() => Promise<{projectId: string, project: string, count: number}[]>} countActiveJobsByProject
 * @property {() => Promise<number|null>} firstActiveJobId
 * @property {(id: number) => Promise<boolean>} isJobActive
 * @property {(id: number, terminal: object) => Promise<boolean>} repairJobFromWitness
 * @property {(id: number, outcome: object) => Promise<boolean>} reclassifyJob the outcome re-derived from the job's own log
 * @property {(ids: number[]) => Promise<number[]>} existingJobIds the ids of the list that have a row, read-only
 * @property {(spec: object) => Promise<"recovered"|"exists"|"project-missing">} recoverJob recreates a lost row from its run on disk with a `result.recovered` marker; not a status writer, so no issue follow runs
 * @property {(id: number, spec: object) => Promise<boolean>} correctJobPrAttribution moves a job's pull request URL and swaps its one notice line in a single compare-and-swap; false means refused, nothing written
 * @property {() => Promise<boolean>} hasClaimablePending
 * @property {() => Promise<object|null>} peekNextJob
 * @property {() => Promise<object[]>} listWithSlug unfinished jobs that already have a run directory
 * @property {() => Promise<object[]>} listOpenJobs every job that is not closed and already named its run, the owners of the worktrees `nightqueue doctor` reports
 * @property {() => Promise<object[]>} recentHostCommandCounts the host-command counters of the most recently finished jobs, the sample `nightqueue doctor` sums
 * @property {() => Promise<object[]>} recentOrchestratorCounts the orchestrator counters of the most recently finished jobs, the sample `nightqueue doctor` sums
 * @property {(tier: string, options?: {limit?: number}) => Promise<{n: number, turns: number|null, ctx: number|null, cost: number|null}>} tierBaseline the medians of turns, last context and cost of the newest delivered jobs of a tier, read-only
 * @property {(id: number) => Promise<string|null>} status the status column of one job, or null when the row is gone
 * @property {(id: number, spec: object) => Promise<object|null>} acquireClose takes the close lease of a job in one compare-and-swap and re-arms its checklist; null means refused, nothing written
 * @property {(id: number, spec: object) => Promise<boolean>} adoptClose confirms the close lease is this worker's and renews it
 * @property {(id: number, spec: object) => Promise<boolean>} recordCloseStep writes the checklist after a step and renews the close lease, witnessed on disk
 * @property {(id: number, spec: object) => Promise<boolean>} failClose stops a close as failed, keeping its checklist and releasing the lease, witnessed on disk
 * @property {(id: number, spec: object) => Promise<object|null>} settleClose closes a done job whose checklist records the merge, releases the lease and appends the settled line to its notice, witnessed on disk
 * @property {(id: number, spec: object) => Promise<object|null>} cancelOnClosedPr cancels a done job whose pull request a close step read closed without merge, keeping the checklist and releasing the lease, witnessed on disk
 * @property {(id: number, spec: object) => Promise<boolean>} noteCloseWorktree records where the settled close left the job's worktree, best effort
 * @property {(id: number, spec: object) => Promise<object|null>} acquirePostClose takes the post-close lease of a closed job (`close_worker` + `close_lease_until`, `close_status` stays NULL) in one compare-and-swap; null means another live process holds it
 * @property {(id: number, spec: object) => Promise<boolean>} recordPostCloseStep writes the checklist after a post-close step and appends its `After close:` notice line when given, witnessed on disk; never changes the job's status
 * @property {(id: number, spec: object) => Promise<boolean>} releasePostClose releases the post-close lease of a closed job
 * @property {() => Promise<object[]>} listCloses the closes in flight, failed or stalled, with the liveness of each lease
 */

/**
 * @typedef {object} RunsDomain
 * @property {(run: object) => Promise<object>} logPipelineRun
 * @property {(run: object, options: {since: string}) => Promise<object>} logPipelineRunOnce the replay of a queued run: writes it unless a run of the same project and slug was recorded since `since`, then answers `{skipped: true}`
 * @property {(spec: object) => Promise<string|null>} latestRunOutcome the outcome of the latest run recorded for a project and slug at or after an instant, or null when there is none
 * @property {(telemetry: object) => Promise<object>} updateRunTelemetry fills the durations and the models the RUNTIME measured in the stream over the row the agent recorded: the measured value wins, the agent's survives only where there is none, and a run the agent never recorded is never inserted
 */

/**
 * @typedef {object} LessonsDomain
 * @property {(lesson: object) => Promise<object>} saveLesson
 * @property {(id: number) => Promise<object|null>} getLesson
 * @property {(id: number) => Promise<object>} bumpAttempts
 * @property {(id: number) => Promise<object>} bumpViolation
 * @property {(ids: number[]) => Promise<number>} markInjected
 * @property {(spec: object) => Promise<boolean>} setLessonEmbedding
 * @property {(spec?: object) => Promise<object[]>} lessonsMissingEmbedding
 * @property {(spec: object) => Promise<object|null>} findByNormalizedTitle
 * @property {() => Promise<object[]>} memoryStats
 * @property {(spec?: object) => Promise<object[]>} recallLessons
 * @property {(lesson: object) => Promise<object>} saveLessonDeduped
 * @property {(items: object[], options?: object) => Promise<object>} persistLessons
 */

/**
 * @typedef {object} MemoryDomain
 * @property {(entry: object) => Promise<object>} saveMemory
 * @property {(spec?: object) => Promise<object[]>} recentMemories
 * @property {(spec?: object) => Promise<object[]>} searchMemories
 * @property {(spec?: object) => Promise<object|null>} memoryByKey
 * @property {(spec?: object) => Promise<object[]>} recallMemories
 */

/**
 * @typedef {object} IndexDomain
 * @property {(spec: object) => Promise<object>} saveProjectIndex
 * @property {(spec: {projectId: string, repoRoot?: string, files?: object[], libs?: object[], since: string}) => Promise<{files: number, libs: number}>} fillProjectIndex writes a queued index save only where no save touched the row since `since`, with the queued modification times; the replay of a queued `index_save`
 * @property {(spec?: object) => Promise<object>} recallProjectIndex
 */

/**
 * @typedef {object} DecisionsDomain
 * @property {(id: number) => Promise<object|null>} getDecision
 * @property {(spec?: object) => Promise<object|null>} getDecisionByNumber
 * @property {(ref: string, context?: {projectId?: string|null}) => Promise<object>} decisionOfRef the one decision a ref names (`D-<n>` in the project context, `<KEY>/D-<n>`, `G/D-<n>`), refusing an unknown or ambiguous ref
 * @property {(ref: string, context?: {projectId?: string|null}) => Promise<number>} decisionIdOfRef the id of the one decision a ref names
 * @property {(entries: Array<number|string>|null|undefined, owner: object) => Promise<number[]|null|undefined>} ownDecisionNumbers the per-owner numbers a list of numbers or refs names, refusing a ref of another owner
 * @property {(decision: object) => Promise<object>} saveDecision
 * @property {(spec: object) => Promise<object>} saveReviewedDecision
 * @property {(id: number, patch?: object) => Promise<object>} updateDecision
 * @property {(spec?: object) => Promise<object[]>} listDecisions
 * @property {(spec?: object) => Promise<object[]>} decisionTitles
 * @property {(jobId: number) => Promise<object[]>} proposalsOfJob
 * @property {() => Promise<object[]>} staleProposals
 * @property {(spec: object) => Promise<boolean>} setDecisionEmbedding
 * @property {(spec?: object) => Promise<object[]>} decisionsMissingEmbedding
 * @property {(spec?: object) => Promise<object[]>} recentDecisions
 * @property {(spec?: object) => Promise<object[]>} searchDecisionsLexical
 * @property {(spec?: object) => Promise<object[]>} searchDecisionsSemantic
 * @property {(spec?: object) => Promise<object[]>} recallDecisions
 */

/**
 * @typedef {object} IssuesDomain
 * @property {(id: number) => Promise<object|null>} getIssue
 * @property {(id: number, options?: {viewer?: string|null}) => Promise<object>} getIssueDetail one item untruncated with its comment thread; a project viewer (by id) reads only what its project sees
 * @property {(item?: object) => Promise<object>} saveIssue `type` is required
 * @property {(id: number, patch?: object) => Promise<object>} updateIssue a move back from review or done appends `reopened`, signed by `patch.author` (the operator by default)
 * @property {(spec: {id: number, body: string, author?: string, viewer?: string|null}) => Promise<object>} addIssueComment (viewer: a project id) appends a `note`; comments are append-only
 * @property {(jobId: number) => Promise<string|null>} issueRefOfJob `<KEY>-<number>` of the item a job was queued from, or null
 * @property {(ref: string) => Promise<number>} itemIdOfRef the id of the item a ref (`<KEY>-<number>`, current or old key) names, refusing an unknown one
 * @property {(options?: {dryRun?: boolean}) => Promise<{items: number, written: number, skipped: number}>} backfillIssues the one-off synthesis of the comments of items linked before comments existed; idempotent
 * @property {(owner: object, filters?: {status?: string[], priority?: number[], type?: string[]}) => Promise<object>} listIssues every item the owner sees, in workflow order, then org first, then priority (1 first) and position; an org item carries `project_status` (a project's own row) or `projects` (the org's matrix)
 * @property {(spec: {query?: string, file?: string, projectId?: string|null, orgId?: string, limit?: number}) => Promise<object[]>} searchIssues up to five items the owner sees matching the text or a file path its jobs touched
 * @property {(id: number) => Promise<object>} queueableIssue
 * @property {(id: number, jobId: number) => Promise<boolean>} linkIssueJob links an open item to its job and moves it to `in_progress`; false means a concurrent caller linked it first
 * @property {(jobId: number) => Promise<number>} followJob moves the items and org project rows linked to a job by what its current row means, re-deriving each org item; idempotent, it returns how many moved
 * @property {() => Promise<number>} followDriftedJobs follows every job whose linked items or rows missed its last status
 * @property {() => Promise<object[]>} issueDrift the linked items and rows whose status disagrees with their job's row, and the org items whose status disagrees with their rows, read without writing
 * @property {(spec?: object) => Promise<string>} buildIssuePrompt
 * @property {(spec?: object) => Promise<object>} queueIssue `{job, jobs, skipped, item, targetProject}`: an org item queued for `all` fathers one job per project
 */

/**
 * The registry of orgs: an org is a row with an id and a renamable name.
 * @typedef {object} OrgsDomain
 * @property {() => Promise<object[]>} list every org, earliest first
 * @property {(name: string) => Promise<object|null>} byName
 * @property {(id: string) => Promise<object|null>} byId
 * @property {(name: string, key?: string|null) => Promise<object>} add the key asked for, or a free one derived from the name
 * @property {(id: string, name: string) => Promise<object>} rename one row: every table owns rows by the org id
 * @property {(id: string, key: string) => Promise<{row: object, oldKey: string, key: string}>} setKey one row and one alias: the old key keeps resolving
 * @property {(name: string) => Promise<string>} suggestKey a free key derived from the name
 * @property {() => Promise<Record<string, string[]>>} keyAliases the old keys of every org, oldest first, keyed by org id
 * @property {(id: string) => Promise<object>} remove refused while a project or a row still belongs to it
 */

/**
 * The registry of projects: a project is a row with an id, a renamable name, an org and an optional checkout path.
 * @typedef {object} ProjectsDomain
 * @property {() => Promise<object[]>} list every project, path-less ones included, with its org name
 * @property {(name: string) => Promise<object|null>} byName
 * @property {(id: string) => Promise<object|null>} byId
 * @property {(id: string) => Promise<object|null>} integrations the project's `integrations` (schema v21 column) as an object; null when it has none or the column is not there yet
 * @property {(id: string, value: object|null) => Promise<object|null>} setIntegrations writes the project's `integrations`; null or an empty object stores NULL, the project without integrations again
 * @property {(cwd: string) => Promise<object|null>} at the project whose checkout contains the directory
 * @property {(orgId: string) => Promise<object[]>} ofOrg
 * @property {(spec: {name: string, path: string|null, orgId: string, key?: string|null}) => Promise<object>} add the key asked for, or a free one derived from the name
 * @property {(id: string, name: string) => Promise<object>} rename one row: every table owns rows by the project id
 * @property {(id: string, key: string) => Promise<{row: object, oldKey: string, key: string}>} setKey one row and one alias: the old key keeps resolving
 * @property {(name: string) => Promise<string>} suggestKey a free key derived from the name
 * @property {() => Promise<Record<string, string[]>>} keyAliases the old keys of every project, oldest first, keyed by project id
 * @property {(id: string, spec: {orgId?: string, path?: string|null}) => Promise<object>} move
 * @property {(id: string) => Promise<object>} remove refused while a row still belongs to it
 * @property {(id: string) => Promise<{table: string, total: number}[]>} footprint the rows the project owns, per table, only where there is any
 * @property {(id: string) => Promise<{project: object, removed: {table: string, total: number}[]}>} purge the project and every row it owns in one transaction; refused while a job is running or closing
 */

/**
 * The health of the database file itself, which `nightqueue doctor --db` reports and `--fix` repairs.
 * @typedef {object} DbDomain
 * @property {() => Promise<{main: number|null, wal: number|null, shm: number|null}>} files the sizes of the main file and its sidecars, null when absent
 * @property {() => Promise<{ok: boolean, lines: string[]}>} quickCheck `PRAGMA quick_check` on the live file, read-only
 * @property {() => Promise<{ok: boolean, lines: string[]}>} quickCheckMainAlone `PRAGMA quick_check` on a temporary copy of the main file alone
 * @property {() => Promise<{ok: boolean, lines: string[]}>} integrityCheck `PRAGMA integrity_check` on the live file, read-only
 * @property {() => Promise<{busy: number, log: number, checkpointed: number}>} checkpointTruncate `PRAGMA wal_checkpoint(TRUNCATE)` with no migration, behind a read-only pin
 */

/**
 * The raw numbers `nightqueue doctor` diagnoses with. It never throws: each field is resolved in its
 * own `try` and its failure is reported in `errors`, so one broken check never poisons the other.
 * @typedef {object} StoreHealth
 * @property {number|null} schemaVersion
 * @property {number|null} orphanJobs
 * @property {number|null} danglingReferences rows whose reference names a row that does not exist
 * @property {{schemaVersion: string|null, orphanJobs: string|null, danglingReferences: string|null}} errors
 * @property {{code: string, errcode: number|null, detail: string, home: string, path: string, hint: string}|null} unavailable
 *   the first field failure that means the database itself is unusable (a StoreUnavailableError), else null
 */

/**
 * @typedef {object} Store
 * @property {JobsDomain} jobs
 * @property {RunsDomain} runs
 * @property {LessonsDomain} lessons
 * @property {MemoryDomain} memory
 * @property {IndexDomain} index
 * @property {DecisionsDomain} decisions
 * @property {IssuesDomain} issues
 * @property {OrgsDomain} orgs
 * @property {ProjectsDomain} projects
 * @property {DbDomain} db
 * @property {() => Promise<StoreHealth>} health
 * @property {() => Promise<void>} connect opens the connection now, for the caller that needs it to exist before it reads anything
 * @property {() => Promise<void>} close releases this instance; a read-write one never closes the shared connection
 * @property {() => Promise<boolean>} checkpoint folds the write-ahead log back into the database file
 * @property {() => Promise<void>} requireCurrentSchema refuses, with the `nightqueue update` message, a database older than this build; it never migrates
 */

/**
 * Every method of the contract, per domain, so an implementation can be checked against it
 * mechanically instead of by reading. Top-level methods live under the `""` key.
 */
export const STORE_CONTRACT = Object.freeze({
  jobs: [
    "addJob",
    "claimNextJob",
    "claimJobById",
    "releaseJob",
    "gatePreflightJob",
    "parkJob",
    "renewLease",
    "countAttempt",
    "sweepOrphans",
    "persistRunFacts",
    "bindRunSlug",
    "linkPipelineRun",
    "finishJob",
    "fillFinishGaps",
    "fillSessionFacts",
    "cancelJob",
    "cancelRunningJob",
    "listCloseCandidates",
    "jobsWithPrNumber",
    "retryJob",
    "getJob",
    "jobSpawnRefs",
    "listJobs",
    "countsByStatus",
    "countBlockedGates",
    "countActiveJobs",
    "countActiveJobsByProject",
    "firstActiveJobId",
    "isJobActive",
    "repairJobFromWitness",
    "reclassifyJob",
    "existingJobIds",
    "recoverJob",
    "correctJobPrAttribution",
    "hasClaimablePending",
    "peekNextJob",
    "listWithSlug",
    "listOpenJobs",
    "recentHostCommandCounts",
    "recentOrchestratorCounts",
    "tierBaseline",
    "status",
    "acquireClose",
    "adoptClose",
    "recordCloseStep",
    "failClose",
    "settleClose",
    "cancelOnClosedPr",
    "noteCloseWorktree",
    "acquirePostClose",
    "recordPostCloseStep",
    "releasePostClose",
    "listCloses",
  ],
  runs: ["logPipelineRun", "logPipelineRunOnce", "updateRunTelemetry", "latestRunOutcome"],
  lessons: [
    "saveLesson",
    "getLesson",
    "bumpAttempts",
    "bumpViolation",
    "markInjected",
    "setLessonEmbedding",
    "lessonsMissingEmbedding",
    "findByNormalizedTitle",
    "memoryStats",
    "recallLessons",
    "saveLessonDeduped",
    "persistLessons",
  ],
  memory: ["saveMemory", "recentMemories", "searchMemories", "memoryByKey", "recallMemories"],
  index: ["saveProjectIndex", "fillProjectIndex", "recallProjectIndex"],
  decisions: [
    "getDecision",
    "getDecisionByNumber",
    "decisionOfRef",
    "decisionIdOfRef",
    "ownDecisionNumbers",
    "saveDecision",
    "saveReviewedDecision",
    "updateDecision",
    "listDecisions",
    "decisionTitles",
    "proposalsOfJob",
    "staleProposals",
    "setDecisionEmbedding",
    "decisionsMissingEmbedding",
    "recentDecisions",
    "searchDecisionsLexical",
    "searchDecisionsSemantic",
    "recallDecisions",
  ],
  issues: [
    "getIssue",
    "getIssueDetail",
    "saveIssue",
    "updateIssue",
    "addIssueComment",
    "issueRefOfJob",
    "itemIdOfRef",
    "backfillIssues",
    "listIssues",
    "searchIssues",
    "queueableIssue",
    "linkIssueJob",
    "followJob",
    "followDriftedJobs",
    "issueDrift",
    "buildIssuePrompt",
    "queueIssue",
  ],
  orgs: ["list", "byName", "byId", "add", "rename", "setKey", "suggestKey", "keyAliases", "remove"],
  projects: ["list", "byName", "byId", "integrations", "setIntegrations", "at", "ofOrg", "add", "rename", "setKey", "suggestKey", "keyAliases", "move", "remove", "footprint", "purge"],
  db: ["files", "quickCheck", "quickCheckMainAlone", "integrityCheck", "checkpointTruncate"],
  "": ["health", "connect", "close", "checkpoint", "requireCurrentSchema"],
});

/**
 * The methods a store opened read-only answers. Everything else refuses by name instead of
 * falling back to a writable connection, which would create and migrate the database a read-only
 * caller promised never to write.
 */
export const READ_ONLY_METHODS = Object.freeze([
  "jobs.status",
  "jobs.getJob",
  "jobs.jobSpawnRefs",
  "jobs.listJobs",
  "jobs.listWithSlug",
  "jobs.listOpenJobs",
  "jobs.isJobActive",
  "jobs.existingJobIds",
  "jobs.countsByStatus",
  "jobs.countBlockedGates",
  "jobs.countActiveJobs",
  "jobs.countActiveJobsByProject",
  "jobs.recentHostCommandCounts",
  "jobs.recentOrchestratorCounts",
  "jobs.tierBaseline",
  "jobs.listCloses",
  "jobs.jobsWithPrNumber",
  "decisions.listDecisions",
  "decisions.decisionTitles",
  "decisions.proposalsOfJob",
  "decisions.staleProposals",
  "decisions.getDecisionByNumber",
  "decisions.decisionOfRef",
  "decisions.decisionIdOfRef",
  "issues.listIssues",
  "issues.getIssueDetail",
  "issues.issueRefOfJob",
  "issues.itemIdOfRef",
  "issues.issueDrift",
  "issues.searchIssues",
  "orgs.list",
  "orgs.byName",
  "orgs.byId",
  "orgs.keyAliases",
  "projects.list",
  "projects.byName",
  "projects.byId",
  "projects.integrations",
  "projects.at",
  "projects.ofOrg",
  "projects.keyAliases",
  "db.files",
  "db.quickCheck",
  "db.quickCheckMainAlone",
  "db.integrityCheck",
  "health",
  "close",
  "requireCurrentSchema",
]);
