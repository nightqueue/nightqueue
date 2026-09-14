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
 * The only exceptions are the names the contract fixes: `jobs.listWithSlug`, `jobs.status`,
 * `orgs.rename`, `orgs.usage`, `health` and `close`.
 */

/**
 * @typedef {object} JobsDomain
 * @property {(spec: object) => Promise<object>} addJob
 * @property {(spec: object) => Promise<object|null>} claimNextJob
 * @property {(id: number, spec: object) => Promise<object|null>} claimJobById
 * @property {(id: number, spec: object) => Promise<boolean>} releaseJob
 * @property {(id: number, spec: object) => Promise<boolean>} renewLease
 * @property {(id: number, spec: object) => Promise<boolean>} countAttempt
 * @property {(options?: object) => Promise<{failed: number, requeued: number}>} sweepOrphans
 * @property {(id: number, facts: object) => Promise<boolean>} persistRunFacts
 * @property {(jobId: number, ref: object) => Promise<number>} linkPipelineRun
 * @property {(id: number, outcome: object) => Promise<boolean>} finishJob
 * @property {(id: number, options?: object) => Promise<object>} cancelJob
 * @property {(id: number, options?: object) => Promise<object>} retryJob
 * @property {(id: number) => Promise<object|null>} getJob
 * @property {(options?: object) => Promise<object[]>} listJobs
 * @property {(options: object) => Promise<object[]>} listMergeCandidates
 * @property {(id: number, merge: object) => Promise<boolean>} markJobMerged
 * @property {(id: number, options: object) => Promise<boolean>} stampPrChecked
 * @property {() => Promise<Record<string, number>>} countsByStatus
 * @property {() => Promise<number>} countActiveJobs
 * @property {() => Promise<number|null>} firstActiveJobId
 * @property {(id: number) => Promise<boolean>} isJobActive
 * @property {(id: number, terminal: object) => Promise<boolean>} repairJobFromWitness
 * @property {() => Promise<boolean>} hasClaimablePending
 * @property {() => Promise<object|null>} peekNextJob
 * @property {() => Promise<object[]>} listWithSlug unfinished jobs that already have a run directory
 * @property {(id: number) => Promise<string|null>} status the status column of one job, or null when the row is gone
 */

/**
 * @typedef {object} RunsDomain
 * @property {(run: object) => Promise<object>} logPipelineRun
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
 * @property {(spec?: object) => Promise<object>} recallProjectIndex
 */

/**
 * @typedef {object} DecisionsDomain
 * @property {(id: number) => Promise<object|null>} getDecision
 * @property {(spec?: object) => Promise<object|null>} getDecisionByNumber
 * @property {(decision: object) => Promise<object>} saveDecision
 * @property {(id: number, patch?: object) => Promise<object>} updateDecision
 * @property {(spec?: object) => Promise<object[]>} listDecisions
 * @property {(spec: object) => Promise<boolean>} setDecisionEmbedding
 * @property {(spec?: object) => Promise<object[]>} decisionsMissingEmbedding
 * @property {(spec?: object) => Promise<object[]>} recentDecisions
 * @property {(spec?: object) => Promise<object[]>} searchDecisionsLexical
 * @property {(spec?: object) => Promise<object[]>} searchDecisionsSemantic
 * @property {(spec?: object) => Promise<object[]>} recallDecisions
 */

/**
 * @typedef {object} RoadmapDomain
 * @property {(id: number) => Promise<object|null>} getRoadmapItem
 * @property {(item?: object) => Promise<object>} saveRoadmapItem
 * @property {(id: number, patch?: object) => Promise<object>} updateRoadmapItem
 * @property {(owner: object) => Promise<object>} listRoadmap
 * @property {(id: number) => Promise<object>} queueableRoadmapItem
 * @property {(id: number, jobId: number) => Promise<boolean>} markRoadmapItemQueued
 * @property {(jobId: number) => Promise<boolean>} markRoadmapItemDone
 * @property {(spec?: object) => Promise<string>} buildRoadmapPrompt
 * @property {(spec?: object) => Promise<object>} queueRoadmapItem
 */

/**
 * @typedef {object} OrgsDomain
 * @property {(from: string, to: string) => Promise<void>} rename both tables in one transaction
 * @property {(name: string) => Promise<{table: string, total: number}[]>} usage what the org still owns
 * @property {() => Promise<{org: string, total: number}[]>} rowCountsByOrg raw counts, no config filtering
 */

/**
 * The raw numbers `nightshift doctor` diagnoses with. It never throws: each field is resolved in its
 * own `try` and its failure is reported in `errors`, so one broken check never poisons the other.
 * @typedef {object} StoreHealth
 * @property {number|null} schemaVersion
 * @property {number|null} orphanJobs
 * @property {{schemaVersion: string|null, orphanJobs: string|null}} errors
 */

/**
 * @typedef {object} Store
 * @property {JobsDomain} jobs
 * @property {RunsDomain} runs
 * @property {LessonsDomain} lessons
 * @property {MemoryDomain} memory
 * @property {IndexDomain} index
 * @property {DecisionsDomain} decisions
 * @property {RoadmapDomain} roadmap
 * @property {OrgsDomain} orgs
 * @property {() => Promise<StoreHealth>} health
 * @property {() => Promise<void>} connect opens the connection now, for the caller that needs it to exist before it reads anything
 * @property {() => Promise<void>} close releases this instance; a read-write one never closes the shared connection
 * @property {() => Promise<boolean>} checkpoint folds the write-ahead log back into the database file
 * @property {() => Promise<void>} migrateIfOutdated brings a database written by an older build up to this schema
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
    "renewLease",
    "countAttempt",
    "sweepOrphans",
    "persistRunFacts",
    "linkPipelineRun",
    "finishJob",
    "cancelJob",
    "retryJob",
    "getJob",
    "listJobs",
    "listMergeCandidates",
    "markJobMerged",
    "stampPrChecked",
    "countsByStatus",
    "countActiveJobs",
    "firstActiveJobId",
    "isJobActive",
    "repairJobFromWitness",
    "hasClaimablePending",
    "peekNextJob",
    "listWithSlug",
    "status",
  ],
  runs: ["logPipelineRun"],
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
  index: ["saveProjectIndex", "recallProjectIndex"],
  decisions: [
    "getDecision",
    "getDecisionByNumber",
    "saveDecision",
    "updateDecision",
    "listDecisions",
    "setDecisionEmbedding",
    "decisionsMissingEmbedding",
    "recentDecisions",
    "searchDecisionsLexical",
    "searchDecisionsSemantic",
    "recallDecisions",
  ],
  roadmap: [
    "getRoadmapItem",
    "saveRoadmapItem",
    "updateRoadmapItem",
    "listRoadmap",
    "queueableRoadmapItem",
    "markRoadmapItemQueued",
    "markRoadmapItemDone",
    "buildRoadmapPrompt",
    "queueRoadmapItem",
  ],
  orgs: ["rename", "usage", "rowCountsByOrg"],
  "": ["health", "connect", "close", "checkpoint", "migrateIfOutdated"],
});

/**
 * The methods a store opened read-only answers. Everything else refuses by name instead of
 * falling back to a writable connection, which would create and migrate the database a read-only
 * caller promised never to write.
 */
export const READ_ONLY_METHODS = Object.freeze([
  "jobs.status",
  "jobs.getJob",
  "jobs.listJobs",
  "jobs.listMergeCandidates",
  "jobs.listWithSlug",
  "jobs.isJobActive",
  "jobs.countsByStatus",
  "jobs.countActiveJobs",
  "decisions.listDecisions",
  "decisions.getDecisionByNumber",
  "roadmap.listRoadmap",
  "orgs.rowCountsByOrg",
  "health",
  "close",
  "migrateIfOutdated",
]);
