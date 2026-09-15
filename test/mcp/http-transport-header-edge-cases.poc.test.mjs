import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeHome } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));
const TEST_TOKEN = "s3cret-token";

// Spawns `nightshift mcp --http` on an ephemeral port and resolves once it is listening.
function startHttp(t, env) {
  const child = spawn(process.execPath, [CLI, "mcp", "--http", "--port", "0", "--token", TEST_TOKEN], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
      const listening = out.match(/^mcp http listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp$/m);
      if (listening) resolve({ child, port: Number(listening[1]) });
    });
    child.once("exit", (code) => reject(new Error(`the http server exited with ${code} before listening:\n${err}${out}`)));
  });
}

// Writes an HTTP/1.1 request by hand over a raw socket (no header normalization) and resolves the raw response text.
function rawRequest(port, headLines, body = "") {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(headLines.join("\r\n") + "\r\n\r\n" + body);
    });
    let data = "";
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`the socket hung for 5s waiting a response; got so far:\n${data}`));
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(data));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
  });
}

// Status line of a raw HTTP/1.1 response, e.g. 403 out of "HTTP/1.1 403 Forbidden".
function statusOf(rawResponse) {
  const match = rawResponse.match(/^HTTP\/1\.\d (\d+)/);
  assert.ok(match, `not a well-formed HTTP response (server hung, crashed the connection, or sent garbage):\n${rawResponse}`);
  return Number(match[1]);
}

// The server must never treat this variant as authorized: no 200 (the MCP transport was never reached) and no 500 (no crash).
function assertNeverAuthorizedNorCrashed(rawResponse, label) {
  const status = statusOf(rawResponse);
  assert.notEqual(status, 200, `${label}: the request reached the MCP transport (200) instead of being refused:\n${rawResponse}`);
  assert.notEqual(status, 500, `${label}: the server crashed answering this variant instead of refusing it cleanly:\n${rawResponse}`);
}

test("H-A1: two Origin header lines (loopback + foreign, both orders) are refused, never 200, never 500", async (t) => {
  const env = makeHome(t, "mcp-http-edge-origin-dup");
  const { port } = await startHttp(t, env);
  const body = "{}";
  const headers = (extra) => [
    "POST /mcp HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    ...extra,
    `Authorization: Bearer ${TEST_TOKEN}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
  ];

  const loopbackFirst = await rawRequest(port, headers([`Origin: http://127.0.0.1:${port}`, "Origin: http://evil.example"]), body);
  assertNeverAuthorizedNorCrashed(loopbackFirst, "loopback-origin-first");
  assert.equal(statusOf(loopbackFirst), 403, `expected a clean 403 origin refusal:\n${loopbackFirst}`);

  const foreignFirst = await rawRequest(port, headers(["Origin: http://evil.example", `Origin: http://127.0.0.1:${port}`]), body);
  assertNeverAuthorizedNorCrashed(foreignFirst, "foreign-origin-first");
  assert.equal(statusOf(foreignFirst), 403, `expected a clean 403 origin refusal:\n${foreignFirst}`);
});

test("H-A2: two Host header lines (foreign + loopback, both orders) are refused, never 200, never 500", async (t) => {
  const env = makeHome(t, "mcp-http-edge-host-dup");
  const { port } = await startHttp(t, env);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "attacker", version: "0.0.0" } },
  });
  const headers = (hostLines) => [
    "POST /mcp HTTP/1.1",
    ...hostLines,
    `Authorization: Bearer ${TEST_TOKEN}`,
    "Content-Type: application/json",
    "Accept: application/json, text/event-stream",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
  ];

  const foreignFirst = await rawRequest(port, headers(["Host: evil.example", `Host: 127.0.0.1:${port}`]), body);
  assertNeverAuthorizedNorCrashed(foreignFirst, "foreign-host-first");

  const loopbackFirst = await rawRequest(port, headers([`Host: 127.0.0.1:${port}`, "Host: evil.example"]), body);
  assertNeverAuthorizedNorCrashed(loopbackFirst, "loopback-host-first");
});

test("H-A3: a request with no Host header at all never reaches the MCP transport, never crashes, never hangs", async (t) => {
  const env = makeHome(t, "mcp-http-edge-host-missing");
  const { port } = await startHttp(t, env);
  const body = "{}";
  const response = await rawRequest(
    port,
    ["POST /mcp HTTP/1.1", `Authorization: Bearer ${TEST_TOKEN}`, "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close"],
    body,
  );
  assertNeverAuthorizedNorCrashed(response, "no-host-header");
});

test("H-A4: a syntactically invalid Origin is refused with a clean 403, never a 500", async (t) => {
  const env = makeHome(t, "mcp-http-edge-origin-invalid");
  const { port } = await startHttp(t, env);
  const body = "{}";
  const response = await rawRequest(
    port,
    [
      "POST /mcp HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Origin: http://[bad",
      `Authorization: Bearer ${TEST_TOKEN}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
    ],
    body,
  );
  assertNeverAuthorizedNorCrashed(response, "invalid-origin");
  assert.equal(statusOf(response), 403, `expected a clean 403 origin refusal, not a crash from an unhandled URL parse error:\n${response}`);
});
