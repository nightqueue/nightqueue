import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { UserError } from "../../config/errors.mjs";
import { startMaintenance, stopMaintenance } from "../../queue/maintenance.mjs";
import { createServer } from "../tools.mjs";

export const DEFAULT_HTTP_PORT = 4747;
const MCP_PATH = "/mcp";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// Answers a request with a JSON body, the only shape an HTTP caller ever sees.
function respond(res, status, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

// Tells whether a hostname names the loopback interface, IPv6 brackets and a trailing dot aside.
function isLoopbackHostname(hostname) {
  const bare = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  return LOOPBACK_HOSTS.has(bare);
}

// Tells whether a `host[:port]` authority, IPv6 bracketed or raw included, points at loopback.
function isLoopbackAuthority(authority) {
  if (typeof authority !== "string" || authority === "") return false;
  if (authority.startsWith("[")) return isLoopbackHostname(authority.slice(0, authority.indexOf("]") + 1));
  const parts = authority.split(":");
  return isLoopbackHostname(parts.length > 2 ? authority : parts[0]);
}

// Tells whether an `Origin` header resolves to loopback; a malformed one is a refusal, not an error.
function isLoopbackOrigin(origin) {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// Compares an `Authorization` header against the expected bearer token in constant time.
function tokenMatches(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The path of a request, or null when the target is not a path this server could serve.
function requestPath(url) {
  try {
    return new URL(url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
}

// Answers one POST with a fresh stateless server bound to its own transport, both disposed with the response.
async function serveMcp(req, res, env) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createServer(env);
  res.on("close", () => {
    Promise.resolve(transport.close()).catch(() => {});
    Promise.resolve(server.close()).catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

// Every value the raw header block carries for one header name, in wire order and never merged.
function rawHeaderValues(req, name) {
  const raw = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  const values = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === name) values.push(String(raw[i + 1]));
  }
  return values;
}

// Why the loopback gate refuses this request, or null when it lets it through; a repeated gate header is a refusal.
function loopbackRefusal(req) {
  const origins = rawHeaderValues(req, "origin");
  const hosts = rawHeaderValues(req, "host");
  if (origins.length > 1 || (origins.length === 1 && !isLoopbackOrigin(origins[0]))) return "origin not allowed";
  if (hosts.length !== 1 || !isLoopbackAuthority(hosts[0])) return "host not allowed";
  return null;
}

// Serves one request behind the loopback gate, the token gate and the endpoint gate, in that order.
async function handleMcpRequest(req, res, { env, token }) {
  const refusal = loopbackRefusal(req);
  if (refusal) return respond(res, 403, refusal);
  if (!tokenMatches(req.headers.authorization, token)) return respond(res, 401, "missing or invalid bearer token");
  if (requestPath(req.url) !== MCP_PATH) return respond(res, 404, `unknown path; the MCP endpoint is ${MCP_PATH}`);
  if (req.method !== "POST") return respond(res, 405, "the MCP endpoint only accepts POST");
  await serveMcp(req, res, env);
}

// Answers a failed request without leaking a stack, or drops the socket when the headers already went out.
function failRequest(res, err) {
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  respond(res, 500, err?.message ?? String(err));
}

// Binds the listener and resolves the port it got, turning a busy or forbidden port into a user error.
function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListening);
      if (err?.code === "EADDRINUSE") {
        reject(new UserError(`port ${port} is already in use; pass \`--port <n>\` to serve on another one`));
        return;
      }
      if (err?.code === "EACCES") {
        reject(new UserError(`port ${port} cannot be bound by this user; pass \`--port <n>\` to serve on another one`));
        return;
      }
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

// Stops the listener on SIGINT and SIGTERM, dropping open connections so the loop drains.
function stopOnSignal(close) {
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

// Starts the loopback Streamable HTTP listener, and the one maintenance timer of this process, resolving only once it is accepting requests.
export async function startHttpServer({ env = process.env, port = DEFAULT_HTTP_PORT, token, host = "127.0.0.1" }) {
  if (typeof token !== "string" || token === "") throw new UserError("the http transport needs a token to serve with");
  const server = createHttpServer((req, res) => {
    handleMcpRequest(req, res, { env, token }).catch((err) => failRequest(res, err));
  });
  const boundPort = await listenOn(server, port, host);
  startMaintenance(env);
  const close = () => {
    stopMaintenance(env);
    server.close();
    server.closeAllConnections();
  };
  stopOnSignal(close);
  return { url: `http://${host}:${boundPort}${MCP_PATH}`, port: boundPort, close };
}
