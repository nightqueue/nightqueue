import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveDecision, setDecisionEmbedding } from "../../src/memory/decisions.mjs";
import { cancelJob, finishJob, getJob } from "../../src/memory/jobs.mjs";
import {
  buildIssuePrompt,
  followJob,
  getIssue,
  getIssueDetail,
  queueIssue,
  saveIssue,
  updateIssue,
} from "../../src/memory/issues.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { recordPhaseDone, recordRunFields } from "../../src/queue/run-state.mjs";
import { openStore } from "../../src/store/open.mjs";
import { fakeEmbedder, makeDir, makeHome, makeProject, mergedChecklist, projectIdOf, settleThroughStore, ensureProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, SLUG } from "../../test-support/streams.mjs";
import { runDir } from "../../src/config/paths.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const PR_URL = "https://github.com/acme/alpha/pull/7";

const LINKED = {
  title: "the heartbeat is renewed by the owner only",
  context: "two runners renewed the same lease",
  decision: "renew the lease only from the worker that owns it",
  consequences: "a lost lease kills the child",
  status: "accepted",
};

const RELATED = {
  title: "heartbeat interval is configuration, never a constant",
  context: "a slow disk timed the lease out",
  decision: "read the heartbeat interval from the configuration",
  status: "accepted",
};

const ITEM = { title: "rewrite runner heartbeat", detail: "the renew path must survive a slow disk" };

const EXPECTED_PROMPT = `## Task
rewrite runner heartbeat

the renew path must survive a slow disk

## Issue
Issue: AP-1
Type: improvement
Commit type: refactor or perf

## Linked decision
D-1 the heartbeat is renewed by the owner only (accepted)
Context: two runners renewed the same lease
Decision: renew the lease only from the worker that owns it
Consequences: a lost lease kills the child

## Standing decisions
- D-1 the heartbeat is renewed by the owner only
- D-2 heartbeat interval is configuration, never a constant

## Related decisions
D-2 heartbeat interval is configuration, never a constant (accepted)
Context: a slow disk timed the lease out
Decision: read the heartbeat interval from the configuration`;

// Connects a real stdio client to `nightqueue mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// JSON payload of a successful tool result.
function payloadOf(result) {
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result));
}

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]] ?? ""}\n`;
}

// A home with the registered project, the linked decision, the related one and one issue joining them.
function makeIssuesHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const linked = saveDecision({ projectId: projectIdOf(env, "alpha"), ...LINKED }, env);
  saveDecision({ projectId: projectIdOf(env, "alpha"), ...RELATED }, env);
  const item = saveIssue({ type: "improvement", projectId: projectIdOf(env, "alpha"), ...ITEM, decision_id: linked.id }, env);
  return { env, item };
}

test("queue_add from an issue builds the prompt of the item and links the two", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-prompt");
  const client = await connect(t, env);

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref, prompt: null } }));
  assert.equal(queued.ok, true);
  assert.equal(queued.project, "alpha");
  assert.equal(queued.issueId, item.id);
  assert.equal(getJob(queued.id, env).prompt, EXPECTED_PROMPT);

  const row = getIssue(item.id, env);
  assert.equal(row.status, "in_progress");
  assert.equal(row.job_id, queued.id);
});

test("an item with no detail and no linked decision queues the task alone", async (t) => {
  const env = makeHome(t, "issue-queue-bare");
  makeProject(t, env, "alpha");
  const item = saveIssue({ type: "chore", projectId: projectIdOf(env, "alpha"), title: "index the logs" }, env);
  const client = await connect(t, env);

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref } }));
  assert.equal(getJob(queued.id, env).prompt, "## Task\nindex the logs\n\n## Issue\nIssue: AP-1\nType: chore\nCommit type: chore");
});

test("queue_add refuses no prompt source at all, and a project that is not the item's", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-refusals");
  makeProject(t, env, "beta");
  const client = await connect(t, env);

  const neither = await client.callTool({ name: "queue_add", arguments: { project: "alpha" } });
  assert.equal(neither.isError, true);
  assert.match(textOf(neither), /queue_add needs `prompt`, or `issue_id` to build it from an issue/);

  const foreign = await client.callTool({ name: "queue_add", arguments: { project: "beta", issue_id: item.ref } });
  assert.equal(foreign.isError, true);
  assert.match(textOf(foreign), /belongs to project `alpha`, not `beta`/);

  const unknown = await client.callTool({ name: "queue_add", arguments: { issue_id: "AP-404" } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown issue `AP-404`/);
  assert.equal(getIssue(item.id, env).status, "todo");
});

test("a queued item is refused a second job while the first is alive, and accepted once it is cancelled", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-live-job");
  const client = await connect(t, env);

  const first = payloadOf(await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref } }));
  const refused = await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), new RegExp(`already queued as J-${first.id} \\(\`pending\`\\)`));

  cancelJob(first.id, { reason: "no longer needed" }, env);
  const second = payloadOf(await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref } }));
  assert.notEqual(second.id, first.id);
  assert.equal(getIssue(item.id, env).job_id, second.id);
});

test("a job that ends done puts its own issue in review, and leaves every other one alone", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-done-hook");
  useFakeClaude(env, makeDir(t, "issue-queue-done-plan"), [{ stdout: doneStream(), exitCode: 0 }]);
  const untouched = saveIssue({ type: "improvement", projectId: projectIdOf(env, "alpha"), title: "index the logs" }, env);
  const client = await connect(t, env);
  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref } }));

  const cycle = await runCycle({ jobId: queued.id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit() } });

  assert.deepEqual(
    cycle.processed.map((entry) => entry.status),
    ["done"],
  );
  const row = getIssue(item.id, env);
  assert.equal(row.status, "in_review");
  assert.equal(row.closed_at, null);
  assert.equal(getIssue(untouched.id, env).status, "todo");
  assert.equal(followJob(queued.id, env), 0, "a second follow moved an item that already followed its job");
});

test("the runner records the files the implementation artifact lists, and the pr comment carries them", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-files");
  useFakeClaude(env, makeDir(t, "issue-queue-files-plan"), [{ stdout: doneStream(), exitCode: 0 }]);
  const client = await connect(t, env);
  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref } }));
  const artifactDir = runDir(ensureProject(env, "alpha"), SLUG, env);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "04-implementation.md"), "## Modified files\n- `src/runner.mjs`\n```\nsrc/example.mjs\n```\n\n## Done\n");

  await runCycle({ jobId: queued.id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit() } });

  assert.deepEqual(JSON.parse(getJob(queued.id, env).result).files, ["src/runner.mjs"]);
  const pr = getIssueDetail(item.id, {}, env).comments.find((comment) => comment.kind === "pr");
  assert.deepEqual(pr.refs.files, [{ path: "src/runner.mjs" }]);
});

test("a job that ends done moves an item the operator cancelled while it ran, and the link survives as history", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-dropped-item");
  useFakeClaude(env, makeDir(t, "issue-queue-dropped-plan"), [{ stdout: doneStream(), exitCode: 0 }]);
  const client = await connect(t, env);
  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref } }));
  updateIssue(item.id, { status: "cancelled" }, env);

  const cycle = await runCycle({ jobId: queued.id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit() } });

  assert.deepEqual(
    cycle.processed.map((entry) => entry.status),
    ["done"],
  );
  const row = getIssue(item.id, env);
  assert.equal(row.status, "in_review");
  assert.equal(row.job_id, queued.id, "the link is history and survives a manual status change");
});

test("nightqueue queue add --issue builds the same prompt as the tool, from anywhere", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-cli");
  const elsewhere = makeDir(t, "issue-queue-cli-cwd");

  const added = spawnSync(process.execPath, [CLI, "queue", "add", "--issue", item.ref], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /issue AP-1 of `alpha` is now `in_progress`/);
  assert.equal(getJob(1, env).prompt, EXPECTED_PROMPT);
  assert.equal(getIssue(item.id, env).job_id, 1);

  const malformed = spawnSync(process.execPath, [CLI, "queue", "add", "--issue", "zero"], { env, cwd: elsewhere, encoding: "utf8" });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /expected an issue ref \(`<KEY>-<number>`\), got `zero`/);
});

test("a job built from an issue carries the operator's tier, through the tool and through the CLI", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-tier");
  const elsewhere = makeDir(t, "issue-queue-tier-cwd");
  const client = await connect(t, env);

  const queued = payloadOf(
    await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref, tier: "complex" } }),
  );
  assert.equal(queued.tier, "complex");
  assert.equal(getJob(queued.id, env).tier, "complex");
  cancelJob(queued.id, { reason: "queued again through the CLI" }, env);

  const added = spawnSync(process.execPath, [CLI, "queue", "add", "--issue", item.ref, "--tier", "complex"], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(getJob(getIssue(item.id, env).job_id, env).tier, "complex");
});

const RUN_SLUG = "hunt-the-notice";
const NOTE = "mind the slow disk; keep the lease renewal in one place";
const ITEM_END = "Commit type: refactor or perf\n\n";

// The expected prompt with `sections` placed right after the item block and before the decisions.
function promptWith(...sections) {
  return EXPECTED_PROMPT.replace(ITEM_END, () => `${ITEM_END}${sections.map((section) => `${section}\n\n`).join("")}`);
}

// An operator run of `alpha` with its triage done, and the block the runtime writes for it.
function makeOperatorRun(env) {
  const projectId = ensureProject(env, "alpha");
  recordRunFields({ projectId, slug: RUN_SLUG, fields: { origin: "operator", type: "bug/error", evidenceLevel: 3 }, env });
  recordPhaseDone({ projectId, slug: RUN_SLUG, phase: "triage", artifact: "01-triage.md", verdict: "PROCEED", env });
  const dir = runDir(projectId, RUN_SLUG, env);
  const block = ["## PRIOR RUN (operator)", `RUN_DIR: ${dir}`, "Last completed phase: triage", "Evidence level: 3", "Resume from phase: explore"].join("\n");
  return { dir, block };
}

// The `queued` comment of an item, newest last.
function queuedComments(env, item) {
  return getIssueDetail(item.id, {}, env).comments.filter((comment) => comment.kind === "queued");
}

test("queue_add from an issue with a note puts it verbatim after the item block and records it on the row and the comment", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-note");
  const client = await connect(t, env);

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref, prompt: NOTE } }));

  const job = getJob(queued.id, env);
  assert.equal(job.prompt, promptWith(`## Operator note\n${NOTE}`));
  assert.equal(job.operator_note, NOTE);
  assert.equal(job.slug, null);
  assert.equal(queuedComments(env, item)[0].body, `J-${queued.id} queued\n\n${NOTE}`);
});

test("queue_add from an issue with a run_dir binds the run and places its block right after the item block", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-run-dir");
  const { dir, block } = makeOperatorRun(env);
  const client = await connect(t, env);

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref, run_dir: dir } }));

  const job = getJob(queued.id, env);
  assert.equal(job.prompt, promptWith(block));
  assert.equal(job.slug, RUN_SLUG);
  assert.equal(job.operator_note, null);
  assert.equal(queuedComments(env, item)[0].body, `J-${queued.id} queued\n\nRun dir: ${dir}`);
});

test("queue_add from an issue with a note and a run_dir orders item, note, prior run, decisions", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-note-run-dir");
  const { dir, block } = makeOperatorRun(env);
  const client = await connect(t, env);

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref, prompt: NOTE, run_dir: dir } }));

  const job = getJob(queued.id, env);
  assert.equal(job.prompt, promptWith(`## Operator note\n${NOTE}`, block));
  assert.equal(job.slug, RUN_SLUG);
  assert.equal(job.operator_note, NOTE);
  assert.equal(queuedComments(env, item)[0].body, `J-${queued.id} queued\n\n${NOTE}\n\nRun dir: ${dir}`);
});

test("queue_add from an issue refuses a run_dir as for a free prompt, and queues nothing", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-run-dir-refusals");
  const { dir } = makeOperatorRun(env);
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: "plain-run", fields: { type: "bug/error" }, env });
  const client = await connect(t, env);
  const refuse = async (run_dir) => {
    const result = await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref, run_dir } });
    assert.equal(result.isError, true, textOf(result));
    return textOf(result);
  };

  assert.match(await refuse(join(env.NIGHTQUEUE_HOME, "elsewhere", RUN_SLUG)), /`run_dir` must be `/);
  assert.match(await refuse(runDir(ensureProject(env, "alpha"), "plain-run", env)), /is not an operator run/);
  assert.match(await refuse("runs/alpha/x"), /must be an absolute or `~\/` path/);
  assert.equal(getIssue(item.id, env).status, "todo");

  const first = payloadOf(await client.callTool({ name: "queue_add", arguments: { issue_id: item.ref, run_dir: dir } }));
  const other = saveIssue({ type: "chore", projectId: projectIdOf(env, "alpha"), title: "index the logs" }, env);
  const taken = await client.callTool({ name: "queue_add", arguments: { issue_id: other.ref, run_dir: dir } });
  assert.equal(taken.isError, true);
  assert.match(textOf(taken), new RegExp(`J-${first.id} already runs from `));
  assert.equal(getIssue(other.id, env).status, "todo");
});

test("nightqueue queue add --issue takes a note and a --run-dir", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-cli-note");
  const { dir, block } = makeOperatorRun(env);

  const added = spawnSync(process.execPath, [CLI, "queue", "add", "--issue", item.ref, "--run-dir", dir, NOTE], { env, encoding: "utf8" });

  assert.equal(added.status, 0, added.stderr);
  const job = getJob(1, env);
  assert.equal(job.prompt, promptWith(`## Operator note\n${NOTE}`, block));
  assert.equal(job.operator_note, NOTE);
  assert.equal(job.slug, RUN_SLUG);

  const alone = spawnSync(process.execPath, [CLI, "queue", "add", "--run-dir", dir, "fix it"], { env, encoding: "utf8" });
  assert.equal(alone.status, 1);
  assert.match(alone.stderr, /`--run-dir` goes with `--issue`/);
});

const RELATED_HEADING = "## Related decisions";
const STANDING_HEADING = "## Standing decisions";
const RECALLED_NON_LINKED = 5;
const FAKE_MODEL = "fake-embedder@v1";
const FAKE_VECTOR = [1, 0, 0, 0];

const LEXICAL_ONLY = {
  title: "the runner claims one job at a time",
  context: "two runners took the same job",
  decision: "claim every job under a lease",
  status: "accepted",
};

const SEMANTIC_ONLY = [
  {
    title: "cold starts pay for the model download",
    context: "the first call was slow",
    decision: "cache the model on disk",
    status: "accepted",
  },
  {
    title: "one worktree per task",
    context: "two tasks wrote the same tree",
    decision: "never share a checkout",
    status: "accepted",
  },
  {
    title: "the pull request is the only delivery",
    context: "local commits were lost",
    decision: "open a pull request at the end",
    status: "accepted",
  },
];

// How many times a heading stands alone as a line of a prompt.
function headingOccurrences(prompt, heading) {
  return prompt.split("\n").filter((line) => line === heading).length;
}

// How many decisions were rendered under `## Related decisions`, which is always the last block of the prompt.
function relatedCount(prompt) {
  const start = prompt.indexOf(RELATED_HEADING);
  if (start < 0) return 0;
  return prompt
    .slice(start + RELATED_HEADING.length)
    .split("\n")
    .filter((line) => /^D-\d+ /.test(line)).length;
}

// A home with the semantic path ON: one item, decisions its title recalls lexically, and decisions only an embedder reaches.
function makeEmbeddedHome(t, name) {
  const env = makeHome(t, name, { embed: true });
  makeProject(t, env, "alpha");
  const linked = saveDecision({ projectId: projectIdOf(env, "alpha"), ...LINKED }, env);
  saveDecision({ projectId: projectIdOf(env, "alpha"), ...RELATED }, env);
  saveDecision({ projectId: projectIdOf(env, "alpha"), ...LEXICAL_ONLY }, env);
  for (const decision of SEMANTIC_ONLY) {
    const saved = saveDecision({ projectId: projectIdOf(env, "alpha"), ...decision }, env);
    setDecisionEmbedding({ id: saved.id, vector: FAKE_VECTOR, model: FAKE_MODEL }, env);
  }
  const item = saveIssue({ type: "improvement", projectId: projectIdOf(env, "alpha"), ...ITEM, decision_id: linked.id }, env);
  return { env, item };
}

test("with an embedder enabled the prompt carries one `## Related decisions` heading and every recalled non-linked decision, up to eight", async (t) => {
  const { env, item } = makeEmbeddedHome(t, "issue-queue-embedder");
  const embedder = fakeEmbedder(FAKE_VECTOR, { model: FAKE_MODEL });

  const prompt = await buildIssuePrompt({ item: getIssue(item.id, env), embedder }, env);
  assert.ok(embedder.calls.length > 0, "the semantic path never ran, so this test would prove nothing");
  assert.equal(headingOccurrences(prompt, RELATED_HEADING), 1, prompt);
  assert.equal(headingOccurrences(prompt, STANDING_HEADING), 1, prompt);
  assert.ok(prompt.indexOf(STANDING_HEADING) < prompt.indexOf(RELATED_HEADING), prompt);
  assert.equal(relatedCount(prompt), RECALLED_NON_LINKED, `the related block must hold every recalled non-linked decision:\n${prompt}`);

  const { job } = await queueIssue({ id: item.id, embedder }, env);
  const queued = getJob(job.id, env).prompt;
  assert.equal(headingOccurrences(queued, RELATED_HEADING), 1, queued);
  assert.equal(relatedCount(queued), RECALLED_NON_LINKED, queued);
});

test("a proposed decision is listed by title under `## Proposed (not binding)`, after the standing titles and before the related ones", async (t) => {
  const { env, item } = makeIssuesHome(t, "issue-queue-proposed");
  const proposed = saveDecision(
    { projectId: projectIdOf(env, "alpha"), title: "heartbeats move to a side table", context: "still open", decision: "nothing settled yet", status: "proposed" },
    env,
  );

  const prompt = await buildIssuePrompt({ item: getIssue(item.id, env) }, env);

  const heading = "## Proposed (not binding)";
  assert.ok(prompt.includes(`${heading}\n- D-${proposed.number} heartbeats move to a side table\n\n${RELATED_HEADING}`), prompt);
  assert.ok(prompt.indexOf(STANDING_HEADING) < prompt.indexOf(heading), prompt);
  assert.equal(prompt.includes("nothing settled yet"), false, "a proposal is listed by title only");
  const standing = prompt.slice(prompt.indexOf(STANDING_HEADING), prompt.indexOf(heading));
  assert.equal(standing.includes("heartbeats move to a side table"), false, "a proposal was listed as standing");
});

// A store on a fresh home whose one issue is queued as a job through the store, the way queue_add links it.
async function linkedJob(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const store = openStore(env);
  const item = await store.issues.saveIssue({ type: "improvement", projectId: projectIdOf(env, "alpha"), title: "follow the job" });
  const { job } = await store.issues.queueIssue({ id: item.id });
  return { env, store, item, job };
}

// The status and closed_at of the item right now.
async function itemState(store, item) {
  const row = await store.issues.getIssue(item.id);
  return { status: row.status, closed: row.closed_at !== null };
}

// Claims the job and finishes it on the given status, through the store the runner uses.
async function runTo(store, job, status, { prUrl } = {}) {
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }), "setup: the job was not claimed");
  assert.equal(await store.jobs.finishJob(job.id, { worker: "w1", status, prUrl }), true, "setup: the job was not finished");
}

test("an item follows its job through gate, retry, failure, done and a delivered close", async (t) => {
  const { store, item, job } = await linkedJob(t, "issue-follow-lifecycle");
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });

  await runTo(store, job, "gate");
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });
  await store.jobs.retryJob(job.id, { note: "go on" });
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });

  await runTo(store, job, "failed");
  assert.deepEqual(await itemState(store, item), { status: "todo", closed: false });
  await store.jobs.retryJob(job.id, {});
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });

  await runTo(store, job, "done", { prUrl: PR_URL });
  assert.deepEqual(await itemState(store, item), { status: "in_review", closed: false });
  await settleThroughStore(store, job.id);
  assert.deepEqual(await itemState(store, item), { status: "done", closed: true });
  assert.equal(await store.issues.followJob(job.id), 0);
});

test("a cancelled job sends its item back to todo", async (t) => {
  const { store, item, job } = await linkedJob(t, "issue-follow-cancel");
  await store.jobs.cancelJob(job.id, { reason: "not now" });
  assert.deepEqual(await itemState(store, item), { status: "todo", closed: false });
});

test("a closed job (settleClose) closes its item as done with the merge sha", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "issue-follow-close");
  await runTo(store, job, "done", { prUrl: PR_URL });
  await settleThroughStore(store, job.id);
  assert.deepEqual(await itemState(store, item), { status: "done", closed: true });
  const closed = getIssueDetail(item.id, {}, env).comments.at(-1);
  assert.deepEqual([closed.kind, closed.refs.pr, closed.refs.sha], ["closed", PR_URL, mergedChecklist().data.mergeSha]);
});

test("a release or a park back to pending keeps the item in progress", async (t) => {
  const { store, item, job } = await linkedJob(t, "issue-follow-release");
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }));
  assert.equal(await store.jobs.releaseJob(job.id, { worker: "w1" }), true);
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }));
  assert.equal(await store.jobs.parkJob(job.id, { worker: "w1", notBefore: new Date(Date.now() + 60000).toISOString() }), true);
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });
});

test("a status written behind the store's back is picked up by the next orphan sweep", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "issue-follow-sweep");
  openDb(env).prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(job.id);
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });
  await store.jobs.sweepOrphans();
  assert.deepEqual(await itemState(store, item), { status: "todo", closed: false });
});

test("a retry of a job whose failure nobody followed still leaves the failure's comment first", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "issue-follow-unseen-retry");
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }), "setup: the job was not claimed");
  assert.equal(finishJob(job.id, { worker: "w1", status: "failed" }, env), true, "setup: the job was not finished");
  await store.jobs.retryJob(job.id, {});
  const kinds = getIssueDetail(item.id, {}, env).comments.map((comment) => comment.kind);
  assert.deepEqual(kinds, ["queued", "failed", "queued"], "the unfollowed failure lost its comment");
});

test("a close of a job whose finish nobody followed still leaves the pull request's comment first", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "issue-follow-unseen-close");
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }), "setup: the job was not claimed");
  assert.equal(finishJob(job.id, { worker: "w1", status: "done", prUrl: PR_URL }, env), true, "setup: the job was not finished");
  await settleThroughStore(store, job.id);
  assert.deepEqual(await itemState(store, item), { status: "done", closed: true });
  const kinds = getIssueDetail(item.id, {}, env).comments.map((comment) => comment.kind);
  assert.deepEqual(kinds, ["queued", "pr", "closed"], "the unfollowed finish lost its comment");
});

test("a close that cancels a job whose finish nobody followed still leaves the pull request's comment first", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "issue-follow-unseen-cancel");
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }), "setup: the job was not claimed");
  assert.equal(finishJob(job.id, { worker: "w1", status: "done", prUrl: PR_URL }, env), true, "setup: the job was not finished");
  assert.ok(await store.jobs.acquireClose(job.id, { worker: "close-w", leaseS: 600 }), "setup: the close lease was refused");
  const close = { attempts: 1, steps: {}, data: { prNumber: 7, merged: false } };
  assert.ok(await store.jobs.cancelOnClosedPr(job.id, { worker: "close-w", close, note: "closed without merge" }), "setup: the cancel was refused");
  assert.deepEqual(await itemState(store, item), { status: "todo", closed: false });
  const kinds = getIssueDetail(item.id, {}, env).comments.map((comment) => comment.kind);
  assert.deepEqual(kinds, ["queued", "pr", "failed"], "the unfollowed finish lost its comment");
});
