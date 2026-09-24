import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeHome } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const TEST_TOKEN = "s3cret-token";

// Spawns `nightqueue mcp --http` on an ephemeral port and resolves once it printed the listening line.
function startHttp(t, env) {
  const args = [CLI, "mcp", "--http", "--port", "0", "--token", TEST_TOKEN];
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
      if (listening) resolve({ child, url: listening[1] });
    });
    child.once("exit", (code) => reject(new Error(`the http server exited with ${code} before listening:\n${err}${out}`)));
  });
}

// Opens a raw socket, writes a valid-header/truncated-body POST, then destroys it as soon as the bytes are queued,
// without waiting for the server's reaction — this is what maximizes overlap with an in-flight `server.connect()`.
function abruptDisconnect(host, port) {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port }, () => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      const truncated = body.slice(0, Math.max(1, Math.floor(body.length / 2)));
      const head =
        `POST /mcp HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Origin: http://${host}\r\n` +
        `Authorization: Bearer ${TEST_TOKEN}\r\n` +
        `Content-Type: application/json\r\n` +
        `Accept: application/json, text/event-stream\r\n` +
        `Content-Length: ${body.length * 100}\r\n` +
        `\r\n` +
        truncated;
      socket.write(head);
      socket.destroy();
      resolve();
    });
    socket.on("error", () => {});
  });
}

// A fresh, well-formed request through the real MCP client, proving the server still answers normally.
async function freshRequestStillWorks(t, url) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
  });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  return tools.tools;
}

test("an abrupt client disconnect mid-request never crashes the server, and a fresh request still gets a normal answer", async (t) => {
  const env = makeHome(t, "mcp-http-abrupt-disconnect");
  const { child, url } = await startHttp(t, env);
  const target = new URL(url);

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let exited = false;
  let exitCode = null;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  // Three concurrent bursts of abrupt disconnects, each burst racing several sockets against the same
  // in-flight window, since a single sequential attempt could miss the narrow race by pure timing luck.
  for (let burst = 0; burst < 3; burst++) {
    await Promise.all(Array.from({ length: 8 }, () => abruptDisconnect(target.hostname, target.port)));
  }

  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(
    exited,
    false,
    `the server process exited (code ${exitCode}) after abrupt disconnects, it should still be running. stderr:\n${stderr}`,
  );
  assert.equal(child.exitCode, null, `the child process reports an exit code; it should still be alive. stderr:\n${stderr}`);

  const tools = await freshRequestStillWorks(t, url);
  assert.ok(Array.isArray(tools) && tools.length > 0, "a fresh request right after the disconnects did not get a normal tool list");
});
