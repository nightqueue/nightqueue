import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { withProviders } from "../../src/integrations/registry.mjs";
import { acquireClose, acquirePostClose, getJob, jobView } from "../../src/memory/jobs.mjs";
import { CLOSE_STEPS, postCloseStepsNamed, runClosePipeline } from "../../src/queue/close.mjs";
import { runPostCloseSteps } from "../../src/queue/close-start.mjs";
import { closeChecklistLines, statusLabel } from "../../src/queue/close-view.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject, projectIdOf, seedClosedJob, seedDoneJob } from "../../test-support/memory.mjs";
import { bindTrackerConnection, setIntegrations, trackerProvider, TRACKER_SECRET, TRACKER_URL } from "../../test-support/origin-provider.mjs";

const WORKER = "close:test:1:post";
const MERGE_SHA = "abc1234def5678";
const PROMPT = `the worker crashes on boot, see ${TRACKER_URL}`;
const LOGGING = { tracker: { log: { connection: "trk" } } };
const POST_STEPS = CLOSE_STEPS.filter((step) => step.required === false);

// Resolves the origin issue through the http the runtime hands in.
async function resolveIssue({ ref, slot, http, result }) {
  const answer = await http(`https://tracker.example/api/issues/${ref}/resolve`, { method: "PUT", headers: { Authorization: `Bearer ${slot.token}` }, body: { sha: result.mergeSha } });
  return answer.ok ? { status: "done", note: `resolved issue ${ref}` } : { status: "warning", note: `resolve refused (${answer.detail})` };
}

// Posts the close to the log connection through the http the runtime hands in.
async function logClose({ job, result, connection, http }) {
  const answer = await http("https://tracker.example/api/log", { method: "POST", headers: { Authorization: `Bearer ${connection.token}` }, body: { text: `${job.ref} closed as ${result.mergeSha}` } });
  return answer.ok ? { status: "done", note: "posted" } : { status: "warning", note: answer.detail };
}

// The tracker fixture with a close action and a log action, either replaceable.
function closingProvider({ onClosed = resolveIssue, log = logClose } = {}) {
  return { ...trackerProvider(), onClosed, log };
}

// A fake fetch recording every call, answering the status a URL part maps to, 200 otherwise.
function fakeFetch(statuses = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ?? null });
    const status = Object.entries(statuses).find(([part]) => url.includes(part))?.[1] ?? 200;
    return { status, headers: new Map(), json: async () => ({}) };
  };
  return { impl, calls };
}

// Pre-close steps that merge and settle without gh, so the real post-close steps run after a real settle.
function fakePreSteps() {
  const done = (note, data) => async () => ({ status: "done", note, data });
  return [
    { name: "preflight", run: done("checks green", { title: "fix the worker" }) },
    { name: "conflict", run: async () => ({ status: "skipped", note: "mergeable" }) },
    { name: "merge", run: done("merged", { merged: true, mergeSha: MERGE_SHA }) },
    { name: "settle", run: async ({ ctx }) => ({ status: "done", note: "ready", data: { noticeLine: `Closed: PR #${ctx.prNumber} merged as abc1234 on 2026-10-01` } }) },
  ];
}

// A home with project `alpha`, a done job queued from a tracker link and its close lease held; integrations as given.
function postHome(t, name, { integrations = LOGGING, bind = true } = {}) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  const id = seedDoneJob(env, { prompt: PROMPT });
  if (bind) bindTrackerConnection(env, projectId);
  if (integrations) setIntegrations(env, projectId, integrations);
  return { env, checkout, id, projectId, store: openStore(env) };
}

// Runs one close attempt with the fake pre-close steps and the real post-close ones, collecting what onStep reported.
async function closeOnce(home, { fetch, signal = null, store = home.store }) {
  acquireClose(home.id, { worker: WORKER, leaseS: 660 }, home.env);
  const reported = [];
  const outcome = await runClosePipeline({
    store,
    job: getJob(home.id, home.env),
    worker: WORKER,
    env: home.env,
    deps: { fetch: fetch.impl },
    timeoutS: 60,
    signal,
    onStep: (step) => reported.push(step),
    checkout: home.checkout,
    steps: [...fakePreSteps(), ...POST_STEPS],
  });
  return { outcome, reported, row: getJob(home.id, home.env) };
}

// The stored checklist of a row.
function checklistOf(row) {
  return JSON.parse(row.close);
}

// Runs the CLI in this process with the given close deps, collecting what it printed.
async function runCli(env, argv, closeDeps) {
  const out = [];
  const err = [];
  const code = await run(argv, { ...defaultContext(), env, closeDeps, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

test("a project without integrations closes exactly as before: no post-close entry, step, lease or notice line", async (t) => {
  await withProviders([closingProvider()], async () => {
    const home = postHome(t, "post-none", { integrations: null });
    const fetch = fakeFetch();
    const { outcome, reported, row } = await closeOnce(home, { fetch });

    assert.deepEqual(outcome, { status: "closed", step: "settle", reason: null, mergeSha: MERGE_SHA, worktree: null });
    assert.deepEqual(reported.map((step) => step.name), ["preflight", "conflict", "merge", "settle"]);
    assert.equal(row.status, "closed");
    assert.equal(row.close_worker, null);
    assert.equal(row.notice_md, "Closed: PR #7 merged as abc1234 on 2026-10-01");
    assert.deepEqual(Object.keys(checklistOf(row).steps), ["preflight", "conflict", "merge", "settle"]);
    assert.equal(fetch.calls.length, 0);
  });
});

test("with integrations the origin is resolved and the close logged once, the job stays closed and the notice is unchanged", async (t) => {
  await withProviders([closingProvider()], async () => {
    const home = postHome(t, "post-done");
    const fetch = fakeFetch();
    const { outcome, reported, row } = await closeOnce(home, { fetch });

    assert.equal(outcome.status, "closed");
    assert.deepEqual(outcome.postClose.steps, [
      { name: "origin", status: "done", note: "resolved issue 4507" },
      { name: "log", status: "done", note: "tracker: posted" },
    ]);
    assert.deepEqual(reported.map((step) => [step.name, step.status]).slice(4), [["origin", "done"], ["log", "done"]]);
    assert.deepEqual(fetch.calls.map((call) => [call.method, call.url]), [
      ["PUT", "https://tracker.example/api/issues/4507/resolve"],
      ["POST", "https://tracker.example/api/log"],
    ]);
    assert.ok(fetch.calls[1].body.includes(MERGE_SHA));
    const checklist = checklistOf(row);
    assert.equal(checklist.data.originNotified, true);
    assert.deepEqual(checklist.data.logged, { tracker: true });
    assert.equal(checklist.steps.origin.status, "done");
    assert.equal(row.status, "closed");
    assert.equal(row.close_status, null);
    assert.equal(row.close_worker, null, "the post-close lease is released");
    assert.equal(row.notice_md, "Closed: PR #7 merged as abc1234 on 2026-10-01");
    assert.ok(!row.close.includes(TRACKER_SECRET));
    const lines = closeChecklistLines(jobView(row));
    assert.ok(lines.some((line) => line.includes("origin") && line.includes("resolved issue 4507")));
  });
});

test("a refused, failed or throwing service is a warning line in the notice, never a change of the closed job", async (t) => {
  const cases = [
    { name: "refused", provider: closingProvider(), statuses: { "/resolve": 500 }, note: "resolve refused (HTTP 500)" },
    { name: "failed", provider: closingProvider({ onClosed: async () => ({ status: "failed", note: "x" }) }), statuses: {}, note: "tracker answered an invalid result" },
    { name: "throws", provider: closingProvider({ onClosed: async () => { throw new Error(`boom ${TRACKER_SECRET}`); } }), statuses: {}, note: "the tracker close action failed" },
  ];
  for (const { name, provider, statuses, note } of cases) {
    await withProviders([provider], async () => {
      const home = postHome(t, `post-warn-${name}`);
      const { outcome, row } = await closeOnce(home, { fetch: fakeFetch(statuses) });

      assert.equal(outcome.status, "closed", name);
      assert.equal(row.status, "closed", name);
      assert.equal(checklistOf(row).steps.origin.status, "warning", name);
      assert.equal(checklistOf(row).data.originNotified, undefined, name);
      assert.ok(row.notice_md.endsWith(`\n\nAfter close: origin warning - ${note}`), `${name}: ${row.notice_md}`);
      assert.ok(!row.notice_md.includes(TRACKER_SECRET), name);
      assert.ok(!row.close.includes(TRACKER_SECRET), name);
    });
  }
});

test("an origin with no connection in the org is a noticed skip, a project that never enabled the provider a silent one", async (t) => {
  await withProviders([closingProvider()], async () => {
    const unbound = postHome(t, "post-unbound", { bind: false, integrations: { tracker: { enabled: true } } });
    const { row } = await closeOnce(unbound, { fetch: fakeFetch() });
    assert.equal(checklistOf(row).steps.origin.status, "skipped");
    assert.ok(row.notice_md.endsWith("After close: origin skipped - no tracker connection in the org"));
    assert.equal(checklistOf(row).steps.log.note, "no log destination");

    const other = postHome(t, "post-other", { integrations: { elsewhere: { enabled: true } } });
    const fetch = fakeFetch();
    const second = await closeOnce(other, { fetch });
    assert.equal(checklistOf(second.row).steps.origin.note, "project has no tracker integration");
    assert.equal(second.row.notice_md, "Closed: PR #7 merged as abc1234 on 2026-10-01");
    assert.equal(fetch.calls.length, 0);
  });
});

test("an interrupted or overdue post-close step is a warning and the job stays closed", async (t) => {
  let entered = null;
  const hanging = closingProvider({
    onClosed: () =>
      new Promise(() => {
        entered();
      }),
  });
  await withProviders([hanging], async () => {
    const home = postHome(t, "post-interrupt");
    const controller = new AbortController();
    const reached = new Promise((resolve) => {
      entered = resolve;
    });
    const pending = closeOnce(home, { fetch: fakeFetch(), signal: controller.signal });
    await reached;
    controller.abort();
    const { outcome, row } = await pending;
    assert.equal(outcome.status, "closed");
    assert.equal(row.status, "closed");
    assert.deepEqual(outcome.postClose.steps.map((step) => [step.name, step.status, step.note]), [
      ["origin", "warning", "interrupted"],
      ["log", "warning", "interrupted"],
    ]);
  });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withProviders([hanging], async () => {
    const home = postHome(t, "post-overdue");
    const reached = new Promise((resolve) => {
      entered = resolve;
    });
    const pending = closeOnce(home, { fetch: fakeFetch() });
    await reached;
    t.mock.timers.tick(60000);
    const { outcome, row } = await pending;
    assert.equal(row.status, "closed");
    assert.equal(outcome.postClose.steps[0].note, "passed the post-close budget of 60s");
    assert.ok(row.notice_md.includes("After close: origin warning - passed the post-close budget of 60s"));
  });
  t.mock.timers.reset();
});

test("a post-close checklist write that fails is reported as a line and the close stays closed", async (t) => {
  await withProviders([closingProvider()], async () => {
    const home = postHome(t, "post-write-fails");
    const store = { ...home.store, jobs: { ...home.store.jobs, recordPostCloseStep: async () => { throw new Error("database is locked"); } } };
    const { outcome, reported, row } = await closeOnce(home, { fetch: fakeFetch(), store });
    assert.equal(outcome.status, "closed");
    assert.equal(row.status, "closed");
    assert.ok(reported.some((step) => step.status === "warning" && step.note === "the post-close checklist could not be written"));
    assert.ok(reported.every((step) => !String(step.note).includes("database is locked")), "the store's error text is never copied");
    assert.equal(outcome.postClose.steps.length, 1, "the steps after a failed write are not run");
  });
});

test("a log connection the project's org no longer uses is a noticed skip with no request to it", async (t) => {
  await withProviders([closingProvider()], async () => {
    const home = postHome(t, "post-log-other-org", { bind: false, integrations: { tracker: { log: { connection: "other" } } } });
    bindTrackerConnection(home.env, home.projectId, { name: "other" });
    bindTrackerConnection(home.env, home.projectId, { name: "trk" });
    const fetch = fakeFetch();
    const { outcome, row } = await closeOnce(home, { fetch });
    assert.equal(row.status, "closed");
    assert.deepEqual(outcome.postClose.steps.find((step) => step.name === "log"), { name: "log", status: "skipped", note: "tracker: log connection other is not bound to the project's org" });
    assert.ok(fetch.calls.every((call) => !call.url.includes("/api/log")));
  });
});

test("a store that throws when the post-close phase starts never rejects the close of a job already closed", async (t) => {
  await withProviders([closingProvider()], async () => {
    const home = postHome(t, "post-acquire-throws");
    const store = { ...home.store, jobs: { ...home.store.jobs, acquirePostClose: async () => { throw new Error("database is locked"); } } };
    const { outcome, reported, row } = await closeOnce(home, { fetch: fakeFetch(), store });
    assert.equal(row.status, "closed");
    assert.equal(outcome.status, "closed");
    assert.equal(outcome.postClose.status, "failed");
    assert.ok(reported.some((step) => step.name === "post-close" && step.status === "warning" && !step.note.includes("database is locked")));
  });
});

test("--steps re-runs only the named steps; a step already done makes no request, and a success after a warning is noticed", async (t) => {
  await withProviders([closingProvider()], async () => {
    const home = postHome(t, "post-rerun");
    await closeOnce(home, { fetch: fakeFetch({ "/resolve": 503 }) });

    const retry = fakeFetch();
    const first = await runPostCloseSteps({ store: home.store, id: home.id, names: ["origin"], env: home.env, deps: { fetch: retry.impl } });
    assert.deepEqual(first.steps, [{ name: "origin", status: "done", note: "resolved issue 4507" }]);
    assert.deepEqual(retry.calls.map((call) => call.method), ["PUT"]);
    const row = getJob(home.id, home.env);
    assert.ok(row.notice_md.endsWith("After close: origin warning - resolve refused (HTTP 503)\n\nAfter close: origin done - resolved issue 4507"));
    assert.equal(row.close_worker, null);

    const again = fakeFetch();
    const second = await runPostCloseSteps({ store: home.store, id: home.id, names: ["log", "origin", "log"], env: home.env, deps: { fetch: again.impl } });
    assert.deepEqual(second.steps, [
      { name: "origin", status: "done", note: "already notified" },
      { name: "log", status: "done", note: "tracker: already logged" },
    ]);
    assert.equal(again.calls.length, 0);
    assert.equal(getJob(home.id, home.env).notice_md, row.notice_md);
  });
});

test("--steps refuses a pre-close or unknown step, a job not closed, a run inside a job and a live post-close lease", async (t) => {
  await withProviders([closingProvider()], async () => {
    assert.throws(() => postCloseStepsNamed(["merge"]), /`merge` is not a post-close step; valid steps: origin, log/);
    assert.throws(() => postCloseStepsNamed(["origin", "settle"]), /`settle` is not a post-close step/);
    assert.throws(() => postCloseStepsNamed([]), /no step is not a post-close step/);

    const done = postHome(t, "post-refuse-done");
    await assert.rejects(runPostCloseSteps({ store: done.store, id: done.id, names: ["origin"], env: done.env }), /runs only on a closed job; close it first with nightqueue queue close J-1/);
    await assert.rejects(runPostCloseSteps({ store: done.store, id: done.id, names: ["origin"], env: { ...done.env, NIGHTQUEUE_JOB_ID: "9" } }), /refusing to close from inside job `9`/);

    const env = makeHome(t, "post-refuse-lease");
    makeProject(t, env, "alpha");
    const id = seedClosedJob(env, { prompt: PROMPT });
    setIntegrations(env, projectIdOf(env, "alpha"), LOGGING);
    assert.ok(acquirePostClose(id, { worker: "close:other:2:beef", leaseS: 120 }, env));
    await assert.rejects(runPostCloseSteps({ store: openStore(env), id, names: ["origin"], env }), /are being run by `close:other:2:beef`/);

    const row = getJob(id, env);
    assert.equal(statusLabel(row), "closed", "a closed job under a post-close lease still reads closed");
    assert.match(closeChecklistLines(row)[0], /closed, attempt 1/);
  });
});

test("two concurrent --steps re-runs: exactly one takes the lease and notifies, the other is refused", async (t) => {
  await withProviders([closingProvider()], async () => {
    const env = makeHome(t, "post-race");
    makeProject(t, env, "alpha");
    const projectId = projectIdOf(env, "alpha");
    const id = seedClosedJob(env, { prompt: PROMPT });
    bindTrackerConnection(env, projectId);
    setIntegrations(env, projectId, LOGGING);
    const fetch = fakeFetch();
    const store = openStore(env);
    const results = await Promise.all([1, 2].map(() => runPostCloseSteps({ store, id, names: ["origin"], env, deps: { fetch: fetch.impl } })));

    assert.deepEqual(results.map((result) => result.status).sort(), ["ran", "refused"]);
    assert.equal(fetch.calls.length, 1);
  });
});

test("queue close --steps prints each step and a summary, exits 1 on a warning, and refuses a pre-close step", async (t) => {
  await withProviders([closingProvider()], async () => {
    const env = makeHome(t, "post-cli");
    makeProject(t, env, "alpha");
    const projectId = projectIdOf(env, "alpha");
    seedClosedJob(env, { prompt: PROMPT });
    bindTrackerConnection(env, projectId);
    setIntegrations(env, projectId, LOGGING);

    const warned = await runCli(env, ["queue", "close", "J-1", "--steps", "origin,log"], { fetch: fakeFetch({ "/log": 500 }).impl });
    assert.equal(warned.code, 1);
    assert.deepEqual(warned.out, ["✓ origin     resolved issue 4507", "! log        tracker: HTTP 500", "J-1 post-close: origin done, log warning"]);

    const json = await runCli(env, ["queue", "close", "J-1", "--steps", "log", "--json"], { fetch: fakeFetch().impl });
    assert.equal(json.code, 0);
    const payload = JSON.parse(json.out[0]);
    assert.deepEqual(payload.steps, [{ name: "log", status: "done", note: "tracker: posted" }]);
    assert.equal(payload.job.status, "closed");
    assert.ok(!JSON.stringify([warned, json]).includes(TRACKER_SECRET));

    const refused = await runCli(env, ["queue", "close", "J-1", "--steps", "merge"], {});
    assert.notEqual(refused.code, 0);
    assert.match(refused.err.join("\n"), /valid steps: origin, log/);
    const forced = await runCli(env, ["queue", "close", "J-1", "--steps", "origin", "--force"], {});
    assert.notEqual(forced.code, 0);
    assert.match(forced.err.join("\n"), /cannot be combined with --merged or --force/);
  });
});
