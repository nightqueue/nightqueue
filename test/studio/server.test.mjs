import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startStudioServer } from "../../src/studio/server.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { jobLogPath } from "../../src/config/paths.mjs";
import { attemptMarker, toolResultEvent, toolUseEvent } from "../../test-support/streams.mjs";
import { ensureProject, makeHome } from "../../test-support/memory.mjs";
import { APP_JS, INDEX_HTML, makeDist, send, sendRaw, startStudio, STUDIO_TOKEN, studioCookie } from "../../test-support/studio.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));

const GATED_REQUESTS = [
  { method: "GET", path: "/" },
  { method: "GET", path: "/assets/app.js" },
  { method: "GET", path: "/api/info" },
  { method: "GET", path: "/api/jobs/J-1/diffstat" },
  { method: "GET", path: "/api/jobs/J-1/recalls" },
  { method: "GET", path: "/events" },
  { method: "POST", path: "/mcp", headers: { "content-type": "application/json" }, body: "{}" },
];

// Connects an SDK client to the studio's `/mcp` with the given extra headers, closed when the test ends.
async function connectMcp(t, origin, headers) {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: "studio-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

test("every request without the token is refused, pages, assets, the API, the streams and MCP alike", async (t) => {
  const env = makeHome(t, "studio-no-token");
  const { port } = await startStudio(t, env);
  for (const request of GATED_REQUESTS) {
    const answer = await send(port, request);
    assert.equal(answer.status, 401, `${request.method} ${request.path} answered ${answer.status}`);
    assert.equal(answer.headers["access-control-allow-origin"], undefined);
  }
});

test("a foreign Origin is refused on every path, even with a valid cookie", async (t) => {
  const env = makeHome(t, "studio-foreign-origin");
  const { port } = await startStudio(t, env);
  for (const request of GATED_REQUESTS) {
    const headers = { ...request.headers, origin: "http://evil.example", cookie: studioCookie(port) };
    const answer = await send(port, { ...request, headers });
    assert.equal(answer.status, 403, `${request.method} ${request.path} answered ${answer.status}`);
  }
});

test("a repeated Origin or Host header is refused before anything else", async (t) => {
  const env = makeHome(t, "studio-repeated-headers");
  const { port } = await startStudio(t, env);
  const cookie = `Cookie: ${studioCookie(port)}`;
  const origin = `Origin: http://127.0.0.1:${port}`;
  assert.equal(await sendRaw(port, ["GET /api/info HTTP/1.1", `Host: 127.0.0.1:${port}`, origin, origin, cookie, "Connection: close"]), 403);
  assert.equal(await sendRaw(port, ["GET /api/info HTTP/1.1", `Host: 127.0.0.1:${port}`, `Host: 127.0.0.1:${port}`, cookie, "Connection: close"]), 403);
  assert.equal(await sendRaw(port, ["GET /api/info HTTP/1.1", `Host: 127.0.0.1:${port}`, cookie, "Connection: close"]), 200);
});

test("the printed token is exchanged once for an HttpOnly per-port cookie and a redirect that drops it", async (t) => {
  const env = makeHome(t, "studio-exchange");
  const studio = await startStudio(t, env);
  assert.equal(studio.url, `http://127.0.0.1:${studio.port}/?t=${STUDIO_TOKEN}`);
  const good = await send(studio.port, { path: `/jobs/J-3?t=${STUDIO_TOKEN}&x=1` });
  assert.equal(good.status, 303);
  assert.equal(good.headers.location, "/jobs/J-3?x=1");
  const cookie = good.headers["set-cookie"]?.[0] ?? "";
  assert.ok(cookie.startsWith(`nq_studio_${studio.port}=${STUDIO_TOKEN};`), cookie);
  for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/"]) assert.ok(cookie.includes(attribute), `${attribute} missing from ${cookie}`);
  const bad = await send(studio.port, { path: "/?t=not-the-token" });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers["set-cookie"], undefined);
});

test("cookie-authorised reads are served with the CSP and nosniff headers", async (t) => {
  const env = makeHome(t, "studio-cookie-reads");
  const { port } = await startStudio(t, env);
  const headers = { cookie: studioCookie(port) };
  const page = await send(port, { path: "/", headers });
  assert.equal(page.status, 200);
  assert.equal(page.body, INDEX_HTML);
  assert.equal(page.headers["cache-control"], "no-store");
  const asset = await send(port, { path: "/assets/app.js", headers });
  assert.equal(asset.status, 200);
  assert.equal(asset.body, APP_JS);
  assert.match(asset.headers["cache-control"], /immutable/);
  const info = await send(port, { path: "/api/info", headers });
  assert.equal(info.status, 200);
  const body = JSON.parse(info.body);
  assert.equal(body.mcp, `http://127.0.0.1:${port}/mcp`);
  assert.equal(body.queue_paused, false);
  for (const answer of [page, asset, info]) {
    assert.match(answer.headers["content-security-policy"], /default-src 'self'/);
    assert.equal(answer.headers["x-content-type-options"], "nosniff");
  }
});

test("the favicon and the web manifest are served with their own types, behind the cookie", async (t) => {
  const env = makeHome(t, "studio-icons");
  const distDir = makeDist(t);
  writeFileSync(`${distDir}/favicon.ico`, Buffer.from([0, 0, 1, 0]));
  writeFileSync(`${distDir}/site.webmanifest`, "{}");
  const { port } = await startStudio(t, env, { distDir });
  const headers = { cookie: studioCookie(port) };
  const icon = await send(port, { path: "/favicon.ico", headers });
  assert.equal(icon.status, 200);
  assert.equal(icon.headers["content-type"], "image/x-icon");
  const manifest = await send(port, { path: "/site.webmanifest", headers });
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers["content-type"], "application/manifest+json");
  assert.equal((await send(port, { path: "/favicon.ico" })).status, 401);
});

test("a cookie write needs the studio's exact origin, port included, and then MCP works through the SDK client", async (t) => {
  const env = makeHome(t, "studio-cookie-writes");
  const { port, origin } = await startStudio(t, env);
  const cookie = studioCookie(port);
  const write = { method: "POST", path: "/mcp", body: "{}", headers: { "content-type": "application/json", cookie } };
  assert.equal((await send(port, write)).status, 403, "a cookie POST without Origin got through");
  assert.equal((await send(port, { ...write, headers: { ...write.headers, origin: `http://127.0.0.1:${port + 1}` } })).status, 403, "a page on another loopback port drove a write");
  const client = await connectMcp(t, origin, { cookie, origin });
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "queue_status"), "the studio MCP lists no queue_status");
});

test("a bearer client keeps working on /mcp, as with `mcp --http`", async (t) => {
  const env = makeHome(t, "studio-bearer");
  const { origin } = await startStudio(t, env);
  const client = await connectMcp(t, origin, { authorization: `Bearer ${STUDIO_TOKEN}` });
  const result = await client.callTool({ name: "queue_status", arguments: {} });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
});

test("a path that climbs out of the dist is never served", async (t) => {
  const env = makeHome(t, "studio-traversal");
  const { port } = await startStudio(t, env);
  const headers = { cookie: studioCookie(port) };
  for (const path of ["/assets/../../package.json", "/%2e%2e/%2e%2e/package.json", "/..%2fsrc/cli/index.mjs", "/assets/%2e%2e%2f%2e%2e%2fpackage.json"]) {
    const answer = await send(port, { path, headers });
    assert.equal(answer.status, 404, `${path} answered ${answer.status}: ${answer.body.slice(0, 80)}`);
  }
});

test("a page navigation the dist has no file for gets index.html, so a deep link loads the app", async (t) => {
  const env = makeHome(t, "studio-spa");
  const { port } = await startStudio(t, env);
  const answer = await send(port, { path: "/jobs/J-1", headers: { cookie: studioCookie(port), accept: "text/html" } });
  assert.equal(answer.status, 200);
  assert.equal(answer.body, INDEX_HTML);
  const missing = await send(port, { path: "/jobs/J-1", headers: { cookie: studioCookie(port), accept: "application/json" } });
  assert.equal(missing.status, 404);
});

test("the API-only mode serves no page, still answers the API, and is the only mode that honours a dev origin", async (t) => {
  const env = makeHome(t, "studio-api-only");
  const devOrigin = "http://127.0.0.1:5173";
  await assert.rejects(startStudioServer({ env, port: 0, token: STUDIO_TOKEN, distDir: makeDist(t), devOrigin }), /API-only/);
  const { port } = await startStudio(t, env, { apiOnly: true, devOrigin });
  const cookie = studioCookie(port);
  assert.equal((await send(port, { path: "/", headers: { cookie, accept: "text/html" } })).status, 404);
  assert.equal((await send(port, { path: "/api/info", headers: { cookie } })).status, 200);
  const write = { method: "POST", path: "/api/nothing-here", body: "{}", headers: { "content-type": "application/json", cookie, origin: devOrigin } };
  assert.equal((await send(port, write)).status, 404, "the dev origin was not let through the write rule");
  assert.equal((await send(port, { ...write, headers: { ...write.headers, origin: "http://127.0.0.1:5174" } })).status, 403);
});

test("two studios on two ports never accept each other's cookie", async (t) => {
  const env = makeHome(t, "studio-two-ports");
  const first = await startStudio(t, env);
  const second = await startStudio(t, env);
  assert.equal((await send(second.port, { path: "/api/info", headers: { cookie: studioCookie(first.port) } })).status, 401);
  assert.equal((await send(second.port, { path: "/api/info", headers: { cookie: studioCookie(second.port) } })).status, 200);
});

test("the API refuses a write body that is not JSON, and an unknown job log is a 404", async (t) => {
  const env = makeHome(t, "studio-api-errors");
  const { port, origin } = await startStudio(t, env);
  const headers = { cookie: studioCookie(port), origin };
  const plain = await send(port, { method: "POST", path: "/api/runners/start", body: "mode=watch", headers: { ...headers, "content-type": "text/plain" } });
  assert.equal(plain.status, 400);
  const drain = await send(port, { method: "POST", path: "/api/runners/start", body: JSON.stringify({ mode: "drain" }), headers: { ...headers, "content-type": "application/json" } });
  assert.equal(drain.status, 400);
  assert.match(JSON.parse(drain.body).error, /queue_run/);
  assert.equal((await send(port, { path: "/api/jobs/J-999/log", headers })).status, 404);
  assert.equal((await send(port, { path: "/api/jobs/nope/log", headers })).status, 400);
  assert.equal((await send(port, { path: "/api/jobs/J-999/diffstat", headers })).status, 404);
  assert.equal((await send(port, { path: "/api/jobs/nope/diffstat", headers })).status, 400);
  assert.equal((await send(port, { path: "/api/jobs/J-999/recalls", headers })).status, 404);
  assert.equal((await send(port, { path: "/api/jobs/nope/recalls", headers })).status, 400);
});

test("the recalls of a job read its whole log, and a job with no log answers no groups", async (t) => {
  const env = makeHome(t, "studio-api-recalls");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  const { port } = await startStudio(t, env);
  const headers = { cookie: studioCookie(port) };
  const empty = await send(port, { path: `/api/jobs/J-${id}/recalls`, headers });
  assert.deepEqual([empty.status, JSON.parse(empty.body)], [200, { groups: [] }]);
  const call = toolUseEvent({ name: "mcp__nightqueue__lesson_recall", id: "r1", input: { query: "worker" } });
  const answer = toolResultEvent({ toolUseId: "r1", content: [{ type: "text", text: JSON.stringify([{ id: 5, title: "Guard it" }]) }] });
  mkdirSync(dirname(jobLogPath(id, env)), { recursive: true });
  writeFileSync(jobLogPath(id, env), [attemptMarker(1), JSON.stringify(call), attemptMarker(2), JSON.stringify(answer)].join("\n"));
  const full = JSON.parse((await send(port, { path: `/api/jobs/J-${id}/recalls`, headers })).body);
  assert.equal(full.groups[0].agent, "orchestrator");
  assert.deepEqual(full.groups[0].recalls[0].results, [{ ref: "L5", title: "Guard it" }]);
});

test("the diffstat of a job with no worktree and no recorded files answers none", async (t) => {
  const env = makeHome(t, "studio-api-diffstat");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  const { port } = await startStudio(t, env);
  const answer = await send(port, { path: `/api/jobs/J-${id}/diffstat`, headers: { cookie: studioCookie(port) } });
  assert.equal(answer.status, 200);
  const body = JSON.parse(answer.body);
  assert.deepEqual([body.source, body.files, body.totals], ["none", [], null]);
});

// Spawns `nightqueue studio` on an ephemeral port in a temporary home and resolves the URL it printed.
function spawnStudio(t, env, args) {
  const child = spawn(process.execPath, [CLI, "studio", "--port", "0", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const listening = out.match(/^studio listening on (\S+)$/m);
      if (listening) resolve(listening[1]);
    });
    child.once("exit", (code) => reject(new Error(`studio exited with ${code} before listening:\n${err}${out}`)));
  });
}

test("`nightqueue studio` prints its tokenized URL, and that URL is the way in", async (t) => {
  const env = makeHome(t, "studio-cli");
  const printed = new URL(await spawnStudio(t, env, ["--api-only", "--token", "cli-token"]));
  assert.equal(printed.hostname, "127.0.0.1");
  assert.equal(printed.searchParams.get("t"), "cli-token");
  const port = Number(printed.port);
  const exchange = await send(port, { path: `${printed.pathname}${printed.search}` });
  assert.equal(exchange.status, 303);
  const cookie = exchange.headers["set-cookie"][0].split(";")[0];
  assert.equal((await send(port, { path: "/api/info", headers: { cookie } })).status, 200);
  assert.equal((await send(port, { path: "/api/info" })).status, 401);
});

test("pause and resume flip the queue-wide sentinel the info route reports", async (t) => {
  const env = makeHome(t, "studio-pause");
  const { port, origin } = await startStudio(t, env);
  const headers = { cookie: studioCookie(port), origin, "content-type": "application/json" };
  assert.deepEqual(JSON.parse((await send(port, { method: "POST", path: "/api/queue/pause", body: "{}", headers })).body), { queue_paused: true });
  assert.equal(JSON.parse((await send(port, { path: "/api/info", headers })).body).queue_paused, true);
  assert.deepEqual(JSON.parse((await send(port, { method: "POST", path: "/api/queue/resume", body: "{}", headers })).body), { queue_paused: false });
  assert.equal(JSON.parse((await send(port, { path: "/api/info", headers })).body).queue_paused, false);
});

test("a page opened on `localhost` writes with its exact origin, and another port of either name stays refused", async (t) => {
  const env = makeHome(t, "studio-localhost-origin");
  const { port } = await startStudio(t, env);
  const write = (origin) => send(port, { method: "POST", path: "/api/queue/pause", body: "{}", headers: { "content-type": "application/json", cookie: studioCookie(port), host: `localhost:${port}`, origin } });
  assert.equal((await write(`http://localhost:${port}`)).status, 200, "the localhost page of this port was refused");
  assert.equal((await write(`http://localhost:${port + 1}`)).status, 403, "a localhost page on another port drove a write");
  assert.equal((await write(`http://127.0.0.1:${port + 1}`)).status, 403, "a 127.0.0.1 page on another port drove a write");
});

test("a runner start whose `from`, `until` or `interval_s` has the wrong type is a 400 that spawns nothing", async (t) => {
  const env = { ...makeHome(t, "studio-runner-types"), NIGHTQUEUE_CLAUDE_BIN: "/usr/bin/false" };
  const { port, origin } = await startStudio(t, env);
  const headers = { cookie: studioCookie(port), origin, "content-type": "application/json" };
  const bodies = [
    { mode: "watch", from: ["09:00"], until: ["09:00"] },
    { mode: "watch", from: "09:00", until: 900 },
    { mode: "watch", until: { at: "10:00" } },
    { mode: "watch", interval_s: "30" },
    { mode: "watch", interval_s: [30] },
  ];
  for (const body of bodies) {
    const answer = await send(port, { method: "POST", path: "/api/runners/start", body: JSON.stringify(body), headers });
    assert.equal(answer.status, 400, `${JSON.stringify(body)} answered ${answer.status}: ${answer.body}`);
  }
});
