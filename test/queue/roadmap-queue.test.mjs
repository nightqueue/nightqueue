import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveDecision, setDecisionEmbedding } from "../../src/memory/decisions.mjs";
import { cancelJob, getJob } from "../../src/memory/jobs.mjs";
import {
  buildRoadmapPrompt,
  getRoadmapItem,
  markRoadmapItemDone,
  queueRoadmapItem,
  saveRoadmapItem,
  updateRoadmapItem,
} from "../../src/memory/roadmap.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { fakeEmbedder, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));

const LINKED = {
  title: "the heartbeat is renewed by the owner only",
  context: "two runners renewed the same lease",
  decision: "renew the lease only from the worker that owns it",
  consequences: "a lost lease kills the child",
};

const RELATED = {
  title: "heartbeat interval is configuration, never a constant",
  context: "a slow disk timed the lease out",
  decision: "read the heartbeat interval from the configuration",
};

const ITEM = { horizon: "now", title: "rewrite runner heartbeat", detail: "the renew path must survive a slow disk" };

const EXPECTED_PROMPT = `## Task
rewrite runner heartbeat

the renew path must survive a slow disk

## Linked decision
#1 the heartbeat is renewed by the owner only (accepted)
Context: two runners renewed the same lease
Decision: renew the lease only from the worker that owns it
Consequences: a lost lease kills the child

## Related decisions
#2 heartbeat interval is configuration, never a constant (accepted)
Context: a slow disk timed the lease out
Decision: read the heartbeat interval from the configuration`;

// Connects a real stdio client to `nightshift mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightshift-tests", version: "0.0.0" });
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

// A home with the registered project, the linked decision, the related one and one roadmap item joining them.
function makeRoadmapHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const linked = saveDecision({ project: "alpha", ...LINKED }, env);
  saveDecision({ project: "alpha", ...RELATED }, env);
  const item = saveRoadmapItem({ project: "alpha", ...ITEM, decision_id: linked.id }, env);
  return { env, item };
}

test("queue_add from a roadmap item builds the prompt of the item and links the two", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-prompt");
  const client = await connect(t, env);

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, prompt: null } }));
  assert.equal(queued.ok, true);
  assert.equal(queued.project, "alpha");
  assert.equal(queued.roadmapItemId, item.id);
  assert.equal(getJob(queued.id, env).prompt, EXPECTED_PROMPT);

  const row = getRoadmapItem(item.id, env);
  assert.equal(row.status, "queued");
  assert.equal(row.job_id, queued.id);
});

test("an item with no detail and no linked decision queues the task alone", async (t) => {
  const env = makeHome(t, "roadmap-queue-bare");
  makeProject(t, env, "alpha");
  const item = saveRoadmapItem({ project: "alpha", horizon: "next", title: "index the logs" }, env);
  const client = await connect(t, env);

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } }));
  assert.equal(getJob(queued.id, env).prompt, "## Task\nindex the logs");
});

test("queue_add refuses two prompt sources, none at all, and a project that is not the item's", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-refusals");
  makeProject(t, env, "beta");
  const client = await connect(t, env);

  const both = await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, prompt: "fix the worker" } });
  assert.equal(both.isError, true);
  assert.match(textOf(both), /pass either `prompt` or `roadmap_item_id`, never both/);

  const neither = await client.callTool({ name: "queue_add", arguments: { project: "alpha" } });
  assert.equal(neither.isError, true);
  assert.match(textOf(neither), /queue_add needs `prompt`, or `roadmap_item_id` to build it from a roadmap item/);

  const foreign = await client.callTool({ name: "queue_add", arguments: { project: "beta", roadmap_item_id: item.id } });
  assert.equal(foreign.isError, true);
  assert.match(textOf(foreign), /belongs to project `alpha`, not `beta`/);

  const unknown = await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: 404 } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown roadmap item `404`/);
  assert.equal(getRoadmapItem(item.id, env).status, "open");
});

test("a queued item is refused a second job while the first is alive, and accepted once it is cancelled", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-live-job");
  const client = await connect(t, env);

  const first = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } }));
  const refused = await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), new RegExp(`already queued as job \`${first.id}\` \\(\`pending\`\\)`));

  cancelJob(first.id, { reason: "no longer needed" }, env);
  const second = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } }));
  assert.notEqual(second.id, first.id);
  assert.equal(getRoadmapItem(item.id, env).job_id, second.id);
});

test("a job that ends done closes its own roadmap item, and leaves every other one alone", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-done-hook");
  useFakeClaude(env, makeDir(t, "roadmap-queue-done-plan"), [{ stdout: doneStream(), exitCode: 0 }]);
  const untouched = saveRoadmapItem({ project: "alpha", horizon: "later", title: "index the logs" }, env);
  const client = await connect(t, env);
  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } }));

  const cycle = await runCycle({ jobId: queued.id, env, deps: { gitImpl: fakeGit() } });

  assert.deepEqual(
    cycle.processed.map((entry) => entry.status),
    ["done"],
  );
  assert.equal(getRoadmapItem(item.id, env).status, "done");
  assert.equal(getRoadmapItem(untouched.id, env).status, "open");
  assert.equal(markRoadmapItemDone(queued.id, env), 0, "a second finish flipped an item that was already done");
});

test("a job that ends done never reopens an item the operator dropped, and the link survives as history", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-dropped-item");
  useFakeClaude(env, makeDir(t, "roadmap-queue-dropped-plan"), [{ stdout: doneStream(), exitCode: 0 }]);
  const client = await connect(t, env);
  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } }));
  updateRoadmapItem(item.id, { status: "dropped" }, env);

  const cycle = await runCycle({ jobId: queued.id, env, deps: { gitImpl: fakeGit() } });

  assert.deepEqual(
    cycle.processed.map((entry) => entry.status),
    ["done"],
  );
  const row = getRoadmapItem(item.id, env);
  assert.equal(row.status, "dropped");
  assert.equal(row.job_id, queued.id, "the link is history and survives a manual status change");
});

test("nightshift queue add --roadmap builds the same prompt as the tool, from anywhere", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-cli");
  const elsewhere = makeDir(t, "roadmap-queue-cli-cwd");

  const added = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", String(item.id)], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /roadmap item #1 of `alpha` is now `queued`/);
  assert.equal(getJob(1, env).prompt, EXPECTED_PROMPT);
  assert.equal(getRoadmapItem(item.id, env).job_id, 1);

  const both = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", "1", "fix", "the", "worker"], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /pass either `prompt` or `roadmap_item_id`, never both/);

  const malformed = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", "zero"], { env, cwd: elsewhere, encoding: "utf8" });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /`--roadmap` expects a positive integer, got `zero`/);
});

test("a job built from a roadmap item carries the operator's tier, through the tool and through the CLI", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-tier");
  const elsewhere = makeDir(t, "roadmap-queue-tier-cwd");
  const client = await connect(t, env);

  const queued = payloadOf(
    await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, tier: "complex" } }),
  );
  assert.equal(queued.tier, "complex");
  assert.equal(getJob(queued.id, env).tier, "complex");
  cancelJob(queued.id, { reason: "queued again through the CLI" }, env);

  const added = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", String(item.id), "--tier", "complex"], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(getJob(getRoadmapItem(item.id, env).job_id, env).tier, "complex");
});

const RELATED_HEADING = "## Related decisions";
const FAKE_MODEL = "fake-embedder@v1";
const FAKE_VECTOR = [1, 0, 0, 0];

const LEXICAL_ONLY = {
  title: "the runner claims one job at a time",
  context: "two runners took the same job",
  decision: "claim every job under a lease",
};

const SEMANTIC_ONLY = [
  { title: "cold starts pay for the model download", context: "the first call was slow", decision: "cache the model on disk" },
  { title: "one worktree per task", context: "two tasks wrote the same tree", decision: "never share a checkout" },
  { title: "the pull request is the only delivery", context: "local commits were lost", decision: "open a pull request at the end" },
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
    .filter((line) => /^#\d+ /.test(line)).length;
}

// A home with the semantic path ON: one item, decisions its title recalls lexically, and decisions only an embedder reaches.
function makeEmbeddedHome(t, name) {
  const env = makeHome(t, name, { embed: true });
  makeProject(t, env, "alpha");
  const linked = saveDecision({ project: "alpha", ...LINKED }, env);
  saveDecision({ project: "alpha", ...RELATED }, env);
  saveDecision({ project: "alpha", ...LEXICAL_ONLY }, env);
  for (const decision of SEMANTIC_ONLY) {
    const saved = saveDecision({ project: "alpha", ...decision }, env);
    setDecisionEmbedding({ id: saved.id, vector: FAKE_VECTOR, model: FAKE_MODEL }, env);
  }
  const item = saveRoadmapItem({ project: "alpha", ...ITEM, decision_id: linked.id }, env);
  return { env, item };
}

test("with an embedder enabled the prompt still carries one `## Related decisions` heading and three decisions under it", async (t) => {
  const { env, item } = makeEmbeddedHome(t, "roadmap-queue-embedder");
  const embedder = fakeEmbedder(FAKE_VECTOR, { model: FAKE_MODEL });

  const prompt = await buildRoadmapPrompt({ item: getRoadmapItem(item.id, env), embedder }, env);
  assert.ok(embedder.calls.length > 0, "the semantic path never ran, so this test would prove nothing");
  assert.equal(headingOccurrences(prompt, RELATED_HEADING), 1, prompt);
  assert.equal(relatedCount(prompt), 3, `the related block must hold three decisions, whichever they are:\n${prompt}`);

  const { job } = await queueRoadmapItem({ id: item.id, embedder }, env);
  const queued = getJob(job.id, env).prompt;
  assert.equal(headingOccurrences(queued, RELATED_HEADING), 1, queued);
  assert.equal(relatedCount(queued), 3, queued);
});
