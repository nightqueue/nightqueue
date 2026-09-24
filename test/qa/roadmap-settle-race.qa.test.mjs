// A close settling while other processes retry, cancel and sweep the same job: the settle is the only write that
// lands, the job ends `closed` and never `pending`/`cancelled`, and the roadmap item follows it exactly once -
// one `pr` and one `closed` comment carrying the merge sha, nothing from the refused retries or cancels.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getRoadmapItemDetail } from "../../src/memory/roadmap.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeDir, makeHome, makeProject, mergedChecklist } from "../../test-support/memory.mjs";

const OPEN_STORE_URL = new URL("../../src/store/open.mjs", import.meta.url).href;
const PR_URL = "https://github.com/acme/alpha/pull/7";
const ROUNDS = 6;
const SPIN_MS = 5000;
const SETTLE_DELAY_MS = 150;

// Source of a child process that waits a moment, so its racers are already spinning, then settles one close through the store.
function settlerSource() {
  return [
    `import { openStore } from ${JSON.stringify(OPEN_STORE_URL)};`,
    "const [, , jobRaw, delayRaw, checklistRaw] = process.argv;",
    "const store = openStore(process.env);",
    "await new Promise((resolve) => setTimeout(resolve, Number(delayRaw)));",
    "const checklist = JSON.parse(checklistRaw);",
    "try {",
    "  const settled = await store.jobs.settleClose(Number(jobRaw), { worker: 'close-w', close: checklist, noticeLine: checklist.data.noticeLine });",
    "  process.stdout.write(settled ? 'settled' : 'refused');",
    "} finally {",
    "  await store.close();",
    "}",
  ].join("\n");
}

// Source of a child process that spins retrying and cancelling one job through the store until it reads it closed, counting the calls that landed.
function retrierSource() {
  return [
    `import { openStore } from ${JSON.stringify(OPEN_STORE_URL)};`,
    "const [, , jobRaw, durationRaw] = process.argv;",
    "const id = Number(jobRaw);",
    "const store = openStore(process.env);",
    "const deadline = Date.now() + Number(durationRaw);",
    "let landed = 0;",
    "const attempt = async (write) => { try { await write(); landed += 1; } catch {} };",
    "while (Date.now() < deadline && (await store.jobs.status(id)) !== 'closed') {",
    "  await attempt(() => store.jobs.retryJob(id, {}));",
    "  await attempt(() => store.jobs.cancelJob(id, { reason: 'race' }));",
    "}",
    "await attempt(() => store.jobs.retryJob(id, {}));",
    "await attempt(() => store.jobs.cancelJob(id, { reason: 'race' }));",
    "await store.close();",
    "process.stdout.write(String(landed));",
  ].join("\n");
}

// Source of a child process that spins the orphan sweep, which follows drifted items, until it reads the job closed, then sweeps once more.
function sweeperSource() {
  return [
    `import { openStore } from ${JSON.stringify(OPEN_STORE_URL)};`,
    "const [, , jobRaw, durationRaw] = process.argv;",
    "const id = Number(jobRaw);",
    "const store = openStore(process.env);",
    "const deadline = Date.now() + Number(durationRaw);",
    "let sweeps = 0;",
    "while (Date.now() < deadline && (await store.jobs.status(id)) !== 'closed') { await store.jobs.sweepOrphans(); sweeps += 1; }",
    "await store.jobs.sweepOrphans();",
    "await store.close();",
    "process.stdout.write(String(sweeps + 1));",
  ].join("\n");
}

// Runs one racer child process to its end.
function runRacer(script, env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args.map(String)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// Writes the three racer scripts to a temporary directory and answers their paths.
function writeScripts(t) {
  const dir = makeDir(t, "roadmap-settle-race-scripts");
  const scripts = { settler: join(dir, "settler.mjs"), retrier: join(dir, "retrier.mjs"), sweeper: join(dir, "sweeper.mjs") };
  writeFileSync(scripts.settler, settlerSource(), "utf8");
  writeFileSync(scripts.retrier, retrierSource(), "utf8");
  writeFileSync(scripts.sweeper, sweeperSource(), "utf8");
  return scripts;
}

// Queues a fresh item, runs its job to `done` with a pull request and takes the close lease for `close-w`, all through the store.
async function closingItem(store, round) {
  const item = await store.roadmap.saveRoadmapItem({ type: "bug", project: "alpha", title: `settle race ${round}` });
  const { job } = await store.roadmap.queueRoadmapItem({ id: item.id });
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }), `round ${round}: setup: the job was not claimed`);
  assert.equal(await store.jobs.finishJob(job.id, { worker: "w1", status: "done", prUrl: PR_URL }), true, `round ${round}: setup: not finished`);
  assert.ok(await store.jobs.acquireClose(job.id, { worker: "close-w", leaseS: 600 }), `round ${round}: setup: the close lease was refused`);
  return { item, job };
}

test("a settleClose racing retries, cancels and sweeps in other processes closes the job and its item exactly once", async (t) => {
  const env = makeHome(t, "roadmap-settle-race");
  makeProject(t, env, "alpha");
  const store = openStore(env);
  t.after(() => store.close());
  const scripts = writeScripts(t);
  const checklist = mergedChecklist();

  for (let round = 0; round < ROUNDS; round += 1) {
    const { item, job } = await closingItem(store, round);
    const [settler, retrier, sweeper] = await Promise.all([
      runRacer(scripts.settler, env, [job.id, SETTLE_DELAY_MS, JSON.stringify(checklist)]),
      runRacer(scripts.retrier, env, [job.id, SPIN_MS]),
      runRacer(scripts.sweeper, env, [job.id, SPIN_MS]),
    ]);
    for (const [name, result] of Object.entries({ settler, retrier, sweeper })) {
      assert.equal(result.code, 0, `round ${round} ${name} stderr: ${result.stderr}`);
    }
    assert.equal(settler.stdout, "settled", `round ${round}: the settle was refused`);
    assert.equal(retrier.stdout, "0", `round ${round}: a retry or a cancel landed on a job being closed`);
    assert.equal(await store.jobs.status(job.id), "closed", `round ${round}: the job did not end closed`);

    const detail = getRoadmapItemDetail(item.id, {}, env);
    const kinds = detail.comments.map((comment) => comment.kind);
    assert.equal(detail.status, "done", `round ${round}: the item did not end done (kinds: ${kinds})`);
    assert.deepEqual(kinds, ["queued", "pr", "closed"], `round ${round}: the thread is not one pr and one closed`);
    assert.equal(detail.comments.at(-1).refs.sha, checklist.data.mergeSha, `round ${round}: the closed comment lost the merge sha`);
  }
});
