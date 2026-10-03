import { createServer as createHttpServer } from "node:http";
import { UserError } from "../config/errors.mjs";
import { failRequest, isLoopbackOrigin, listenOn, loopbackRefusal, requestPath, respond, serveMcp, stopOnSignal } from "../mcp/transports/http-gate.mjs";
import { checkSchemaOrWarn } from "../mcp/transports/startup-store.mjs";
import { startMaintenance, stopMaintenance } from "../queue/maintenance.mjs";
import { ensureStoreExists } from "../store/open.mjs";
import { serveApi } from "./api.mjs";
import { authorise, exchangeToken, mutationRefusal } from "./auth.mjs";
import { createQueueStream, streamJob } from "./events.mjs";
import { serveStatic } from "./static.mjs";

export const DEFAULT_STUDIO_PORT = 4747;
const TOKEN_SHAPE = /^[A-Za-z0-9._~-]+$/;

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

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
function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

// Routes an authorised request to the MCP endpoint, the API, the event streams or the built pages.
async function routeRequest(req, res, context) {
  const path = requestPath(req.url);
  if (path === null) return respond(res, 400, "unreadable request target");
  if (path === "/mcp") {
    if (req.method !== "POST") return respond(res, 405, "the MCP endpoint only accepts POST");
    return await serveMcp(req, res, context.env);
  }
  if (path === "/api" || path.startsWith("/api/")) return await serveApi(req, res, { env: context.env, origin: context.origin, path });
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
  applySecurityHeaders(res);
  const refusal = loopbackRefusal(req);
  if (refusal) return respond(res, 403, refusal);
  if (exchangeToken(req, res, context)) return;
  const auth = authorise(req, context);
  if (!auth) return respond(res, 401, "missing or invalid studio token; open the URL `nightqueue studio` printed");
  const writeRefusal = mutationRefusal(req, { auth, allowedOrigins: context.allowedOrigins });
  if (writeRefusal) return respond(res, 403, writeRefusal);
  await routeRequest(req, res, context);
}

// The exact origins a page of this server carries: its bound origin and the `localhost` name of the same port.
function ownOrigins(origin, port) {
  return [...new Set([origin, `http://localhost:${port}`])];
}

// Starts the studio on loopback: the built pages, `/mcp`, `/api` and `/events`, all behind one per-start token; resolves once it accepts requests.
export async function startStudioServer({ env = process.env, port = DEFAULT_STUDIO_PORT, token, host = "127.0.0.1", distDir, apiOnly = false, devOrigin = null }) {
  requireToken(token);
  const dev = requireDevOrigin(devOrigin, apiOnly);
  await checkSchemaOrWarn(env);
  await ensureStoreExists(env);
  const queueStream = createQueueStream({ env });
  const context = { env, token, distDir, apiOnly, queueStream, port: null, origin: null, allowedOrigins: [] };
  const server = createHttpServer((req, res) => {
    handleStudioRequest(req, res, context).catch((err) => failRequest(res, err));
  });
  const boundPort = await listenOn(server, port, host);
  context.port = boundPort;
  context.origin = `http://${host}:${boundPort}`;
  context.allowedOrigins = [...ownOrigins(context.origin, boundPort), ...(dev ? [dev] : [])];
  startMaintenance(env);
  let dropSignals = () => {};
  const close = () => {
    dropSignals();
    stopMaintenance(env);
    queueStream.close();
    server.close();
    server.closeAllConnections();
  };
  dropSignals = stopOnSignal(close);
  return { url: `${context.origin}/?t=${token}`, origin: context.origin, port: boundPort, close, queueStream };
}
