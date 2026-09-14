import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { dbPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// These tests guard the READ PATH of a long-lived follow: every poll reads on a connection opened for that
// poll alone. They cannot reproduce the `-shm` split that makes a long-held connection actually answer stale
// - neither the triage nor the plan could force it on demand; the evidence for it is production (jobs
// #15/#12/#7/#11). What is provable here, and is what the fix changes, is that the process-wide cached
// connection is no longer the one the view reads through.

const QUEUE_SRC = fileURLToPath(new URL("../../src/cli/queue.mjs", import.meta.url));
const MCP_SRC = fileURLToPath(new URL("../../src/mcp/server.mjs", import.meta.url));
const PR_URL = "https://github.com/acme/api/pull/7";

// Runs `queue status --follow --until-idle` in this process with an injected sleep, exactly the entry point an operator watches.
async function runFollow(env, onTick) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { isTTY: false, columns: 200, write: () => {} },
    sleep: async () => await onTick(),
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  const code = await run(["queue", "status", "--follow", "--until-idle"], ctx);
  return { code, out, err };
}

// The snapshots a piped follow printed, one entry per redraw: on a pipe each one is closed by an empty line.
function snapshots(out) {
  const groups = [];
  let current = [];
  for (const line of out) {
    if (line !== "") {
      current.push(line);
      continue;
    }
    groups.push(current.join("\n"));
    current = [];
  }
  if (current.length) groups.push(current.join("\n"));
  return groups;
}

// Writes the rows through a connection of its own, the way the runner process would: never the one this process has cached.
function writeThroughOwnConnection(env, statements) {
  const db = new DatabaseSync(dbPath(env));
  try {
    for (const [sql, ...values] of statements) db.prepare(sql).run(...values);
  } finally {
    db.close();
  }
}

test("a job finished by another connection between two polls renders done, with its pull request, in the later snapshot", async (t) => {
  const env = makeHome(t, "follow-fresh-read-done");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);

  let ticks = 0;
  const result = await runFollow(env, () => {
    ticks += 1;
    if (ticks !== 1) return;
    writeThroughOwnConnection(env, [
      [
        "UPDATE jobs SET status = 'done', pr_url = ?, finished_at = ?, worker = NULL, lease_until = NULL WHERE id = ?",
        PR_URL,
        "2026-01-01 00:00:00",
        id,
      ],
    ]);
  });

  assert.equal(result.code, 0, result.err.join("\n"));
  const views = snapshots(result.out);
  assert.ok(views.length >= 2, `the follow redrew only ${views.length} time(s); it never polled after the other connection's write`);
  assert.match(views[0], /running/, "the first poll did not render the claimed job as running");
  const last = views.at(-1);
  assert.match(last, /done/, "the follow kept rendering the pre-write row after another connection finished the job");
  assert.ok(last.includes(PR_URL), `the later snapshot carries no pull request URL: ${last}`);
});

test("a job marked merged by another connection during a running follow renders merged in a later snapshot", async (t) => {
  const env = makeHome(t, "follow-fresh-read-merged");
  makeProject(t, env, "alpha");
  const delivered = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(delivered, { worker: "host:1", cap: 4 }, env);
  finishJob(delivered, { worker: "host:1", status: "done", prUrl: PR_URL }, env);
  const waiting = addJob({ project: "alpha", prompt: "write the changelog" }, env).id;

  let ticks = 0;
  const result = await runFollow(env, () => {
    ticks += 1;
    if (ticks !== 1) return;
    writeThroughOwnConnection(env, [
      ["UPDATE jobs SET status = 'merged', merged_at = ?, pr_checked_at = ? WHERE id = ?", "2026-01-01 00:00:00", "2026-01-01 00:00:00", delivered],
      ["UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?", "2026-01-01 00:00:00", waiting],
    ]);
  });

  assert.equal(result.code, 0, result.err.join("\n"));
  const views = snapshots(result.out);
  assert.ok(views.length >= 2, `the follow redrew only ${views.length} time(s); it never polled after the other connection's write`);
  assert.match(views[0], /merged=0/, "the first poll already counted a merged job; the transition this test asserts never happened inside the session");
  assert.match(views.at(-1), /merged=1/, "the follow never rendered the merge another connection wrote mid-session");
  assert.match(views.at(-1), new RegExp(`#${delivered}\\s+\\S+ merged`), `the row of job #${delivered} is not rendered as merged: ${views.at(-1)}`);
});

test("no poll of a follow session prepares the queue view's statements on the process-wide cached connection", async (t) => {
  const env = makeHome(t, "follow-fresh-read-spy");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  finishJob(id, { worker: "host:1", status: "done", prUrl: PR_URL }, env);

  const cached = openDb(env);
  const original = cached.prepare.bind(cached);
  const seen = [];
  cached.prepare = (sql) => {
    seen.push(sql);
    return original(sql);
  };
  t.after(() => {
    delete cached.prepare;
  });
  original("SELECT 1").get();
  assert.deepEqual(seen, [], "the control statement went through the original method; the spy below would never see anything");
  cached.prepare("SELECT 1").get();
  assert.deepEqual(seen, ["SELECT 1"], "the spy does not shadow `prepare` on this build; this test cannot prove anything");
  seen.length = 0;

  const result = await runFollow(env, () => {});
  assert.equal(result.code, 0, result.err.join("\n"));
  assert.ok(snapshots(result.out).length >= 1, "the follow never rendered the queue at all");

  const leaked = seen.filter((sql) => /FROM jobs/.test(sql));
  assert.deepEqual(leaked, [], `the follow read the jobs table on the process-wide cached connection instead of a fresh one per poll: ${leaked.join(" | ")}`);
});

// The source of one function of a file, sliced so a pin cannot drift onto an unrelated function of the same file.
function functionSource(path, header) {
  const text = readFileSync(path, "utf8");
  const start = text.indexOf(header);
  assert.ok(start >= 0, `\`${header}\` moved or was renamed; update this pin`);
  const ends = ["\nfunction ", "\nasync function "].map((token) => text.indexOf(token, start + 1)).filter((index) => index >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) : text.length);
}

// The definition of the `queue_status` tool, from its name to the name of the tool declared after it.
function queueStatusToolSource() {
  const text = readFileSync(MCP_SRC, "utf8");
  const start = text.indexOf('name: "queue_status"');
  assert.ok(start >= 0, "the `queue_status` tool moved or was renamed; update this pin");
  const end = text.indexOf('name: "queue_run"', start + 1);
  assert.ok(end >= 0, "the tool declared after `queue_status` moved; update this pin");
  return text.slice(start, end);
}

test("every long-lived reader takes its store from withReadOnlyStore, never from the process-wide cached one", () => {
  const cases = [
    ["followStatus", functionSource(QUEUE_SRC, "async function followStatus")],
    ["jobStatusReader", functionSource(QUEUE_SRC, "function jobStatusReader")],
    ["the MCP queue_status handler", queueStatusToolSource()],
  ];
  for (const [name, source] of cases) {
    assert.match(
      source,
      /withReadOnlyStore\(/,
      `${name} polls for the life of its process; reading through \`openStore(env)\` puts every one of its reads back on the one connection cached for that whole life`,
    );
  }
});
