// H-C1 · a fail-then-retry race across two job writers can skip the intermediate event, losing its comment
// (and, worse, silently undoing the retry itself).
//
// Root cause found by racing: `finishJob`'s own durability check (src/memory/jobs.mjs:498-517,
// `ensureDurable`/`verifyWitnessed`/`reapplyFinish`) reads the job back through a FRESH connection right
// after its commit to confirm the write survived. If a concurrent `retryJob` commits in that exact gap
// (moving the job from `failed` to `pending`), the fresh read no longer matches what `finishJob` wrote, so
// `ensureDurable` concludes the write was "lost" and calls `reapplyFinish`, which does an unconditional
// `UPDATE jobs SET status = 'failed', ... WHERE id = ?` (no status guard) — silently reverting the job's own
// legitimate retry back to `failed`. This also starves `followJobQuietly` (src/store/local.mjs:35-41) of the
// intermediate event: `roadmap-workflow.mjs`'s `jobEvent()` (line 66) never sees the job pass through
// `pending` cleanly, so the item's `failed`-kind comment can be silently dropped from the thread, breaking
// the one-comment-per-job-event contract `roadmap-comments.test.mjs`'s sequential lifecycle test enforces.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getRoadmapItemDetail } from "../../src/memory/roadmap.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const OPEN_STORE_URL = new URL("../../src/store/open.mjs", import.meta.url).href;

// Source of a child process that finishes one job as `failed`, exactly once, through the follow-wrapped store.
function finisherSource() {
  return [
    `import { openStore } from ${JSON.stringify(OPEN_STORE_URL)};`,
    "const [, , jobRaw] = process.argv;",
    "const store = openStore(process.env);",
    "try {",
    "  await store.jobs.finishJob(Number(jobRaw), { worker: 'w1', status: 'failed' });",
    "} finally {",
    "  await store.close();",
    "}",
  ].join("\n");
}

// Source of a child process that spins retrying one job, through the follow-wrapped store, until the retry
// lands (the job only accepts a retry once it is `failed`) or the deadline passes.
function retrierSource() {
  return [
    `import { openStore } from ${JSON.stringify(OPEN_STORE_URL)};`,
    "const [, , jobRaw, durationRaw] = process.argv;",
    "const store = openStore(process.env);",
    "const deadline = Date.now() + Number(durationRaw);",
    "let ok = false;",
    "while (!ok && Date.now() < deadline) {",
    "  try {",
    "    await store.jobs.retryJob(Number(jobRaw), {});",
    "    ok = true;",
    "  } catch {",
    "    // not failed yet — yield 2ms so the spin never starves the finisher of the write lock on a slow host",
    "    await new Promise((resolve) => setTimeout(resolve, 2));",
    "  }",
    "}",
    "await store.close();",
    "process.stdout.write(ok ? 'ok' : 'timeout');",
  ].join("\n");
}

// Runs one racer child process to its end.
function runRacer(script, env, jobId, extraArg) {
  const args = extraArg === undefined ? [script, String(jobId)] : [script, String(jobId), String(extraArg)];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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

test("a racing fail-then-retry across two writers never silently drops the failed comment or the retry", async (t) => {
  const env = makeHome(t, "roadmap-followjob-race");
  makeProject(t, env, "alpha");
  const store = openStore(env);
  t.after(() => store.close());

  const item = await store.roadmap.saveRoadmapItem({ type: "bug", project: "alpha", title: "race me" });
  const { job } = await store.roadmap.queueRoadmapItem({ id: item.id });

  const dir = makeDir(t, "roadmap-followjob-race-scripts");
  const finishScript = join(dir, "finisher.mjs");
  const retryScript = join(dir, "retrier.mjs");
  writeFileSync(finishScript, finisherSource(), "utf8");
  writeFileSync(retryScript, retrierSource(), "utf8");

  const ROUNDS = 20;
  // The deadline bounds a hang, not the race: on a loaded 2-core CI runner a round can take seconds to spawn and settle.
  const RETRY_DEADLINE_MS = 30000;

  for (let round = 0; round < ROUNDS; round += 1) {
    // Each round starts the job fresh at `running`, claimed by w1, so the finisher's UPDATE is legal. A
    // refusal here is itself evidence of the break: it means the PREVIOUS round's legitimate retry (which
    // left the job `pending`) was silently reverted back to `failed` by the race, so there is nothing
    // claimable — the retry never really happened from the operator's point of view.
    const claimed = await store.jobs.claimJobById(job.id, { worker: "w1", cap: null });
    assert.ok(
      claimed,
      `round ${round}: the job was not claimable as \`pending\` — the previous round's retry was silently ` +
        `undone by the fail/retry race (ensureDurable's reapplyFinish reverting the job back to \`failed\`)`,
    );

    const [finishResult, retryResult] = await Promise.all([
      runRacer(finishScript, env, job.id),
      runRacer(retryScript, env, job.id, RETRY_DEADLINE_MS),
    ]);
    assert.equal(finishResult.code, 0, `round ${round} finisher stderr: ${finishResult.stderr}`);
    assert.equal(retryResult.code, 0, `round ${round} retrier stderr: ${retryResult.stderr}`);
    assert.equal(retryResult.stdout, "ok", `round ${round}: retry never landed within the deadline`);

    // The correct behavior, from the operator's point of view: every fail event this loop caused the job to
    // pass through must be visible, right now, as a `failed`-kind comment on the item's thread — a fail
    // interruption can never be silently swallowed by a race with a retry, no matter how tight the timing.
    const kinds = getRoadmapItemDetail(item.id, {}, env).comments.map((comment) => comment.kind);
    const failedCount = kinds.filter((kind) => kind === "failed").length;
    assert.equal(
      failedCount,
      round + 1,
      `round ${round}: expected ${round + 1} cumulative 'failed' comments on the item thread, found ${failedCount} ` +
        `(kinds so far: ${JSON.stringify(kinds)}) — the fail event was dropped by the fail/retry race`,
    );
  }
});
