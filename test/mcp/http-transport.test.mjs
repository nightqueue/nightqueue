import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createServer } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const TEST_TOKEN = "s3cret-token";

const LESSON = {
  title: "the worker leaks a file descriptor on failure",
  root_cause: "the early return skipped the close",
  solution: "close it in a finally block",
  prevention: "always close the file descriptor in a finally block",
  attempts: 2,
};

// Connects a real stdio client to `nightqueue mcp`, closed at the end of the test.
async function connectStdio(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// Spawns `nightqueue mcp --http` on an ephemeral port and resolves what it printed once it is listening.
function startHttp(t, env, { token = TEST_TOKEN, port = "0", withToken = true } = {}) {
  const args = [CLI, "mcp", "--http", "--port", port, ...(withToken ? ["--token", token] : [])];
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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
      const listening = out.match(/^mcp http listening on (\S+)$/m);
      if (listening) resolve({ child, url: listening[1], token: out.match(/^mcp http token: (\S+)$/m)?.[1], stdout: out });
    });
    child.once("exit", (code) => reject(new Error(`the http server exited with ${code} before listening:\n${err}${out}`)));
  });
}

// Connects a real Streamable HTTP client to a started server, closed at the end of the test.
async function connectHttp(t, url, token) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// POSTs an empty body to the endpoint with the given headers and answers the status code.
function post(url, headers) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port: target.port, path: target.pathname, method: "POST", headers },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// JSON payload of a successful tool result.
function payloadOf(result) {
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result));
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// Names of a tool list, sorted, never counted against a hardcoded number.
function sortedNames(tools) {
  return tools.map((tool) => tool.name).sort();
}

test("the same call returns the same payload over stdio and over http", async (t) => {
  const env = makeHome(t, "mcp-http-parity");
  makeProject(t, env, "alpha");
  const stdio = await connectStdio(t, env);
  const saved = payloadOf(await stdio.callTool({ name: "lesson_save", arguments: { ...LESSON, project: "alpha" } }));
  assert.equal(saved.ok, true);

  const { url } = await startHttp(t, env);
  const http = await connectHttp(t, url, TEST_TOKEN);

  const call = { name: "lesson_recall", arguments: { project: "alpha" } };
  const fromStdio = payloadOf(await stdio.callTool(call));
  const fromHttp = payloadOf(await http.callTool(call));

  assert.ok(Array.isArray(fromHttp) && fromHttp.length > 0, `the http recall came back empty: ${JSON.stringify(fromHttp)}`);
  assert.equal(fromHttp[0].title, LESSON.title, "the http side did not read the lesson written over stdio");
  assert.deepEqual(fromStdio, fromHttp);
});

test("both transports expose the same tool surface", async (t) => {
  const env = makeHome(t, "mcp-http-tools");
  const stdio = await connectStdio(t, env);
  const { url } = await startHttp(t, env);
  const http = await connectHttp(t, url, TEST_TOKEN);

  const names = sortedNames((await http.listTools()).tools);
  assert.ok(names.length > 0, "the http server listed no tool");
  assert.deepEqual(sortedNames((await stdio.listTools()).tools), names);
});

test("a request without a valid bearer token is refused", async (t) => {
  const env = makeHome(t, "mcp-http-token");
  const { url } = await startHttp(t, env);

  assert.equal(await post(url, {}), 401);
  assert.equal(await post(url, { authorization: `Bearer ${TEST_TOKEN}x` }), 401);
  assert.equal(await post(url, { authorization: TEST_TOKEN }), 401);
});

test("a foreign origin or a foreign host is refused, a loopback one is not", async (t) => {
  const env = makeHome(t, "mcp-http-origin");
  const { url } = await startHttp(t, env);
  const authorized = { authorization: `Bearer ${TEST_TOKEN}` };

  assert.equal(await post(url, { ...authorized, origin: "http://evil.example" }), 403);
  assert.equal(await post(url, { ...authorized, host: "evil.example" }), 403);
  assert.notEqual(await post(url, { ...authorized, origin: "http://127.0.0.1:1234" }), 403);
  assert.notEqual(await post(url, authorized), 403);
});

test("a loopback host written in another legitimate spelling is not refused", async (t) => {
  const env = makeHome(t, "mcp-http-host-spellings");
  const { url } = await startHttp(t, env);
  const authorized = { authorization: `Bearer ${TEST_TOKEN}` };

  for (const host of ["::1", "[::1]:1234", "localhost.:1234", "LOCALHOST"]) {
    assert.notEqual(await post(url, { ...authorized, host }), 403, `\`Host: ${host}\` is a local caller and was refused`);
  }
  for (const origin of ["http://[::1]:1234", "http://localhost./"]) {
    assert.notEqual(await post(url, { ...authorized, origin }), 403, `\`Origin: ${origin}\` is a local caller and was refused`);
  }
});

test("with no token given the server generates one, prints it and serves with it", async (t) => {
  const env = makeHome(t, "mcp-http-generated");
  const generated = await startHttp(t, env, { withToken: false });
  assert.ok(generated.token, `no token line was printed:\n${generated.stdout}`);

  const client = await connectHttp(t, generated.url, generated.token);
  assert.ok((await client.listTools()).tools.length > 0);
  assert.equal(await post(generated.url, {}), 401);

  const given = await startHttp(t, env);
  assert.equal(given.token, undefined, `a token given on the command line was printed back:\n${given.stdout}`);
});

test("a port already in use fails loudly, naming the port", async (t) => {
  const env = makeHome(t, "mcp-http-busy");
  const busy = createServer();
  t.after(() => busy.close());
  busy.listen(0, "127.0.0.1");
  await once(busy, "listening");
  const port = String(busy.address().port);

  const result = spawnSync(process.execPath, [CLI, "mcp", "--http", "--port", port, "--token", TEST_TOKEN], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`port ${port} is already in use`));
});

test("SIGTERM stops the server with exit code 0 and frees the port", async (t) => {
  const env = makeHome(t, "mcp-http-signal");
  const { child, url } = await startHttp(t, env);

  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  await assert.rejects(post(url, { authorization: `Bearer ${TEST_TOKEN}` }));
});

test("`--port` and `--token` are refused without `--http`", async (t) => {
  const env = makeHome(t, "mcp-http-flags");
  const result = spawnSync(process.execPath, [CLI, "mcp", "--port", "4747"], { env, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /only apply with `--http`/);
});
