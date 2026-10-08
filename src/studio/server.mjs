import { createServer as createHttpServer } from "node:http";
import { UserError } from "../config/errors.mjs";
import { failRequest, isLoopbackOrigin, listenOn, loopbackRefusal, originIsExactly, requestPath, respond, serveMcp, stopOnSignal } from "../mcp/transports/http-gate.mjs";
import { checkSchemaOrWarn } from "../mcp/transports/startup-store.mjs";
import { startMaintenance, stopMaintenance } from "../queue/maintenance.mjs";
import { ensureStoreExists } from "../store/open.mjs";
import { serveApi } from "./api.mjs";
import { authorise, exchangeToken, mutationRefusal } from "./auth.mjs";
import { createQueueStream, streamJob } from "./events.mjs";
import { serveStatic } from "./static.mjs";
import { createTerminalManager } from "./terminal.mjs";
import { acceptUpgrade, handshakeRefusal, refuseUpgrade } from "./websocket.mjs";

export const DEFAULT_STUDIO_PORT = 4747;
const TOKEN_SHAPE = /^[A-Za-z0-9._~-]+$/;
const TERM_PATH = /^\/term\/([0-9a-f]{16})$/;
const MISSING_TOKEN = "missing or invalid studio token; open the URL `nightqueue studio` printed";

// The headers every studio response carries; `connect-src` adds the `ws://` form of each origin a page may open a terminal from.
function securityHeaders(allowedOrigins = []) {
  const sockets = allowedOrigins.map((origin) => origin.replace(/^http:/, "ws:"));
  return {
    "content-security-policy": `default-src 'self'; connect-src ${["'self'", ...sockets].join(" ")}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

// Refuses a token that a cookie or a URL could not carry as it is.
function requireToken(token) {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) {
    throw new UserError("the studio needs a token of letters, digits, `.`, `_`, `~` or `-` to serve with");
  }
}

// Refuses a dev origin that is not a loopback `http://host:port`, and any dev origin outside the API-only mode.
function requireDevOrigin(devOrigin, apiOnly) {
  if (devOrigin === null || devOrigin === undefined) return null;
  if (!apiOnly) throw new UserError("a dev origin only applies to the API-only mode");
  let url = null;
  try {
    url = new URL(devOrigin);
  } catch {
    throw new UserError(`the dev origin \`${devOrigin}\` is not a URL`);
  }
  if (url.protocol !== "http:" || !url.port || !isLoopbackOrigin(devOrigin) || url.origin !== devOrigin) {
    throw new UserError(`the dev origin must be a loopback \`http://host:port\`, got \`${devOrigin}\``);
  }
  return devOrigin;
}

// Sets the headers every studio response carries, whatever it turns out to be.
function applySecurityHeaders(res, headers) {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
}

// Routes an authorised request to the MCP endpoint, the API, the event streams or the built pages.
async function routeRequest(req, res, context) {
  const path = requestPath(req.url);
  if (path === null) return respond(res, 400, "unreadable request target");
  if (path === "/mcp") {
    if (req.method !== "POST") return respond(res, 405, "the MCP endpoint only accepts POST");
    return await serveMcp(req, res, context.env);
  }
  if (path === "/api" || path.startsWith("/api/")) return await serveApi(req, res, { env: context.env, origin: context.origin, path, terminals: context.terminals, fetchImpl: context.fetchImpl });
  if (path === "/term" || path.startsWith("/term/")) return respond(res, 426, "this path only accepts a WebSocket upgrade");
  if (path === "/events") {
    if (req.method !== "GET") return respond(res, 405, "the event streams only answer GET");
    const job = new URL(req.url, "http://127.0.0.1").searchParams.get("job");
    if (job !== null) return await streamJob(req, res, { env: context.env, ref: job });
    return context.queueStream.subscribe(req, res);
  }
  if (context.apiOnly) return respond(res, 404, "this studio serves the API only; the pages come from `npm run studio:dev`");
  return await serveStatic(req, res, { distDir: context.distDir });
}

// Serves one request behind the loopback gate, the token exchange, the token gate and the origin rule for writes, in that order.
async function handleStudioRequest(req, res, context) {
  applySecurityHeaders(res, context.securityHeaders);
  const refusal = loopbackRefusal(req);
  if (refusal) return respond(res, 403, refusal);
  if (exchangeToken(req, res, context)) return;
  const auth = authorise(req, context);
  if (!auth) return respond(res, 401, MISSING_TOKEN);
  const writeRefusal = mutationRefusal(req, { auth, allowedOrigins: context.allowedOrigins });
  if (writeRefusal) return respond(res, 403, writeRefusal);
  await routeRequest(req, res, context);
}

// The terminal an upgrade may attach to, or the status and message it is refused with: loopback, token, exact origin, path, handshake, then a live terminal.
function upgradeTarget(req, context) {
  const refusal = loopbackRefusal(req);
  if (refusal) return { status: 403, message: refusal };
  if (!authorise(req, context)) return { status: 401, message: MISSING_TOKEN };
  if (!originIsExactly(req, context.allowedOrigins)) return { status: 403, message: "a terminal connection must carry the studio's exact origin" };
  const id = TERM_PATH.exec(requestPath(req.url) ?? "")?.[1];
  if (!id) return { status: 404, message: "only /term/<id> upgrades" };
  const handshake = handshakeRefusal(req);
  if (handshake) return { status: 400, message: handshake };
  if (!context.terminals?.isLive(id)) return { status: 404, message: `no live terminal \`${id}\`` };
  return { id };
}

// Upgrades a guarded `/term/<id>` request to a WebSocket tracked until it closes and attached to its terminal; any other upgrade gets a short HTTP refusal.
function handleUpgrade(req, socket, head, context) {
  socket.on("error", () => socket.destroy());
  const target = upgradeTarget(req, context);
  if (!target.id) return refuseUpgrade(socket, target.status, target.message);
  const connection = acceptUpgrade(req, socket, head);
  context.upgraded.add(connection);
  connection.onClose(() => context.upgraded.delete(connection));
  try {
    context.terminals.attach(target.id, connection);
  } catch (err) {
    connection.close(1011, err?.message ?? "the terminal could not be attached");
  }
}

// The exact origins a page of this server carries: its bound origin and the `localhost` name of the same port.
function ownOrigins(origin, port) {
  return [...new Set([origin, `http://localhost:${port}`])];
}

// Stops everything the studio started: the terminals and their sockets first, then the listener; resolves once the listener closed.
function shutDown({ env, server, context, dropSignals }) {
  dropSignals();
  stopMaintenance(env);
  context.queueStream.close();
  context.terminals?.closeAll();
  for (const connection of context.upgraded) connection.terminate(1001, "studio closing");
  const closed = new Promise((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  return closed;
}

// Starts the studio on loopback: the built pages, `/mcp`, `/api`, `/events` and `/term`, all behind one per-start token; resolves once it accepts requests.
export async function startStudioServer({ env = process.env, port = DEFAULT_STUDIO_PORT, token, host = "127.0.0.1", distDir, apiOnly = false, devOrigin = null, terminal = {}, fetchImpl }) {
  requireToken(token);
  const dev = requireDevOrigin(devOrigin, apiOnly);
  await checkSchemaOrWarn(env);
  await ensureStoreExists(env);
  const queueStream = createQueueStream({ env });
  const context = { env, token, distDir, apiOnly, fetchImpl, queueStream, port: null, origin: null, allowedOrigins: [], securityHeaders: securityHeaders(), terminals: null, upgraded: new Set() };
  const server = createHttpServer((req, res) => {
    handleStudioRequest(req, res, context).catch((err) => failRequest(res, err));
  });
  server.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head, context));
  const boundPort = await listenOn(server, port, host);
  context.port = boundPort;
  context.origin = `http://${host}:${boundPort}`;
  context.allowedOrigins = [...ownOrigins(context.origin, boundPort), ...(dev ? [dev] : [])];
  context.securityHeaders = securityHeaders(context.allowedOrigins);
  context.terminals = createTerminalManager({ env, port: boundPort, deps: terminal.deps, timing: terminal.timing });
  context.terminals.reap();
  startMaintenance(env);
  const stop = { dropSignals: () => {}, done: null };
  const close = () => {
    stop.done ??= shutDown({ env, server, context, dropSignals: stop.dropSignals });
    return stop.done;
  };
  stop.dropSignals = stopOnSignal(close);
  return { url: `${context.origin}/?t=${token}`, origin: context.origin, port: boundPort, close, queueStream, terminals: context.terminals };
}
