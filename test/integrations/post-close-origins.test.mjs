import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetOrigin, originStep } from "../../src/integrations/post-close.mjs";
import { withProviders } from "../../src/integrations/registry.mjs";

const ORG = "org-1";
const KINDS = ["alpha", "beta", "gamma"];

// A provider whose close action calls one URL per origin and answers done on 2xx, warning otherwise.
function closingProvider(kind) {
  return {
    kind,
    connection: { cardinality: "one", secretFields: ["token"], extraFields: [], secretLabel: "token", test: async () => ({ ok: true }) },
    capabilities: { post: true, read: false, resolve: true },
    origin: { parse: () => null },
    onClosed: async ({ ref, http }) => {
      const answer = await http(`https://svc.example/${kind}/${ref}`, { method: "POST" });
      return answer.ok ? { status: "done", note: `closed ${ref}` } : { status: "warning", note: `refused (${answer.detail})` };
    },
  };
}

// A fake fetch recording every URL, answering the status a URL part maps to, 200 otherwise; a `throw` status throws.
function fakeFetch(statuses = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const status = Object.entries(statuses).find(([part]) => url.includes(part))?.[1] ?? 200;
    if (status === "throw") throw new Error("socket hang up secret-token");
    return { status, headers: new Map(), json: async () => ({}), text: async () => "" };
  };
  return { impl, calls };
}

// The close deps: the fetch and an org binding one connection per kind.
function depsWith(fetch, kinds = KINDS) {
  const config = { orgConnections: { [ORG]: Object.fromEntries(kinds.map((kind) => [kind, `${kind}-conn`])) } };
  const secrets = { connections: Object.fromEntries(kinds.map((kind) => [`${kind}-conn`, { type: kind, token: "secret-token" }])) };
  return { fetch: fetch.impl, integrations: { config: () => config, secrets: () => secrets } };
}

// A post-close context for the given origins and stored checklist data.
function ctxWith(origins, { data = {}, remainingMs = () => 60000 } = {}) {
  return {
    jobId: 1,
    jobRef: "J-1",
    origins,
    data,
    orgId: ORG,
    integrations: Object.fromEntries(KINDS.map((kind) => [kind, { enabled: true }])),
    signal: new AbortController().signal,
    remainingMs,
  };
}

const STORED = [
  { kind: "gamma", ref: "g1" },
  { kind: "alpha", ref: "a1" },
  { kind: "beta", ref: "b1" },
];

// Runs a function with the three closing providers registered in alpha, beta, gamma order.
function withThree(fn) {
  return withProviders(KINDS.map(closingProvider), fn);
}

test("every origin is closed once in registry order, each marked notified under `<kind> <ref>`", async () => {
  await withThree(async () => {
    const fetch = fakeFetch();
    const result = await originStep({ ctx: ctxWith(STORED), deps: depsWith(fetch) });
    assert.deepEqual(fetch.calls, ["https://svc.example/alpha/a1", "https://svc.example/beta/b1", "https://svc.example/gamma/g1"]);
    assert.equal(result.status, "done");
    assert.deepEqual(result.data.originsNotified, { "alpha a1": true, "beta b1": true, "gamma g1": true });
    assert.deepEqual(
      result.lines.map((line) => line.note),
      ["alpha a1: closed a1", "beta b1: closed b1", "gamma g1: closed g1"],
    );
  });
});

test("one origin refusing or throwing is a warning of its own line; the others stay notified and a re-run calls only the failed one", async () => {
  for (const status of [404, "throw"]) {
    await withThree(async () => {
      const fetch = fakeFetch({ "/gamma/": status });
      const first = await originStep({ ctx: ctxWith(STORED), deps: depsWith(fetch) });
      assert.equal(first.status, "warning", String(status));
      assert.deepEqual(first.data.originsNotified, { "alpha a1": true, "beta b1": true }, String(status));
      assert.deepEqual(first.lines.map((line) => line.status), ["done", "done", "warning"], String(status));
      assert.ok(first.lines[2].note.startsWith("gamma g1: "), first.lines[2].note);
      assert.ok(!JSON.stringify(first).includes("secret-token"), "no secret or error text leaks");

      const retry = fakeFetch();
      const second = await originStep({ ctx: ctxWith(STORED, { data: { ...first.data } }), deps: depsWith(retry) });
      assert.deepEqual(retry.calls, ["https://svc.example/gamma/g1"]);
      assert.equal(second.status, "done");
      assert.deepEqual(second.lines.map((line) => line.note), ["alpha a1: already notified", "beta b1: already notified", "gamma g1: closed g1"]);

      const idle = fakeFetch();
      await originStep({ ctx: ctxWith(STORED, { data: { ...second.data } }), deps: depsWith(idle) });
      assert.equal(idle.calls.length, 0, "a re-close of every done origin makes no request");
    });
  }
});

test("no origin is a silent skip with no request; a single origin answers as before with its line", async () => {
  await withThree(async () => {
    const fetch = fakeFetch();
    assert.deepEqual(await originStep({ ctx: ctxWith([]), deps: depsWith(fetch) }), { status: "skipped", note: "no origin" });
    const single = await originStep({ ctx: ctxWith([{ kind: "beta", ref: "b9" }]), deps: depsWith(fetch) });
    assert.equal(single.status, "done");
    assert.equal(single.note, "beta b9: closed b9");
    assert.deepEqual(fetch.calls, ["https://svc.example/beta/b9"]);
  });
});

test("an origin without a connection is a noticed skip and never blocks the next origin", async () => {
  await withThree(async () => {
    const fetch = fakeFetch();
    const result = await originStep({ ctx: ctxWith(STORED), deps: depsWith(fetch, ["alpha", "gamma"]) });
    assert.deepEqual(result.lines.map((line) => [line.status, line.notice]), [["done", false], ["skipped", true], ["done", false]]);
    assert.equal(result.status, "done");
    assert.equal(result.notice, true);
    assert.deepEqual(fetch.calls, ["https://svc.example/alpha/a1", "https://svc.example/gamma/g1"]);
  });
});

test("an origin reached inside the budget reserve is not attempted, and the earlier ones stay recorded", async () => {
  await withThree(async () => {
    const fetch = fakeFetch();
    const remaining = [60000, 2000, 1000];
    const remainingMs = () => remaining[Math.min(fetch.calls.length, remaining.length - 1)];
    const result = await originStep({ ctx: ctxWith(STORED, { remainingMs }), deps: depsWith(fetch) });
    assert.deepEqual(fetch.calls, ["https://svc.example/alpha/a1"]);
    assert.deepEqual(result.data.originsNotified, { "alpha a1": true });
    assert.equal(result.status, "warning");
    assert.equal(result.lines[1].note, "beta b1: not attempted, the post-close budget ran out");
  });
});

test("forgetOrigin clears every origin's mark and progress", () => {
  const data = { originsNotified: { "alpha a1": true }, originsProgress: { "beta b1": { sent: true } }, logged: { alpha: true } };
  forgetOrigin(data);
  assert.deepEqual(data, { logged: { alpha: true } });
});
