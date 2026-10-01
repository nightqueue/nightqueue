import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb } from "../../src/memory/db.mjs";
import { getDecision, saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { setOrgKey, setProjectKey } from "../../src/memory/registry.mjs";
import { getIssue, getIssueDetail, saveIssue } from "../../src/memory/issues.mjs";
import { ensureProject, makeHome, makeProject, orgIdOf, projectIdOf, seedDoneJob } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));

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

// Calls a tool that must be refused, and answers its message.
async function refusalOf(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} was not refused: ${textOf(result)}`);
  return textOf(result);
}

// A decision of an owner, with only the text every decision needs.
function decision(owner, title) {
  return { ...owner, title, context: `context of ${title}`, decision: `decision of ${title}`, status: "accepted" };
}

// A home with alpha (AP) and beta (BT) in org acme (AM), each owner holding decisions and items, then alpha renamed to NQ and acme to AC.
function makeRefsHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha", { org: "acme" });
  makeProject(t, env, "beta", { org: "acme" });
  const alpha = { projectId: projectIdOf(env, "alpha") };
  const beta = { projectId: projectIdOf(env, "beta") };
  const acme = { orgId: orgIdOf(env, "acme") };
  saveDecision(decision(alpha, "alpha pins sqlite"), env);
  saveDecision(decision(alpha, "alpha logs as json"), env);
  saveDecision(decision(beta, "beta ships weekly"), env);
  saveDecision(decision(acme, "every repo runs one node"), env);
  const rows = {
    alphaItem: saveIssue({ type: "bug", ...alpha, title: "alpha crashes" }, env),
    betaItem: saveIssue({ type: "bug", ...beta, title: "beta crashes" }, env),
    orgItem: saveIssue({ type: "chore", ...acme, title: "raise node" }, env),
    globalItem: saveIssue({ type: "chore", projectId: null, title: "a global chore" }, env),
  };
  const db = openDb(env);
  setProjectKey(db, { id: alpha.projectId, key: "NQ" });
  setOrgKey(db, { id: acme.orgId, key: "AC" });
  return { env, ...rows };
}

test("the item tools take a ref, old key included, and refuse an integer or an unknown ref", async (t) => {
  const { env, alphaItem, orgItem, globalItem } = makeRefsHome(t, "mcp-refs-items");
  const client = await connect(t, env);

  assert.deepEqual([alphaItem.ref, orgItem.ref, globalItem.ref], ["AP-1", "AM-1", "G-1"]);
  for (const ref of ["NQ-1", "AP-1", "nq-1", " AP-1 "]) {
    const detail = payloadOf(await client.callTool({ name: "issue_get", arguments: { id: ref } }));
    assert.equal(detail.ref, "NQ-1", ref);
    assert.equal(detail.id, alphaItem.id, ref);
  }
  assert.equal(payloadOf(await client.callTool({ name: "issue_get", arguments: { id: "AM-1" } })).ref, "AC-1");
  assert.equal(payloadOf(await client.callTool({ name: "issue_get", arguments: { id: "G-1" } })).id, globalItem.id);

  assert.match(await refusalOf(client, "issue_get", { id: alphaItem.id }), /^your client has the tool definitions of an older nightqueue \(contract 2, this server is 3\)/);
  assert.match(await refusalOf(client, "issue_get", { id: "D-1" }), /expected an issue ref/);
  assert.match(await refusalOf(client, "issue_get", { id: "J-1" }), /expected an issue ref/);
  assert.match(await refusalOf(client, "issue_get", { id: "NQ-9" }), /unknown issue `NQ-9`/);
  assert.match(await refusalOf(client, "issue_get", { id: "ZZ-1" }), /unknown issue `ZZ-1`/);

  const comment = payloadOf(await client.callTool({ name: "issue_comment", arguments: { id: "AP-1", body: "seen" } }));
  assert.equal(comment.comment.body, "seen");
  assert.match(await refusalOf(client, "issue_comment", { id: 1, body: "x" }), /older nightqueue/);

  const updated = payloadOf(await client.callTool({ name: "issue_update", arguments: { id: "AP-1", decision_id: "D-2" } }));
  assert.deepEqual([updated.item.ref, updated.item.decision_ref], ["NQ-1", "D-2"]);
  assert.match(await refusalOf(client, "issue_update", { id: 1, status: "cancelled" }), /older nightqueue/);
  assert.match(await refusalOf(client, "issue_update", { id: "NQ-1", decision_id: 2 }), /older nightqueue/);
  assert.match(await refusalOf(client, "issue_update", { id: "AC-1", decision_id: "D-1" }), /`D-1` names a decision of a project: pass the project, or write it `<KEY>\/D-1`/);
  const orgLinked = payloadOf(await client.callTool({ name: "issue_update", arguments: { id: "AC-1", decision_id: "AM/D-1" } }));
  assert.equal(orgLinked.item.decision_ref, "AC/D-1");
  assert.equal(getIssue(orgItem.id, env).decision_id, 4);

  const saved = payloadOf(
    await client.callTool({ name: "issue_save", arguments: { project: "alpha", type: "feature", title: "cache it", decision_id: "AP/D-1" } }),
  );
  assert.equal(saved.ref, "NQ-2");
  assert.equal(getIssue(saved.id, env).decision_id, 1);
  assert.match(
    await refusalOf(client, "issue_save", { project: "alpha", type: "feature", title: "x", decision_id: "BT/D-1" }),
    /belongs to project `beta`, not project `alpha`/,
  );

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { issue_id: "AP-1" } }));
  assert.equal(queued.issue_ref, "NQ-1");
  assert.equal(queued.issueId, alphaItem.id);
  assert.match(await refusalOf(client, "queue_add", { issue_id: 2 }), /older nightqueue/);
});

test("decision_update takes a decision ref: `D-<n>` needs a project, `<KEY>/D-<n>` names its owner, old keys resolve", async (t) => {
  const { env } = makeRefsHome(t, "mcp-refs-decisions");
  const client = await connect(t, env);

  assert.match(
    await refusalOf(client, "decision_update", { id: "D-1", status: "rejected" }),
    /`D-1` names a decision of a project: pass the project, or write it `<KEY>\/D-1`/,
  );
  assert.match(await refusalOf(client, "decision_update", { id: 1, status: "rejected" }), /older nightqueue/);
  assert.match(await refusalOf(client, "decision_update", { id: "NQ-1", status: "rejected" }), /expected a decision ref/);
  assert.match(await refusalOf(client, "decision_update", { id: "NQ/D-9", status: "rejected" }), /unknown decision `NQ\/D-9`/);

  const named = payloadOf(await client.callTool({ name: "decision_update", arguments: { id: "D-1", project: "alpha", title: "alpha pins sqlite 3" } }));
  assert.deepEqual([named.decision.ref, named.decision.title], ["D-1", "alpha pins sqlite 3"]);
  const alias = payloadOf(await client.callTool({ name: "decision_update", arguments: { id: "AP/D-1", status: "superseded", superseded_by: "D-2" } }));
  assert.equal(alias.decision.status, "superseded");
  assert.equal(getDecision(1, env).superseded_by, 2);
  const org = payloadOf(await client.callTool({ name: "decision_update", arguments: { id: "AM/D-1", title: "every repo runs node 24" } }));
  assert.deepEqual([org.decision.ref, org.decision.scope], ["AC/D-1", "org"]);
  assert.match(
    await refusalOf(client, "decision_update", { id: "BT/D-1", status: "superseded", superseded_by: "NQ/D-2" }),
    /belongs to project `alpha`, not project `beta`/,
  );
});

test("decision_save names candidates by number or by a ref of the same owner, and refuses a ref of another owner", async (t) => {
  const { env } = makeRefsHome(t, "mcp-refs-decision-save");
  const client = await connect(t, env);
  const base = { project: "alpha", title: "alpha keeps one worker", context: "c", decision: "d", status: "proposed" };

  assert.match(await refusalOf(client, "decision_save", { ...base, unrelated: ["AC/D-1"] }), /`AC\/D-1` is not a decision of project `alpha`/);
  assert.match(await refusalOf(client, "decision_save", { ...base, unrelated: ["D-7"] }), /unknown decision `D-7`/);
  const saved = payloadOf(await client.callTool({ name: "decision_save", arguments: { ...base, unrelated: ["D-1", "NQ/D-2"] } }));
  assert.equal(saved.ref, "D-3");
  const orgSaved = payloadOf(
    await client.callTool({ name: "decision_save", arguments: { org: "acme", title: "acme tags releases", context: "c", decision: "d", unrelated: ["AM/D-1", 1] } }),
  );
  assert.equal(orgSaved.ref, "AC/D-2");
});

test("the job tools take a job ref or a plain id, and refuse anything else", async (t) => {
  const env = makeHome(t, "mcp-refs-jobs");
  const job = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env);
  const client = await connect(t, env);

  assert.equal(payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: `J-${job.id}` } })).job.id, job.id);
  assert.equal(payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: `j-${job.id}` } })).job.id, job.id);
  assert.equal(payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: job.id } })).job.id, job.id);
  assert.match(await refusalOf(client, "queue_status", { job_id: "AP-1" }), /expected a job ref \(`J-<id>`\) or a job id, got `AP-1`/);
  assert.match(await refusalOf(client, "queue_run", { job_id: "soon" }), /expected a job ref/);
  assert.match(await refusalOf(client, "queue_session", { job_id: "D-1" }), /expected a job ref/);
  assert.match(await refusalOf(client, "queue_close", { job_id: `J-${job.id}` }), new RegExp(`J-${job.id}|pending`));

  const cancelled = payloadOf(await client.callTool({ name: "queue_cancel", arguments: { job_id: `J-${job.id}`, reason: "later" } }));
  assert.equal(cancelled.job.status, "cancelled");
  const retried = payloadOf(await client.callTool({ name: "queue_retry", arguments: { job_id: `J-${job.id}` } }));
  assert.equal(retried.job.status, "pending");
  assert.equal(getJob(job.id, env).status, "pending");
});

test("queue_status finds a job by the pull request it opened: one, none, several, a foreign URL", async (t) => {
  const env = makeHome(t, "mcp-refs-pr-url");
  const one = seedDoneJob(env, { prUrl: "https://github.com/Acme/api/pull/7" });
  seedDoneJob(env, { prUrl: "https://github.com/acme/api/pull/77" });
  seedDoneJob(env, { prUrl: "https://github.com/acme/web/pull/7" });
  const twins = [seedDoneJob(env, { prUrl: "https://github.com/acme/api/pull/9" }), seedDoneJob(env, { prUrl: "https://github.com/acme/api/pull/9/" })];
  const client = await connect(t, env);

  for (const url of ["https://github.com/Acme/api/pull/7", "https://github.com/acme/api/pull/7/files/", "https://github.com/ACME/API/pull/7#x"]) {
    assert.equal(payloadOf(await client.callTool({ name: "queue_status", arguments: { pr_url: url } })).job.id, one, url);
  }
  assert.match(
    await refusalOf(client, "queue_status", { pr_url: "https://github.com/acme/api/pull/9" }),
    new RegExp(`\`https://github.com/acme/api/pull/9\` was opened by more than one job: J-${twins[0]}, J-${twins[1]}; pass one of them`),
  );
  assert.match(await refusalOf(client, "queue_status", { pr_url: "https://github.com/acme/api/pull/8" }), /no job opened `https:\/\/github.com\/acme\/api\/pull\/8`/);
  assert.match(await refusalOf(client, "queue_status", { pr_url: "https://gitlab.com/acme/api/-/merge_requests/7" }), /not a GitHub pull request URL/);
  assert.match(await refusalOf(client, "queue_status", { pr_url: "https://github.com/acme/api/pull/7", job_id: one }), /pass either `job_id` or `pr_url`, never both/);
});

test("inside a job a ref resolves to the same row as before, so another project's item or decision is still refused", async (t) => {
  const { env, betaItem } = makeRefsHome(t, "mcp-refs-visibility");
  const job = addJob({ projectId: projectIdOf(env, "alpha"), prompt: "fix alpha" }, env);
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  assert.match(
    await refusalOf(client, "issue_update", { id: "BT-1", status: "cancelled" }),
    new RegExp(`refusing to update issue \`BT-1\` from inside job \`${job.id}\`: it belongs to project \`beta\``),
  );
  assert.equal(getIssue(betaItem.id, env).status, "todo", "the refused update reached beta's item");
  assert.match(await refusalOf(client, "issue_comment", { id: "BT-1", body: "leak" }), /belongs to project `beta`, not project `alpha`/);
  assert.equal(getIssueDetail(betaItem.id, {}, env).comments.length, 0, "the refused comment was written");
  assert.match(await refusalOf(client, "decision_update", { id: "BT/D-1", status: "rejected" }), /refusing to update decision `BT\/D-1`/);
  assert.equal(getDecision(3, env).status, "accepted", "the refused update reached beta's decision");
  assert.match(await refusalOf(client, "decision_update", { id: "AC/D-1", status: "rejected" }), /it belongs to org `acme`/);

  const own = payloadOf(await client.callTool({ name: "decision_update", arguments: { id: "D-1", status: "rejected" } }));
  assert.deepEqual([own.decision.ref, own.decision.status, own.decision.owner], ["D-1", "rejected", "alpha"]);
  const ownItem = payloadOf(await client.callTool({ name: "issue_update", arguments: { id: "AP-1", status: "cancelled" } }));
  assert.equal(ownItem.item.status, "cancelled");
});
