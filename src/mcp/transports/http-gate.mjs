import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { UserError } from "../../config/errors.mjs";
import { createServer } from "../tools.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// Answers a request with a JSON body, the only shape an HTTP caller ever sees.
export function respond(res, status, message) {
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
export function isLoopbackOrigin(origin) {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// Compares two secrets in constant time; a length mismatch is a plain refusal.
function secretMatches(given, token) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Compares an `Authorization` header against the expected bearer token in constant time.
export function tokenMatches(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return secretMatches(header.slice("Bearer ".length), token);
}

// The path of a request, or null when the target is not a path this server could serve.
export function requestPath(url) {
  try {
    return new URL(url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
}

// Answers one POST with a fresh stateless server bound to its own transport, both disposed with the response.
export async function serveMcp(req, res, env) {
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
export function rawHeaderValues(req, name) {
  const raw = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  const values = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === name) values.push(String(raw[i + 1]));
  }
  return values;
}

// Why the loopback gate refuses this request, or null when it lets it through; a repeated gate header is a refusal.
export function loopbackRefusal(req) {
  const origins = rawHeaderValues(req, "origin");
  const hosts = rawHeaderValues(req, "host");
  if (origins.length > 1 || (origins.length === 1 && !isLoopbackOrigin(origins[0]))) return "origin not allowed";
  if (hosts.length !== 1 || !isLoopbackAuthority(hosts[0])) return "host not allowed";
  return null;
}

// The values one cookie name carries across every `Cookie` header of the request, in wire order.
function cookieValues(req, name) {
  const values = [];
  for (const header of rawHeaderValues(req, "cookie")) {
    for (const pair of header.split(";")) {
      const cut = pair.indexOf("=");
      if (cut > 0 && pair.slice(0, cut).trim() === name) values.push(pair.slice(cut + 1).trim());
    }
  }
  return values;
}

// Tells whether the request carries exactly one cookie of that name holding the token, compared in constant time.
export function cookieTokenMatches(req, name, token) {
  const values = cookieValues(req, name);
  return values.length === 1 && secretMatches(values[0], token);
}

// Tells whether the request carries exactly one `Origin` header and it is one of the allowed origins, port included.
export function originIsExactly(req, allowedOrigins) {
  const origins = rawHeaderValues(req, "origin");
  return origins.length === 1 && allowedOrigins.includes(origins[0]);
}

// Answers a failed request without leaking a stack, or drops the socket when the headers already went out.
export function failRequest(res, err) {
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  respond(res, 500, err?.message ?? String(err));
}

// Binds the listener and resolves the port it got, turning a busy or forbidden port into a user error.
export function listenOn(server, port, host) {
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

// Stops the listener on SIGINT and SIGTERM, dropping open connections so the loop drains; answers the function that drops both handlers.
export function stopOnSignal(close) {
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return () => {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  };
}
