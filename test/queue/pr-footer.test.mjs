import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { addJob } from "../../src/memory/jobs.mjs";
import { queueIssue, saveIssue } from "../../src/memory/issues.mjs";
import { PUBLISHED_BODY_FILE, footerOf, itemRefOfJob, publishedBodyFile } from "../../src/queue/pr-footer.mjs";
import { openStore } from "../../src/store/open.mjs";
import { ensureProject, makeDir, makeHome, makeProject, orgIdOf, projectIdOf } from "../../test-support/memory.mjs";

const BODY = "## Report\n\nthe thing is done.\n\n";

// A home with one project, a run directory and the agent's body file.
function makeFooterHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const runDir = makeDir(t, `${name}-run`);
  const bodyFile = join(makeDir(t, `${name}-body`), "body.md");
  writeFileSync(bodyFile, BODY);
  return { env, runDir, bodyFile, store: openStore(env) };
}

// The sha-256 of a file, to prove the agent's body was never edited.
function hashOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("the footer is only `Opened by nightqueue · <ref>` for an item, and the bare signature otherwise", () => {
  assert.equal(footerOf("NQ-12"), "Opened by nightqueue · NQ-12");
  assert.equal(footerOf(null), "Opened by nightqueue");
  assert.equal(footerOf(undefined), "Opened by nightqueue");
});

test("an issue job publishes a copy ending with its item's footer, the same on a second call, and the agent's file is unchanged", async (t) => {
  const { env, runDir, bodyFile, store } = makeFooterHome(t, "pr-footer-linked");
  const item = saveIssue({ type: "feature", projectId: projectIdOf(env, "alpha"), title: "ship it" }, env);
  const { job } = await queueIssue({ id: item.id }, env);
  const before = hashOf(bodyFile);

  const first = await publishedBodyFile({ bodyFile, runDir, jobId: job.id, resolveItemRef: () => itemRefOfJob(store, job.id) });
  const second = await publishedBodyFile({ bodyFile, runDir, jobId: job.id, resolveItemRef: () => itemRefOfJob(store, job.id) });

  assert.equal(first, join(runDir, PUBLISHED_BODY_FILE));
  assert.equal(second, first);
  assert.equal(item.ref, "AP-1");
  assert.equal(readFileSync(first, "utf8"), "## Report\n\nthe thing is done.\n\nOpened by nightqueue · AP-1\n");
  assert.equal(hashOf(bodyFile), before, "the agent's body file was edited");
});

test("a job queued from an org item ends its body with the org item's ref", async (t) => {
  const { env, runDir, bodyFile, store } = makeFooterHome(t, "pr-footer-org");
  makeProject(t, env, "beta", { org: "acme" });
  makeProject(t, env, "gamma", { org: "acme" });
  const item = saveIssue({ type: "chore", orgId: orgIdOf(env, "acme"), title: "pin node" }, env);
  const { jobs } = await queueIssue({ id: item.id, allProjects: true }, env);
  assert.equal(jobs.length, 2);

  for (const job of jobs) {
    const published = await publishedBodyFile({ bodyFile, runDir, jobId: job.id, resolveItemRef: () => itemRefOfJob(store, job.id) });
    assert.ok(readFileSync(published, "utf8").endsWith(`\n\nOpened by nightqueue · ${item.ref}\n`));
  }
});

test("a free-prompt job and a run outside the queue end with the bare signature", async (t) => {
  const { env, runDir, bodyFile, store } = makeFooterHome(t, "pr-footer-plain");
  const plain = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix it" }, env);

  for (const jobId of [plain.id, null]) {
    const published = await publishedBodyFile({ bodyFile, runDir, jobId, resolveItemRef: () => itemRefOfJob(store, jobId) });
    assert.equal(readFileSync(published, "utf8"), "## Report\n\nthe thing is done.\n\nOpened by nightqueue\n");
  }
});

test("a store that cannot answer refuses the publication, naming the job, instead of dropping the footer", async (t) => {
  const { runDir, bodyFile } = makeFooterHome(t, "pr-footer-broken");
  const store = { issues: { issueRefOfJob: async () => { throw new Error("database is locked"); } } };
  await assert.rejects(publishedBodyFile({ bodyFile, runDir, jobId: 3, resolveItemRef: () => itemRefOfJob(store, 3) }), {
    name: "UserError",
    message: "could not build the pull request footer from J-3: database is locked; nothing was pushed",
  });
});
