export const CLOSE_PR_URL = "https://github.com/acme/api/pull/7";
export const HEAD_SHA = "1111111aaaaaaaaa";
export const PUSHED_SHA = "2222222bbbbbbbbb";
export const MERGE_SHA = "abc1234def567890";

const GIT_DEFAULTS = {
  "rev-parse --abbrev-ref HEAD": { ok: true, stdout: "main\n", stderr: "" },
  "rev-parse origin/": { ok: true, stdout: `${HEAD_SHA}\n`, stderr: "" },
  "rev-parse HEAD": { ok: true, stdout: `${PUSHED_SHA}\n`, stderr: "" },
};

// An open, mergeable pull request as the fake gh reads it, with the given fields changed.
export function openPr(changes = {}) {
  return {
    ok: true,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefName: "fix/worker",
    headRefOid: HEAD_SHA,
    baseRefName: "main",
    mergeSha: null,
    mergedAt: null,
    title: "Fix the worker",
    number: 7,
    isDraft: false,
    ...changes,
  };
}

// The same pull request merged, with its merge commit.
export function mergedPr(changes = {}) {
  return openPr({ state: "MERGED", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", mergeSha: MERGE_SHA, mergedAt: "2026-09-21T10:00:00Z", ...changes });
}

// A successful git answer with the given output.
export function gitOk(stdout = "") {
  return { ok: true, stdout, stderr: "" };
}

// A failed git answer with the given error text.
export function gitFail(stderr = "failed", stdout = "") {
  return { ok: false, stdout, stderr };
}

// The answer of the longest scripted prefix of a git call, a default one, or a plain success.
function gitAnswer(script, args) {
  const line = args.join(" ");
  const table = { ...GIT_DEFAULTS, ...script };
  const prefix = Object.keys(table).filter((key) => line.startsWith(key)).sort((a, b) => b.length - a.length)[0];
  const answer = prefix === undefined ? gitOk() : table[prefix];
  return typeof answer === "function" ? answer(args) : answer;
}

// In-process gh, git, npm and filesystem doubles for a close, scripted by a mutable world and logging every call; nothing is spawned.
export function fakeCloseDeps(changes = {}) {
  const world = {
    pr: openPr(),
    reads: [],
    checks: { ok: true, checks: [{ name: "test", bucket: "pass" }], failing: [], pending: [] },
    diffNames: { ok: true, files: ["src/a.mjs"] },
    git: {},
    merge: (current) => {
      current.pr = mergedPr();
      return { ok: true, stderr: "" };
    },
    suite: { ok: true, output: "", timedOut: false },
    testScript: "node --test",
    exists: () => true,
    ...changes,
  };
  const log = { git: [], prReads: 0, checkReads: 0, merges: [], tests: [], tempDirs: [], removedDirs: [], sleeps: [], linked: [] };
  const deps = {
    git: async (args, options = {}) => {
      log.git.push({ args, cwd: options.cwd });
      return gitAnswer(world.git, args);
    },
    gh: {
      prDetail: async () => {
        log.prReads += 1;
        return world.reads.length ? world.reads.shift() : world.pr;
      },
      prChecks: async () => {
        log.checkReads += 1;
        return world.checks;
      },
      prMerge: async (url, options = {}) => {
        log.merges.push({ url, matchHeadCommit: options.matchHeadCommit ?? null });
        return world.merge(world);
      },
      prDiffNames: async () => world.diffNames,
    },
    fs: {
      exists: (path) => world.exists(path),
      makeTempDir: (prefix) => {
        const dir = `/tmp/fake-${prefix}0`;
        log.tempDirs.push(dir);
        return dir;
      },
      removeDir: (dir) => log.removedDirs.push(dir),
      linkNodeModules: (checkout, dir) => log.linked.push({ checkout, dir }),
      readTestScript: () => world.testScript,
    },
    runTest: async (options) => {
      log.tests.push(options);
      return world.suite;
    },
    sleep: async (ms) => {
      log.sleeps.push(ms);
    },
  };
  return { deps, world, log };
}

// The git command lines a fake close ran, optionally only those run in one directory.
export function gitLines(log, cwd) {
  return log.git.filter((call) => cwd === undefined || call.cwd === cwd).map((call) => call.args.join(" "));
}
