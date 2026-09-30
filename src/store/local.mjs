import { UserError } from "../config/errors.mjs";
import { dbPath, homeDir } from "../config/paths.mjs";
import { checkpointWal, migrateIfOutdated, openDb, openDbReadOnly, retireConnection, schemaVersionOn } from "../memory/db.mjs";
import * as dbHealth from "../memory/db-health.mjs";
import * as decisions from "../memory/decisions.mjs";
import * as dedup from "../memory/dedup.mjs";
import * as index from "../memory/index.mjs";
import * as jobs from "../memory/jobs.mjs";
import * as lessons from "../memory/lessons.mjs";
import * as memory from "../memory/memory.mjs";
import { orphansOf } from "../memory/migration/v20.mjs";
import * as purge from "../memory/project-purge.mjs";
import * as registry from "../memory/registry.mjs";
import * as roadmap from "../memory/roadmap.mjs";
import * as roadmapBackfill from "../memory/roadmap-backfill.mjs";
import * as roadmapSearch from "../memory/roadmap-search.mjs";
import * as runs from "../memory/runs.mjs";
import * as search from "../memory/search.mjs";
import { classifyStoreError } from "../memory/store-error.mjs";
import { READ_ONLY_METHODS } from "./store.mjs";

const READ_ONLY_ALLOWED = new Set(READ_ONLY_METHODS);

// Every job method whose write can move a job's status; the roadmap follows each of them after the write succeeds.
export const JOB_STATUS_WRITERS = Object.freeze([
  "claimNextJob",
  "claimJobById",
  "releaseJob",
  "gatePreflightJob",
  "parkJob",
  "finishJob",
  "cancelJob",
  "cancelRunningJob",
  "retryJob",
  "repairJobFromWitness",
  "reclassifyJob",
  "settleClose",
  "cancelOnClosedPr",
]);

// Runs a write that moves a job out of a status the roadmap comments on in one transaction with the follow of the status it
// left, so a writer racing the one that set it never skips its event; an id the write refuses anyway goes to the write alone.
function followingPassedStatus({ jobId, write, fromKey }, env) {
  if (!Number.isInteger(jobId) || jobId < 1) return write();
  return roadmap.followJobWrite({ jobId, write, fromKey }, env);
}

// Brings the roadmap items of a job in line with its row; the bookkeeping never costs the job write it follows.
function followJobQuietly(jobId, env) {
  try {
    roadmap.followJob(jobId, env);
  } catch {
    return;
  }
}

// Re-syncs every roadmap item whose job moved without it; the bookkeeping never costs the sweep it follows.
function followDriftedQuietly(env) {
  try {
    roadmap.followDriftedJobs(env);
  } catch {
    return;
  }
}

// The job a successful write moved: the row it returned, or the id it was called with; null when the write refused.
function writtenJobId(written, firstArg) {
  if (!written) return null;
  if (typeof written === "object" && Number.isInteger(written.id)) return written.id;
  return Number.isInteger(firstArg) ? firstArg : null;
}

// Wraps every job-status writer so the roadmap follows the row the writer just committed.
function followingJobWrites(domain, env) {
  for (const name of JOB_STATUS_WRITERS) {
    const write = domain[name];
    domain[name] = async (...args) => {
      const written = await write(...args);
      const jobId = writtenJobId(written, args[0]);
      if (jobId !== null) followJobQuietly(jobId, env);
      return written;
    };
  }
  return domain;
}

// Sweeps the orphaned jobs and then re-syncs the roadmap items any missed event left behind.
function sweepAndFollow(env, options) {
  const swept = jobs.sweepOrphans(env, options);
  followDriftedQuietly(env);
  return swept;
}

// Every job method; the reads take the store's own connection, which is what lets a follow poll through `withReadOnlyStore` and never answer from a stale WAL snapshot.
function jobsDomain(env, db) {
  return followingJobWrites(jobsMethods(env, db), env);
}

// The job methods as `src/memory/jobs.mjs` answers them, before the roadmap follow is wrapped around the writers.
function jobsMethods(env, db) {
  return {
    addJob: async (spec) => jobs.addJob(spec, env),
    claimNextJob: async (spec) => jobs.claimNextJob(spec, env),
    claimJobById: async (id, spec) => jobs.claimJobById(id, spec, env),
    releaseJob: async (id, spec) => jobs.releaseJob(id, spec, env),
    gatePreflightJob: async (id, spec) => jobs.gatePreflightJob(id, spec, env),
    parkJob: async (id, spec) => jobs.parkJob(id, spec, env),
    renewLease: async (id, spec) => jobs.renewLease(id, spec, env),
    countAttempt: async (id, spec) => jobs.countAttempt(id, spec, env),
    sweepOrphans: async (options) => sweepAndFollow(env, options),
    persistRunFacts: async (id, facts) => jobs.persistRunFacts(id, facts, env),
    bindRunSlug: async (id, spec) => jobs.bindRunSlug(id, spec, env),
    linkPipelineRun: async (jobId, ref) => jobs.linkPipelineRun(jobId, ref, env),
    finishJob: async (id, outcome) => jobs.finishJob(id, outcome, env),
    fillFinishGaps: async (id, spec) => jobs.fillFinishGaps(id, spec, env),
    fillSessionFacts: async (id, spec) => jobs.fillSessionFacts(id, spec, env),
    cancelJob: async (id, options) => jobs.cancelJob(id, options, env),
    cancelRunningJob: async (id, spec) => jobs.cancelRunningJob(id, spec, env),
    listCloseCandidates: async () => jobs.listCloseCandidates(env, db()),
    jobsWithPrNumber: async (number) => jobs.jobsWithPrNumber(number, env, db()),
    retryJob: async (id, options) =>
      followingPassedStatus({ jobId: id, write: () => jobs.retryJob(id, options, env), fromKey: "retriedFrom" }, env),
    getJob: async (id) => jobs.getJob(id, env, db()),
    jobSpawnRefs: async (id) => roadmap.jobSpawnRefs(id, env, db()),
    listJobs: async (options) => jobs.listJobs(options, env, db()),
    countsByStatus: async () => jobs.countsByStatus(env, db()),
    countBlockedGates: async () => jobs.countBlockedGates(env, db()),
    countActiveJobs: async () => jobs.countActiveJobs(env, db()),
    countActiveJobsByProject: async () => jobs.countActiveJobsByProject(env, db()),
    firstActiveJobId: async () => jobs.firstActiveJobId(env),
    isJobActive: async (id) => jobs.isJobActive(id, env, db()),
    repairJobFromWitness: async (id, terminal) => jobs.repairJobFromWitness(id, terminal, env),
    reclassifyJob: async (id, outcome) => jobs.reclassifyJob(id, outcome, env),
    existingJobIds: async (ids) => jobs.existingJobIds(ids, env, db()),
    recoverJob: async (spec) => jobs.recoverJob(spec, env),
    correctJobPrAttribution: async (id, spec) => jobs.correctJobPrAttribution(id, spec, env),
    hasClaimablePending: async () => jobs.hasClaimablePending(env),
    peekNextJob: async () => jobs.peekNextJob(env),
    listWithSlug: async () => jobs.listJobsWithSlug(env, db()),
    listOpenJobs: async () => jobs.listOpenJobs(env, db()),
    recentHostCommandCounts: async () => jobs.recentHostCommandCounts(env, db()),
    recentOrchestratorCounts: async () => jobs.recentOrchestratorCounts(env, db()),
    status: async (id) => jobs.jobStatus(id, env, db()),
    acquireClose: async (id, spec) => jobs.acquireClose(id, spec, env),
    adoptClose: async (id, spec) => jobs.adoptClose(id, spec, env),
    recordCloseStep: async (id, spec) => jobs.recordCloseStep(id, spec, env),
    failClose: async (id, spec) => jobs.failClose(id, spec, env),
    settleClose: async (id, spec) => jobs.settleClose(id, spec, env),
    cancelOnClosedPr: async (id, spec) => jobs.cancelOnClosedPr(id, spec, env),
    noteCloseWorktree: async (id, spec) => jobs.noteCloseWorktree(id, spec, env),
    listCloses: async () => jobs.listCloses(env, db()),
  };
}

// The pipeline run of a finished job.
function runsDomain(env) {
  return {
    logPipelineRun: async (run) => runs.logPipelineRun(run, env),
    logPipelineRunOnce: async (run, options) => runs.logPipelineRunOnce(run, options, env),
    updateRunTelemetry: async (telemetry) => runs.updateRunTelemetry(telemetry, env),
    latestRunOutcome: async (spec) => runs.latestRunOutcome(spec, env),
  };
}

// The lessons, including the recall of `search.mjs` and the deduplicated writes of `dedup.mjs`, both of which read on the store's own connection.
function lessonsDomain(env, db) {
  return {
    saveLesson: async (lesson) => lessons.saveLesson(lesson, env),
    getLesson: async (id) => lessons.getLesson(id, env),
    bumpAttempts: async (id) => lessons.bumpAttempts(id, env),
    bumpViolation: async (id) => lessons.bumpViolation(id, env),
    markInjected: async (ids) => lessons.markInjected(ids, env),
    setLessonEmbedding: async (spec) => lessons.setLessonEmbedding(spec, env),
    lessonsMissingEmbedding: async (spec) => lessons.lessonsMissingEmbedding(spec, env),
    findByNormalizedTitle: async (spec) => lessons.findByNormalizedTitle(spec, env),
    memoryStats: async () => lessons.memoryStats(env),
    recallLessons: async (spec) => search.recallLessons(spec, env, db()),
    saveLessonDeduped: async (lesson) => dedup.saveLessonDeduped(lesson, env),
    persistLessons: async (items, options) => dedup.persistLessons(items, options, env, db()),
  };
}

// The key/value memories of a project.
function memoryDomain(env) {
  return {
    saveMemory: async (entry) => memory.saveMemory(entry, env),
    recentMemories: async (spec) => memory.recentMemories(spec, env),
    searchMemories: async (spec) => memory.searchMemories(spec, env),
    memoryByKey: async (spec) => memory.memoryByKey(spec, env),
    recallMemories: async (spec) => search.recallMemories(spec, env),
  };
}

// The index of a project's files and libraries.
function indexDomain(env) {
  return {
    saveProjectIndex: async (spec) => index.saveProjectIndex(spec, env),
    fillProjectIndex: async (spec) => index.fillProjectIndex(spec, env),
    recallProjectIndex: async (spec) => index.recallProjectIndex(spec, env),
  };
}

// The decisions; the two read paths take the store's own connection, which is what makes them work read-only.
function decisionsDomain(env, db) {
  return {
    getDecision: async (id) => decisions.getDecision(id, env),
    getDecisionByNumber: async (spec) => decisions.getDecisionByNumber(spec, env, db()),
    decisionOfRef: async (ref, context) => decisions.decisionOfRef(ref, context, env, db()),
    decisionIdOfRef: async (ref, context) => decisions.decisionIdOfRef(ref, context, env, db()),
    ownDecisionNumbers: async (entries, owner) => decisions.ownDecisionNumbers(entries, owner, env, db()),
    saveDecision: async (decision) => decisions.saveDecision(decision, env),
    saveReviewedDecision: async (spec) => decisions.saveReviewedDecision(spec, env),
    updateDecision: async (id, patch) => decisions.updateDecision(id, patch, env),
    listDecisions: async (spec) => decisions.listDecisions(spec, env, db()),
    decisionTitles: async (spec) => decisions.decisionTitles(spec, env, db()),
    proposalsOfJob: async (jobId) => decisions.proposalsOfJob(jobId, env, db()),
    staleProposals: async () => decisions.staleProposals(env, db()),
    setDecisionEmbedding: async (spec) => decisions.setDecisionEmbedding(spec, env),
    decisionsMissingEmbedding: async (spec) => decisions.decisionsMissingEmbedding(spec, env),
    recentDecisions: async (spec) => decisions.recentDecisions(spec, env),
    searchDecisionsLexical: async (spec) => decisions.searchDecisionsLexical(spec, env),
    searchDecisionsSemantic: async (spec) => decisions.searchDecisionsSemantic(spec, env),
    recallDecisions: async (spec) => decisions.recallDecisions(spec, env),
  };
}

// The roadmap; `listRoadmap`, `searchRoadmap`, `getRoadmapItemDetail`, `roadmapRefOfJob` and `roadmapDrift` take the store's own connection, which is what makes them work read-only.
function roadmapDomain(env, db) {
  return {
    getRoadmapItem: async (id) => roadmap.getRoadmapItem(id, env),
    getRoadmapItemDetail: async (id, options) => roadmap.getRoadmapItemDetail(id, options, env, db()),
    saveRoadmapItem: async (item) => roadmap.saveRoadmapItem(item, env),
    updateRoadmapItem: async (id, patch) => roadmap.updateRoadmapItem(id, patch, env),
    addRoadmapComment: async (spec) => roadmap.addRoadmapComment(spec, env),
    roadmapRefOfJob: async (jobId) => roadmap.roadmapRefOfJob(jobId, env, db()),
    itemIdOfRef: async (ref) => roadmap.itemIdOfRef(ref, env, db()),
    backfillRoadmap: async (options) => roadmapBackfill.backfillRoadmap(options, env),
    listRoadmap: async (owner, filters) => roadmap.listRoadmap(owner, filters, env, db()),
    searchRoadmap: async (spec) => roadmapSearch.searchRoadmap(spec, env, db()),
    queueableRoadmapItem: async (id) => roadmap.queueableRoadmapItem(id, env),
    linkRoadmapItemJob: async (id, jobId) => roadmap.linkRoadmapItemJob(id, jobId, env),
    followJob: async (jobId) => roadmap.followJob(jobId, env),
    followDriftedJobs: async () => roadmap.followDriftedJobs(env),
    roadmapDrift: async () => roadmap.roadmapDrift(env, db()),
    buildRoadmapPrompt: async (spec) => roadmap.buildRoadmapPrompt(spec, env),
    queueRoadmapItem: async (spec) => roadmap.queueRoadmapItem(spec, env),
  };
}

// The registry of orgs; a rename is one row.
function orgsDomain(db) {
  return {
    list: async () => registry.listOrgs(db()),
    byName: async (name) => registry.orgByName(db(), name),
    byId: async (id) => registry.orgById(db(), id),
    add: async (name, key) => registry.insertOrg(db(), name, key),
    rename: async (id, name) => registry.renameOrg(db(), { id, name }),
    setKey: async (id, key) => registry.setOrgKey(db(), { id, key }),
    suggestKey: async (name) => registry.suggestFreeKey(db(), name, "org"),
    keyAliases: async () => registry.keyAliases(db(), "org"),
    remove: async (id) => registry.removeOrg(db(), id),
  };
}

// The registry of projects.
function projectsDomain(db) {
  return {
    list: async () => registry.listProjects(db()),
    byName: async (name) => registry.projectByName(db(), name),
    byId: async (id) => registry.projectById(db(), id),
    at: async (cwd) => registry.projectAt(db(), cwd),
    ofOrg: async (orgId) => registry.projectsOfOrg(db(), orgId),
    add: async (spec) => registry.insertProject(db(), spec),
    rename: async (id, name) => registry.renameProject(db(), { id, name }),
    setKey: async (id, key) => registry.setProjectKey(db(), { id, key }),
    suggestKey: async (name) => registry.suggestFreeKey(db(), name, "project"),
    keyAliases: async () => registry.keyAliases(db(), "project"),
    move: async (id, spec) => registry.moveProject(db(), { ...spec, id }),
    remove: async (id) => registry.removeProject(db(), id),
    footprint: async (id) => purge.projectFootprint(db(), id),
    purge: async (id) => purge.purgeProject(db(), id),
  };
}

// The health of the database file itself, for `nightqueue doctor --db` and `--fix`; each call opens and closes its own connection.
function dbDomain(env) {
  return {
    files: async () => dbHealth.dbFiles(env),
    quickCheck: async () => dbHealth.quickCheck(env),
    quickCheckMainAlone: async () => dbHealth.quickCheckMainAlone(env),
    integrityCheck: async () => dbHealth.integrityCheck(env),
    checkpointTruncate: async () => dbHealth.checkpointTruncate(env),
  };
}

// The message of a failure, as the caller would print it.
function errorMessage(err) {
  return err?.message ?? String(err);
}

// The StoreUnavailableError a failure means for this home, or null when the database itself is not the problem.
function unavailableOf(err, env) {
  return classifyStoreError(err, { home: homeDir(env), path: dbPath(env) });
}

// The `unavailable` block of a diagnosis: what doctor needs to name the failure and its fix.
function unavailableBlock({ code, errcode, detail, home, path, hint }) {
  return { code, errcode, detail, home, path, hint };
}

// The raw numbers of a diagnosis, each field resolved on its own so one broken read never poisons the other and nothing ever throws.
function readHealth({ db, env, connection }) {
  const errors = { schemaVersion: null, orphanJobs: null, danglingReferences: null };
  const health = { schemaVersion: null, orphanJobs: null, danglingReferences: null, errors, unavailable: null };
  const readers = {
    schemaVersion: () => schemaVersionOn(db()),
    orphanJobs: () => jobs.countOrphanJobs(db()),
    danglingReferences: () => orphansOf(db()).length,
  };
  for (const [field, read] of Object.entries(readers)) {
    try {
      health[field] = read();
    } catch (err) {
      const unavailable = unavailableOf(err, env);
      errors[field] = errorMessage(err);
      if (unavailable) health.unavailable ??= unavailableBlock(unavailable);
    }
  }
  if (health.unavailable) connection.drop();
  return health;
}

// The shared read-write connection of the home, opened only when a method needs it - building a store creates no database - and re-resolved on every call so the store can never hold a handle a test closed.
function readWriteConnection(env) {
  return { get: () => openDb(env), release: () => {}, drop: () => retireConnection(env) };
}

// Closes a read-only connection without letting the close throw; closing a read-only one never removes `-shm`.
function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    return;
  }
}

// The read-only connection of the store, opened only when a method needs it: `openDbReadOnly` throws on a home with no database, and every read-only caller guards around its own open.
function readOnlyConnection(env) {
  let db = null;
  return {
    get: () => (db ??= openDbReadOnly(env)),
    release: () => {
      const open = db;
      db = null;
      open?.close();
    },
    drop: () => {
      const open = db;
      db = null;
      closeQuietly(open);
    },
  };
}

// Wraps a store method so a failure of the database itself leaves as a StoreUnavailableError and the broken handle is never reused.
function classifying(fn, { env, connection }) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      const unavailable = unavailableOf(err, env);
      if (!unavailable) throw err;
      connection.drop();
      throw unavailable;
    }
  };
}

// Wraps every domain method and every top-level method but `close` in `classifying`.
function classifyAll(store, context) {
  for (const [key, value] of Object.entries(store)) {
    if (typeof value === "function") {
      if (key !== "close") store[key] = classifying(value, context);
      continue;
    }
    for (const [method, fn] of Object.entries(value)) value[method] = classifying(fn, context);
  }
  return store;
}

// Refuses a method a read-only connection must never run, naming it; never a silent fallback to a writable connection.
function refuse(name) {
  return async () => {
    throw new UserError(`\`${name}\` needs a writable store and this one was opened read-only`);
  };
}

// Replaces every method outside the read-only allow-list with a refusal, so a read-only store can never create nor migrate the database it reads.
function fenceReadOnly(store) {
  for (const [key, value] of Object.entries(store)) {
    if (typeof value === "function") {
      if (!READ_ONLY_ALLOWED.has(key)) store[key] = refuse(key);
      continue;
    }
    for (const method of Object.keys(value)) {
      if (READ_ONLY_ALLOWED.has(`${key}.${method}`)) continue;
      value[method] = refuse(`${key}.${method}`);
    }
  }
  return store;
}

// The store backed by this host's SQLite: every method is async and every body is a single delegation to the synchronous `src/memory/`, so no transaction can span an `await`.
export function createLocalStore(env = process.env, { readOnly = false, onClose = () => {} } = {}) {
  const connection = readOnly ? readOnlyConnection(env) : readWriteConnection(env);
  const db = () => connection.get();
  const store = classifyAll({
    jobs: jobsDomain(env, db),
    runs: runsDomain(env),
    lessons: lessonsDomain(env, db),
    memory: memoryDomain(env),
    index: indexDomain(env),
    decisions: decisionsDomain(env, db),
    roadmap: roadmapDomain(env, db),
    orgs: orgsDomain(db),
    projects: projectsDomain(db),
    db: dbDomain(env),
    health: async () => readHealth({ db, env, connection }),
    connect: async () => {
      db();
    },
    close: async () => {
      connection.release();
      onClose();
    },
    checkpoint: async () => checkpointWal(env),
    migrateIfOutdated: async () => migrateIfOutdated(env),
  }, { env, connection });
  return readOnly ? fenceReadOnly(store) : store;
}
