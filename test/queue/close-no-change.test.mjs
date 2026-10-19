import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { withProviders } from "../../src/integrations/registry.mjs";
import { acquireClose, getJob, jobView } from "../../src/memory/jobs.mjs";
import { NO_CHANGE_NEXT_STEP_LINE, STRAY_PR_PREFIX } from "../../src/queue/classify.mjs";
import { runClosePipeline } from "../../src/queue/close.mjs";
import { runPostCloseSteps, validateCloseTarget } from "../../src/queue/close-start.mjs";
import { closeChecklistLines } from "../../src/queue/close-view.mjs";
import { stoppedReason } from "../../src/queue/last-cell.mjs";
import { KEPT_PREFIX } from "../../src/queue/worktree.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject, projectIdOf, seedDoneJob } from "../../test-support/memory.mjs";
import { bindTrackerConnection, setIntegrations, trackerProvider, TRACKER_URL } from "../../test-support/origin-provider.mjs";

const WORKER = "close:test:1:nochange";
const CONCLUSION = "✅ Resolved — no code change needed\n\nThe loop comes from the CDN cache rule, not from this repository. Confirm it is still a single event before closing.";
const ORIGIN_CONCLUSION = "The loop comes from the CDN cache rule, not from this repository.";
const NOTICE = `${CONCLUSION}\n\n${KEPT_PREFIX}/tmp/wt-9 - it has uncommitted changes.`;
const NO_PR_NOTE = "no pull request: resolved without a code change";
const LOGGING = { tracker: { log: { connection: "trk" } } };

// Close deps that fail the test on any gh or git call: a close resolved without change must never reach them.
function forbiddenDeps(calls) {
  return new Proxy(
    {},
    {
      get: (_target, name) => {
        if (name === "settleClosed" || typeof name === "symbol") return undefined;
        return () => {
          calls.push(String(name));
          throw new Error(`${String(name)} must not be called`);
        };
      },
    },
  );
}

// A tracker provider whose close and log actions record the result they were told, answering the given status.
function recordingProvider(seen, { originStatus = "done" } = {}) {
  return {
    ...trackerProvider(),
    onClosed: async ({ result }) => {
      seen.origin.push(result);
      return { status: originStatus, note: `told ${originStatus}` };
    },
    log: async ({ result }) => {
      seen.log.push(result);
      return { status: "done", note: "logged" };
    },
  };
}

// A home with project `alpha` logging closes to the tracker, and a done job from a tracker link with no pull request.
function noChangeHome(t, name, { prUrl = null } = {}) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  const id = seedDoneJob(env, { prompt: `the login loops, see ${TRACKER_URL}`, prUrl, noticeMd: NOTICE });
  bindTrackerConnection(env, projectId);
  setIntegrations(env, projectId, LOGGING);
  return { env, checkout, id, store: openStore(env) };
}

// Runs one close attempt over the real steps with the given deps.
async function closeOnce(home, deps) {
  assert.ok(acquireClose(home.id, { worker: WORKER, leaseS: 660 }, home.env), "the close lease was refused");
  return await runClosePipeline({ store: home.store, job: getJob(home.id, home.env), worker: WORKER, env: home.env, deps, timeoutS: 60, checkout: home.checkout });
}

test("a done job with no pull request closes with no gh or git call: the pre steps skipped, settled as resolved without change", async (t) => {
  const seen = { origin: [], log: [] };
  await withProviders([recordingProvider(seen)], async () => {
    const home = noChangeHome(t, "close-no-change");
    const calls = [];
    const outcome = await closeOnce(home, forbiddenDeps(calls));

    assert.deepEqual(calls, [], "a close resolved without change called gh or git");
    assert.equal(outcome.status, "closed");
    assert.equal(outcome.resolution, "no-change");
    assert.equal(outcome.mergeSha, null);
    const row = getJob(home.id, home.env);
    assert.equal(row.status, "closed");
    assert.equal(row.pr_url, null);
    const checklist = JSON.parse(row.close);
    for (const name of ["preflight", "conflict", "merge"]) {
      assert.deepEqual([checklist.steps[name].status, checklist.steps[name].note], ["skipped", NO_PR_NOTE], name);
    }
    assert.equal(checklist.steps.settle.status, "done");
    for (const name of ["origin", "log"]) assert.ok(checklist.finishedAt >= checklist.steps[name].at, `finishedAt precedes the ${name} step`);
    assert.equal(checklist.data.resolvedWithoutChange, true);
    assert.match(checklist.data.noticeLine, /^Closed: resolved without change on \d{4}-\d{2}-\d{2}$/);
    assert.equal(outcome.postClose.steps.map((step) => `${step.name} ${step.status}`).join(", "), "ota skipped, origin done, log done");

    const view = jobView(row);
    assert.equal(view.resolution, "no-change");
    assert.equal(stoppedReason(view), "closed without change");
    assert.ok(closeChecklistLines(view).includes(`${"resolution".padEnd(16)}resolved without change (no pull request)`));
  });
  for (const result of [...seen.origin, ...seen.log]) {
    assert.equal(result.resolution, "no-change");
    assert.equal(result.conclusion, ORIGIN_CONCLUSION, "the conclusion carried a line the runtime appended");
    assert.equal(result.prUrl, null);
    assert.equal(result.mergeSha, null);
  }
  assert.deepEqual([seen.origin.length, seen.log.length], [1, 1]);
});

test("a done job with a pull request still runs the real preflight", async (t) => {
  const home = noChangeHome(t, "close-no-change-pr", { prUrl: "https://github.com/acme/api/pull/7" });
  const outcome = await closeOnce(home, forbiddenDeps([]));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.step, "preflight");
  assert.equal(outcome.resolution, undefined);
  const preflight = JSON.parse(getJob(home.id, home.env).close).steps.preflight;
  assert.equal(preflight.status, "failed", "the real preflight did not run against the forbidden deps");
  assert.notEqual(preflight.note, NO_PR_NOTE);
});

test("--steps origin on a closed job resolved without change re-tells only that origin, still as resolved without change", async (t) => {
  const first = { origin: [], log: [] };
  const home = await withProviders([recordingProvider(first, { originStatus: "warning" })], async () => {
    const built = noChangeHome(t, "close-no-change-steps");
    await closeOnce(built, forbiddenDeps([]));
    return built;
  });
  assert.equal(getJob(home.id, home.env).notice_md.endsWith("After close: origin warning - tracker 4507: told warning"), true);

  const second = { origin: [], log: [] };
  await withProviders([recordingProvider(second)], async () => {
    const rerun = await runPostCloseSteps({ store: home.store, id: home.id, names: ["origin", "log"], env: home.env });
    assert.deepEqual(rerun.steps.map((step) => `${step.name} ${step.status}`), ["origin done", "log done"]);
  });
  assert.equal(second.origin.length, 1);
  assert.equal(second.log.length, 0, "the log already posted was posted again");
  assert.equal(second.origin[0].resolution, "no-change");
  assert.equal(second.origin[0].conclusion, ORIGIN_CONCLUSION);
});

test("--force is refused on a job with no pull request, and the close without it is accepted", async (t) => {
  const home = noChangeHome(t, "close-no-change-force");
  await assert.rejects(
    validateCloseTarget({ store: home.store, id: home.id, force: true, env: home.env }),
    new RegExp(`job \`${home.id}\` has no pull request: --force only skips pull request checks; close it without --force`),
  );
  const target = await validateCloseTarget({ store: home.store, id: home.id, env: home.env });
  assert.equal(target.job.id, home.id);
  assert.equal(stoppedReason(jobView(getJob(home.id, home.env))), `resolved without change - close it with nightqueue queue close J-${home.id}`);
});

test("the conclusion told to the origins carries no operator instruction (QA PoC H1)", async (t) => {
  const trailer = "Next step: close the job so where it came from is told it was resolved without a code change.";
  const notice = `✅ Resolved — no code change needed\n\nThe loop comes from the CDN cache rule.\n\n${trailer}`;
  const seen = [];
  const provider = {
    ...trackerProvider(),
    onClosed: async ({ result }) => {
      seen.push(result.conclusion);
      return { status: "done", note: "ok" };
    },
    log: async ({ result }) => {
      seen.push(result.conclusion);
      return { status: "done", note: "ok" };
    },
  };
  await withProviders([provider], async () => {
    const env = makeHome(t, "poc-h1");
    const checkout = makeProject(t, env, "alpha");
    const projectId = projectIdOf(env, "alpha");
    const id = seedDoneJob(env, { prompt: `see ${TRACKER_URL}`, prUrl: null, noticeMd: notice });
    bindTrackerConnection(env, projectId);
    setIntegrations(env, projectId, { tracker: { log: { connection: "trk" } } });
    const store = openStore(env);
    assert.ok(acquireClose(id, { worker: "w:1", leaseS: 660 }, env));
    await runClosePipeline({ store, job: getJob(id, env), worker: "w:1", env, deps: forbiddenDeps([]), timeoutS: 60, checkout });
  });
  assert.ok(seen.length > 0);
  for (const conclusion of seen) assert.equal(String(conclusion).includes("Next step: close the job"), false, `leaked: ${JSON.stringify(conclusion)}`);
});

test("the conclusion told to the origins never names a stray pull request the run published", async (t) => {
  const stray = `${STRAY_PR_PREFIX}https://github.com/acme/web/pull/9; no pull request of this run's own branch was found`;
  const seen = { origin: [], log: [] };
  await withProviders([recordingProvider(seen)], async () => {
    const env = makeHome(t, "close-no-change-stray");
    const checkout = makeProject(t, env, "alpha");
    const projectId = projectIdOf(env, "alpha");
    const id = seedDoneJob(env, { prompt: `see ${TRACKER_URL}`, prUrl: null, noticeMd: `${CONCLUSION}\n\n${NO_CHANGE_NEXT_STEP_LINE}\n\n${stray}` });
    bindTrackerConnection(env, projectId);
    setIntegrations(env, projectId, LOGGING);
    await closeOnce({ env, checkout, id, store: openStore(env) }, forbiddenDeps([]));
  });
  for (const result of [...seen.origin, ...seen.log]) {
    assert.equal(result.conclusion, ORIGIN_CONCLUSION);
    assert.equal(result.conclusion.includes("/pull/"), false);
  }
});

test("a done job with no pull request and no no-change record is refused as nothing to close, and its view says no resolution", async (t) => {
  const env = makeHome(t, "close-no-change-unmarked");
  makeProject(t, env, "alpha");
  const id = seedDoneJob(env, { prUrl: null, resolution: null, noticeMd: CONCLUSION });
  const store = openStore(env);
  await assert.rejects(validateCloseTarget({ store, id, env }), /nothing to close: the job has no pull request/);
  assert.equal(acquireClose(id, { worker: WORKER, leaseS: 660 }, env), null, "the close lease was taken by an unmarked job");
  assert.equal(getJob(id, env).close_status, null);
  assert.equal(jobView(getJob(id, env)).resolution, null);
});

test("queue close --foreground on a job resolved without change prints that it closed with no pull request", async (t) => {
  const home = noChangeHome(t, "close-no-change-cli");
  const out = [];
  const err = [];
  const ctx = { ...defaultContext(), env: home.env, closeDeps: forbiddenDeps([]), out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = await withProviders([recordingProvider({ origin: [], log: [] })], async () => await run(["queue", "close", String(home.id), "--foreground"], ctx));
  assert.equal(code, 0, err.join("\n"));
  assert.equal(out.at(-1), `J-${home.id} closed: resolved without change (no pull request)`);
});
