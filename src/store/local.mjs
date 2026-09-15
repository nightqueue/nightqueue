import { UserError } from "../config/errors.mjs";
import { checkpointWal, migrateIfOutdated, openDb, openDbReadOnly, schemaVersionOn } from "../memory/db.mjs";
import * as decisions from "../memory/decisions.mjs";
import * as dedup from "../memory/dedup.mjs";
import * as index from "../memory/index.mjs";
import * as jobs from "../memory/jobs.mjs";
import * as lessons from "../memory/lessons.mjs";
import * as memory from "../memory/memory.mjs";
import * as orgs from "../memory/orgs.mjs";
import * as roadmap from "../memory/roadmap.mjs";
import * as runs from "../memory/runs.mjs";
import * as search from "../memory/search.mjs";
import { READ_ONLY_METHODS } from "./store.mjs";

const READ_ONLY_ALLOWED = new Set(READ_ONLY_METHODS);

// Every job method; the reads take the store's own connection, which is what lets a follow poll through `withReadOnlyStore` and never answer from a stale WAL snapshot.
function jobsDomain(env, db) {
  return {
    addJob: async (spec) => jobs.addJob(spec, env),
    claimNextJob: async (spec) => jobs.claimNextJob(spec, env),
    claimJobById: async (id, spec) => jobs.claimJobById(id, spec, env),
    releaseJob: async (id, spec) => jobs.releaseJob(id, spec, env),
    parkJob: async (id, spec) => jobs.parkJob(id, spec, env),
    renewLease: async (id, spec) => jobs.renewLease(id, spec, env),
    countAttempt: async (id, spec) => jobs.countAttempt(id, spec, env),
    sweepOrphans: async (options) => jobs.sweepOrphans(env, options),
    persistRunFacts: async (id, facts) => jobs.persistRunFacts(id, facts, env),
    linkPipelineRun: async (jobId, ref) => jobs.linkPipelineRun(jobId, ref, env),
    finishJob: async (id, outcome) => jobs.finishJob(id, outcome, env),
    cancelJob: async (id, options) => jobs.cancelJob(id, options, env),
    retryJob: async (id, options) => jobs.retryJob(id, options, env),
    getJob: async (id) => jobs.getJob(id, env, db()),
    listJobs: async (options) => jobs.listJobs(options, env, db()),
    listMergeCandidates: async (options) => jobs.listMergeCandidates(options, env, db()),
    markJobMerged: async (id, merge) => jobs.markJobMerged(id, merge, env),
    stampPrChecked: async (id, options) => jobs.stampPrChecked(id, options, env),
    countsByStatus: async () => jobs.countsByStatus(env, db()),
    countActiveJobs: async () => jobs.countActiveJobs(env, db()),
    firstActiveJobId: async () => jobs.firstActiveJobId(env),
    isJobActive: async (id) => jobs.isJobActive(id, env, db()),
    repairJobFromWitness: async (id, terminal) => jobs.repairJobFromWitness(id, terminal, env),
    reclassifyJob: async (id, outcome) => jobs.reclassifyJob(id, outcome, env),
    hasClaimablePending: async () => jobs.hasClaimablePending(env),
    peekNextJob: async () => jobs.peekNextJob(env),
    listWithSlug: async () => jobs.listJobsWithSlug(env, db()),
    status: async (id) => jobs.jobStatus(id, env, db()),
  };
}

// The pipeline run of a finished job.
function runsDomain(env) {
  return {
    logPipelineRun: async (run) => runs.logPipelineRun(run, env),
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
    recallProjectIndex: async (spec) => index.recallProjectIndex(spec, env),
  };
}

// The decisions; the two read paths take the store's own connection, which is what makes them work read-only.
function decisionsDomain(env, db) {
  return {
    getDecision: async (id) => decisions.getDecision(id, env),
    getDecisionByNumber: async (spec) => decisions.getDecisionByNumber(spec, env, db()),
    saveDecision: async (decision) => decisions.saveDecision(decision, env),
    updateDecision: async (id, patch) => decisions.updateDecision(id, patch, env),
    listDecisions: async (spec) => decisions.listDecisions(spec, env, db()),
    setDecisionEmbedding: async (spec) => decisions.setDecisionEmbedding(spec, env),
    decisionsMissingEmbedding: async (spec) => decisions.decisionsMissingEmbedding(spec, env),
    recentDecisions: async (spec) => decisions.recentDecisions(spec, env),
    searchDecisionsLexical: async (spec) => decisions.searchDecisionsLexical(spec, env),
    searchDecisionsSemantic: async (spec) => decisions.searchDecisionsSemantic(spec, env),
    recallDecisions: async (spec) => decisions.recallDecisions(spec, env),
  };
}

// The roadmap; `listRoadmap` takes the store's own connection, which is what makes it work read-only.
function roadmapDomain(env, db) {
  return {
    getRoadmapItem: async (id) => roadmap.getRoadmapItem(id, env),
    saveRoadmapItem: async (item) => roadmap.saveRoadmapItem(item, env),
    updateRoadmapItem: async (id, patch) => roadmap.updateRoadmapItem(id, patch, env),
    listRoadmap: async (owner) => roadmap.listRoadmap(owner, env, db()),
    queueableRoadmapItem: async (id) => roadmap.queueableRoadmapItem(id, env),
    markRoadmapItemQueued: async (id, jobId) => roadmap.markRoadmapItemQueued(id, jobId, env),
    markRoadmapItemDone: async (jobId) => roadmap.markRoadmapItemDone(jobId, env),
    buildRoadmapPrompt: async (spec) => roadmap.buildRoadmapPrompt(spec, env),
    queueRoadmapItem: async (spec) => roadmap.queueRoadmapItem(spec, env),
  };
}

// The rows the orgs own; the rename is one transaction and this method inserts no `await` inside it.
function orgsDomain(env, db) {
  return {
    rename: async (from, to) => orgs.renameOrgRows(env, from, to),
    usage: async (name) => orgs.orgRowCounts(env, name),
    rowCountsByOrg: async () => orgs.orgRowCountsByOrg(db()),
  };
}

// The message of a failure, as the caller would print it.
function errorMessage(err) {
  return err?.message ?? String(err);
}

// The raw numbers of a diagnosis, each field resolved on its own so one broken read never poisons the other and nothing ever throws.
function readHealth(db) {
  const errors = { schemaVersion: null, orphanJobs: null };
  const health = { schemaVersion: null, orphanJobs: null, errors };
  try {
    health.schemaVersion = schemaVersionOn(db());
  } catch (err) {
    errors.schemaVersion = errorMessage(err);
  }
  try {
    health.orphanJobs = jobs.countOrphanJobs(db());
  } catch (err) {
    errors.orphanJobs = errorMessage(err);
  }
  return health;
}

// The shared read-write connection of the home, opened only when a method needs it - building a store creates no database - and re-resolved on every call so the store can never hold a handle a test closed.
function readWriteConnection(env) {
  return { get: () => openDb(env), release: () => {} };
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
  };
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
  const store = {
    jobs: jobsDomain(env, db),
    runs: runsDomain(env),
    lessons: lessonsDomain(env, db),
    memory: memoryDomain(env),
    index: indexDomain(env),
    decisions: decisionsDomain(env, db),
    roadmap: roadmapDomain(env, db),
    orgs: orgsDomain(env, db),
    health: async () => readHealth(db),
    connect: async () => {
      db();
    },
    close: async () => {
      connection.release();
      onClose();
    },
    checkpoint: async () => checkpointWal(env),
    migrateIfOutdated: async () => migrateIfOutdated(env),
  };
  return readOnly ? fenceReadOnly(store) : store;
}
